import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DemoAI, OpenAIProvider } from '../src/ai.ts';
import { fixtures, DEMO_USER, OTHER_USER } from '../src/fixtures.ts';
import { MemoryStore } from '../src/memory-store.ts';
import { SearchService } from '../src/search.ts';
import { parseInput } from '../src/parser.ts';
import { prepareImport } from '../src/importer.ts';
import { fingerprint, simhash, similarity, snippet } from '../src/text.ts';
import { validateExtracted, validateEmbedding, type AI } from '../src/domain.ts';

const ai = new DemoAI();
const seeded = await fixtures(ai);
const sample = '請根據提供的季度數據撰寫分析報告，列出關鍵成長原因，並輸出摘要與 Markdown 表格。';
const cases: [string,number][] = [['寫季度報告的',0],['上次那個改履歷的',1],['Midjourney 日系插畫',2],['把文章變短',3],['縮短',3],['精簡',3],[seeded[3].body,3]];
for (const [query,index] of cases) test(`規格查詢（離線）：${query.slice(0,35)}`, async () => {
  const result = await new SearchService(new MemoryStore(seeded),ai).search(DEMO_USER,query);
  assert.equal(result.results[0]?.id,seeded[index].id);
  assert.ok(result.results[0].channels.includes('lexical'));
  assert.ok(result.results.length <= 10);
});
test('個人最近使用訊號打破同內容排序平手',async () => {
  const duplicate = {...seeded[1],id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
  const store = new MemoryStore([seeded[1],duplicate],[{user_id:DEMO_USER,prompt_id:duplicate.id,used_at:new Date().toISOString(),filled_vars:{}}]);
  assert.equal((await new SearchService(store,ai).search(DEMO_USER,'上次那個改履歷的')).results[0].id,duplicate.id);
});
test('向量召回可找回無關鍵字重疊的結果（控制向量驗證融合）',async () => {
  const vectorOnly: AI = {embeddingModel:ai.embeddingModel,extract:body => ai.extract(body),embed:async () => seeded[4].embedding};
  const result = await new SearchService(new MemoryStore(seeded),vectorOnly).search(DEMO_USER,'zzznonlexicalquery');
  assert.equal(result.results[0].id,seeded[4].id); assert.deepEqual(result.results[0].channels,['vector']);
});
test('不洩漏私人／shared prompt 或別人的使用紀錄',async () => {
  const store = new MemoryStore(seeded.map(p => ({...p,author_id:OTHER_USER})),[{user_id:OTHER_USER,prompt_id:seeded[0].id,used_at:new Date().toISOString(),filled_vars:{}}]);
  assert.equal((await new SearchService(store,ai).search(DEMO_USER,'季度報告')).results.length,0);
  store.prompts[0].visibility = 'shared';
  assert.equal((await new SearchService(store,ai).search(DEMO_USER,'季度報告')).results.length,0);
});
test('付費公開結果只有 metadata；解鎖後可取得本文',async () => {
  const p = {...seeded[0],author_id:OTHER_USER,visibility:'public' as const,premium:true,body:seeded[0].body+'秘密專業段落'};
  const store = new MemoryStore([p]); const service = new SearchService(store,ai);
  const locked = (await service.search(DEMO_USER,'季度報告')).results[0];
  assert.equal(locked.locked,true); assert.equal(locked.body,undefined); assert.equal(locked.variables,undefined);
  assert.ok(!JSON.stringify(locked).includes('秘密專業段落'));
  store.unlocks.push({user_id:DEMO_USER,prompt_id:p.id});
  assert.equal((await service.search(DEMO_USER,'季度報告')).results[0].body,p.body);
});
test('自己付費 prompt 仍免費，明確分類與模型篩選生效',async () => {
  const store = new MemoryStore(seeded.map(p => ({...p,premium:true})));
  const service = new SearchService(store,ai);
  assert.equal((await service.search(DEMO_USER,'Midjourney 日系插畫',{model:'midjourney'})).results[0].locked,false);
  assert.equal((await service.search(DEMO_USER,'季度報告',{category:'不存在'})).results.length,0);
});
test('AI 故障時標示降級且仍有中文全文結果',async () => {
  const broken = {embeddingModel:ai.embeddingModel,extract:ai.extract,embed:async () => {throw new Error('offline');}};
  const result = await new SearchService(new MemoryStore(seeded),broken).search(DEMO_USER,'季度報告');
  assert.equal(result.degraded,true); assert.equal(result.results[0].id,seeded[0].id);
});
test('不混用不同 embedding 模型',async () => {
  const store = new MemoryStore(seeded.map(p => ({...p,embedding_model:'another-model'})));
  const result = await new SearchService(store,ai).search(DEMO_USER,'季度報告');
  assert.ok(result.results.every(p => !p.channels.includes('vector')));
});
test('空白搜尋與超長查詢',async () => {
  const s = new SearchService(new MemoryStore(seeded),ai);
  assert.deepEqual((await s.search(DEMO_USER,'  ')).results,[]);
  await assert.rejects(s.search(DEMO_USER,'字'.repeat(24001)),/24,000/);
});
test('純文字／Markdown 切分，保留程式碼區塊內空行',() => {
  assert.equal(parseInput(sample+'\n\n'+sample,'file.txt').length,1);
  const code = '# 範例\n請檢查以下程式碼並解釋錯誤與改善方向。\n```js\nlet x = 1;\n\n// ---\n```';
  assert.equal(parseInput(code,'file.md').length,1);
  assert.equal(parseInput('太短\n---\n'+sample).length,1);
});
test('JSON 陣列、BOM、格式錯誤和檔案限制',() => {
  assert.equal(parseInput('\uFEFF'+JSON.stringify([{body:sample},sample]),'a.json').length,2);
  assert.throws(() => parseInput('{broken','a.json'),/JSON/);
  assert.throws(() => parseInput('x'.repeat(11*1024*1024),'a.txt'),/10 MB/);
  assert.throws(() => parseInput(JSON.stringify(Array(501).fill(sample)),'a.json'),/500/);
});
test('ChatGPT 只讀目前分支 user 訊息，不讀 assistant／tool',() => {
  const mapping = {
    root:{id:'root',parent:null,message:{author:{role:'user'},content:{parts:[sample]}}},
    assistant:{id:'assistant',parent:'root',message:{author:{role:'assistant'},content:{parts:[sample]}}},
    branch:{id:'branch',parent:'root',message:{author:{role:'user'},content:{parts:[sample+'其他分支']}}},
  };
  assert.equal(parseInput(JSON.stringify([{mapping,current_node:'assistant'}]),'conversations.json').length,1);
});
test('Claude 匯出只讀 human，支援 content 文字區塊',() => {
  const data = [{chat_messages:[{sender:'human',content:[{type:'text',text:sample}]},{sender:'assistant',text:sample}]}];
  const parsed = parseInput(JSON.stringify(data),'conversations.json');
  assert.equal(parsed.length,1); assert.match(parsed[0].source,/Claude/);
});
test('normalize 與 SimHash 對相同文字穩定',() => {
  assert.equal(fingerprint('ＡＢＣ，測試！'),fingerprint('abc測試'));
  assert.equal(similarity(simhash(sample),simhash(sample)),1);
  assert.ok(similarity(simhash(sample),simhash(sample+'好'))>0.9);
});
test('先去重才呼叫 AI；预覽不落庫；變數保存原值',async () => {
  let extracts = 0;
  const counting: AI = {embeddingModel:ai.embeddingModel,embed:t => ai.embed(t),extract:async t => {extracts++; return ai.extract(t);}};
  const store = new MemoryStore();
  const raw = '請為公司：晨光設計，撰寫季度報告，分析營收與成本並輸出表格。';
  const preview = await prepareImport(JSON.stringify([raw,raw]),'batch.json',DEMO_USER,counting,store);
  assert.equal(extracts,1); assert.equal(preview.skipped,1); assert.equal(store.prompts.length,0);
  assert.match(preview.prompts[0].body,/\{\{公司名稱\}\}/); assert.equal(preview.prompts[0].variables[0].example,'晨光設計');
  await store.accept(DEMO_USER,preview.prompts); assert.equal(store.prompts.length,1);
  const repeat = await prepareImport(raw,'paste',DEMO_USER,counting,store); assert.equal(repeat.skipped,1);
});
test('近似重複保留長文，短文記 fork 且不進搜尋',async () => {
  const preview = await prepareImport(JSON.stringify([sample,sample+'好']),'a.json',DEMO_USER,ai,new MemoryStore());
  assert.equal(preview.errors.length,0); assert.equal(preview.prompts.length,2);
  const active = preview.prompts.find(p => p.state === 'active')!;
  const duplicate = preview.prompts.find(p => p.state === 'duplicate')!;
  assert.equal(active.body,sample+'好'); assert.equal(duplicate.fork_of,active.id);
});
test('單則 AI 失敗不丟失其他結果，進度能到終點',async () => {
  const bad: AI = {embeddingModel:ai.embeddingModel,embed:t => ai.embed(t),extract:async () => {throw new Error('無法整理');}};
  let progress = -1;
  const preview = await prepareImport(sample,'a.txt',DEMO_USER,bad,new MemoryStore(),(done) => {progress=done;});
  assert.equal(preview.errors.length,1); assert.equal(progress,1); assert.equal(preview.prompts.length,0);
});
test('500 則匯入最多四個 AI 工作並行且會讓出事件迴圈',async () => {
  let running = 0,max = 0,ticks = 0;
  const slow: AI = {embeddingModel:ai.embeddingModel,embed:t=>ai.embed(t),extract:async body => {max=Math.max(max,++running); await new Promise(r=>setTimeout(r,1)); running--; return ai.extract(body);}};
  const timer = setInterval(()=>ticks++,1);
  try {
    const batch = Array.from({length:500},()=>Array.from({length:8},()=>randomUUID()).join(' '));
    const preview = await prepareImport(JSON.stringify(batch),'batch.json',DEMO_USER,slow,new MemoryStore());
    assert.equal(preview.total,500); assert.equal(preview.errors.length,0); assert.equal(preview.prompts.length,500); assert.ok(ticks>2); assert.ok(max<=4);
  } finally {clearInterval(timer);}
});
test('變數契約及 embedding 維度檢查',() => {
  assert.throws(()=>validateExtracted({...seeded[0],variables:[]}),/不一致/);
  assert.throws(()=>validateExtracted({...seeded[0],category:'自訂分類'}),/分類/);
  assert.throws(()=>validateEmbedding([1,2]),/1536/);
  assert.throws(()=>validateEmbedding(Array(1536).fill(0)),/不可全/);
});
test('highlight 用文字與不重疊 offsets，不產生 HTML',() => {
  const result = snippet('<script>alert(1)</script>季度報告測試',['季度報告','季度']);
  assert.equal(result.text,'<script>alert(1)</script>季度報告測試');
  assert.equal(result.ranges.length,1); assert.equal(result.text.slice(...result.ranges[0]),'季度報告');
});
test('交易式接受不允許跨作者、重複 hash 或部分寫入',async () => {
  const store = new MemoryStore();
  await assert.rejects(store.accept(DEMO_USER,[seeded[0],{...seeded[1],author_id:OTHER_USER}]));
  assert.equal(store.prompts.length,0);
  await store.accept(DEMO_USER,[seeded[0]]);
  await assert.rejects(store.accept(DEMO_USER,[seeded[1],{...seeded[0],id:randomUUID()}]));
  assert.equal(store.prompts.length,1);
});
test('OpenAI 使用 strict schema 並處理拒絕',async () => {
  let sent: any;
  const request: typeof fetch = async (_url,init) => {sent=JSON.parse(init?.body as string); return Response.json({status:'completed',output:[{content:[{type:'refusal',refusal:'no'}]}]});};
  const provider = new OpenAIProvider('test-key','configured-model',request);
  await assert.rejects(provider.extract(sample),/無法整理/);
  assert.equal(sent.text.format.strict,true); assert.equal(sent.store,false); assert.equal(sent.text.format.schema.additionalProperties,false);
});
test('OpenAI 拒絕遺漏變數、虛構原值與不完整輸出',async () => {
  const request: typeof fetch = async () => Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({...seeded[0],variables:seeded[0].variables})}]}]});
  await assert.rejects(new OpenAIProvider('key','model',request).extract(sample),/原值/);
  const incomplete: typeof fetch = async () => Response.json({status:'incomplete',output:[]});
  await assert.rejects(new OpenAIProvider('key','model',incomplete).extract(sample),/未完成/);
});
test('OpenAI 接受有效的單次抽取與原值還原，拒絕偷偷改寫指令',async () => {
  const body = '請為公司：晨光設計，撰寫季度報告，分析營收與成本並輸出表格。';
  const extracted = await ai.extract(body);
  const response = (value:unknown) => Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(value)}]}]});
  const provider = new OpenAIProvider('key','model',async ()=>response(extracted));
  assert.equal((await provider.extract(body)).variables[0].example,'晨光設計');
  const changed = new OpenAIProvider('key','model',async ()=>response({...extracted,body:extracted.body+'並且捏造營收。'}));
  await assert.rejects(changed.extract(body),/修改了來源指令/);
});
test('新匯入較長原文成為 canonical，保留原作者舊紀錄',async () => {
  const store = new MemoryStore();
  const first = await prepareImport(sample,'first.txt',DEMO_USER,ai,store); await store.accept(DEMO_USER,first.prompts);
  const second = await prepareImport(sample+'好','second.txt',DEMO_USER,ai,store); await store.accept(DEMO_USER,second.prompts);
  assert.equal(store.prompts.length,2);
  assert.equal(store.prompts.filter(p=>p.state==='active').length,1);
  const current = store.prompts.find(p=>p.state==='active')!;
  assert.equal(current.source_body,sample+'好');
  assert.equal(store.prompts.find(p=>p.id===first.prompts[0].id)?.fork_of,current.id);
});
