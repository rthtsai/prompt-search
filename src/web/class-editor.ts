import type {Variable} from '../domain.ts';
import {describe} from './describe.ts';
import {asDataUrl} from './class-store.ts';
import type {ClassCard,ClassRpc,ClassTask} from './class-store.ts';
// 班級版編輯器的規則層。畫面只負責顯示，什麼算有效、送出去長什麼樣，都在這裡，
// 而且不碰 DOM，所以可以直接測。圖片壓縮也在這裡，只是把「畫布」抽成 Raster 介面。

/** 三種存法：全新、改同一版、開新版本。開新版本一定要寫改了什麼。 */
export type SaveMode='new'|'edit'|'version';

export type Draft={
  id:string|null;        // edit / version 的基準 prompt
  version:string|null;   // 基準的 updated_at，給樂觀鎖用
  title:string;
  body:string;
  summary:string;
  taskId:string|null;
  variables:Variable[];
  versionNote:string;
};

export const LIMITS={title:160,body:24000,summary:2000,note:200,
  /** 伺服器量的是 base64 字串本身的長度，不是解碼後的大小。 */
  fullBase64:400*1024,thumbBase64:40*1024,
  fullEdge:1280,thumbEdge:320,outputsPerVersion:5} as const;

export function emptyDraft(taskId:string|null=null):Draft{
  return {id:null,version:null,title:'',body:'',summary:'',taskId,variables:[],versionNote:''};
}

/** 從既有卡片開一份草稿。改版時故意不帶上一版的說明，逼作者重寫。 */
export function draftFrom(card:ClassCard,mode:Exclude<SaveMode,'new'>):Draft{
  return {id:card.id,version:card.updated_at,title:card.title,body:card.body,
    summary:card.summary??'',taskId:card.task_id,variables:card.variables??[],
    versionNote:mode==='edit'?card.version_note??'':''};
}

/** 本文裡出現過的 {{變數}}，依出現順序、去重。 */
export function placeholdersIn(body:string):string[]{
  const seen:string[]=[];
  for(const match of body.matchAll(/\{\{([^{}]+)\}\}/g)){
    const name=match[1];
    if(!seen.includes(name))seen.push(name);
  }
  return seen;
}

/**
 * 伺服器要求變數清單和本文裡的 {{}} 完全一致，多一個少一個都會被擋下來。
 * 所以每次改本文都重算一次，但保留原本填過的說明和範例。
 */
export function reconcileVariables(body:string,existing:Variable[]):Variable[]{
  return placeholdersIn(body).map(name=>
    existing.find(v=>v.name===name)??{name,label:name,example:'',required:true});
}

/** 送出前最後一關；回傳第一個問題，沒問題就是 null。 */
export function draftProblem(draft:Draft,mode:SaveMode):string|null{
  const title=draft.title.trim(), body=draft.body;
  if(!title)return '請幫這個 Prompt 取個標題';
  if([...title].length>LIMITS.title)return `標題請控制在 ${LIMITS.title} 字以內`;
  if(!body.trim())return '本文還是空的';
  if(body.length>LIMITS.body)return `本文太長了（上限 ${LIMITS.body} 字）`;
  if(draft.summary.length>LIMITS.summary)return '說明太長了';
  if(/\{\{\s*\}\}/.test(body))return '有一組 {{ }} 裡面沒寫變數名稱';
  const names=draft.variables.map(v=>v.name);
  if(new Set(names).size!==names.length)return '變數名稱重複了';
  const wanted=placeholdersIn(body);
  if(names.length!==wanted.length||wanted.some(n=>!names.includes(n)))
    return '變數和本文對不起來，請重新整理後再試';
  if(mode==='version'&&!draft.versionNote.trim())return '請寫下這一版改了什麼、為什麼';
  if([...draft.versionNote].length>LIMITS.note)return `版本說明請控制在 ${LIMITS.note} 字以內`;
  if((mode==='edit'||mode==='version')&&!draft.id)return '找不到要修改的 Prompt，請重新整理';
  return null;
}

/** 說明留白就用規則式產生一句，和原版同一套，不呼叫任何 AI。 */
export function summaryOf(draft:Draft):string{
  const written=draft.summary.trim();
  if(written)return written.slice(0,LIMITS.summary);
  return describe(draft.body,{title:draft.title,variables:draft.variables}).slice(0,LIMITS.summary);
}

