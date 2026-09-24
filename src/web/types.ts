import type { Variable } from '../domain.ts';
export type CardPrompt = { id:string; title:string; body:string; summary:string; summary_auto?:boolean; category:string; tags:string[]; variables:Variable[]; model_hint:string[]; use_count:number; last_used:string|null; source:string; fork_of:string|null; updated_at:string; body_en?:string|null; created_at?:string; group_id?:string; version_no?:number; version_note?:string; examples?:{id?:string;kind?:'image'|'video'|'file'|'text';path?:string;name?:string;mime?:string;size?:number;text?:string;caption:string;added_at?:string}[]; versions?:CardPrompt[]; highlight?:{text:string;ranges:[number,number][]} };
export type Library = { items:CardPrompt[]; total:number; uses:number; categories:{name:string;count:number;fixed?:boolean}[]; tags:string[]; mode:'local'|'cloud'; degraded:boolean; warning?:string; manage?:boolean; storage?:string; stamp?:string; synced_at?:string };
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
    if(!d) return {name,label:name,example:'',required:true};
    const type=d.type&&['text','select','radio','number'].includes(d.type)?d.type:undefined;
    const options=(d.options??[]).map(o=>String(o).trim()).filter(Boolean).slice(0,30);
    const out:Variable={name,label:(d.label||name).trim()||name,example:d.example??'',required:!!d.required};
    if(type&&type!=='text') out.type=type;
    if((type==='select'||type==='radio')){ if(!options.length) throw new Error(`「${out.label}」是選單，請至少填一個選項`); out.options=[...new Set(options)]; }
    return out;
  });
}
