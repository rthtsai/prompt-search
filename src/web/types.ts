import type { Category, Variable } from '../domain.ts';
export type CardPrompt = { id:string; title:string; body:string; summary:string; category:Category; tags:string[]; variables:Variable[]; model_hint:string[]; use_count:number; last_used:string|null; source:string; fork_of:string|null; updated_at:string; highlight?:{text:string;ranges:[number,number][]} };
export type Library = { items:CardPrompt[]; total:number; uses:number; categories:{name:Category;count:number}[]; tags:string[]; mode:'local'|'cloud'; degraded:boolean; warning?:string };
export type ImportJob = {id:string;status:'processing'|'review'|'accepted'|'error';done:number;total:number;items:CardPrompt[];duplicates:number;skipped:number;errors:{index:number;message:string}[];message?:string};
export function fillTemplate(body:string,variables:Variable[],values:Record<string,string>): string {
  const value=(name:string)=>Object.hasOwn(values,name)&&typeof values[name]==='string'?values[name]:'';
  for (const v of variables) if(v.required && !value(v.name).trim()) throw new Error(`請填寫「${v.label}」`);
  return body.replace(/\{\{([^{}]+)\}\}/g,(_,name)=>value(name));
}
