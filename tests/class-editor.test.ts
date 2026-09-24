import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDraft,draftFrom,placeholdersIn,reconcileVariables,draftProblem,summaryOf,
  saveRequest,saveDraft,selectableTasks,fitWithin,stripDataUrl,asDataUrl,looksLikeJpeg,
  shrinkImage,prepareOutputImage,addTextOutput,LIMITS,
  type Draft,type Raster} from '../src/web/class-editor.ts';
import type {ClassCard} from '../src/web/class-store.ts';

const draft=(over:Partial<Draft>={}):Draft=>({...emptyDraft(),
  title:'幫我出題',body:'請幫我出 {{題數}} 題 {{科目}} 的練習題。',
  variables:[{name:'題數',label:'題數',example:'5',required:true},
             {name:'科目',label:'科目',example:'數學',required:true}],...over});

test('變數就是本文裡的 {{}}，依出現順序去重', () => {
  assert.deepEqual(placeholdersIn('{{a}} 和 {{b}}，再一次 {{a}}'),['a','b']);
  assert.deepEqual(placeholdersIn('沒有變數'),[]);
});

test('改本文會重算變數，但填過的範例要留著', () => {
  const before=[{name:'科目',label:'哪一科',example:'數學',required:true},
                {name:'題數',label:'題數',example:'5',required:true}];
  const after=reconcileVariables('出 {{科目}} 的 {{難度}} 題目',before);
  assert.deepEqual(after.map(v=>v.name),['科目','難度']);
  assert.equal(after[0].label,'哪一科');      // 原本填的保留
  assert.equal(after[0].example,'數學');
  assert.equal(after[1].label,'難度');        // 新的用名稱當預設
});

test('送出前會擋下標題空白、本文空白、空的 {{}}', () => {
  assert.equal(draftProblem(draft(),'new'),null);
  assert.equal(draftProblem(draft({title:'   '}),'new'),'請幫這個 Prompt 取個標題');
  assert.equal(draftProblem(draft({body:'',variables:[]}),'new'),'本文還是空的');
  assert.equal(draftProblem(draft({body:'請寫 {{ }} 出來',variables:[]}),'new'),
    '有一組 {{ }} 裡面沒寫變數名稱');
});

test('變數和本文對不起來就不送，因為伺服器一定會退回來', () => {
  assert.equal(draftProblem(draft({variables:[{name:'題數',label:'題數',example:'',required:true}]}),'new'),
    '變數和本文對不起來，請重新整理後再試');
});

test('開新版本一定要寫改了什麼，改同一版則不強迫', () => {
  const base=draft({id:'p1',version:'2026-09-25T00:00:00Z'});
  assert.equal(draftProblem(base,'version'),'請寫下這一版改了什麼、為什麼');
  assert.equal(draftProblem({...base,versionNote:'  '},'version'),'請寫下這一版改了什麼、為什麼');
  assert.equal(draftProblem({...base,versionNote:'把角色講清楚'},'version'),null);
  assert.equal(draftProblem(base,'edit'),null);
});

test('說明留白就用規則式產生，不會送出空的 summary', () => {
  assert.ok(summaryOf(draft()).length>0);
  assert.equal(summaryOf(draft({summary:'  自己寫的說明  '})),'自己寫的說明');
});

test('三種存法送出三種請求，改同一版才帶樂觀鎖', () => {
  const base=draft({id:'p1',version:'v1',taskId:'t1',versionNote:'加了輸出格式'});
  assert.equal((saveRequest(base,'c1','new') as {op:string}).op,'save');
  assert.equal((saveRequest(base,'c1','new') as {id?:string}).id,undefined);
  const edit=saveRequest(base,'c1','edit') as Record<string,unknown>;
  assert.equal(edit.op,'edit');assert.equal(edit.id,'p1');assert.equal(edit.version,'v1');
  const version=saveRequest(base,'c1','version') as Record<string,unknown>;
  assert.equal(version.op,'version');assert.equal(version.version,undefined);
  assert.equal((version.item as {version_note:string}).version_note,'加了輸出格式');
  assert.equal((version.item as {task_id:string}).task_id,'t1');
});

