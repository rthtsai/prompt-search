import test from 'node:test';
import assert from 'node:assert/strict';
import {fillState,copyLabel,progressLabel,blankWarning,previewSegments,previewText,
  guessRequired} from '../src/web/fill.ts';
import {readFromUrl} from '../src/web/maintainer.ts';
import type {Variable} from '../src/domain.ts';

const v=(name:string,required=true):Variable=>({name,label:name,example:'',required});
const body='請幫 {{城市}} 寫一篇 {{字數}} 字的介紹，語氣 {{語氣}}。';
const vars=[v('城市'),v('字數',false),v('語氣',false)];

test('只算本文真的用到的變數，沒用到的不該擋住複製', () => {
  const state=fillState([...vars,v('沒用到的')],body,{城市:'台南'});
  assert.deepEqual(state.active.map(x=>x.name),['城市','字數','語氣']);
  assert.equal(state.missing.length,0);
  assert.equal(state.total,3);
});

test('按鈕文字會說實話：沒填完就不寫「複製」', () => {
  assert.equal(copyLabel(fillState(vars,body,{})),'還有 1 格要填');
  assert.equal(copyLabel(fillState([v('a'),v('b')],'{{a}}{{b}}',{})),'還有 2 格要填');
  assert.equal(copyLabel(fillState(vars,body,{城市:'台南'})),'複製完整 Prompt');
  assert.equal(copyLabel(fillState(vars,body,{城市:'台南'}),'中文版'),'複製中文版');
});

test('只填了空白字元不算填', () => {
  assert.equal(fillState(vars,body,{城市:'   '}).missing.length,1);
});

test('進度與空白段落的說明講得出是哪幾格', () => {
  const state=fillState(vars,body,{城市:'台南'});
  assert.equal(progressLabel(state),'已填 1 / 3');
  assert.equal(blankWarning(state),'〈字數〉、〈語氣〉 沒有填，複製出來的內容這幾段會是空白。');
});

test('預覽切成段落，沒填的那一段標成 pending', () => {
  const segments=previewSegments(body,{城市:'台南'});
  assert.deepEqual(segments.filter(s=>s.pending).map(s=>s.text),['{{字數}}','{{語氣}}']);
  assert.equal(segments.find(s=>s.text==='台南')?.pending,false);
  assert.equal(previewText(body,{城市:'台南'}),'請幫 台南 寫一篇 {{字數}} 字的介紹，語氣 {{語氣}}。');
});

test('沒有變數的本文，預覽就是原文一段', () => {
  assert.deepEqual(previewSegments('沒有變數',{}),[{text:'沒有變數',pending:false}]);
});

test('必填的猜法：核心詞或出現在第一段才必填', () => {
  const text='請介紹 {{城市}}。\n\n附加：\n要不要工作紙 {{工作紙}}';
  assert.equal(guessRequired('城市',text),true);      // 核心詞
  assert.equal(guessRequired('工作紙',text),false);   // 第二段的附加選項
  assert.equal(guessRequired('語氣','請用 {{語氣}} 寫'),true);  // 在第一段
  assert.equal(guessRequired('工作紙',''),false);
});

test('維護者 token 從網址讀進來，而且會從網址被抹掉', () => {
  const a=readFromUrl('https://x.dev/prompt-search/?maintainer=abc123&v=rec');
  assert.equal(a.token,'abc123');
  assert.equal(a.cleaned,'/prompt-search/?v=rec');
  assert.ok(!a.cleaned.includes('maintainer'));
  const b=readFromUrl('https://x.dev/prompt-search/?maintainer=xyz');
  assert.equal(b.cleaned,'/prompt-search/');
  assert.equal(readFromUrl('https://x.dev/prompt-search/').token,null);
  assert.equal(readFromUrl('not a url').token,null);
});

import {describe as autoDescribe} from '../src/web/describe.ts';

