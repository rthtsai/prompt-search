import {CATEGORIES,type Variable} from '../domain.ts';
import {withDescription} from './describe.ts';
import {parseInput} from '../parser.ts';
import {organizeBrowser,searchBrowser} from './browser-store.ts';
import {maintainerToken,isMaintainer} from './maintainer.ts';
import {type CardPrompt,type ImportJob,mergeVariables} from './types.ts';
import {CLOUD_CACHE_KEY,collectLegacy,legacyCard,legacyBackup,type LegacySnapshot} from './legacy-storage.ts';

export type CloudConfig={url:string;key:string};
export type Rpc=(request:Record<string,unknown>)=>Promise<any>;
const equivalent=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/\s/gu,'');
function cards(value:unknown):CardPrompt[]{
 if(!Array.isArray(value)||value.some(p=>!p||typeof p.id!=='string'||typeof p.body!=='string'||!Array.isArray(p.variables)||typeof p.updated_at!=='string'))throw new Error('資料格式不正確，你的內容沒有被清掉');
 return value;
}
export function createRpc(config:CloudConfig,transport:typeof fetch=fetch):Rpc {
 if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.url))throw new Error('網站設定不完整，請聯絡維護者');
 if(!config.key||config.key.startsWith('sb_secret_'))throw new Error('網站設定不完整，請聯絡維護者');
 if(config.key.startsWith('eyJ')){try{const payload=JSON.parse(atob(config.key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(payload.role!=='anon')throw new Error();}catch{throw new Error('瀏覽器只能使用 anon 公開金鑰');}}
 return async(request)=>{
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),20000);
  try{
   // 破壞性操作在資料庫端要驗這個 token；沒有就只剩新增與複製。
   const token=maintainerToken();
   const payload=token?{...request,maintainer:token}:request;
   const response=await transport(config.url+'/rest/v1/rpc/prompt_library',{method:'POST',headers:{apikey:config.key,'Content-Type':'application/json',...(config.key.startsWith('eyJ')?{Authorization:'Bearer '+config.key}:{})},body:JSON.stringify({request:payload}),signal:controller.signal,cache:'no-store'});
   const result=await response.json();if(!response.ok)throw new Error(result.message??`雲端請求失敗 (${response.status})`);return result;
  }catch(e){if((e as Error).name==='AbortError')throw new Error('連線逾時，資料尚未確認儲存，請重試');throw e;}finally{clearTimeout(timeout);}
 };
}
export async function uploadBatches(items:CardPrompt[],rpc:Rpc){
 const saved:CardPrompt[]=[];
 for(let i=0;i<items.length;i+=25){const batch=items.slice(i,i+25);const result=cards(await rpc({op:'import',items:batch}));
  if(result.length!==batch.length||result.some((p,j)=>equivalent(p.body)!==equivalent(batch[j].body)))throw new Error('還沒有全部存進去，你的內容沒有遺失，請重試');
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
  for(const p of page){if(seen.has(p.id))throw new Error('讀取時出現重複，請重新整理');seen.add(p.id);all.push(p);}
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
export function draftItem(input:{title:string;body:string;body_en?:string|null;summary:string;summary_auto?:boolean;category:string;variables?:Variable[];version_note?:string},previous:Variable[]=[]):CardPrompt{
 const body=String(input.body??''),en=typeof input.body_en==='string'&&input.body_en.trim()?input.body_en:null;
 if(body.trim().length<20)throw new Error('Prompt 內容至少 20 字');
 if(en&&en.trim().length<20)throw new Error('英文版本至少 20 字，或留空');
 const p=organizeBrowser(body.replace(/\{\{[^{}]+\}\}/g,'X'),'共用辭典');
 return withDescription({...p,body,body_en:en,title:String(input.title??'').trim()||p.title,summary:String(input.summary??'').trim(),summary_auto:input.summary_auto,category:input.category,
  variables:mergeVariables([body,en],input.variables??[],previous),version_note:String(input.version_note??'').slice(0,200)});
}
export const exampleUrl=(base:string,path:string)=>`${base}/storage/v1/object/public/prompt-examples/${path}`;
/** What a prompt can produce: a picture, a file to download, or the text answer itself. */
export const exampleTypes:Record<string,{ext:string;label:string}>={
 'image/jpeg':{ext:'jpg',label:'圖片'},'image/png':{ext:'png',label:'圖片'},'image/webp':{ext:'webp',label:'圖片'},
 'video/mp4':{ext:'mp4',label:'影片'},'video/webm':{ext:'webm',label:'影片'},
 'application/pdf':{ext:'pdf',label:'PDF'},
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':{ext:'docx',label:'Word'},
 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':{ext:'xlsx',label:'Excel'},
 'application/vnd.openxmlformats-officedocument.presentationml.presentation':{ext:'pptx',label:'PowerPoint'},
 'text/plain':{ext:'txt',label:'文字檔'},'text/markdown':{ext:'md',label:'Markdown'},
 'text/csv':{ext:'csv',label:'CSV'},'application/json':{ext:'json',label:'JSON'}};
const byExtension:Record<string,string>={pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
 txt:'text/plain',md:'text/markdown',csv:'text/csv',json:'application/json',mp4:'video/mp4',webm:'video/webm'};
/** Browsers leave .md and a few others without a type, so fall back to the extension. */
export function exampleKind(file:File){
 const ext=(file.name.split('.').pop()??'').toLowerCase();
 const mime=exampleTypes[file.type]?file.type:byExtension[ext];
 if(!mime)throw new Error('支援圖片（JPG／PNG／WebP）、影片（MP4／WebM）、PDF、Word、Excel、PowerPoint、txt、md、csv、json');
 return {mime,ext:exampleTypes[mime].ext,label:exampleTypes[mime].label,
  image:mime.startsWith('image/'),video:mime.startsWith('video/')};
}
/** Downscale in the browser so a phone photo or 4K render stays a small upload. */
export async function shrinkImage(file:File,max=1600,quality=0.82):Promise<{blob:Blob;type:string}>{
 if(!/^image\/(jpeg|png|webp)$/.test(file.type))throw new Error('請選擇 JPG、PNG 或 WebP 圖片');
 if(typeof createImageBitmap!=='function')return {blob:file,type:file.type};
 const bitmap=await createImageBitmap(file);
 const scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height));
 if(scale===1&&file.size<=900_000)return {blob:file,type:file.type};
 const canvas=document.createElement('canvas');
 canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
 canvas.getContext('2d')!.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close?.();
 const type=file.type==='image/png'?'image/png':'image/jpeg';
 const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,type,quality));
 if(!blob)return {blob:file,type:file.type};
 return blob.size<file.size?{blob,type}:{blob:file,type:file.type};
}
export class CloudStore {
 private rpc:Rpc;private jobs=new Map<string,ImportJob>();private migration:Promise<void>|undefined;
 private migrationMessage='';private cacheWarning='';private categoryList:CloudCategory[]=CATEGORIES.map(name=>({name,fixed:name==='其他'}));
 private config:CloudConfig;private transport:typeof fetch;
 constructor(config:CloudConfig,transport:typeof fetch=fetch){this.config=config;this.transport=transport.bind(globalThis);this.rpc=createRpc(config,transport);}
 private async migrate(){
  return this.migration??=(async()=>{const source=await collectLegacy();const result=await migrateSnapshots(source.snapshots,this.rpc);
   const errors=[...source.errors,...result.errors];this.migrationMessage=errors.length?'舊收藏還沒有全部搬過去，原本的內容沒有遺失。'+errors.join('；'):result.uploaded?`已把這台裝置上的 ${result.uploaded} 則 Prompt 加進大家的辭典。`:'';
  })().catch(e=>{this.migrationMessage='舊收藏沒有遺失，搬移沒有成功：'+(e as Error).message;});
 }
 private writeCache(prompts:CardPrompt[]){try{localStorage.setItem(CLOUD_CACHE_KEY,JSON.stringify({url:this.config.url,prompts,categories:this.categoryList,savedAt:new Date().toISOString()}));this.cacheWarning='';}catch{this.cacheWarning='這台裝置無法暫存資料，其他功能仍可正常使用。';}}
 private readCache():CardPrompt[]|null{try{const c=JSON.parse(localStorage.getItem(CLOUD_CACHE_KEY)??'null');if(c?.url!==this.config.url)return null;if(Array.isArray(c.categories))this.categoryList=c.categories;return cards(c.prompts);}catch{return null;}}
 private invalidate(){try{localStorage.removeItem(CLOUD_CACHE_KEY);}catch{/* Cache is never a write queue or migration source. */}}
 private async all(){const [result,categories]=await Promise.all([readAll(this.rpc),this.rpc({op:'categories'}).catch(()=>null)]);
  if(Array.isArray(categories)&&categories.every(c=>typeof c?.name==='string'))this.categoryList=categories;this.writeCache(result);return result;}
 private async stamp(){return JSON.stringify(await this.rpc({op:'stamp'}));}
 /** Upload first, then attach: a failed upload never leaves a broken example on a prompt. */
 async addExample(id:string,file:File,caption:string,role?:'input'|'output'){
  const kind=exampleKind(file);
  let body:Blob=file,ext=kind.ext,mime=kind.mime;
  if(kind.image){const small=await shrinkImage(file);body=small.blob;mime=small.type;ext=small.type==='image/png'?'png':'jpg';
   if(body.size>3*1024*1024)throw new Error('圖片太大，請改用 3 MB 以內的圖片');}
  // 影片沒辦法在瀏覽器裡壓縮，所以直接給比較寬的上限
  else if(kind.video){if(body.size>25*1024*1024)throw new Error('影片太大，請改用 25 MB 以內的影片');}
  else if(body.size>10*1024*1024)throw new Error('檔案太大，請改用 10 MB 以內的檔案');
  const path=`${id}/${crypto.randomUUID()}.${ext}`;
  const response=await this.transport(`${this.config.url}/storage/v1/object/prompt-examples/${path}`,
   {method:'POST',headers:{apikey:this.config.key,'Content-Type':mime,'x-upsert':'false',
     ...(this.config.key.startsWith('eyJ')?{Authorization:'Bearer '+this.config.key}:{})},body});
  if(!response.ok){const detail=await response.text().catch(()=>'');throw new Error('上傳失敗'+(detail?'：'+detail.slice(0,200):`（${response.status}）`));}
  const entry={kind:kind.image?'image':kind.video?'video':'file',path,name:file.name.slice(0,120),mime,size:body.size,caption:caption.slice(0,200),...(role?{role}:{})};
  const card=await this.rpc({op:'example_add',id,entry});this.invalidate();return card as CardPrompt;
 }
 /** A text answer needs no upload; it is stored with the prompt. */
 async addTextExample(id:string,text:string,caption:string){
  if(!text.trim())throw new Error('請先貼上文字結果');
  const card=await this.rpc({op:'example_add',id,entry:{kind:'text',text:text.slice(0,8000),caption:caption.slice(0,200)}});
  this.invalidate();return card as CardPrompt;
 }
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
   try{[all,stamp]=await Promise.all([this.all(),this.stamp().catch(()=>undefined)]);warning=[this.migrationMessage,this.cacheWarning].filter(Boolean).join(' ');}catch(e){const cached=this.readCache();if(!cached)throw new Error([warning,'連不上，請檢查網路後再試：'+(e as Error).message].filter(Boolean).join(' '));all=cached;offline=true;warning+=' 目前顯示的是離線時的舊內容，連上網路後才能新增或修改。';}
   const groups=groupVersions(all);
   const q=url.searchParams.get('q')??'',category=url.searchParams.get('category'),tag=url.searchParams.get('tag'),sort=url.searchParams.get('sort');
   let items=groups.filter(p=>(!category||p.category===category)&&(!tag||p.tags.includes(tag)));
   if(q.trim())items=searchBrowser(items,q);
   if(sort==='recent')items=items.filter(p=>p.last_used).sort((a,b)=>(b.last_used??'').localeCompare(a.last_used??''));
   else if(sort==='popular')items.sort((a,b)=>b.use_count-a.use_count);else if(!q)items.sort((a,b)=>b.updated_at.localeCompare(a.updated_at));
   const names=[...this.categoryList];for(const p of groups)if(!names.some(c=>c.name===p.category))names.push({name:p.category});
   return {items,total:groups.length,uses:all.reduce((n,p)=>n+p.use_count,0),categories:names.map(c=>({...c,count:groups.filter(p=>p.category===c.name).length})),tags:[...new Set(groups.flatMap(p=>p.tags))],mode:'cloud',degraded:offline,warning,manage:isMaintainer(),storage:this.config.url,stamp,synced_at:offline?undefined:new Date().toISOString()} as T;
  }
  if(url.pathname==='/api/categories'){
   const result=await this.rpc({op:'categories_save',items:input.items});if(!Array.isArray(result))throw new Error('分類沒有存成功，請重試');this.categoryList=result;this.invalidate();return result as T;
  }
  // 範例說明可以事後改：原本只能在上傳的那一刻寫，寫完就再也碰不到
  if(url.pathname==='/api/examples'&&options.method==='POST'){
   // 同一個入口改說明或改角色（原圖／產出），兩者都不會讓內容消失
   const r=input.role
    ? await this.rpc({op:'example_role',id:input.id,entry_id:input.entryId,path:input.path,role:input.role})
    : await this.rpc({op:'example_caption',id:input.id,entry_id:input.entryId,path:input.path,
        caption:String(input.caption??'').slice(0,200)});
   this.invalidate();return r as T;
  }
  if(url.pathname==='/api/examples'&&options.method==='DELETE'){
   const r=await this.rpc({op:'example_remove',id:input.id,entry:{id:input.entryId,path:input.path}});this.invalidate();return r as T;
  }
  if(url.pathname==='/api/bulk'){
   const ids:string[]=input.ids;if(!Array.isArray(ids)||!ids.length)throw new Error('請先勾選 Prompt');
   const op=input.action==='move'?'move':input.action==='delete'?'delete_many':input.action==='merge'?'merge':input.action==='restore'?'restore_many':'';if(!op)throw new Error('不支援的操作');
   const result=await this.rpc({op,ids,category:input.category});this.invalidate();return result as T;
  }
  if(url.pathname==='/api/imports'){
   const parsed=parseInput(input.text,input.source),items:CardPrompt[]=[],errors:ImportJob['errors']=[],seen=new Set<string>();let skipped=0;
   let restored:any[]|undefined;try{const value=JSON.parse(input.text);if(value.version&&Array.isArray(value.prompts))restored=value.prompts;}catch{/* Plain text import. */}
   if(restored&&restored.length!==parsed.length)throw new Error('備份裡有幾則無法匯入，請先留著原檔再檢查');
   parsed.forEach((p,index)=>{try{const card=withDescription(restored?legacyCard(restored[index]):organizeBrowser(p.body,p.source)),key=equivalent(card.body);if(seen.has(key)){skipped++;return;}seen.add(key);items.push(card);}catch(e){errors.push({index,message:(e as Error).message});}});
   const job:ImportJob={id:crypto.randomUUID(),status:'review',done:parsed.length,total:parsed.length,items,duplicates:0,skipped,errors};this.jobs.set(job.id,job);return job as T;
  }
  if(url.pathname.startsWith('/api/imports/')){
   const job=this.jobs.get(url.pathname.split('/').at(-1)!);if(!job)throw new Error('整理視窗已重開，請重新貼上或匯入');
   if(options.method==='POST'&&job.status!=='accepted'){
    // 畫面上改過的說明與分類要送回來，其餘仍以整理結果為準。
    const edits:CardPrompt[]=Array.isArray(input.items)?input.items:[];
    const items=job.items.map(p=>{const e=edits.find(x=>x?.id===p.id);
     return e?{...p,summary:String(e.summary??p.summary).slice(0,2000),summary_auto:!!e.summary_auto,
       category:typeof e.category==='string'&&e.category?e.category:p.category}:p;});
    await uploadBatches(items,this.rpc);job.items=items;job.status='accepted';this.invalidate();}return job as T;
  }
  if(url.pathname.startsWith('/api/prompts/')){
   const id=url.pathname.split('/').at(-1)!;
   if(options.method==='DELETE'){const result=await this.rpc({op:'delete',id,version:input.version});if(!result?.deleted)throw new Error('刪除沒有成功，請重新整理後再試');this.invalidate();return result;}
   if(input.action==='restore'){const result=await this.rpc({op:'restore',id});this.invalidate();return result as T;}
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
 return current().api<T>(path,options);
}
function current(){return store??=new CloudStore({url:process.env.NEXT_PUBLIC_SUPABASE_URL??'',key:process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY??''});}
export function cloudAddExample(id:string,file:File,caption:string,role?:'input'|'output'){return current().addExample(id,file,caption,role);}
export function cloudAddTextExample(id:string,text:string,caption:string){return current().addTextExample(id,text,caption);}
