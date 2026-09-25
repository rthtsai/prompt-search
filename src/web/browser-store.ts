import definitions from '../../fixtures/prompts.json' with {type:'json'};
import {CATEGORIES,validateExtracted,type Extracted} from '../domain.ts';
import {normalize,rewrite,snippet} from '../text-shared.ts';
import {guessRequired} from './fill.ts';
import {describe} from './describe.ts';
import {parseInput} from '../parser.ts';
import {fillTemplate,type CardPrompt,type Library,type ImportJob} from './types.ts';

// GitHub Pages edition: per-browser IndexedDB, no remote API or shared accounts.
type Data={prompts:CardPrompt[];jobs:Record<string,ImportJob>;accepted:string[];events:string[]};
const running=new Set<string>();
let connection:Promise<IDBDatabase>|undefined;
function db(){return connection??=new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('prompt-dictionary-pages-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('state');request.onerror=()=>reject(new Error('瀏覽器無法儲存資料，請確認未封鎖網站儲存空間'));request.onsuccess=()=>resolve(request.result);});}
function initial():Data {return {prompts:definitions.map((p,i)=>({...p,category:p.category as CardPrompt['category'],id:`sample-${i}`,source:'fixtures/prompts.json',fork_of:null,use_count:0,last_used:null,updated_at:'2026-09-21T00:00:00Z'})),jobs:{},accepted:[],events:[]};}
async function transaction<T>(operation:(data:Data)=>T,write=true):Promise<T>{const database=await db();return new Promise<T>((resolve,reject)=>{const tx=database.transaction('state','readwrite'),store=tx.objectStore('state'),request=store.get('library');let result:T;request.onsuccess=()=>{try{const data:Data=request.result??initial();result=operation(data);if(write||!request.result)store.put(data,'library');}catch(e){reject(e);tx.abort();}};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(new Error('儲存失敗，可能是瀏覽器儲存空間不足'));tx.onabort=()=>reject(new Error('操作未儲存，請重試'));});}
export function organizeBrowser(input:string,source:string):CardPrompt {
  let body=input;const variables:Extracted['variables']=[];
  for(const m of input.matchAll(/(公司名稱|公司|主題|文章|職缺)\s*[:：]\s*([^\n，。；]{2,40})/g)){
    const name=m[1]==='公司'?'公司名稱':m[1];if(m[2].includes('{{')||variables.some(v=>v.name===name))continue;
    body=body.replace(m[0],`${m[1]}：{{${name}}}`);variables.push({name,label:name,example:m[2],required:true});
  }
  // 一律必填會讓「要不要工作紙」這種可選欄位卡住複製，所以只有核心欄位才必填
  for(const m of body.matchAll(/\{\{([^{}]+)\}\}/g))if(!variables.some(v=>v.name===m[1]))variables.push({name:m[1],label:m[1],example:'',required:guessRequired(m[1],body)});
  const q=rewrite(input),title=input.split('\n')[0].replace(/^#+\s*/,'').slice(0,60);
  const extracted:Extracted={title,body,summary:describe(body,{title,variables})||input.replace(/\s+/g,' ').slice(0,100),use_case:title,category:(q.categories[0]??'其他') as Extracted['category'],tags:q.tags,model_hint:q.models,lang:'zh-Hant',variables};validateExtracted(extracted);
  return {...extracted,summary_auto:true,id:crypto.randomUUID(),source,fork_of:null,use_count:0,last_used:null,updated_at:new Date().toISOString()};
}
export function searchBrowser(prompts:CardPrompt[],query:string):CardPrompt[]{
  const q=rewrite(query);return prompts.map(p=>{const haystack=[p.title,p.summary,p.body,p.body_en??'',p.tags.join(' '),p.model_hint.join(' ')].join('\n').toLowerCase();let score=q.terms.reduce((n,t)=>n+(haystack.includes(t)?t.length:0)+(p.title.toLowerCase().includes(t)?t.length:0),0);if(q.recent&&p.last_used)score*=1.25;return {p,score};}).filter(p=>p.score>0).sort((a,b)=>b.score-a.score).slice(0,10).map(({p})=>({...p,highlight:snippet(p.body,q.terms)}));
}
async function library(url:URL):Promise<Library>{return transaction(data=>{const q=url.searchParams.get('q')??'',category=url.searchParams.get('category'),tag=url.searchParams.get('tag'),sort=url.searchParams.get('sort');let items=data.prompts.filter(p=>(!category||p.category===category)&&(!tag||p.tags.includes(tag)));if(q.trim())items=searchBrowser(items,q);if(sort==='recent')items=items.filter(p=>p.last_used).sort((a,b)=>(b.last_used??'').localeCompare(a.last_used??''));else if(sort==='popular')items.sort((a,b)=>b.use_count-a.use_count);else if(!q)items.sort((a,b)=>b.updated_at.localeCompare(a.updated_at));return {items,total:data.prompts.length,uses:data.prompts.reduce((n,p)=>n+p.use_count,0),categories:CATEGORIES.map(name=>({name,count:data.prompts.filter(p=>p.category===name).length})),tags:[...new Set(data.prompts.flatMap(p=>p.tags))],mode:'local',degraded:false};},false);}
async function start(text:string,source:string){const parsed=parseInput(text,source),id=crypto.randomUUID(),job:ImportJob={id,status:'processing',done:0,total:parsed.length,items:[],duplicates:0,skipped:0,errors:[]};await transaction(data=>{data.jobs[id]=job;});running.add(id);void (async()=>{try{const existing=await transaction(data=>data.prompts,false),seen=new Set(existing.flatMap(p=>[normalize(p.body),normalize(p.summary)]));for(let i=0;i<parsed.length;i++){try{const p=organizeBrowser(parsed[i].body,parsed[i].source),key=normalize(p.body);if(seen.has(key)){job.skipped++;}else{seen.add(key);job.items.push(p);}}catch(e){job.errors.push({index:i,message:(e as Error).message});}job.done=i+1;if(i%10===0){await transaction(data=>{data.jobs[id]=job;});await new Promise(resolve=>setTimeout(resolve,0));}}job.status='review';await transaction(data=>{data.jobs[id]=job;});}catch(e){job.status='error';job.message=(e as Error).message;await transaction(data=>{data.jobs[id]=job;}).catch(()=>{});}finally{running.delete(id);}})();return job;}
export async function browserApi<T>(path:string,options:RequestInit={}):Promise<T>{
  const url=new URL(path,'https://local.invalid'),method=options.method??'GET',input=options.body?JSON.parse(String(options.body)):{};
  if(url.pathname==='/api/export')return await transaction(data=>({version:1,exported_at:new Date().toISOString(),prompts:data.prompts}),false) as T;
  if(url.pathname==='/api/library')return await library(url) as T;
  if(url.pathname==='/api/imports'&&method==='POST')return await start(input.text,input.source) as T;
  if(url.pathname.startsWith('/api/imports/')){const id=url.pathname.split('/').at(-1)!;return await transaction(data=>{const job=data.jobs[id];if(!job)throw new Error('找不到這次匯入');if(method==='GET'){if(job.status==='processing'&&!running.has(id)){job.status='error';job.message='網頁已重新載入，請重新匯入';}return job;}if(data.accepted.includes(id))return job;if(job.status!=='review')throw new Error('請等候整理完成');
    // 預覽畫面上改過的說明與分類要收下來，不然改了等於白改
    const edits:CardPrompt[]=Array.isArray(input?.items)?input.items:[];
    job.items=job.items.map(p=>{const e=edits.find(x=>x?.id===p.id);
      return e?{...p,summary:String(e.summary??p.summary).slice(0,2000),summary_auto:!!e.summary_auto,
        category:typeof e.category==='string'&&e.category?e.category:p.category}:p;});
    for(const p of job.items){if(data.prompts.some(old=>normalize(old.body)===normalize(p.body)))throw new Error('內容已在另一個視窗匯入，請重新整理');data.prompts.push(p);}data.accepted.push(id);job.status='accepted';return job;}) as T;}
  // 示範版也要能改分類，不然卡片上的分類選單在這個模式下會丟「不支援的操作」
  if(url.pathname==='/api/bulk'&&method==='POST')return await transaction(data=>{
    const ids:string[]=Array.isArray(input.ids)?input.ids:[];
    if(input.action==='move'){let n=0;
      for(const p of data.prompts)if(ids.includes(p.id)){p.category=String(input.category);n++;}
      return {moved:n};}
    if(input.action==='delete'){const before=data.prompts.length;
      data.prompts=data.prompts.filter(p=>!ids.includes(p.id));return {deleted:before-data.prompts.length};}
    throw new Error('示範版不支援這個操作');
  }) as T;
  if(url.pathname.startsWith('/api/prompts/')){const id=url.pathname.split('/').at(-1)!;return await transaction(data=>{const p=data.prompts.find(p=>p.id===id);if(!p)throw new Error('找不到這個 Prompt');if(input.action==='use'){fillTemplate(p.body,p.variables,input.values);if(!data.events.includes(input.eventId)){p.use_count++;p.last_used=new Date().toISOString();data.events.push(input.eventId);data.events=data.events.slice(-10000);}return p;}if(input.action==='edit'){const updated=organizeBrowser(input.body,p.source);updated.title=input.title.trim();updated.summary=input.summary.trim();updated.category=input.category;updated.variables=updated.variables.map(v=>p.variables.find(old=>old.name===v.name)??v);validateExtracted({...updated,use_case:updated.title,lang:'zh-Hant'});if(data.prompts.some(old=>(input.fork||old.id!==id)&&normalize(old.body)===normalize(updated.body)))throw new Error('這份內容已在辭典裡，請修改後再儲存');if(input.fork){updated.fork_of=id;data.prompts.push(updated);}else{Object.assign(updated,{id,use_count:p.use_count,last_used:p.last_used,fork_of:p.fork_of});data.prompts[data.prompts.indexOf(p)]=updated;}return updated;}throw new Error('不支援的操作');}) as T;}
  throw new Error('不支援的操作');
}
