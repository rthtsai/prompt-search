import {organizeBrowser} from './browser-store.ts';
import {CATEGORIES,validateExtracted} from '../domain.ts';
import type {CardPrompt} from './types.ts';

export type LegacySnapshot={label:string;items:unknown[];clear:()=>Promise<void>};
export const CLOUD_CACHE_KEY='prompt-search:cloud-cache:v1';
export function legacyItems(value:unknown):unknown[] {
 if(Array.isArray(value))return value;
 if(value&&typeof value==='object'){
  const v=value as Record<string,unknown>;
  if(Array.isArray(v.prompts))return v.prompts;
  if(Array.isArray(v.items))return v.items;
 }
 throw new Error('本機資料格式無法辨識，已保留原始資料');
}
export function legacyCard(value:unknown):CardPrompt {
 if(!value||typeof value!=='object')throw new Error('本機 Prompt 格式無法辨識');
 const v=value as Record<string,any>;const body=v.body??v.content??v.prompt;
 if(typeof body!=='string')throw new Error('本機 Prompt 缺少內容');
 const card=organizeBrowser(body,typeof v.source==='string'?v.source:'本機資料遷移');
 if(typeof v.title==='string'&&v.title.trim())card.title=v.title;
 if(typeof v.summary==='string'&&v.summary.trim()){card.summary=v.summary;card.summary_auto=false;}
 if(CATEGORIES.includes(v.category))card.category=v.category;
 if(Array.isArray(v.tags))card.tags=v.tags;
 if(Array.isArray(v.model_hint))card.model_hint=v.model_hint;
 if(Array.isArray(v.variables))card.variables=card.variables.map(variable=>{
  const old=v.variables.find((x:any)=>x?.name===variable.name);
  return old?{...variable,label:typeof old.label==='string'?old.label:variable.label,
   example:typeof old.example==='string'?old.example:'',required:typeof old.required==='boolean'?old.required:true}:variable;
 });
 validateExtracted({...card,use_case:card.title,lang:'zh-Hant'});return card;
}
function legacyKey(key:string){return key!==CLOUD_CACHE_KEY && (/^(prompt[-_ ]?(search|dictionary|library|辭典))([-_: .]|$)/i.test(key)||['prompts','promptLibrary','promptDictionary'].includes(key));}
function openLegacy():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{
 const request=indexedDB.open('prompt-dictionary-pages-v1');
 request.onerror=()=>reject(new Error('無法讀取舊版 IndexedDB，資料未刪除'));
 request.onblocked=()=>reject(new Error('舊版資料被其他分頁使用，請關閉舊分頁後重試'));
 request.onsuccess=()=>resolve(request.result);
});}
export async function readIndexedDBSnapshot():Promise<LegacySnapshot|null>{
 const db=await openLegacy();
 try{
  if(!db.objectStoreNames.contains('state'))return null;
  const value=await new Promise<any>((resolve,reject)=>{const tx=db.transaction('state','readonly');const req=tx.objectStore('state').get('library');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(new Error('無法讀取 IndexedDB 資料'));});
  if(!value)return null;const items=legacyItems(value);if(!items.length)return null;
  const signature=JSON.stringify(items);
  return {label:'舊版 IndexedDB',items,clear:async()=>{
   const latest=await openLegacy();
   try{await new Promise<void>((resolve,reject)=>{const tx=latest.transaction('state','readwrite');const store=tx.objectStore('state');const req=store.get('library');let changed=false;
    req.onsuccess=()=>{if(JSON.stringify(req.result?.prompts)!==signature){changed=true;tx.abort();return;}store.put({...req.result,prompts:[]},'library');};
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(new Error('無法清除已遷移資料，下次將安全重試'));
    tx.onabort=()=>reject(new Error(changed?'本機資料在遷移時有變動，已保留，請重試':'本機資料已保留，請重試'));
   });}finally{latest.close();}
  }};
 }finally{db.close();}
}
export async function collectLegacy():Promise<{snapshots:LegacySnapshot[];errors:string[]}>{
 const snapshots:LegacySnapshot[]=[],errors:string[]=[];
 try{for(const key of Object.keys(localStorage).filter(legacyKey)){
  try{const raw=localStorage.getItem(key);if(raw===null)continue;const items=legacyItems(JSON.parse(raw));if(!items.length)continue;
   snapshots.push({label:key,items,clear:async()=>{if(localStorage.getItem(key)!==raw)throw new Error('本機資料在遷移時有變動，請重試');localStorage.removeItem(key);}});
  }catch(e){errors.push(`${key}：${(e as Error).message}`);}
 }}catch{errors.push('無法讀取 localStorage，本機資料未清除');}
 try{const snapshot=await readIndexedDBSnapshot();if(snapshot)snapshots.push(snapshot);}catch(e){errors.push((e as Error).message);}
 return {snapshots,errors};
}
// Keep original raw values in backups even when they cannot be parsed for migration.
export async function legacyBackup(){
 const raw:Record<string,unknown>={};
 for(const key of Object.keys(localStorage).filter(legacyKey))raw[key]=localStorage.getItem(key);
 const snapshot=await readIndexedDBSnapshot();if(snapshot)raw.indexedDB=snapshot.items;
 return raw;
}
