import test from 'node:test';
import assert from 'node:assert/strict';
import {weaken, whatWasLost} from '../src/web/weaken.ts';

const good='你是一位資深編輯。請把以下文章精簡成三個重點，並整理成表格。\n規則：不要加入原文沒有的資訊。';

test('降級後拿掉角色、格式與限制，只剩光禿禿的任務', () => {
  const weak = weaken(good);
  assert.ok(!/你是一位資深編輯/.test(weak), `角色設定應該被拿掉：${weak}`);
  assert.ok(!/表格/.test(weak), `輸出格式應該被拿掉：${weak}`);
  assert.ok(!/不要加入/.test(weak), `限制條件應該被拿掉：${weak}`);
  assert.match(weak, /^幫我/);
});

test('降級後的長度仍符合資料庫下限（20 字）', () => {
  for(const body of [good, '請列出重點。', '你是老師。出題。', 'Summarise this article into three points and output a table.'])
    assert.ok([...weaken(body)].length >= 20, `太短會被資料庫拒絕：${weaken(body)}`);
});

test('變數會變成模糊的指稱，新手版本沒有可填欄位', () => {
  const weak = weaken('請依照{{教材}}內容出 {{題數}} 題選擇題，並附上答案與詳解。',
    {variables:[{name:'教材',label:'教材',example:'',required:true},{name:'題數',label:'題數',example:'',required:true}]});
  assert.ok(!/\{\{/.test(weak), `不該留下變數語法：${weak}`);
  assert.match(weak, /這份資料/);
});

test('具體數量會被模糊化', () => {
  assert.ok(!/\b10\b/.test(weaken('請出 10 題選擇題。')), '數字應該被模糊化');
});

test('whatWasLost 列出被拆掉的零件', () => {
  const lost = whatWasLost(good);
  assert.deepEqual(lost.includes('角色設定'), true);
  assert.deepEqual(lost.includes('輸出格式'), true);
  assert.deepEqual(lost.includes('限制與驗收條件'), true);
});
