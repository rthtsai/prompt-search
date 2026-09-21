import { randomUUID } from 'node:crypto';
import { OpenAIProvider } from '../src/ai.ts';
import { PostgresStore } from '../src/postgres-store.ts';
import { fixtures } from '../src/fixtures.ts';
import { prepareImport } from '../src/importer.ts';
import { SearchService } from '../src/search.ts';

if (!process.env.DATABASE_URL || !process.env.OPENAI_API_KEY || !process.env.OPENAI_EXTRACTION_MODEL) {
  console.error('尚未執行正式驗收：需 DATABASE_URL、OPENAI_API_KEY、OPENAI_EXTRACTION_MODEL。');
  process.exit(2);
}
const ai = new OpenAIProvider(process.env.OPENAI_API_KEY,process.env.OPENAI_EXTRACTION_MODEL);
const store = new PostgresStore(process.env.DATABASE_URL), user = randomUUID();
let failed = false;
try {
  await store.pool.query('INSERT INTO app_user(id,handle,display_name) VALUES($1,$2,$2)',[user,`evaluation-${user}`]);
  const prompts = (await fixtures(ai,user)).map(p=>({...p,id:randomUUID()}));
  await store.accept(user,prompts);
  await store.pool.query('INSERT INTO usage_log(user_id,prompt_id) VALUES($1,$2)',[user,prompts[1].id]);
  const pipeline = await prepareImport('請為公司：晨光設計，整理季度營運資料。根據實際數據分析營收與成本，輸出 Markdown 表格與三項可執行建議。','live-eval',user,ai,store);
  const parameterized = pipeline.prompts.some(p=>p.variables.some(v=>v.example==='晨光設計') && /\{\{/.test(p.body));
  if (pipeline.errors.length || !parameterized) failed = true;
  console.log(JSON.stringify({check:'AI 自動整理與具體公司名稱變數化',passed:parameterized,errors:pipeline.errors}));
  const service = new SearchService(store,ai);
  const cases: [string,number][] = [['寫季度報告的',0],['上次那個改履歷的',1],['Midjourney 日系插畫',2],['把文章變短',3],['縮短',3],['精簡',3],[prompts[3].body,3],['讓主管看懂本季營運成果與下一季的改善方向',0],['替我的求職經歷突出亮點',1]];
  const cold: number[] = [], warm: number[] = [];
  for (const [query,index] of cases) {
    const result = await service.search(user,query); cold.push(result.duration_ms);
    const passed = !result.degraded && result.results[0]?.id===prompts[index].id;
    if (!passed) failed=true;
    console.log(JSON.stringify({query,passed,first:result.results[0]?.title,duration_ms:result.duration_ms}));
  }
  for (let i=0;i<100;i++) warm.push((await service.search(user,cases[i%cases.length][0])).duration_ms);
  const p95 = (values:number[])=>values.sort((a,b)=>a-b)[Math.ceil(values.length*0.95)-1];
  const latency = {cold_samples:cold.length,cold_p95_ms:p95(cold),warm_samples:warm.length,warm_p95_ms:p95(warm),note:'六筆資料、單使用者 smoke test；不等於正式規模或併發負載驗收'};
  if (latency.cold_p95_ms>=400 || latency.warm_p95_ms>=400) failed=true;
  console.log(JSON.stringify(latency));
} finally {
  await store.pool.query('DELETE FROM usage_log WHERE user_id=$1',[user]);
  await store.pool.query('DELETE FROM prompt WHERE author_id=$1',[user]);
  await store.pool.query('DELETE FROM app_user WHERE id=$1',[user]);
  await store.close();
}
if(failed) process.exitCode=1;
