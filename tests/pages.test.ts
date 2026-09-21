import test from 'node:test';
import assert from 'node:assert/strict';
import {organizeBrowser,searchBrowser} from '../src/web/browser-store.ts';
import definitions from '../fixtures/prompts.json' with {type:'json'};
import type {CardPrompt} from '../src/web/types.ts';
const prompts=definitions.map((p,i)=>({...p,id:String(i),category:p.category as CardPrompt['category'],source:'sample',fork_of:null,use_count:0,last_used:null,updated_at:'2026-09-21T00:00:00Z'}));
test('GitHub Pages 搜尋的七個規格查詢（關鍵字示範）',()=>{
  for(const [query,index] of [['寫季度報告的',0],['上次那個改履歷的',1],['Midjourney 日系插畫',2],['把文章變短',3],['縮短',3],['精簡',3],[prompts[3].body,3]] as [string,number][])assert.equal(searchBrowser(prompts,query)[0]?.id,String(index),query);
});
test('瀏覽器端匯入保留變數與範例，不需要 Node API',()=>{
  const p=organizeBrowser('請為公司：晨光設計，撰寫季度報告，整理營運資料，輸出 Markdown 表格與行動建議。','paste');
  assert.equal(p.variables[0].example,'晨光設計');assert.match(p.body,/\{\{公司名稱\}\}/);assert.equal(p.category,'報告文書');
});
test('GitHub Pages 空白查詢不會回傳虛構命中',()=>{assert.deepEqual(searchBrowser(prompts,'  '),[]);});
