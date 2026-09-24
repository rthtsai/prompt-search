import type {ClassSession} from './class-store.ts';

// Supabase Auth 的 Google 登入，用原生 fetch 實作（專案其他地方也沒有用 supabase-js）。
// 只保存 refresh token；access token 留在記憶體裡，過期前自動換新，
// 這樣一堂課中間不會突然被登出。

type Tokens={access:string;refresh:string;expiresAt:number};
const STORE='class-lab:refresh';
// access token 快過期時就先換掉，不要等到真的過期才在學生按下儲存時失敗
const MARGIN_MS=90_000;

const readStore=():string|null=>{try{return localStorage.getItem(STORE);}catch{return null;}};
const writeStore=(v:string|null)=>{try{v?localStorage.setItem(STORE,v):localStorage.removeItem(STORE);}catch{}};

/** 登入轉回來時，token 掛在網址的 # 後面；讀完要立刻把它從網址清掉。 */
export function readRedirect(hash:string):Tokens|null{
  const params=new URLSearchParams(hash.replace(/^#/,''));
  const access=params.get('access_token'),refresh=params.get('refresh_token');
  if(!access||!refresh)return null;
  const seconds=Number(params.get('expires_in')??3600);
  return {access,refresh,expiresAt:Date.now()+(Number.isFinite(seconds)?seconds:3600)*1000};
}

export function needsRefresh(tokens:Tokens|null,now=Date.now()):boolean{
  return !tokens||tokens.expiresAt-now<=MARGIN_MS;
}

export type SessionOptions={url:string;key:string;redirectTo:string;
  transport?:typeof fetch;now?:()=>number;
  location?:{hash:string;href:string;assign(url:string):void;replace(url:string):void}};

export function createClassSession(options:SessionOptions):ClassSession{
  const send=(options.transport??fetch).bind(globalThis);
  const now=options.now??(()=>Date.now());
  const place=options.location??(typeof window!=='undefined'?window.location:undefined);
  const listeners=new Set<()=>void>();
  let tokens:Tokens|null=null;
  let refreshing:Promise<Tokens|null>|null=null;

  const announce=()=>{for(const l of listeners)l();};

  // 從登入轉址回來：收下 token，並把網址上的敏感片段清掉
  if(place?.hash){
    const fromUrl=readRedirect(place.hash);
    if(fromUrl){
      tokens=fromUrl;writeStore(fromUrl.refresh);
      try{place.replace(place.href.split('#')[0]);}catch{}
    }
  }

  async function refresh():Promise<Tokens|null>{
    const stored=tokens?.refresh??readStore();
    if(!stored)return null;
    // 同時有好幾個請求時只換一次，不然會用掉彼此的 refresh token
    refreshing??=(async()=>{
      try{
        const response=await send(`${options.url}/auth/v1/token?grant_type=refresh_token`,{
          method:'POST',headers:{apikey:options.key,'Content-Type':'application/json'},
          body:JSON.stringify({refresh_token:stored})});
        if(!response.ok){tokens=null;writeStore(null);announce();return null;}
        const body=await response.json() as {access_token:string;refresh_token:string;expires_in?:number};
        tokens={access:body.access_token,refresh:body.refresh_token,
          expiresAt:now()+(body.expires_in??3600)*1000};
        writeStore(tokens.refresh);announce();
        return tokens;
      }catch{ return null; }   // 網路斷掉不要把人登出，下次呼叫再試
      finally{ refreshing=null; }
    })();
    return refreshing;
  }

  return {
    async token(){
      if(!needsRefresh(tokens,now()))return tokens!.access;
      return (await refresh())?.access??null;
    },
    async signIn(){
      const target=`${options.url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(options.redirectTo)}`;
      place?.assign(target);
    },
    async signOut(){
      const access=tokens?.access;
      tokens=null;writeStore(null);announce();
      if(access)await send(`${options.url}/auth/v1/logout`,{method:'POST',
        headers:{apikey:options.key,Authorization:`Bearer ${access}`}}).catch(()=>{});
    },
    onChange(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
  };
}