test('說明會講出會不會附學習單或簡報——光看標題看不出來的正是這個', () => {
  const text='你是國中理化老師。請針對「浮力」設計一節課，'
    +'包含教學流程、一份學習單，以及一份可以直接上課用的簡報。';
  const summary=autoDescribe(text,{title:'浮力一節課'});
  assert.match(summary,/學習單/);
  assert.match(summary,/簡報/);
});

test('說明的上限放寬到 140 字，不會再把「輸出…」整段切掉', () => {
  const long='請針對 {{主題}} 產出一份教案，'+'內容要涵蓋教學目標與評量方式。'.repeat(6)+'請用條列式輸出。';
  const summary=autoDescribe(long,{title:'教案產生器',
    variables:[{name:'主題',label:'主題',example:'',required:true}]});
  assert.ok([...summary].length<=140,`太長了：${[...summary].length}`);
  assert.match(summary,/可填：主題/);
});

import {coverExample,beforeAfter} from '../src/web/types.ts';

const img=(role:'input'|'output'|undefined,caption:string)=>
  ({id:caption,kind:'image' as const,role,path:'p/'+caption+'.jpg',caption});

test('封面挑產出，不是第一張上傳的圖', () => {
  const prompt={examples:[img('input','原圖'),img('output','成品')]};
  assert.equal(coverExample(prompt)?.caption,'成品');
  // 沒標角色的舊資料當產出，順序照舊
  assert.equal(coverExample({examples:[img(undefined,'舊圖A'),img(undefined,'舊圖B')]})?.caption,'舊圖A');
  assert.equal(coverExample({examples:[]}),null);
});

test('只有原圖沒有產出時，還是要有封面，不能整張卡片變空白', () => {
  assert.equal(coverExample({examples:[img('input','原圖')]})?.caption,'原圖');
});

test('前後對照要一前一後才成立', () => {
  const both=beforeAfter([img('input','原圖'),img('output','成品'),img('output','另一張')]);
  assert.equal(both.before?.caption,'原圖');
  assert.equal(both.after?.caption,'成品');
  assert.deepEqual(both.rest.map(e=>e.caption),['另一張']);
  // 只有產出：不排對照，全部照常顯示
  const only=beforeAfter([img('output','成品'),img('output','另一張')]);
  assert.equal(only.before,null);
  assert.deepEqual(only.rest.map(e=>e.caption),['成品','另一張']);
});

import {categoryStats,rankCategories} from '../src/web/types.ts';
test('分類依使用量自動排序，其他永遠最後，空分類預設不顯示',()=>{
  const now=Date.parse('2026-09-26T00:00:00Z');
  const names=['寫作','快速指令','圖像生成','其他','資料分析'].map(name=>({name}));
  const prompts=[
    {category:'快速指令',use_count:0,last_used:null},{category:'快速指令',use_count:0,last_used:null},
    {category:'快速指令',use_count:0,last_used:null},
    {category:'圖像生成',use_count:3,last_used:'2026-09-25T10:00:00Z'},
    {category:'資料分析',use_count:6,last_used:'2026-08-01T10:00:00Z'},
    {category:'其他',use_count:50,last_used:'2026-09-25T10:00:00Z'},
  ];
  const stats=categoryStats(names,prompts,now);
  assert.deepEqual(stats.find(c=>c.name==='圖像生成'),{name:'圖像生成',count:1,uses:3,recent:1});
  const order=rankCategories(stats).map(c=>c.name);
  // 圖像生成 3+1×5=8 > 資料分析 6（兩個月前用的，沒有近期加分）> 快速指令 0 但則數多；寫作是空的不出現；其他再多人用也在最後
  assert.deepEqual(order,['圖像生成','資料分析','快速指令','其他']);
  assert.deepEqual(rankCategories(stats,{includeEmpty:true}).map(c=>c.name),['圖像生成','資料分析','快速指令','寫作','其他']);
});
test('完全沒有使用紀錄時，照則數排，再照原本的手動順序',()=>{
  const cats=[{name:'A',count:1},{name:'B',count:5},{name:'C',count:1}];
  assert.deepEqual(rankCategories(cats).map(c=>c.name),['B','A','C']);
});
