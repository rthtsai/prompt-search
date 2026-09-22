import test from 'node:test';
import assert from 'node:assert/strict';
import {createRpc,migrateSnapshots,uploadBatches,readAll,CloudStore} from '../src/web/cloud-store.ts';
import {legacyCard,legacyItems,CLOUD_CACHE_KEY} from '../src/web/legacy-storage.ts';
import {organizeBrowser} from '../src/web/browser-store.ts';
const sample=(n=0)=>organizeBrowser(`請為第 ${n} 個測試主題，撰寫完整文章並輸出三個重點與下一步行動。`,'test');
const config={url:'https://test-project.supabase.co',key:'sb_publishable_test'};
test('遷移成功後才清除，重複上傳取得同筆資料',async()=>{
 const source=sample();let cleared=0;const saved=new Map<string,any>();
 const rpc=async(r:any)=>r.items.map((p:any)=>{if(!saved.has(p.body))saved.set(p.body,p);return saved.get(p.body);});
 const snapshot={label:'舊資料',items:[source],clear:async()=>{assert.equal(saved.size,1);cleared++;}};
 const a=await migrateSnapshots([snapshot],rpc);const b=await migrateSnapshots([snapshot],rpc);
 assert.equal(a.errors.length+b.errors.length,0);assert.equal(cleared,2);assert.equal(saved.size,1);
});
test('第二批失敗保留整份本機資料，重試安全完成',async()=>{
 let cleared=false,fail=true;const saved=new Map<string,any>();const items=Array.from({length:26},(_,i)=>sample(i));
 const rpc=async(r:any)=>{if(fail&&r.items[0].body===items[25].body)throw Error('斷線');return r.items.map((p:any)=>{if(!saved.has(p.body))saved.set(p.body,p);return saved.get(p.body);});};
 const snapshot={label:'localStorage',items,clear:async()=>{cleared=true;}};
 const result=await migrateSnapshots([snapshot],rpc);assert.equal(cleared,false);assert.equal(result.errors.length,1);assert.equal(saved.size,25);
 fail=false;assert.equal((await migrateSnapshots([snapshot],rpc)).errors.length,0);assert.equal(cleared,true);assert.equal(saved.size,26);
});
test('格式錯誤、部分回覆及本機併發修改都不會清除原資料',async()=>{
 let cleared=false;
 const invalid=await migrateSnapshots([{label:'old',items:[{content:'太短'}],clear:async()=>{cleared=true;}}],async()=>[]);
 assert.equal(invalid.errors.length,1);assert.equal(cleared,false);
 const partial=await migrateSnapshots([{label:'old',items:[sample()],clear:async()=>{cleared=true;}}],async()=>[]);
 assert.equal(partial.errors.length,1);assert.equal(cleared,false);
 const changed=await migrateSnapshots([{label:'old',items:[sample()],clear:async()=>{throw Error('本機資料在遷移時有變動');}}],async(r:any)=>r.items);
 assert.match(changed.errors[0],/變動/);
});
test('分頁取得所有資料，超過一千筆不截斷',async()=>{
 const all=Array.from({length:1050},(_,i)=>({...sample(),id:String(i+1).padStart(6,'0')}));let calls=0;
 const fetched=await readAll(async(r:any)=>{calls++;return all.filter(p=>!r.cursor||p.id>r.cursor).slice(0,200);});
 assert.equal(fetched.length,1050);assert.equal(calls,6);
});
test('舊版 metadata 保留，未知格式不猜測',()=>{
 const original={...sample(),title:'原本的標題',summary:'原本的摘要',tags:['我的標籤']};
 assert.equal(legacyCard(original).title,original.title);assert.deepEqual(legacyCard(original).tags,original.tags);
 assert.deepEqual(legacyItems({prompts:[original]}),[original]);assert.throws(()=>legacyItems({other:[original]}));
});
test('RPC 只傳公開金鑰，錯誤不當作成功',async()=>{
 let sent:any;
 const rpc=createRpc(config,async(url,options)=>{sent={url,options};return new Response(JSON.stringify([]));});
 await rpc({op:'list'});assert.equal(sent.options.headers.apikey,config.key);assert.equal(sent.options.headers.Authorization,undefined);
 assert.equal(JSON.parse(sent.options.body).request.op,'list');
 assert.throws(()=>createRpc({...config,key:'sb_secret_bad'}));
 const service='eyJ.'+btoa(JSON.stringify({role:'service_role'}))+'.x';assert.throws(()=>createRpc({...config,key:service}));
 await assert.rejects(createRpc(config,async()=>new Response(JSON.stringify({message:'permission denied'}),{status:403}))({op:'list'}),/permission denied/);
 await assert.rejects(uploadBatches([sample()],async()=>[{...sample(),body:'不同內容'}]),/未確認/);
});
test('寫入失敗不當作離線新增成功，不寫入快取',async()=>{
 const storage=new Map<string,string>();const old=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)}});
 try{
  const store=new CloudStore(config,async()=>new Response(JSON.stringify({message:'雲端離線'}),{status:503}));
  const job=await store.api<any>('/api/imports',{method:'POST',body:JSON.stringify({text:sample().body,source:'test'})});
  await assert.rejects(store.api('/api/imports/'+job.id,{method:'POST'}),/離線/);
  assert.equal(storage.has(CLOUD_CACHE_KEY),false);assert.equal((await store.api<any>('/api/imports/'+job.id)).status,'review');
 }finally{if(old)Object.defineProperty(globalThis,'localStorage',old);else delete (globalThis as any).localStorage;}
});
