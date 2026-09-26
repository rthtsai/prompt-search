// 維護者模式。這不是身分驗證，只是一道「路人做不到、手也滑不到」的閘門：
// 真正的防線在資料庫（migration 008），前端這一層只決定按鈕要不要出現。
// token 從網址 ?maintainer=… 帶進來，收進 sessionStorage 後立刻從網址抹掉，
// 免得留在歷史紀錄或被截圖帶走。
const KEY='prompt-dictionary:maintainer';
// 自己的 AI Agent 用的 token：不限流、看得到全文，但不能刪改。網址 ?agent=… 帶進來，處理方式同上
const AGENT_KEY='prompt-dictionary:agent';

/** 純函式：從網址取出 token，並回傳把它拿掉之後的網址。 */
export function readFromUrl(href:string,name='maintainer'):{token:string|null;cleaned:string}{
  let url:URL;
  try{ url=new URL(href); }catch{ return {token:null,cleaned:href}; }
  const token=url.searchParams.get(name);
  if(!token)return {token:null,cleaned:href};
  url.searchParams.delete(name);
  const cleaned=url.pathname+(url.searchParams.toString()?'?'+url.searchParams:'')+url.hash;
  return {token:token.trim()||null,cleaned};
}

export function rememberMaintainer(token:string|null){
  try{ token?sessionStorage.setItem(KEY,token):sessionStorage.removeItem(KEY); }catch{}
}
export function maintainerToken():string|null{
  try{ return sessionStorage.getItem(KEY); }catch{ return null; }
}
export function isMaintainer():boolean{ return !!maintainerToken(); }
export function rememberAgent(token:string|null){
  try{ token?sessionStorage.setItem(AGENT_KEY,token):sessionStorage.removeItem(AGENT_KEY); }catch{}
}
export function agentToken():string|null{
  try{ return sessionStorage.getItem(AGENT_KEY); }catch{ return null; }
}

/** 開頁時跑一次：收下網址上的 token，再把網址換成乾淨的。 */
export function adoptMaintainer(place:{href:string;replace(url:string):void}=typeof window!=='undefined'?window.location:{href:'',replace(){}}){
  const m=readFromUrl(place.href,'maintainer');
  let base=place.href;if(m.token){try{base=new URL(m.cleaned,place.href).href;}catch{}}
  const a=readFromUrl(base,'agent');
  if(m.token)rememberMaintainer(m.token);
  if(a.token)rememberAgent(a.token);
  if(m.token||a.token){try{ place.replace(a.token?a.cleaned:m.cleaned); }catch{}}
  return maintainerToken();
}
