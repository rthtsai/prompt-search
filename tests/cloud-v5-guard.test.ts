import {PGlite} from '@electric-sql/pglite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';
import {readFile,readdir} from 'node:fs/promises';

const TOKEN='maintainer-token-for-tests-0001';
const AGENT='agent-token-for-tests-00000001';

async function fresh(){
  const db=new PGlite({extensions:{pgcrypto,pg_trgm}});const root=new URL('../',import.meta.url);
  let base=await readFile(new URL('supabase/001_fresh_project.sql',root),'utf8');
  base=base.replace('CREATE EXTENSION IF NOT EXISTS vector;','').replace('embedding vector(1536)','embedding double precision[]').replace(/^CREATE INDEX prompt_embedding_hnsw.*$/m,'');
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated;');await db.exec(base);
  // 儲存空間相關的檔案需要 Supabase 的 storage schema，這裡跳過
  const files=(await readdir(new URL('supabase/migrations/',root))).filter(f=>f.endsWith('.sql')&&!f.includes('storage')).sort();
  for(const f of files)await db.exec(await readFile(new URL('supabase/migrations/'+f,root),'utf8'));
  await db.query("insert into public.app_secret(name,hash) values('maintainer',encode(sha256(convert_to($1,'UTF8')),'hex'))",[TOKEN]);
  await db.query("insert into public.app_secret(name,hash) values('agent',encode(sha256(convert_to($1,'UTF8')),'hex'))",[AGENT]);
  await db.exec('SET ROLE anon');
  const as=async(ip:string)=>{await db.query("select set_config('request.headers',$1,false)",[JSON.stringify({'cf-connecting-ip':ip,'x-forwarded-for':ip+', 10.0.0.1','user-agent':'test-agent'})]);};
  const rpc=async(request:any):Promise<any>=>(await db.query<any>('select public.prompt_library($1::jsonb) as result',[JSON.stringify(request)])).rows[0].result;
  return {db,rpc,as};
}
const item=(body:string,title='測試')=>({title,body,summary:'摘要',category:'寫作',variables:[],tags:['t'],model_hint:[],source:'test'});

test('訪客只拿得到卡片表面，全文要一則一則拿',async()=>{
  const {rpc,as}=await fresh();await as('1.1.1.1');
  const long='請把下面這段文字改寫成適合國中生閱讀的版本，保留所有關鍵概念與數字，句子不要超過二十個字，並在最後列出三個重點。'.repeat(2);
  const [p]=await rpc({op:'import',items:[{...item(long),body_en:'Rewrite the passage below for middle-school readers, keep every key idea and number.'}]});
  assert.equal(p.body,long,'匯入回傳的是自己送出的內容，不裁切');

  const [card]=await rpc({op:'list'});
  assert.equal(card.partial,true);assert.equal(card.body,long.slice(0,80));
  assert.equal(card.body_en,undefined);assert.equal(card.has_en,true);
  assert.equal(card.title,'測試');assert.deepEqual(card.tags,['t']);

  const full=await rpc({op:'get',id:p.id});
  assert.equal(full.length,1);assert.equal(full[0].body,long);assert.ok(full[0].body_en);

  // 補範例說明之類會回卡片的操作，也不能拿來繞過
  const viaUse=await rpc({op:'use',id:p.id,event:crypto.randomUUID()});
  assert.equal(viaUse.partial,true);assert.equal(viaUse.body.length,80);

  // 維護者照舊拿全文
  const [m]=await rpc({op:'list',maintainer:TOKEN});
  assert.equal(m.partial,undefined);assert.equal(m.body,long);
});

