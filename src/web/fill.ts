import type {Variable} from '../domain.ts';
// 「還有幾格要填」這件事的規則。畫面只負責顯示，什麼叫做沒填、按鈕該寫什麼，
// 都在這裡，因為這正是她卡住的地方——按鈕看起來能按，按下去卻什麼都沒發生。

export type FillState={
  active:Variable[];      // 本文裡真的用到的變數
  missing:Variable[];     // 必填但空著
  blank:Variable[];       // 非必填但空著（會變成空白段落）
  filled:number;
  total:number;
};

const empty=(values:Record<string,string>,name:string)=>!(values[name]??'').trim();

export function fillState(variables:Variable[],body:string,values:Record<string,string>):FillState{
  const used=new Set([...body.matchAll(/\{\{([^{}]+)\}\}/g)].map(m=>m[1]));
  const active=variables.filter(v=>used.has(v.name));
  return {active,
    missing:active.filter(v=>v.required&&empty(values,v.name)),
    blank:active.filter(v=>!v.required&&empty(values,v.name)),
    filled:active.filter(v=>!empty(values,v.name)).length,
    total:active.length};
}

/** 按鈕永遠說實話：還沒填完就不要寫「複製」。 */
export function copyLabel(state:FillState,suffix='完整 Prompt'):string{
  return state.missing.length?`還有 ${state.missing.length} 格要填`:`複製${suffix}`;
}
export function progressLabel(state:FillState):string{
  return `已填 ${state.filled} / ${state.total}`;
}
/** 非必填留空時，複製前要講清楚哪幾段會是空的，而不是安靜地送出一個有洞的 prompt。 */
export function blankWarning(state:FillState):string{
  const names=state.blank.map(v=>`〈${v.label||v.name}〉`).join('、');
  return `${names} 沒有填，複製出來的內容這幾段會是空白。`;
}

/** 預覽區要把「還沒填」的地方標出來，所以切成一段一段而不是整塊字串。 */
export type Segment={text:string;pending:boolean};
export function previewSegments(body:string,values:Record<string,string>):Segment[]{
  const out:Segment[]=[];
  let last=0;
  for(const match of body.matchAll(/\{\{([^{}]+)\}\}/g)){
    const at=match.index??0;
    if(at>last)out.push({text:body.slice(last,at),pending:false});
    const value=(values[match[1]]??'').trim();
    out.push(value?{text:values[match[1]],pending:false}:{text:match[0],pending:true});
    last=at+match[0].length;
  }
  if(last<body.length)out.push({text:body.slice(last),pending:false});
  return out.length?out:[{text:body,pending:false}];
}
export const previewText=(body:string,values:Record<string,string>)=>
  previewSegments(body,values).map(s=>s.text).join('');

/**
 * 匯入時不要把每個變數都設成必填——她的備課模板裡「要不要工作紙」本來就是可選的。
 * 只有出現在開頭第一段（通常是任務本身），或名字一看就是核心輸入的，才設必填。
 */
const CORE=/(主題|題目|內容|文章|城市|地點|對象|目標|產品|公司|名稱|問題|需求|原文|文字)/;
export function guessRequired(name:string,body:string):boolean{
  if(CORE.test(name))return true;
  const first=(body??'').split(/\n\s*\n/)[0]??'';
  return first.includes(`{{${name}}}`);
}
