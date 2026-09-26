import type { Variable } from '../domain.ts';
import { guessRequired } from './fill.ts';
export type CardPrompt = { id:string; title:string; body:string; summary:string; summary_auto?:boolean; category:string; tags:string[]; variables:Variable[]; model_hint:string[]; use_count:number; last_used:string|null; source:string; fork_of:string|null; updated_at:string; body_en?:string|null; created_at?:string; group_id?:string; version_no?:number; version_note?:string; examples?:{id?:string;kind?:'image'|'video'|'file'|'text';role?:'input'|'output';path?:string;name?:string;mime?:string;size?:number;text?:string;caption:string;added_at?:string}[]; versions?:CardPrompt[]; highlight?:{text:string;ranges:[number,number][]} };
export type CategoryStat = {name:string;count:number;fixed?:boolean;uses?:number;recent?:number};
export type Library = { items:CardPrompt[]; total:number; uses:number; categories:CategoryStat[]; tags:string[]; mode:'local'|'cloud'; degraded:boolean; warning?:string; manage?:boolean; storage?:string; stamp?:string; synced_at?:string };
export type ImportJob = {id:string;status:'processing'|'review'|'accepted'|'error';done:number;total:number;items:CardPrompt[];duplicates:number;skipped:number;errors:{index:number;message:string}[];message?:string};
export function fillTemplate(body:string,variables:Variable[],values:Record<string,string>): string {
  const value=(name:string)=>Object.hasOwn(values,name)&&typeof values[name]==='string'?values[name]:'';
  const used=new Set([...body.matchAll(/\{\{([^{}]+)\}\}/g)].map(m=>m[1]));
  for (const v of variables) if(used.has(v.name) && v.required && !value(v.name).trim()) throw new Error(`請填寫「${v.label}」`);
  for (const v of variables) if(used.has(v.name) && v.type==='number' && value(v.name).trim() && !Number.isFinite(Number(value(v.name)))) throw new Error(`「${v.label}」請填數字`);
  return body.replace(/\{\{([^{}]+)\}\}/g,(_,name)=>value(name));
}
export const placeholders=(...bodies:(string|null|undefined)[])=>[...new Set(bodies.flatMap(b=>[...(b??'').matchAll(/\{\{([^{}]+)\}\}/g)].map(m=>m[1])))];
// Keeps the editor's variable settings (type/options/label) for names that still appear in either language.
export function mergeVariables(bodies:(string|null|undefined)[],defs:Variable[]=[],previous:Variable[]=[]):Variable[] {
  return placeholders(...bodies).map(name=>{
    const d=defs.find(v=>v.name===name)??previous.find(v=>v.name===name);
    // 沒設定過的變數：靠位置和名稱猜必填，而不是一律必填
    if(!d) return {name,label:name,example:'',required:guessRequired(name,bodies[0]??'')};
    const type=d.type&&['text','select','radio','number'].includes(d.type)?d.type:undefined;
    const options=(d.options??[]).map(o=>String(o).trim()).filter(Boolean).slice(0,30);
    const out:Variable={name,label:(d.label||name).trim()||name,example:d.example??'',required:!!d.required};
    if(type&&type!=='text') out.type=type;
    if((type==='select'||type==='radio')){ if(!options.length) throw new Error(`「${out.label}」是選單，請至少填一個選項`); out.options=[...new Set(options)]; }
    return out;
  });
}

export type ExampleItem=NonNullable<CardPrompt['examples']>[number];
const isImage=(e:ExampleItem)=>(e.kind??'image')==='image'&&!!e.path;

/**
 * 封面要挑「產出」，不是「第一張上傳的圖」——修圖類的 prompt 如果先傳原圖，
 * 卡片就會拿最平凡的那張當門面。沒有標角色的舊資料一律當產出。
 */
export function coverExample(prompt:{examples?:CardPrompt['examples']}):ExampleItem|null{
  const images=(prompt.examples??[]).filter(isImage);
  return images.find(e=>e.role!=='input')??images[0]??null;
}
/** 有原圖也有產出時，詳細頁要排成「前 → 後」；其餘的圖照原本的方式排。 */
export function beforeAfter(examples:CardPrompt['examples']):
    {before:ExampleItem|null;after:ExampleItem|null;rest:ExampleItem[]}{
  const images=(examples??[]).filter(isImage);
  const before=images.find(e=>e.role==='input')??null;
  const after=images.find(e=>e.role!=='input')??null;
  if(!before||!after)return {before:null,after:null,rest:images};
  return {before,after,rest:images.filter(e=>e!==before&&e!==after)};
}

/**
 * 分類的使用統計：count 幾則、uses 總共被複製幾次、recent 最近兩週內有被用過的有幾則。
 * prompts 要傳「一個版本群組一張卡」之後的清單，不然同一則的多個版本會重複計算。
 */
export function categoryStats(names:{name:string;fixed?:boolean}[],prompts:{category:string;use_count?:number;last_used?:string|null}[],now=Date.now()):CategoryStat[]{
  const cutoff=now-14*86400000;
  return names.map(c=>{
    const mine=prompts.filter(p=>p.category===c.name);
    return {...c,count:mine.length,uses:mine.reduce((n,p)=>n+(p.use_count||0),0),
      recent:mine.filter(p=>p.last_used&&Date.parse(p.last_used)>=cutoff).length};
  });
}

/**
 * 分類自動排序：常用的在前面。
 * 1. 分數＝總使用次數＋最近兩週有用過的則數×5（讓最近在用的能很快浮上來，而不是被老資料壓住）
 * 2. 同分時，Prompt 多的在前
 * 3. 再同分，照維護者手動排的順序
 * 「其他」永遠放最後；includeEmpty 為 false 時，沒有內容的分類不顯示。
 */
export function rankCategories(cats:CategoryStat[],{includeEmpty=false}:{includeEmpty?:boolean}={}):CategoryStat[]{
  const score=(c:CategoryStat)=>(c.uses??0)+(c.recent??0)*5;
  return cats.map((c,i)=>({c,i}))
    .filter(({c})=>includeEmpty||c.count>0)
    .sort((a,b)=>(a.c.name==='其他'?1:0)-(b.c.name==='其他'?1:0)||score(b.c)-score(a.c)||b.c.count-a.c.count||a.i-b.i)
    .map(({c})=>c);
}

/**
 * 範例的份量：2＝有圖或影片（卡片上會有封面），1＝只有檔案或文字，0＝沒有範例。
 * 看整個版本群組，範例掛在舊版本上也算。
 */
export function exampleTier(p:Pick<CardPrompt,'examples'|'versions'>):number{
  const all=(p.versions??[p]).flatMap(v=>v.examples??[]);
  if(all.some(e=>(e.kind??'image')==='image'||e.kind==='video'))return 2;
  return all.length?1:0;
}

/**
 * 沒有搜尋字時的預設排序：
 * 1. 大家自己寫的在前，站方的「精選範本」在後
 * 2. 同一組裡，有圖的先、有檔案或文字範例的次之、沒有範例的最後
 * 3. 再依更新時間，新的在前
 */
export function defaultOrder(a:CardPrompt,b:CardPrompt):number{
  const curated=(p:CardPrompt)=>p.tags.includes('精選範本')?1:0;
  return curated(a)-curated(b)||exampleTier(b)-exampleTier(a)||b.updated_at.localeCompare(a.updated_at);
}
