import {PGlite} from '@electric-sql/pglite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';
import {readFile} from 'node:fs/promises';
import {CloudStore,groupVersions} from '../src/web/cloud-store.ts';
import {fillTemplate,mergeVariables} from '../src/web/types.ts';

async function setup(){
 const db=new PGlite({extensions:{pgcrypto,pg_trgm}});const root=new URL('../',import.meta.url);
 let base=await readFile(new URL('supabase/001_fresh_project.sql',root),'utf8');
 base=base.replace('CREATE EXTENSION IF NOT EXISTS vector;','').replace('embedding vector(1536)','embedding double precision[]').replace(/^CREATE INDEX prompt_embedding_hnsw.*$/m,'');
 await db.exec('CREATE ROLE anon; CREATE ROLE authenticated;');await db.exec(base);
 // Existing v2 data must survive the v3 migration.
 await db.exec(await readFile(new URL('supabase/migrations/002_shared_library.sql',root),'utf8'));
 await db.exec('SET ROLE anon');
 const rpc=async(request:any):Promise<any>=>(await db.query<any>('select public.prompt_library($1::jsonb) as result',[JSON.stringify(request)])).rows[0].result;
 return {db,rpc,root};
}
const item=(title:string,body:string,extra:any={})=>({title,body,summary:'',category:'教學備課',variables:[],tags:[],model_hint:[],source:'test',...extra});