test('草稿有問題時根本不會發出請求', async () => {
  let called=false;
  await assert.rejects(()=>saveDraft(async()=>{called=true;return {};},draft({title:''}),'c1','new'),
    /取個標題/);
  assert.equal(called,false);
});

test('從既有卡片改版時，上一版的說明不會被帶過來', () => {
  const card={id:'p1',updated_at:'v1',title:'出題',body:'{{a}}',summary:'說明',
    task_id:'t1',variables:[{name:'a',label:'a',example:'',required:true}],
    version_note:'上一版寫的'} as unknown as ClassCard;
  assert.equal(draftFrom(card,'edit').versionNote,'上一版寫的');
  assert.equal(draftFrom(card,'version').versionNote,'');
  assert.equal(draftFrom(card,'version').id,'p1');
});

test('已截止的任務不能再選，除非本來就交在那裡', () => {
  const tasks=[{id:'t1',title:'第一課',closed:false},{id:'t2',title:'第二課',closed:true}];
  assert.deepEqual(selectableTasks(tasks,null).map(t=>t.id),['t1']);
  assert.deepEqual(selectableTasks(tasks,'t2').map(t=>t.id),['t1','t2']);
});

test('縮圖等比例、不放大、至少 1px', () => {
  assert.deepEqual(fitWithin(4000,3000,1280),{width:1280,height:960});
  assert.deepEqual(fitWithin(600,800,1280),{width:600,height:800});
  assert.deepEqual(fitWithin(1000,3,320),{width:320,height:1});
});

test('base64 前綴進出都處理乾淨', () => {
  assert.equal(stripDataUrl('data:image/jpeg;base64,/9j/AAA'),'/9j/AAA');
  assert.equal(stripDataUrl('/9j/AAA'),'/9j/AAA');
  assert.equal(asDataUrl('/9j/AAA'),'data:image/jpeg;base64,/9j/AAA');
  assert.equal(asDataUrl(null),null);
  assert.ok(looksLikeJpeg('/9j/AAA'));
  assert.ok(!looksLikeJpeg('iVBORw0KGgo'));
});

/** 假的畫布：輸出長度只跟邊長和畫質有關，方便驗降階邏輯。 */
const raster=(width:number,height:number,bytesPerPixel=1):Raster=>({width,height,
  async toJpeg(w,h,quality){
    return 'data:image/jpeg;base64,/9j/'+'A'.repeat(Math.round(w*h*bytesPerPixel*quality));
  }});

test('太大的圖先降畫質，還不夠就把邊長減半', async () => {
  const small=await shrinkImage(raster(4000,3000),{edge:1280,budget:LIMITS.fullBase64});
  assert.ok(small.length<=LIMITS.fullBase64);
  assert.ok(looksLikeJpeg(small));
  // 預算緊到 1280 邊長怎麼降畫質都塞不下，必須縮邊長才過得了
  const tight=await shrinkImage(raster(4000,3000),{edge:1280,budget:200*1024});
  assert.ok(tight.length<=200*1024);
});

test('真的壓不下來就講清楚，而不是送一包過大的資料上去', async () => {
  await assert.rejects(()=>shrinkImage(raster(4000,3000,40),{edge:1280,budget:1024}),/壓不下來/);
});

test('大圖和縮圖各自符合伺服器的兩個預算', async () => {
  const image=await prepareOutputImage(raster(4000,3000));
  assert.ok(image.image_full.length<=LIMITS.fullBase64);
  assert.ok(image.image_thumb.length<=LIMITS.thumbBase64);
  assert.ok(image.image_full.length>image.image_thumb.length);
});

test('沒貼東西就按送出，不會打出一個空的輸出', () => {
  assert.throws(()=>addTextOutput(async()=>({}),'c1','p1','   '),/還沒貼上/);
});
