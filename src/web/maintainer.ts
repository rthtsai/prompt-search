// 維護者模式。這不是身分驗證，只是一道「路人做不到、手也滑不到」的閘門：
// 真正的防線在資料庫（migration 008），前端這一層只決定按鈕要不要出現。
// token 從網址 ?maintainer=… 帶進來，收進 sessionStorage 後立刻從網址抹掉，
// 免得留在歷史紀錄或被截圖帶走。
const KEY='prompt-dictionary:maintainer';

/** 純函式：從網址取出 token，並回傳把它拿掉之後的網址。 */
export function readFromUrl(href:string):{token:string|null;cleaned:string}{
  let url:URL;
  try{ url=new URL(href); }catch{ return {token:null,cleaned:href}; }
  const token=url.searchParams.get('maintainer');
  if(!token)return {token:null,cleaned:href};
  url.searchParams.delete('maintainer');
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

/** 開頁時跑一次：收下網址上的 token，再把網址換成乾淨的。 */
export function adoptMaintainer(place:{href:string;replace(url:string):void}=typeof window!=='undefined'?window.location:{href:'',replace(){}}){
  const {token,cleaned}=readFromUrl(place.href);
  if(!token)return maintainerToken();
  rememberMaintainer(token);
  try{ place.replace(cleaned); }catch{}
  return token;
}