test('v3：舊資料升級、版本、英文版、選項變數、批次分類與分類管理',async()=>{
 const {db,rpc,root}=await setup();
 const [old]=await rpc({op:'import',items:[item('出題 V1','請依照教材內容出十題選擇題，並附上答案與詳解，題目要清楚。')]});
 await db.exec('RESET ROLE');await db.exec(await readFile(new URL('supabase/migrations/003_versions_languages_categories.sql',root),'utf8'));await db.exec('SET ROLE anon');
 let [first]=await rpc({op:'list'});assert.equal(first.id,old.id);assert.equal(first.group_id,old.id);assert.equal(first.version_no,1);assert.equal(first.body_en,null);
 // Categories come back ordered with 其他 last.
 let cats=await rpc({op:'categories'});assert.equal(cats[0].name,'寫作');assert.equal(cats.at(-1).name,'其他');assert.equal(cats.at(-1).fixed,true);
 // Typed variables and English body
 const vars=[{name:'程度',label:'學生程度',example:'',required:true,type:'select',options:['小學','中學','大學']},{name:'題數',label:'題數',example:'10',required:true,type:'number'},{name:'level',label:'level',example:'',required:true}];
 const v2=await rpc({op:'version',id:first.id,item:item('出題 V2','請依照教材內容，為{{程度}}學生出 {{題數}} 題選擇題，並附上答案與詳解。',{variables:vars,body_en:'Write {{題數}} multiple-choice questions for {{level}} students based on the material.',version_note:'加入程度'})});
 assert.equal(v2.version_no,2);assert.equal(v2.group_id,first.id);assert.match(v2.body_en,/multiple-choice/);assert.deepEqual(v2.variables[0].options,['小學','中學','大學']);
 await assert.rejects(rpc({op:'version',id:first.id,item:item('重複','請依照教材內容出十題選擇題，並附上答案與詳解，題目要清楚。')}),/相同/);
 await assert.rejects(rpc({op:'import',items:[item('x','請為{{程度}}學生出一份完整的測驗卷，並附答案。',{variables:[{name:'程度',label:'程度',example:'',required:true,type:'select',options:[]}]})]}),/至少要有一個選項/);
 await assert.rejects(rpc({op:'import',items:[item('x','請為{{程度}}學生出一份完整的測驗卷，並附答案。',{variables:[{name:'程度',label:'程度',example:'',required:true,type:'color'}]})]}),/變數格式/);
 await assert.rejects(rpc({op:'import',items:[item('x','請為學生出一份完整的測驗卷，並附答案與詳解。',{body_en:'Write {{n}} questions for the students, with answers.'})]}),/不一致/);
 // Merge separately imported versions
 const [a,b]=await rpc({op:'import',items:[item('畫圖 V1','請畫一張日系插畫風格的貓咪，背景是櫻花樹下的午後。',{category:'其他'}),item('畫圖 V2','請畫一張日系插畫風格的貓咪，背景是櫻花樹下的午後，柔和光線。',{category:'其他'})]});
 assert.equal((await rpc({op:'merge',ids:[a.id,b.id]})).merged,2);
 let list=groupVersions(await rpc({op:'list'}));assert.equal(list.length,2);
 const draw=list.find(p=>p.group_id===a.id)!;assert.equal(draw.id,b.id);assert.equal(draw.versions!.length,2);
 const quiz=list.find(p=>p.group_id===first.id)!;assert.equal(quiz.id,v2.id);
 // Bulk move out of 其他
 assert.equal((await rpc({op:'move',ids:[a.id,b.id],category:'圖像生成'})).moved,2);
 assert.ok((await rpc({op:'list'})).filter((p:any)=>p.group_id===a.id).every((p:any)=>p.category==='圖像生成'));
 // Category manager: rename, add, reorder, remove (prompts fall back to 其他)
 cats=await rpc({op:'categories_save',items:[{name:'Shortcut 1'},{name:'出題',from:'教學備課'},{name:'圖像生成'},{name:'其他'}]});
 assert.deepEqual(cats.map((c:any)=>c.name),['Shortcut 1','出題','圖像生成','其他']);
 list=groupVersions(await rpc({op:'list'}));assert.equal(list.find(p=>p.group_id===first.id)!.category,'出題');
 await assert.rejects(rpc({op:'categories_save',items:[{name:'A'},{name:'A'}]}),/重複/);
 cats=await rpc({op:'categories_save',items:[{name:'出題'},{name:'其他'}]});
 assert.equal(groupVersions(await rpc({op:'list'})).find(p=>p.group_id===a.id)!.category,'其他');
 // Deleting a whole group
 const stamp1=JSON.stringify(await rpc({op:'stamp'}));
 assert.equal((await rpc({op:'delete_many',ids:[a.id,b.id]})).deleted,2);
 assert.notEqual(JSON.stringify(await rpc({op:'stamp'})),stamp1);
 assert.equal(groupVersions(await rpc({op:'list'})).length,1);
 await assert.rejects(db.query('select * from public.category'),/permission denied/);

 // Client path: edit keeps variable settings, save as new version, bulk API
 const transport:typeof fetch=async(_u,o)=>{try{return new Response(JSON.stringify(await rpc(JSON.parse(String(o?.body)).request)));}catch(e){return new Response(JSON.stringify({message:(e as Error).message}),{status:400});}};
 const store=new CloudStore({url:'https://t.supabase.co',key:'sb_publishable_test'},transport);
 let lib=await store.api<any>('/api/library');assert.equal(lib.total,1);assert.equal(lib.items[0].versions.length,2);assert.ok(lib.stamp);assert.deepEqual(lib.categories.map((c:any)=>c.name),['出題','其他']);
 const cur=lib.items[0];
 const v3=await store.api<any>('/api/prompts/'+cur.id,{method:'POST',body:JSON.stringify({action:'edit',asVersion:true,title:'出題 V3',body:cur.body+'\n請標註難度。',body_en:cur.body_en,summary:'',category:'出題',variables:cur.variables,version:cur.updated_at})});
 assert.equal(v3.version_no,3);assert.equal(v3.variables.find((v:any)=>v.name==='程度').type,'select');
 lib=await store.api<any>('/api/library?q=multiple-choice');assert.equal(lib.items[0].id,v3.id);
 await store.api('/api/bulk',{method:'POST',body:JSON.stringify({action:'move',ids:lib.items[0].versions.map((v:any)=>v.id),category:'其他'})});
 assert.equal((await store.api<any>('/api/library?category=其他')).items.length,1);
 await db.close();
});

test('選項變數：英文版只檢查自己用到的變數、數字檢查、保留設定',()=>{
 const vars=[{name:'程度',label:'程度',example:'',required:true,type:'select' as const,options:['小學']},{name:'n',label:'題數',example:'',required:true,type:'number' as const}];
 assert.equal(fillTemplate('Write {{n}} questions.',vars,{n:'5'}),'Write 5 questions.');
 assert.throws(()=>fillTemplate('Write {{n}} questions.',vars,{n:'five'}),/數字/);
 assert.throws(()=>fillTemplate('給{{程度}}',vars,{}),/程度/);
 const merged=mergeVariables(['給{{程度}}出{{n}}題','{{new}}'],vars);assert.equal(merged[0].type,'select');assert.equal(merged[2].label,'new');
 assert.throws(()=>mergeVariables(['{{程度}}'],[{...vars[0],options:[]}]),/選項/);
});
