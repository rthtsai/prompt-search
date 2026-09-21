import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresStore } from '../src/postgres-store.ts';
import { DemoAI } from '../src/ai.ts';
import { fixtures } from '../src/fixtures.ts';
import { SearchService } from '../src/search.ts';
import { rewrite } from '../src/text.ts';

test('PostgreSQL / pgvector / pg_bigm 真實整合', {skip:!process.env.DATABASE_URL}, async t => {
  // Use a migrated test database. All fixture rows belong to fresh random users and are cleaned up.
  const store = new PostgresStore(process.env.DATABASE_URL!);
  const owner = randomUUID(), other = randomUUID(), ai = new DemoAI();
  const prompts = (await fixtures(ai,owner)).map(p=>({...p,id:randomUUID()}));
  try {
    const extensions = (await store.pool.query("SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_bigm')")).rows.map(r=>r.extname);
    assert.deepEqual(extensions.sort(),['pg_bigm','vector']);
    await store.pool.query('INSERT INTO app_user(id,handle,display_name) VALUES($1,$2,$2),($3,$4,$4)',[owner,`test-${owner}`,other,`test-${other}`]);
    await store.accept(owner,prompts);
    await t.test('七個規格查詢經真實 PostgreSQL 召回',async () => {
      const search = new SearchService(store,ai);
      for (const [query,index] of [['寫季度報告的',0],['上次那個改履歷的',1],['Midjourney 日系插畫',2],['把文章變短',3],['縮短',3],['精簡',3],[prompts[3].body,3]] as [string,number][]) {
        assert.equal((await search.search(owner,query)).results[0]?.id,prompts[index].id,query);
      }
    });
    await t.test('三路召回與參數化 LIKE',async () => {
      const query = rewrite('季度報告');
      for (const kind of ['vector','lexical','exact'] as const) assert.ok((await store.recall(kind,owner,query,prompts[0].embedding,ai.embeddingModel,{})).some(h=>h.prompt.id===prompts[0].id));
      const literal = {...rewrite('x'),terms:["%' OR 1=1 --"]};
      assert.equal((await store.recall('lexical',owner,literal,[],ai.embeddingModel,{})).length,0);
    });
    await t.test('私人隔離與公開鎖定本文',async () => {
      const service = new SearchService(store,ai);
      assert.equal((await service.search(other,'季度報告')).results.length,0);
      await store.pool.query("UPDATE prompt SET visibility='public',premium=true WHERE id=$1",[prompts[0].id]);
      const locked = (await service.search(other,'季度報告')).results[0];
      assert.equal(locked.locked,true); assert.equal(locked.body,undefined); assert.equal(locked.highlight.text,prompts[0].summary);
      await store.pool.query('INSERT INTO unlock(user_id,prompt_id) VALUES($1,$2)',[other,prompts[0].id]);
      assert.equal((await service.search(other,'季度報告')).results[0].body,prompts[0].body);
    });
    await t.test('外鍵延後檢查允許先短文、後 canonical 的批次順序',async () => {
      const copy = {...prompts[5],id:randomUUID(),normalized_hash:'a'.repeat(64)};
      const canonical = {...prompts[5],id:randomUUID(),normalized_hash:'b'.repeat(64)};
      await store.accept(owner,[{...copy,state:'duplicate',fork_of:canonical.id},canonical]);
      assert.ok((await store.owned(owner)).some(p=>p.id===copy.id&&p.fork_of===canonical.id));
    });
    await t.test('重複 hash 整批回滾',async () => {
      const fresh = {...prompts[4],id:randomUUID(),normalized_hash:'c'.repeat(64)};
      await assert.rejects(store.accept(owner,[fresh,{...prompts[0],id:randomUUID()}]));
      assert.ok(!(await store.owned(owner)).some(p=>p.id===fresh.id));
    });
  } finally {
    await store.pool.query('DELETE FROM unlock WHERE user_id=ANY($1::uuid[])',[[owner,other]]);
    await store.pool.query('DELETE FROM usage_log WHERE user_id=ANY($1::uuid[])',[[owner,other]]);
    await store.pool.query('DELETE FROM prompt WHERE author_id=ANY($1::uuid[])',[[owner,other]]);
    await store.pool.query('DELETE FROM app_user WHERE id=ANY($1::uuid[])',[[owner,other]]);
    await store.close();
  }
});
