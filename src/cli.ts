import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DemoAI, OpenAIProvider } from './ai.ts';
import { MemoryStore } from './memory-store.ts';
import { PostgresStore } from './postgres-store.ts';
import { SearchService } from './search.ts';
import { prepareImport, type ImportPreview } from './importer.ts';
import { fixtures, DEMO_USER } from './fixtures.ts';
import { type AI, type Prompt, type Store, validateEmbedding, validateExtracted } from './domain.ts';

const args = process.argv.slice(2), command = args[0];
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i+1] : undefined; };
const dataPath = flag('--data') ?? '.data/demo.json';
const demo = args.includes('--demo') || command === 'demo';
const userId = process.env.PROMPTSEARCH_USER_ID ?? DEMO_USER;
let db: PostgresStore | undefined;
async function saveJSON(path: string, value: unknown) {
  await mkdir(dirname(path),{recursive:true});
  await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
}
async function readDemo(): Promise<MemoryStore> {
  try {
    const data = JSON.parse(await readFile(dataPath,'utf8'));
    return new MemoryStore(data.prompts,data.usages,data.unlocks);
  } catch (error: any) { if (error.code === 'ENOENT') return new MemoryStore(); throw error; }
}
async function main() {
  if (!command || command === 'help') {
    console.log(`Prompt 辭典 · 第一階段 CLI\n\nnode src/cli.ts demo\nnode src/cli.ts import FILE --demo --preview .data/review.json\nnode src/cli.ts import - --demo --preview .data/review.json  # 貼上文字由 stdin 傳入\nnode src/cli.ts accept .data/review.json --demo\nnode src/cli.ts search "寫季度報告的" --demo\n\n正式模式：設定 .env，拿掉 --demo，使用 node --env-file=.env src/cli.ts …\n  migrate           建立資料庫結構（需 migration 權限）\n  init-user         建立 CLI 測試帳號（需管理權限）\n  import FILE       AI 整理並產生預覽，不直接落庫\n  accept PREVIEW    接受整批預覽，交易式落庫\n  search QUERY      三路召回、融合與個人化重排\n\n搜尋篩選：--category 分類 --tag 標籤 --model 模型\n匯入可選：--preview PATH --data PATH\n此版本沒有 Web 介面；demo 使用測試用特徵向量，不代表正式語意品質。`); return;
  }
  if (command === 'demo') {
    const ai = new DemoAI(), prompts = await fixtures(ai), store = new MemoryStore(prompts);
    store.usages.push({user_id:userId,prompt_id:prompts[1].id,used_at:new Date().toISOString(),filled_vars:{}});
    await saveJSON(dataPath,store);
    const service = new SearchService(store,ai);
    console.log('本機測試模式：中文 bigram BM25 + 特徵向量，非正式 AI 語意驗收。');
    for (const q of ['寫季度報告的','上次那個改履歷的','Midjourney 日系插畫','把文章變短','縮短','精簡',prompts[3].body]) {
      const result = await service.search(userId,q);
      console.log(JSON.stringify({query:q,first:result.results[0]?.title,channels:result.results[0]?.channels,duration_ms:Math.round(result.duration_ms*100)/100}));
    }
    return;
  }
  let store: Store;
  if (demo) store = await readDemo();
  else {
    if (!process.env.DATABASE_URL) throw new Error('請設定 DATABASE_URL，或使用 --demo');
    db = new PostgresStore(process.env.DATABASE_URL); store = db;
  }
  if (command === 'migrate') {
    if (!db) throw new Error('migrate 需要 PostgreSQL');
    const exists = await db.pool.query("SELECT to_regclass('schema_migration') AS name");
    if (exists.rows[0].name) { console.log('資料庫已套用初始 migration'); return; }
    await db.pool.query(await readFile(new URL('../db/001_init.sql',import.meta.url),'utf8')); console.log('資料庫結構已建立'); return;
  }
  if (command === 'init-user') {
    if (!db) throw new Error('init-user 需要 PostgreSQL');
    await db.pool.query('INSERT INTO app_user(id,handle,display_name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[userId,flag('--handle') ?? 'local-user',flag('--name') ?? '本機使用者']); console.log('CLI 使用者已建立'); return;
  }
  if (command === 'accept') {
    if (!args[1]) throw new Error('請提供預覽檔');
    const preview: ImportPreview = JSON.parse(await readFile(args[1],'utf8'));
    if (!Array.isArray(preview.prompts) || preview.prompts.length > 1000) throw new Error('預覽格式錯誤');
    if (!demo && preview.provider === 'demo-hash-1536-v1') throw new Error('測試向量不可匯入正式資料庫');
    for (const p of preview.prompts) {
      if (p.author_id !== userId || p.visibility !== 'private' || p.premium) throw new Error('只可接受自己的私人匯入資料');
      if (p.state === 'active') validateExtracted(p); validateEmbedding(p.embedding);
    }
    await store.accept(userId,preview.prompts);
    if (demo) await saveJSON(dataPath,store);
    console.log(`已接受 ${preview.prompts.length} 筆（包含重複來源紀錄）；${preview.errors.length} 筆整理錯誤未匯入。`); return;
  }
  const ai: AI = demo ? new DemoAI() : new OpenAIProvider(process.env.OPENAI_API_KEY ?? '',process.env.OPENAI_EXTRACTION_MODEL ?? '');
  if (command === 'import') {
    if (!args[1]) throw new Error('請提供 .txt / .md / .json 檔案或 -');
    let input: string;
    if (args[1] === '-') { process.stdin.setEncoding('utf8'); input = ''; for await (const chunk of process.stdin) input += chunk; }
    else input = await readFile(args[1],'utf8');
    const preview = await prepareImport(input,args[1] === '-' ? '貼上文字' : args[1],userId,ai,store,(done,total) => process.stderr.write(`\r整理中 ${done}/${total}`));
    const path = flag('--preview') ?? '.data/review.json'; await saveJSON(path,preview);
    process.stderr.write('\n');
    console.log(JSON.stringify({preview:path,total:preview.total,ready:preview.prompts.filter(p => p.state === 'active').length,duplicates:preview.prompts.filter(p => p.state === 'duplicate').length,skipped:preview.skipped,errors:preview.errors},null,2));
    console.log('檢查預覽後執行 accept；目前尚未寫入 prompt 資料表。');
  } else if (command === 'search') {
    if (!args[1]) throw new Error('請提供搜尋文字');
    console.log(JSON.stringify(await new SearchService(store,ai).search(userId,args[1],{category:flag('--category'),tag:flag('--tag'),model:flag('--model')}),null,2));
  } else throw new Error('未知指令，請執行 help');
}
main().catch(error => {console.error(error instanceof Error ? error.message : '執行失敗');process.exitCode=1;}).finally(async () => {await db?.close();});
