import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LocalApp} from '../src/web/service.ts';
import {fillTemplate} from '../src/web/types.ts';
import {guard,body} from '../src/web/http.ts';

test('App 的資料會保留：使用、重啟讀回、最近使用與次數去重',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'prompt-web-'));
  try {
    const app=new LocalApp(dir);const initial=await app.library();assert.equal(initial.total,6);assert.equal(initial.uses,0);
    const p=initial.items[0],values=Object.fromEntries(p.variables.map(v=>[v.name,v.example])),event=randomUUID();
    await Promise.all([app.used(p.id,values,event),app.used(p.id,values,event)]);
    const restarted=new LocalApp(dir);const recent=await restarted.library('','','recent');assert.equal(recent.items.length,1);assert.equal(recent.items[0].use_count,1);assert.ok(recent.items[0].last_used);
    await assert.rejects(restarted.used(p.id,{},randomUUID()),/請填寫/);assert.equal((await restarted.library()).uses,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('App 匯入背景完成、重啟後可接受，重送接受不會重複',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'prompt-web-import-'));
  try {
    const app=new LocalApp(dir);const job=await app.startImport('請為主題：森林夜讀，設計一場閱讀分享活動，規劃暖身、討論和反思的流程，輸出時間表與主持人講稿。','test.txt');
    let reviewed=await app.job(job.id);
    for(let i=0;i<100&&reviewed.status==='processing';i++){await new Promise(r=>setTimeout(r,10));reviewed=await app.job(job.id);}
    assert.equal(reviewed.status,'review');assert.equal(reviewed.items.length,1);assert.equal((await app.library()).total,6);
    // The review is persisted before accepting; use the same worker instance to avoid racing its final write.
    await new Promise(r=>setTimeout(r,20));
    const restarted=new LocalApp(dir);await restarted.acceptImport(job.id);await restarted.acceptImport(job.id);
    assert.equal((await restarted.library()).total,7);
    assert.equal((await restarted.library('森林夜讀')).items[0].id,reviewed.items[0].id);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('編輯更新搜尋索引，另存範本保留 fork 並拒絕相同內容',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'prompt-web-edit-'));
  try {
    const app=new LocalApp(dir),p=(await app.library()).items[0];
    const input={title:'董事會績效報告',summary:'給董事會的季度摘要',body:p.body+'請另外列出董事會需要核准的事項。',category:'報告文書'};
    const updated=await app.edit(p.id,input);assert.equal(updated.title,input.title);assert.equal((await app.library('董事會')).items[0].id,p.id);
    await assert.rejects(app.edit(p.id,{...input,fork:true}),/已在辭典/);
    const fork=await app.edit(p.id,{...input,body:input.body+'最後提供開場致詞。',fork:true});assert.equal(fork.fork_of,p.id);assert.notEqual(fork.id,p.id);assert.equal((await app.library()).total,7);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('範本替換保留美元符號與多行原文，拒絕繼承欄位',()=>{
  const variables=[{name:'原文',label:'原文',example:'',required:true}];
  assert.equal(fillTemplate('翻譯：{{原文}}',variables,{'原文':'$&\n$1'}),'翻譯：$&\n$1');
  assert.throws(()=>fillTemplate('{{constructor}}',[{name:'constructor',label:'constructor',example:'',required:true}],{}),/請填寫/);
});
test('本機 API 擋住跨來源寫入與公開主機',()=>{
  assert.doesNotThrow(()=>guard(new Request('http://127.0.0.1:3000/api/library')));
  assert.throws(()=>guard(new Request('http://example.com/api/library')),/本機/);
  assert.throws(()=>guard(new Request('http://127.0.0.1:3000/api/library',{headers:{origin:'https://malicious.example'}}),true),/跨網站/);
});
test('API 請求格式必須為 object',async()=>{
  await assert.rejects(body(new Request('http://localhost',{method:'POST',body:'[]'})),/資料格式/);
});
