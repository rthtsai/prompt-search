import test from 'node:test';
import assert from 'node:assert/strict';
import {classStage,readError,joinClass,setNickname,createClassRpc,
  type ClassMembership,type Me} from '../src/web/class-store.ts';

const member=(over:Partial<ClassMembership>={}):ClassMembership=>({
  class_id:'c1',name:'十年級 AI 課',role:'student',status:'active',
  nickname:'小海',team_id:null,team:null,archived:false,...over});
const me=(classes:ClassMembership[]):Me=>({uid:'u1',classes});

test('沒登入、沒班級、等核可、沒暱稱，各自停在對的畫面', () => {
  assert.equal(classStage(null,null).kind,'signed-out');
  assert.equal(classStage(me([]),null).kind,'no-class');
  assert.equal(classStage(me([member({status:'pending',nickname:null})]),null).kind,'pending');
  assert.equal(classStage(me([member({nickname:null})]),null).kind,'nickname');
  assert.equal(classStage(me([member({archived:true})]),null).kind,'archived');
});

test('一切就緒時回傳目前班級，其餘班級另外列出來給切換用', () => {
  const stage=classStage(me([member(),member({class_id:'c2',name:'十一年級'})]),'c2');
  assert.equal(stage.kind,'ready');
  if(stage.kind!=='ready')return;
  assert.equal(stage.membership.class_id,'c2');
  assert.deepEqual(stage.others.map(c=>c.class_id),['c1']);
});

test('被移出的班級不列入，記住的班級失效時退回還能用的那個', () => {
  const stage=classStage(me([member({class_id:'gone',status:'removed'}),member()]),'gone');
  assert.equal(stage.kind,'ready');
  if(stage.kind==='ready')assert.equal(stage.membership.class_id,'c1');
});

test('沒有記住的班級時，優先挑已經能用的那一班', () => {
  const stage=classStage(me([member({class_id:'waiting',status:'pending',nickname:null}),member()]),null);
  assert.equal(stage.kind,'ready');
});

test('同一個帳號在不同班可以有不同角色', () => {
  const stage=classStage(me([member({role:'student'}),member({class_id:'c2',role:'teacher'})]),'c2');
  if(stage.kind!=='ready')return assert.fail('應該是 ready');
  assert.equal(stage.membership.role,'teacher');
  assert.equal(stage.others[0].role,'student');
});

test('資料庫的錯誤訊息會原樣傳給使用者，過期的登入講人話', () => {
  assert.equal(readError(JSON.stringify({message:'這個班級人數已滿'}),400),'這個班級人數已滿');
  assert.match(readError('',401),/重新登入/);
  assert.match(readError('not json',500),/500/);
});

test('班級代碼不計較大小寫與空白', async () => {
  let sent:any;
  await joinClass(async r=>{sent=r;return {class_id:'c1',status:'pending'};},'  AB12CD  ');
  assert.equal(sent.class_code,'ab12cd');
  await assert.rejects(()=>joinClass(async()=>({}),'   '),/請輸入班級代碼/);
});

test('暱稱長度用字元算，中文兩個字就過關', async () => {
  const rpc=async()=>({nickname:'小海'});
  assert.deepEqual(await setNickname(rpc,'c1','小海'),{nickname:'小海'});
  await assert.rejects(()=>setNickname(rpc,'c1','海'),/2 到 12/);
  await assert.rejects(()=>setNickname(rpc,'c1','一二三四五六七八九十十一十二'),/2 到 12/);
});

test('每次呼叫都帶 JWT；沒登入就不送出請求', async () => {
  let seen:any;
  const transport=(async (_u:any,init:any)=>{seen=init;
    return new Response(JSON.stringify({uid:'u1',classes:[]}),{status:200});}) as unknown as typeof fetch;
  const session={token:async()=>'jwt-abc',signIn:async()=>{},signOut:async()=>{},onChange:()=>()=>{}};
  const rpc=createClassRpc({url:'https://x.supabase.co',key:'anon'},session,transport);
  await rpc({op:'me'});
  assert.equal(seen.headers.Authorization,'Bearer jwt-abc');
  assert.equal(seen.headers.apikey,'anon');

  const anonymous=createClassRpc({url:'https://x.supabase.co',key:'anon'},
    {...session,token:async()=>null},transport);
  await assert.rejects(()=>anonymous({op:'me'}),/請先登入/);
});

import {visibleScopes,listRequest,coverOf,listPrompts,listTasks,
  type ClassCard} from '../src/web/class-store.ts';

const card=(over:Partial<ClassCard>={}):ClassCard=>({
  id:'p1',title:'出題',body:'內容',summary:'說明',category:'其他',tags:[],variables:[],
  model_hint:[],use_count:0,last_used:null,source:'',fork_of:null,
  updated_at:'',created_at:'',group_id:'p1',version_no:1,version_note:'',
  task_id:null,featured:false,member_id:'m1',author:'小海',team:'第二組',outputs:[],...over});

test('沒分組的人不顯示「本組」分頁，不然會永遠空白', () => {
  assert.deepEqual(visibleScopes({team_id:null}).map(s=>s.key),['mine','class','featured']);
  assert.deepEqual(visibleScopes({team_id:'t1'}).map(s=>s.key),['mine','team','class','featured']);
});

test('列表請求一律帶 class_id；沒選任務就不送 task_id', () => {
  assert.deepEqual(listRequest('c1',{scope:'mine',taskId:null}),
    {op:'list',class_id:'c1',scope:'mine'});
  assert.deepEqual(listRequest('c1',{scope:'class',taskId:'t9'}),
    {op:'list',class_id:'c1',scope:'class',task_id:'t9'});
});

test('封面取圖片輸出的縮圖，只有文字輸出就沒有封面', () => {
  assert.equal(coverOf(card()),null);
  assert.equal(coverOf(card({outputs:[{id:'o1',kind:'text',text_body:'答案',member_id:'m1',created_at:''}]})),null);
  assert.equal(coverOf(card({outputs:[
    {id:'o1',kind:'text',text_body:'答案',member_id:'m1',created_at:''},
    {id:'o2',kind:'image',image_thumb:'data:image/jpeg;base64,AAA',member_id:'m1',created_at:''}]})),
    'data:image/jpeg;base64,AAA');
});

test('資料庫存的是裸 base64，封面要自己補回 data: 前綴', () => {
  assert.equal(coverOf(card({outputs:[
    {id:'o1',kind:'image',image_thumb:'/9j/4AAQ',member_id:'m1',created_at:''}]})),
    'data:image/jpeg;base64,/9j/4AAQ');
});

test('列表與任務在伺服器回傳非陣列時不會炸掉', async () => {
  assert.deepEqual(await listPrompts(async()=>null,'c1',{scope:'mine',taskId:null}),[]);
  assert.deepEqual(await listTasks(async()=>({error:'x'}),'c1'),[]);
  assert.equal((await listPrompts(async()=>[card()],'c1',{scope:'mine',taskId:null})).length,1);
});
