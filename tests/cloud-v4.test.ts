import {PGlite} from '@electric-sql/pglite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';
import {readFile} from 'node:fs/promises';
import {CloudStore,exampleUrl} from '../src/web/cloud-store.ts';

test('v4：範例圖片上傳、附加、移除與限制',async()=>{
 const db=new PGlite({extensions:{pgcrypto,pg_trgm}});const root=new URL('../',import.meta.url);
 let base=await readFile(new URL('supabase/001_fresh_project.sql',root),'utf8');
 base=base.replace('CREATE EXTENSION IF NOT EXISTS vector;','').replace('embedding vector(1536)','embedding double precision[]').replace(/^CREATE INDEX prompt_embedding_hnsw.*$/m,'');
 await db.exec('CREATE ROLE anon; CREATE ROLE authenticated;');await db.exec(base);
 for(const f of ['supabase/migrations/002_shared_library.sql','supabase/migrations/003_versions_languages_categories.sql','supabase/migrations/004_examples.sql'])
  await db.exec(await readFile(new URL(f,root),'utf8'));
 await db.exec('SET ROLE anon');
 const rpc=async(request:any):Promise<any>=>(await db.query<any>('select public.prompt_library($1::jsonb) as result',[JSON.stringify(request)])).rows[0].result;
 const [p]=await rpc({op:'import',items:[{title:'畫圖','body':'請畫一張水彩風格的台灣街景，午後陽光，行人撐傘，色調溫暖。',summary:'',category:'圖像生成',variables:[],tags:[],model_hint:[],source:'test'}]});
 assert.deepEqual(p.examples,[]);
 const path=`${p.id}/${crypto.randomUUID()}.jpg`;
 let after=await rpc({op:'example_add',id:p.id,path,caption:'橘貓版本'});
 assert.equal(after.examples.length,1);assert.equal(after.examples[0].caption,'橘貓版本');
 await assert.rejects(rpc({op:'example_add',id:p.id,path}),/已經加過/);
 await assert.rejects(rpc({op:'example_add',id:p.id,path:'../secret.jpg'}),/路徑格式/);
 await assert.rejects(rpc({op:'example_add',id:p.id,path:`${p.id}/${crypto.randomUUID()}.svg`}),/路徑格式/);
 for(let i=0;i<5;i++) after=await rpc({op:'example_add',id:p.id,path:`${p.id}/${crypto.randomUUID()}.png`});
 assert.equal(after.examples.length,6);
 await assert.rejects(rpc({op:'example_add',id:p.id,path:`${p.id}/${crypto.randomUUID()}.jpg`}),/最多 6 張/);
 // Editing the prompt keeps its images.
 const edited=await rpc({op:'edit',id:p.id,version:after.updated_at,item:{title:'畫圖 2',body:p.body,summary:'',category:'圖像生成',variables:[],tags:[],model_hint:[],source:'test'}});
 assert.equal(edited.examples.length,6);
 const removed=await rpc({op:'example_remove',id:p.id,path});
 assert.equal(removed.examples.length,5);
 assert.ok(!removed.examples.some((e:any)=>e.path===path));

 // Client path: uploads the file to storage, then attaches the returned path.
 const uploads:{url:string;type:string|undefined;bytes:number}[]=[];
 const transport:typeof fetch=async(url,options)=>{
  const href=String(url);
  if(href.includes('/storage/v1/object/')){
   uploads.push({url:href,type:(options?.headers as any)?.['Content-Type'],bytes:(options?.body as Blob).size});
   return new Response('{}',{status:200});
  }
  try{return new Response(JSON.stringify(await rpc(JSON.parse(String(options?.body)).request)));}
  catch(e){return new Response(JSON.stringify({message:(e as Error).message}),{status:400});}
 };
 const store=new CloudStore({url:'https://t.supabase.co',key:'sb_publishable_test'},transport);
 const [q]=await rpc({op:'import',items:[{title:'另一則',body:'請幫我把這段會議逐字稿整理成決議、待辦與負責人三個段落。',summary:'',category:'其他',variables:[],tags:[],model_hint:[],source:'test'}]});
 const file=new File([new Uint8Array(1024)],'out.png',{type:'image/png'});
 const saved=await store.addExample(q.id,file,'第一次的結果');
 assert.equal(saved.examples!.length,1);
 assert.equal(uploads.length,1);
 assert.match(uploads[0].url,new RegExp(`/storage/v1/object/prompt-examples/${q.id}/[a-f0-9-]{36}\\.png$`));
 assert.equal(uploads[0].type,'image/png');
 assert.equal(saved.examples![0].caption,'第一次的結果');
 // A failed upload must not attach anything.
 const broken=new CloudStore({url:'https://t.supabase.co',key:'sb_publishable_test'},async(u,o)=>String(u).includes('/storage/')?new Response('no',{status:403}):transport(u,o));
 await assert.rejects(broken.addExample(q.id,file,''),/圖片上傳失敗/);
 assert.equal((await rpc({op:'list'})).find((x:any)=>x.id===q.id).examples.length,1);
 await assert.rejects(store.addExample(q.id,new File([new Uint8Array(8)],'a.gif',{type:'image/gif'}),''),/JPG/);
 await db.close();
});

test('範例圖片網址組合', ()=>{
 assert.equal(exampleUrl('https://t.supabase.co','abc/def.jpg'),'https://t.supabase.co/storage/v1/object/public/prompt-examples/abc/def.jpg');
});