test('get 會帶出整組版本；不存在或格式錯的 id 會被拒絕',async()=>{
  const {rpc,as}=await fresh();await as('2.2.2.2');
  const [a]=await rpc({op:'import',items:[item('第一版：請幫我把會議紀錄整理成三個決議與負責人，格式用表格呈現。')]});
  await rpc({op:'version',id:a.id,item:item('第二版：請把會議紀錄整理成決議、負責人、期限三欄的表格，並標出還沒有結論的議題。')});
  const group=await rpc({op:'get',id:a.id});
  assert.equal(group.length,2);assert.deepEqual(group.map((x:any)=>x.version_no),[1,2]);
  await assert.rejects(rpc({op:'get',id:'00000000-0000-4000-8000-00000000abcd'}),/找不到/);
  await assert.rejects(rpc({op:'get',id:"x' or 1=1"}),/找不到/);
});

test('搜尋在資料庫裡比對全文，只回分數與一小段文字',async()=>{
  const {rpc,as}=await fresh();await as('3.3.3.3');
  const [a]=await rpc({op:'import',items:[item('請把季度營運數據整理成給主管看的報告，包含營收、毛利與下一季的風險。','季報')]});
  await rpc({op:'import',items:[item('請幫我規劃五天的京都行程，每天安排一個主題與午餐地點。','旅行')]});
  const hits=await rpc({op:'search',terms:['毛利','風險']});
  assert.equal(hits.length,1);assert.equal(hits[0].group_id,a.id);
  assert.ok(hits[0].text.includes('毛利'));assert.ok(hits[0].text.length<=120);
  assert.deepEqual(await rpc({op:'search',terms:['不存在的詞']}),[]);
});

test('同一個來源拿太快會被擋，換一個來源不受影響，被擋的也有紀錄',async()=>{
  const {db,rpc,as}=await fresh();await as('4.4.4.4');
  const [p]=await rpc({op:'import',items:[item('請把這封客訴信改寫成有禮貌但立場清楚的回覆，先道歉再說明處理方式。')]});
  for(let i=0;i<40;i++)assert.ok(Array.isArray(await rpc({op:'get',id:p.id})));
  const blocked=await rpc({op:'get',id:p.id});
  assert.equal(blocked.rate_limited,true);assert.match(blocked.error,/太頻繁/);
  await as('5.5.5.5');assert.ok(Array.isArray(await rpc({op:'get',id:p.id})));
  // 維護者不受限
  await as('4.4.4.4');assert.ok(Array.isArray(await rpc({op:'get',id:p.id,maintainer:TOKEN})));

  const stats=await rpc({op:'access_stats',maintainer:TOKEN});
  const row=stats.ips.find((r:any)=>r.ip==='4.4.4.4');
  assert.equal(row.gets,40);assert.equal(row.limited,1);assert.equal(row.distinct_prompts,1);assert.equal(row.ua,'test-agent');
  assert.equal(stats.you,'4.4.4.4');
  // 訪客不能看統計，也碰不到紀錄表
  await assert.rejects(rpc({op:'access_stats'}),/保留給維護者/);
  await assert.rejects(db.query('select * from public.access_log'),/permission denied/);
});

test('封鎖某個 IP 之後它什麼都拿不到，解除後恢復',async()=>{
  const {rpc,as}=await fresh();await as('6.6.6.6');
  await rpc({op:'import',items:[item('請把這段英文翻成自然的繁體中文，專有名詞保留原文並加註。')]});
  await rpc({op:'ip_block',ip:'6.6.6.6',reason:'大量抓取',maintainer:TOKEN});
  for(const op of ['list','categories','stamp']){
    const r=await rpc({op});assert.equal(r.rate_limited,true,op);assert.match(r.error,/暫停/);
  }
  const stats=await rpc({op:'access_stats',maintainer:TOKEN});
  assert.equal(stats.blocked[0].ip,'6.6.6.6');assert.equal(stats.blocked[0].reason,'大量抓取');
  await rpc({op:'ip_unblock',ip:'6.6.6.6',maintainer:TOKEN});
  assert.ok(Array.isArray(await rpc({op:'list'})));
});

