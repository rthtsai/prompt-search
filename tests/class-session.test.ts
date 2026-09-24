import test from 'node:test';
import assert from 'node:assert/strict';
import {createClassSession,readRedirect,needsRefresh} from '../src/web/class-session.ts';

// node 沒有 localStorage，補一個最小的替身
const store=new Map<string,string>();
(globalThis as any).localStorage={getItem:(k:string)=>store.get(k)??null,
  setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}};

const place=(hash='')=>({hash,href:'https://rthtsai.github.io/ai-class-lab/'+hash,
  assigned:'' as string,replaced:'' as string,
  assign(u:string){this.assigned=u;},replace(u:string){this.replaced=u;}});

const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});

test('從轉址網址收下 token，並把 # 片段從網址清掉', () => {
  const parsed=readRedirect('#access_token=aaa&refresh_token=rrr&expires_in=3600');
  assert.equal(parsed?.access,'aaa');
  assert.equal(parsed?.refresh,'rrr');
  assert.equal(readRedirect('#error=access_denied'),null);

  store.clear();
  const where=place('#access_token=aaa&refresh_token=rrr&expires_in=3600');
  createClassSession({url:'https://x.supabase.co',key:'anon',redirectTo:'https://site/',location:where,
    transport:(async()=>reply({})) as unknown as typeof fetch});
  assert.equal(where.replaced,'https://rthtsai.github.io/ai-class-lab/','網址上不該留著 token');
  assert.equal(store.get('class-lab:refresh'),'rrr');
});

test('access token 快過期就先換掉，不等到真的過期才失敗', () => {
  const soon=Date.now()+30_000;
  assert.equal(needsRefresh({access:'a',refresh:'r',expiresAt:soon}),true);
  assert.equal(needsRefresh({access:'a',refresh:'r',expiresAt:Date.now()+600_000}),false);
  assert.equal(needsRefresh(null),true);
});

test('同時多個請求只換一次 token，不會互相用掉 refresh token', async () => {
  store.clear();store.set('class-lab:refresh','r0');
  let calls=0;
  const transport=(async()=>{calls++;
    return reply({access_token:'a1',refresh_token:'r1',expires_in:3600});}) as unknown as typeof fetch;
  const session=createClassSession({url:'https://x.supabase.co',key:'anon',
    redirectTo:'https://site/',location:place(),transport});
  const [a,b,c]=await Promise.all([session.token(),session.token(),session.token()]);
  assert.deepEqual([a,b,c],['a1','a1','a1']);
  assert.equal(calls,1,'應該只呼叫一次更新');
  assert.equal(store.get('class-lab:refresh'),'r1','要存下新的 refresh token');
});

test('refresh token 失效就登出；但網路斷掉不會把人登出', async () => {
  store.clear();store.set('class-lab:refresh','bad');
  const rejected=createClassSession({url:'https://x.supabase.co',key:'anon',redirectTo:'https://site/',
    location:place(),transport:(async()=>reply({error:'invalid'},400)) as unknown as typeof fetch});
  assert.equal(await rejected.token(),null);
  assert.equal(store.get('class-lab:refresh'),undefined,'失效的 token 要清掉');

  store.clear();store.set('class-lab:refresh','r0');
  const offline=createClassSession({url:'https://x.supabase.co',key:'anon',redirectTo:'https://site/',
    location:place(),transport:(async()=>{throw new Error('network');}) as unknown as typeof fetch});
  assert.equal(await offline.token(),null);
  assert.equal(store.get('class-lab:refresh'),'r0','斷線時要保留，回來還能用');
});

test('登入導向 Google，登出清掉本機的 token', async () => {
  store.clear();store.set('class-lab:refresh','r0');
  const where=place();
  const session=createClassSession({url:'https://x.supabase.co',key:'anon',
    redirectTo:'https://rthtsai.github.io/ai-class-lab/',location:where,
    transport:(async()=>reply({access_token:'a1',refresh_token:'r1',expires_in:3600})) as unknown as typeof fetch});
  await session.signIn();
  assert.match(where.assigned,/provider=google/);
  assert.match(where.assigned,/redirect_to=https%3A%2F%2Frthtsai\.github\.io%2Fai-class-lab%2F/);

  await session.token();
  await session.signOut();
  assert.equal(store.get('class-lab:refresh'),undefined);
  assert.equal(await session.token(),null);
});
