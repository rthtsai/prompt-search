import {CATEGORIES,type Variable} from '../domain.ts';
import {parseInput} from '../parser.ts';
import {organizeBrowser,searchBrowser} from './browser-store.ts';
import {type CardPrompt,type ImportJob,mergeVariables} from './types.ts';
import {CLOUD_CACHE_KEY,collectLegacy,legacyCard,legacyBackup,type LegacySnapshot} from './legacy-storage.ts';

export type CloudConfig={url:string;key:string};
export type Rpc=(request:Record<string,unknown>)=>Promise<any>;
const equivalent=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/\s/gu,'');
function cards(value:unknown):CardPrompt[]{
 if(!Array.isArray(value)||value.some(p=>!p||typeof p.id!=='string'||typeof p.body!=='string'||!Array.isArray(p.variables)||typeof p.updated_at!=='string'))throw new Error('雲端回傳格式不正確，未清除本機資料');
 return value;
}
export function createRpc(config:CloudConfig,transport:typeof fetch=fetch):Rpc {
 if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.url))throw new Error('Supabase 專案網址未設定或不正確');
 if(!config.key||config.key.startsWith('sb_secret_'))throw new Error('請設定 Supabase publishable／anon 公開金鑰');
 if(config.key.startsWith('eyJ')){try{const payload=JSON.parse(atob(config.key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(payload.role!=='anon')throw new Error();}catch{throw new Error('瀏覽器只能使用 anon 公開金鑰');}}
 return async(request)=>{
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),20000);
  try{
   const response=await transport(config.url+'/rest/v1/rpc/prompt_library',{method:'POST',headers:{apikey:config.key,'Content-Type':'application/json',...(config.key.startsWith('eyJ')?{Authorization:'Bearer '+config.key}:{})},body:JSON.stringify({request}),signal:controller.signal,cache:'no-store'});
   const result=await response.json();if(!response.ok)throw new Error(result.message??`雲端請求失敗 (${response.status})`);return result;
  }catch(e){if((e as Error).name==='AbortError')throw new Error('連線逾時，資料尚未確認儲存，請重試');throw e;}finally{clearTimeout(timeout);}
 };
}
export async function uploadBatches(items:CardPrompt[],rpc:Rpc){
 const saved:CardPrompt[]=[];
 for(let i=0;i<items.length;i+=25){const batch=items.slice(i,i+25);const result=cards(await rpc({op:'import',items:batch}));
  if(result.length!==batch.length||result.some((p,j)=>equivalent(p.body)!==equivalent(batch[j].body)))throw new Error('雲端未確認所有內容，本機資料已保留');
  saved.push(...result);
 }return saved;
}
export async function migrateSnapshots(snapshots:LegacySnapshot[],rpc:Rpc){
 const errors:string[]=[];let uploaded=0;
 for(const snapshot of snapshots){try{
  const prompts=snapshot.items.map(legacyCard);await uploadBatches(prompts,rpc);
  await snapshot.clear();uploaded+=prompts.length;
 }catch(e){errors.push(`${snapshot.label}：${(e as Error).message}`);}}
 return {uploaded,errors};
}
export async function readAll(rpc:Rpc):Promise<CardPrompt[]>{
 const all:CardPrompt[]=[],seen=new Set<string>();let cursor:string|undefined;
 for(;;){const page=cards(await rpc({op:'list',cursor}));if(!page.length)break;
  for(const p of page){if(seen.has(p.id))throw new Error('雲端分頁資料重複，請重試');seen.add(p.id);all.push(p);}
  cursor=page.at(-1)!.id;if(page.length<200)break;
 }return all;
}
// One card per prompt group: the highest version is shown, all versions ride along (newest first).
export function groupVersions(all:CardPrompt[]):CardPrompt[]{
 const groups=new Map<string,CardPrompt[]>();
 for(const p of all){const g=p.group_id??p.id;const list=groups.get(g);if(list)list.push(p);else groups.set(g,[p]);}
 return [...groups.values()].map(list=>{
  list.sort((a,b)=>(b.version_no??1)-(a.version_no??1)||b.updated_at.localeCompare(a.updated_at));
  const [latest]=list;const uses=list.reduce((n,p)=>n+p.use_count,0);
  const last=list.map(p=>p.last_used).filter(Boolean).sort().at(-1)??null;
  return list.length>1?{...latest,versions:list,use_count:uses,last_used:last}:latest;
 });
}
type CloudCategory={name:string;fixed?:boolean};
export function draftItem(input:{title:string;body:string;body_en?:string|null;summary:string;category:string;variables?:Variable[];version_note?:string},previous:Variable[]=[]):CardPrompt{
 const body=String(input.body??''),en=typeof input.body_en==='string'&&input.body_en.trim()?input.body_en:null;
 if(body.trim().length<20)throw new Error('Prompt 內容至少 20 字');
 if(en&&en.trim().length<20)throw new Error('英文版本至少 20 字，或留空');
 const p=organizeBrowser(body.replace(/\{\{[^{}]+\}\}/g,'X'),'共用辭典');
 return {...p,body,body_en:en,title:String(input.title??'').trim()||p.title,summary:String(input.summary??'').trim(),category:input.category,
  variables:mergeVariables([body,en],input.variables??[],previous),version_note:String(input.version_note??'').slice(0,200)};
}
export class CloudStore {
 private rpc:Rpc;private jobs=new Map<string,ImportJob>();private migration:Promise<void>|undefined;
 private migrationMessage='';private cacheWarning='';private categoryList:CloudCategory[]=CATEGORIES.map(name=>({name,fixed:name==='其他'}));
 private config:CloudConfig;
 constructor(config:CloudConfig,transport:typeof fetch=fetch){this.config=config;this.rpc=createRpc(config,transport);}
 private async migrate(){
  return this.migration??=(async()=>{const source=await collectLegacy();const result=await migrateSnapshots(source.snapshots,this.rpc);
   const errors=[...source.errors,...result.errors];this.migrationMessage=errors.length?'本機資料遷移未完成，原始資料已保留。'+errors.join('；'):result.uploaded?`已將 ${result.uploaded} 則本機 Prompt 同步到共用資料庫。`:'';
  })().catch(e=>{this.migrationMessage='本機資料已保留，遷移失敗：'+(e as Error).message;});
 }
 private writeCache(prompts:CardPrompt[]){try{localStorage.setItem(CLOUD_CACHE_KEY,JSON.stringify({url:this.config.url,prompts,categories:this.categoryList,savedAt:new Date().toISOString()}));this.cacheWarning='';}catch{this.cacheWarning='雲端已連線，但瀏覽器快取無法儲存。';}}
 private readCache():CardPrompt[]|null{try{const c=JSON.parse(localStorage.getItem(CLOUD_CACHE_KEY)??'null');if(c?.url!==this.config.url)return null;if(Array.isArray(c.categories))this.categoryList=c.categories;return cards(c.prompts);}catch{return null;}}
 private invalidate(){try{localStorage.removeItem(CLOUD_CACHE_KEY);}catch{/* Cache is never a write queue or migration source. */}}
 private async all(){const [result,categories]=await Promise.all([readAll(this.rpc),this.rpc({op:'categories'}).catch(()=>null)]);
  if(Array.isArray(categories)&&categories.every(c=>typeof c?.name==='string'))this.categoryList=categories;this.writeCache(result);return result;}
 private async stamp(){return JSON.stringify(await this.rpc({op:'stamp'}));}
 async api<T>(path:string,options:RequestInit={}):Promise<T>{
  const url=new URL(path,'https://local.invalid');const input=options.body?JSON.parse(String(options.body)):{};
  if(url.pathname==='/api/migration/retry'){this.migration=undefined;await this.migrate();return {} as T;}
  if(url.pathname==='/api/export'){
   // Export never silently substitutes an incomplete cache for the full cloud library.
   const prompts=await this.all();const legacy=await legacyBackup();return {version:2,exported_at:new Date().toISOString(),storage:'supabase',prompts,unmigrated_local:legacy} as T;
  }
  await this.migrate();
  if(url.pathname==='/api/stamp')return {stamp:await this.stamp()} as T;
  if(url.pathname==='/api/library'){
   let all:CardPrompt[],offline=false,stamp:string|undefined;let warning=[this.migrationMessage,this.cacheWarning].filter(Boolean).join(' ');
   try{[all,stamp]=await Promise.all([this.all(),this.stamp().catch(()=>undefined)]);warning=[this.migrationMessage,this.cacheWarning].filter(Boolean).join(' ');}catch(e){const cached=this.readCache();if(!cached)throw new Error([warning,'雲端無法連線：'+(e as Error).message].filter(Boolean).join(' '));all=cached;offline=true;warning+=' 目前顯示離線快取，新增、編輯或刪除必須連上雲端才會儲存。';}
   const groups=groupVersions(all);
   const q=url.searchParams.get('q')??'',category=url.searchParams.get('category'),tag=url.searchParams.get('tag'),sort=url.searchParams.get('sort');
   let items=groups.filter(p=>(!category||p.category===category)&&(!tag||p.tags.includes(tag)));
   if(q.trim())items=searchBrowser(items,q);
   if(sort==='recent')items=items.filter(p=>p.last_used).sort((a,b)=>(b.last_used??'').localeCompare(a.last_used??''));
   else if(sort==='popular')items.sort((a,b)=>b.use_count-a.use_count);else if(!q)items.sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
   const names=[...this.categoryList];for(const p of groups)if(!names.some(c=>c.name===p.category))names.push({name:p.category});
   return {items,total:groups.length,uses:all.reduce((n,p)=>n+p.use_count,0),categories:names.map(c=>({...c,count:groups.filter(p=>p.category===c.name).length})),tags:[...new Set(groups.flatMap(p=>p.tags))],mode:'cloud',degraded:offline,warning,manage:true,stamp,synced_at:offline?undefined:new Date().toISOString()} as T;
  }
  if(url.pathname==='/api/categories'){
   const result=await this.rpc({op:'categories_save',items:input.items});if(!Array.isArray(result))throw new Error('雲端未確認分類變更');this.categoryList=result;this.invalidate();return result as T;
  }
  if(url.pathname==='/api/bulk'){
   const ids:string[]=input.ids;if(!Array.isArray(ids)||!ids.length)throw new Error('請先勾選 Prompt');
   const op=input.action==='move'?'move':input.action==='delete'?'delete_many':input.action==='merge'?'merge':'';if(!op)throw new Error('不支援的操作');
   const result=await this.rpc({op,ids,category:input.category});this.invalidate();return result as T;
  }
  if(url.pathname==='/api/imports'){
   const parsed=parseInput(input.text,input.source),items:CardPrompt[]=[],errors:ImportJob['errors']=[],seen=new Set<string>();let skipped=0;
   let restored:any[]|undefined;try{const value=JSON.parse(input.text);if(value.version&&Array.isArray(value.prompts))restored=value.prompts;}catch{/* Plain text import. */}
   if(restored&&restored.length!==parsed.length)throw new Error('備份含有無法匯入的項目，請保留原始備份並檢查');
   parsed.forEach((p,index)=>{try{const card=restored?legacyCard(restored[index]):organizeBrowser(p.body,p.source),key=equivalent(card.body);if(seen.has(key)){skipped++;return;}seen.add(key);items.push(card);}catch(e){errors.push({index,message:(e as Error).message});}});
   const job:ImportJob={id:crypto.randomUUID(),status:'review',done:parsed.length,total:parsed.length,items,duplicates:0,skipped,errors};this.jobs.set(job.id,job);return job as T;
  }
  if(url.pathname.startsWith('/api/imports/')){
   const job=this.jobs.get(url.pathname.split('/').at(-1)!);if(!job)throw new Error('整理視窗已重開，請重新貼上或匯入');
   if(options.method==='POST'&&job.status!=='accepted'){await uploadBatches(job.items,this.rpc);job.status='accepted';this.invalidate();}return job as T;
  }
  if(url.pathname.startsWith('/api/prompts/')){
   const id=url.pathname.split('/').at(-1)!;
   if(options.method==='DELETE'){const result=await this.rpc({op:'delete',id,version:input.version});if(!result?.deleted)throw new Error('雲端未確認刪除');this.invalidate();return result;}
   if(input.action==='edit'){
    const p=draftItem(input,input.previous??[]);
    const result=input.asVersion?await this.rpc({op:'version',id,item:{...p,source:'新版本'}}):input.fork?(await uploadBatches([{...p,source:'另存範本'}],this.rpc))[0]:await this.rpc({op:'edit',id,version:input.version,item:p});this.invalidate();return result as T;
   }
   if(input.action==='use'){const result=await this.rpc({op:'use',id,event:input.eventId});this.invalidate();return result as T;}
  }
  throw new Error('不支援的操作');
 }
}
let store:CloudStore|undefined;
export function cloudApi<T>(path:string,options:RequestInit={}):Promise<T>{
 store??=new CloudStore({url:process.env.NEXT_PUBLIC_SUPABASE_URL??'',key:process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY??''});
 return store.api<T>(path,options);
}