test('瀏覽器端：列表拿表面、點開拿全文、搜尋走資料庫、重新整理後不用再拿一次',async()=>{
  const {rpc,as}=await fresh();await as('7.7.7.7');
  let getCalls=0;
  const transport:typeof fetch=async(_url,options)=>{
    const request=JSON.parse(String(options?.body)).request;if(request.op==='get')getCalls++;
    try{return new Response(JSON.stringify(await rpc(request)));}
    catch(e){return new Response(JSON.stringify({message:(e as Error).message}),{status:400});}
  };
  const {CloudStore}=await import('../src/web/cloud-store.ts');
  const store=new CloudStore({url:'https://t.supabase.co',key:'sb_publishable_test'},transport);
  const body='請把季度營運數據整理成給主管看的報告，包含營收、毛利與下一季的風險。每一段先寫結論再寫原因，不要超過三句，語氣要中性，不要形容詞堆疊，也不要替數字找藉口。'+'最後一段請把每個數字標出來源與期間，查不到的寫查無。';
  const [a]=await rpc({op:'import',items:[{...item(body,'季報'),body_en:'Turn the quarterly figures into a report for my manager, with revenue, margin and next-quarter risks.'}]});
  await rpc({op:'import',items:[item('請幫我規劃五天的京都行程，每天安排一個主題與午餐地點，並附雨天備案。','旅行')]});

  const lib:any=await store.api('/api/library');
  const card=lib.items.find((p:any)=>p.id===a.id);
  assert.equal(card.partial,true);assert.equal(card.body,body.slice(0,80));assert.ok(!card.body.includes('來源與期間'),'搜尋詞要在表面之外');

  const full:any=await store.api('/api/prompt?id='+a.id);
  assert.equal(full.body,body);assert.ok(full.body_en);assert.equal(full.partial,undefined);

  // 重新載入列表：同一版已經拿過，直接補回全文
  const again:any=await store.api('/api/library');
  assert.equal(again.items.find((p:any)=>p.id===a.id).body,body);
  assert.equal(getCalls,1);

  // 搜尋的字只出現在全文後段（卡片表面看不到），仍然找得到
  const found:any=await store.api('/api/library?q='+encodeURIComponent('來源與期間'));
  assert.deepEqual(found.items.map((p:any)=>p.id),[a.id]);
  assert.ok(found.items[0].highlight.text.includes('來源'));

  // 被擋時變成看得懂的錯誤，而不是「資料格式不正確」
  for(let i=0;i<39;i++)await rpc({op:'get',id:a.id});
  await assert.rejects(store.api('/api/prompt?id='+a.id),/太頻繁/);
});

test('Agent 專用 token：不限流、拿得到全文，但不能刪、不能改、不能看監控',async()=>{
  const {rpc,as}=await fresh();await as('8.8.8.8');
  const body='請把這份產品需求整理成使用者故事，每一則都要有角色、目的與驗收條件，最後列出還沒釐清的問題。'.repeat(2);
  const [p]=await rpc({op:'import',items:[item(body)]});
  const [card]=await rpc({op:'list',agent:AGENT});
  assert.equal(card.partial,undefined);assert.equal(card.body,body);
  for(let i=0;i<60;i++)assert.ok(Array.isArray(await rpc({op:'get',id:p.id,agent:AGENT})),'不限流');
  const viaUse=await rpc({op:'use',id:p.id,event:crypto.randomUUID(),agent:AGENT});
  assert.equal(viaUse.body,body);
  for(const op of ['delete','delete_many','merge','edit','access_stats','ip_block','whoami'])
    await assert.rejects(rpc({op,id:p.id,ids:[p.id],ip:'1.1.1.1',agent:AGENT}),/保留給維護者/,op);
  // 錯的 token 就是一般訪客
  const [guest]=await rpc({op:'list',agent:'wrong-token-0000000000'});
  assert.equal(guest.partial,true);
  // 被封鎖的 IP，帶 Agent token 仍然可以用（token 本身就是身分）
  await rpc({op:'ip_block',ip:'8.8.8.8',maintainer:TOKEN});
  assert.ok(Array.isArray(await rpc({op:'list',agent:AGENT})));
  assert.equal((await rpc({op:'list'})).rate_limited,true);
});