export function saveRequest(draft:Draft,classId:string,mode:SaveMode):Record<string,unknown>{
  const item:Record<string,unknown>={title:draft.title.trim(),body:draft.body,
    summary:summaryOf(draft),variables:draft.variables,
    task_id:draft.taskId,version_note:draft.versionNote.trim()};
  if(mode==='new')return {op:'save',class_id:classId,item};
  if(mode==='edit')return {op:'edit',class_id:classId,id:draft.id,version:draft.version,item};
  return {op:'version',class_id:classId,id:draft.id,item};
}

export async function saveDraft(rpc:ClassRpc,draft:Draft,classId:string,mode:SaveMode):Promise<ClassCard>{
  const problem=draftProblem(draft,mode);
  if(problem)throw new Error(problem);
  return await rpc(saveRequest(draft,classId,mode)) as ClassCard;
}

/** 任務下拉：已截止的任務不該再被選來交新東西，除非本來就交在那裡。 */
export function selectableTasks(tasks:ClassTask[],current:string|null):ClassTask[]{
  return tasks.filter(t=>!t.closed||t.id===current);
}

// ------------------------------------------------------------------ 圖片

/** 把瀏覽器那一端抽掉，測試就能塞一張假的圖進來。 */
export type Raster={width:number;height:number;
  toJpeg(width:number,height:number,quality:number):Promise<string>};

export const QUALITIES=[0.8,0.7,0.6,0.5,0.4] as const;

/** 等比例縮到最長邊不超過 max；本來就比較小就不放大。 */
export function fitWithin(width:number,height:number,max:number):{width:number;height:number}{
  const longest=Math.max(width,height);
  if(longest<=max||longest===0)return {width:Math.max(1,Math.round(width)),height:Math.max(1,Math.round(height))};
  const ratio=max/longest;
  return {width:Math.max(1,Math.round(width*ratio)),height:Math.max(1,Math.round(height*ratio))};
}

/** data:image/jpeg;base64,xxx → xxx。資料庫存的是沒有前綴的 base64。 */
export function stripDataUrl(value:string):string{
  const comma=value.indexOf(',');
  return value.startsWith('data:')&&comma>=0?value.slice(comma+1):value;
}
export {asDataUrl};
/** JPEG 的 base64 一定是 /9j/ 開頭，伺服器也是這樣擋的。 */
export function looksLikeJpeg(base64:string):boolean{return base64.startsWith('/9j/');}

/**
 * 壓到預算內：先降畫質，都不夠就把邊長減半再來一輪。
 * 學生用 iPad 拍的照片動輒 4000px，不先縮會整包送不出去。
 */
export async function shrinkImage(raster:Raster,plan:{edge:number;budget:number}):Promise<string>{
  let edge=plan.edge;
  for(let round=0;round<3;round++){
    const size=fitWithin(raster.width,raster.height,edge);
    for(const quality of QUALITIES){
      const base64=stripDataUrl(await raster.toJpeg(size.width,size.height,quality));
      if(base64.length<=plan.budget)return base64;
    }
    edge=Math.max(80,Math.round(edge/2));
  }
  throw new Error('這張圖片壓不下來，請換一張或先裁切過');
}

/** 一次做好大圖和縮圖；兩個預算不同，所以分開壓。 */
export async function prepareOutputImage(raster:Raster):Promise<{image_full:string;image_thumb:string}>{
  const image_full=await shrinkImage(raster,{edge:LIMITS.fullEdge,budget:LIMITS.fullBase64});
  const image_thumb=await shrinkImage(raster,{edge:LIMITS.thumbEdge,budget:LIMITS.thumbBase64});
  if(!looksLikeJpeg(image_full)||!looksLikeJpeg(image_thumb))
    throw new Error('圖片必須是 JPEG，請另存成 JPG 後再上傳');
  return {image_full,image_thumb};
}

export function addTextOutput(rpc:ClassRpc,classId:string,promptId:string,text:string){
  const clean=text.trim();
  if(!clean)throw new Error('還沒貼上任何結果');
  if(clean.length>20000)throw new Error('結果太長了，請只貼關鍵的部分');
  return rpc({op:'output_add',class_id:classId,prompt_id:promptId,kind:'text',text_body:clean});
}
export function addImageOutput(rpc:ClassRpc,classId:string,promptId:string,
    image:{image_full:string;image_thumb:string}){
  return rpc({op:'output_add',class_id:classId,prompt_id:promptId,kind:'image',...image});
}
export function removeOutput(rpc:ClassRpc,classId:string,id:string){
  return rpc({op:'output_delete',class_id:classId,id});
}
