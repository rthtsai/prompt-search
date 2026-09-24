import test from 'node:test';
import assert from 'node:assert/strict';
import {describe as summarise, withDescription} from '../src/web/describe.ts';

test('說明產生器：抓動作句、去掉角色設定、補上格式與變數', () => {
  assert.equal(summarise('你是一位資深編輯。請把以下文章精簡成三個重點，並整理成表格。'),
    '把以下文章精簡成三個重點，並整理成表格');
  assert.match(summarise('請依照{{教材}}內容出 {{題數}} 題選擇題，並附上答案與詳解。',
    {variables:[{name:'教材',label:'教材',example:'',required:true},{name:'題數',label:'題數',example:'',required:true}]}),
    /出 教材.*題數|依照教材/);
  assert.match(summarise('把這段內容整理成 JSON 格式。'),/JSON/);
  assert.match(summarise('請幫我做一份投影片大綱。'),/簡報|大綱/);
});

test('說明產生器：標題不重複、斜線指令不重貼', () => {
  const body='/verify\n請幫我查證內容中的事實，區分已確認的事實與需要佐證的說法。';
  const text=summarise(body,{title:'86. /verify｜查證事實'});
  assert.equal(text.startsWith('/verify'),false);
  assert.match(text,/查證/);
  // 標題和內文講同一件事時不要出現「標題：標題…」
  assert.equal(summarise('把內容變成練習題，附上答案。',{title:'把內容變成練習題'}).split('：').length,1);
});

test('說明產生器：表單型與變數模板有替代寫法', () => {
  const form='填充題：\n- 提供詞庫\n- 提供干擾詞\n- 提供答案';
  assert.match(summarise(form,{title:'填充題：'}),/詞庫.*干擾詞.*答案.*模板/);
  assert.equal(/^[、：，]/.test(summarise(form,{title:'填充題：'})),false);
  const template='{{你的問題}}\n\n回答要求：\n- 回答風格：{{回答風格}}';
  assert.match(summarise(template,{title:'快速指令組合器',
    variables:[{name:'你的問題',label:'你的問題',example:'',required:true},{name:'回答風格',label:'回答風格',example:'',required:false}]}),
    /快速指令組合器（可填：你的問題、回答風格）/);
  assert.equal(summarise(''),'');
  assert.equal(summarise('   \n  '),'');
});

test('只有留白時才自動產生，使用者寫過的不覆蓋', () => {
  const written=withDescription({body:'請把文章縮短成三句話。',summary:'我自己寫的說明'});
  assert.equal(written.summary,'我自己寫的說明');
  assert.equal(written.summary_auto,false);
  const auto=withDescription({body:'請把文章縮短成三句話。',summary:''});
  assert.equal(auto.summary_auto,true);
  assert.match(auto.summary!,/縮短/);
  // 之前是自動產生的，內容改了就重新產生
  const again=withDescription({body:'請把文章翻譯成英文。',summary:'把文章縮短成三句話',summary_auto:true});
  assert.match(again.summary!,/翻譯/);
  assert.equal(again.summary_auto,true);
});

test('每一則實際資料都產得出說明，且長度合理', async () => {
  const {readFile}=await import('node:fs/promises');
  const path=new URL('../fixtures/prompts.json',import.meta.url);
  const items=JSON.parse(await readFile(path,'utf8'));
  for(const p of items){
    const text=summarise(p.body,{title:p.title,variables:p.variables});
    assert.ok(text.length>0,p.title);
    assert.ok([...text].length<=91,p.title);
    assert.equal(text.includes('{{'),false,p.title);
  }
});
