import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = new URL('../src/cli.ts',import.meta.url).pathname;
test('CLI 完整匯入 → 預覽 → 接受 → 搜尋 → 重匯去重',async () => {
  const temp = await mkdtemp(join(tmpdir(),'promptsearch-test-'));
  try {
    const input = join(temp,'input.txt'), preview = join(temp,'review.json'), data = join(temp,'data.json');
    await writeFile(input,'請為公司：晨光設計，撰寫季度報告，分析營收與成本並輸出摘要與表格。');
    const invoke = (args:string[]) => run(process.execPath,[cli,...args,'--demo','--data',data],{env:{...process.env,PROMPTSEARCH_USER_ID:'11111111-1111-4111-8111-111111111111'}});
    await invoke(['import',input,'--preview',preview]);
    await assert.rejects(readFile(data,'utf8'),{code:'ENOENT'});
    const review = JSON.parse(await readFile(preview,'utf8'));
    assert.equal(review.prompts.length,1); assert.equal(review.prompts[0].variables[0].example,'晨光設計');
    await invoke(['accept',preview]);
    const found = JSON.parse((await invoke(['search','寫季度報告的'])).stdout);
    assert.equal(found.results.length,1); assert.match(found.results[0].body,/\{\{公司名稱\}\}/);
    await invoke(['import',input,'--preview',preview]);
    assert.equal(JSON.parse(await readFile(preview,'utf8')).skipped,1);
  } finally {await rm(temp,{recursive:true,force:true});}
});
test('CLI demo 與正式模式有清楚區分',async () => {
  const temp = await mkdtemp(join(tmpdir(),'promptsearch-demo-'));
  try {
    const result = await run(process.execPath,[cli,'demo','--data',join(temp,'data.json')]);
    assert.match(result.stdout,/非正式 AI 語意驗收/);
    assert.match(result.stdout,/文章精簡器/);
    await assert.rejects(run(process.execPath,[cli,'search','季度報告'],{env:{...process.env,DATABASE_URL:''}}),/DATABASE_URL/);
  } finally {await rm(temp,{recursive:true,force:true});}
});
