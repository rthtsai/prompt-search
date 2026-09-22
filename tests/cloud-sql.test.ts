import {PGlite} from '@electric-sql/pglite';
import test from 'node:test';
import {CloudStore} from '../src/web/cloud-store.ts';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
test('共用資料庫實際 SQL：權限、原子去重、修改衝突與刪除',async()=>{
const db=new PGlite({extensions:{pgcrypto,pg_trgm}});
const root=new URL('../',import.meta.url);
let base=await readFile(new URL('supabase/001_fresh_project.sql',root),'utf8');
// PGlite does not bundle vector; storage type/index only are substituted here.
base=base.replace('CREATE EXTENSION IF NOT EXISTS vector;','').replace('embedding vector(1536)','embedding double precision[]').replace(/^CREATE INDEX prompt_embedding_hnsw.*$/m,'');
await db.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
await db.exec(base);
await db.exec(await readFile(new URL('supabase/migrations/002_shared_library.sql',root),'utf8'));
await db.exec('SET ROLE anon');
const rpc=async(request:any):Promise<any>=>(await db.query<any>('select public.prompt_library($1::jsonb) as result',[JSON.stringify(request)])).rows[0].result;
const item={title:'雲端測試',body:'請將 {{文章}} 濃縮成三個重點，並且保留所有重要的數字與結論。',summary:'跨裝置測試',category:'翻譯與潤稿',variables:[{name:'文章',label:'文章',example:'',required:true}],tags:['test'],model_hint:[],source:'test'};
assert.deepEqual(await rpc({op:'list'}),[]);
let [first]=await rpc({op:'import',items:[item]});assert.ok(first.id);assert.equal(first.body,item.body);
assert.equal((await rpc({op:'list'}))[0].id,first.id);
assert.equal((await rpc({op:'import',items:[{...item,body:item.body+'\n\n'}]}))[0].id,first.id);
const edited=await rpc({op:'edit',id:first.id,version:first.updated_at,item:{...item,title:'手機更新'}});assert.equal(edited.title,'手機更新');
await assert.rejects(rpc({op:'edit',id:first.id,version:first.updated_at,item}),/已被修改/);
const event='00000000-0000-4000-8000-000000000002';await rpc({op:'use',id:first.id,event});assert.equal((await rpc({op:'use',id:first.id,event})).use_count,1);
await assert.rejects(db.query('select * from public.prompt'),/permission denied/);
await assert.rejects(db.query('select public.shared_prompt_save($1::jsonb)',[JSON.stringify(item)]),/permission denied/);
await assert.rejects(rpc({op:'import',items:[{...item,body:'另一個有效的 Prompt，請為本次工作整理三個具體的後续行動與重點。',variables:[]},{...item,title:null}]}));
assert.equal((await rpc({op:'list'})).length,1); // entire failed batch rolled back
assert.equal((await rpc({op:'delete',id:first.id,version:edited.updated_at})).deleted,true);
assert.equal((await rpc({op:'list'})).length,0);
await assert.rejects(rpc({op:'import',items:[item]}),/已刪除/);

// Two independent client instances use the same PostgreSQL data, never a shared JS cache.
const transport:typeof fetch=async(_url,options)=>{
 try{return new Response(JSON.stringify(await rpc(JSON.parse(String(options?.body)).request)));}
 catch(e){return new Response(JSON.stringify({message:(e as Error).message}),{status:400});}
};
const config={url:'https://test-project.supabase.co',key:'sb_publishable_test'};
const mobile=new CloudStore(config,transport);
const job=await mobile.api<any>('/api/imports',{method:'POST',body:JSON.stringify({text:item.body+' 新的一筆跨裝置測試。',source:'test'})});
await mobile.api('/api/imports/'+job.id,{method:'POST'});
const reloadedMobile=new CloudStore(config,transport),desktop=new CloudStore(config,transport);
const mobileList=await reloadedMobile.api<any>('/api/library');const desktopList=await desktop.api<any>('/api/library');
assert.equal(mobileList.total,1);assert.equal(desktopList.items[0].id,mobileList.items[0].id);
const current=desktopList.items[0];
await desktop.api('/api/prompts/'+current.id,{method:'POST',body:JSON.stringify({action:'edit',...current,title:'桌機修改',version:current.updated_at})});
const refreshed=await reloadedMobile.api<any>('/api/library');assert.equal(refreshed.items[0].title,'桌機修改');
await desktop.api('/api/prompts/'+current.id,{method:'DELETE',body:JSON.stringify({version:refreshed.items[0].updated_at})});
assert.equal((await reloadedMobile.api<any>('/api/library')).total,0);
await db.close();

});
