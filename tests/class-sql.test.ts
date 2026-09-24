import {PGlite} from '@electric-sql/pglite';
import test from 'node:test';
import assert from 'node:assert/strict';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';
import {readFile} from 'node:fs/promises';

// The class project is 001–003 plus supabase/class/004_class.sql. Supabase supplies auth.uid()
// and auth.users; PGlite does not, so both are stubbed here exactly as Supabase behaves.
async function setup() {
  const db = new PGlite({extensions: {pgcrypto, pg_trgm}});
  const root = new URL('../', import.meta.url);
  let base = await readFile(new URL('supabase/001_fresh_project.sql', root), 'utf8');
  base = base.replace('CREATE EXTENSION IF NOT EXISTS vector;', '')
    .replace('embedding vector(1536)', 'embedding double precision[]')
    .replace(/^CREATE INDEX prompt_embedding_hnsw.*$/m, '');
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
  await db.exec(base);
  await db.exec(`CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;`);
  for (const f of ['supabase/migrations/002_shared_library.sql', 'supabase/migrations/003_versions_languages_categories.sql', 'supabase/class/004_class.sql'])
    await db.exec(await readFile(new URL(f, root), 'utf8'));

  const as = async (uid: string | null, request: any): Promise<any> => {
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
    const rows = await db.query<any>('SELECT public.class_api($1::jsonb) AS result', [JSON.stringify(request)]);
    return rows.rows[0].result;
  };
  const user = async (email: string, name: string) => {
    const id = crypto.randomUUID();
    await db.query('INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES($1,$2,$3)',
      [id, email, JSON.stringify({name})]);
    return id;
  };
  const makeClass = async (name: string, email: string, teams = 0) =>
    (await db.query<any>('SELECT public.class_create($1,$2,40,$3) AS r', [name, email, teams])).rows[0].r;
  return {db, as, user, makeClass};
}
const item = (title: string, body: string, extra: any = {}) => ({title, body, summary: '', category: '其他', variables: [], tags: [], model_hint: [], ...extra});

test('班級版：加入、核可、暱稱、發表、任務與比較', async () => {
  const {db, as, user, makeClass} = await setup();
  const teacher = await user('teacher@example.com', '老師');
  const a = await user('a@example.com', '學生A');
  const b = await user('b@example.com', '學生B');
  const cls = await makeClass('10年級AI課', 'teacher@example.com', 2);
  assert.match(cls.code, /^[a-z0-9]{8}$/);

  // 未加入前什麼都讀不到
  assert.deepEqual((await as(a, {op: 'me'})).classes, []);
  await assert.rejects(as(a, {op: 'list', class_id: cls.class_id}), /不屬於這個班級/);
  await assert.rejects(as(null, {op: 'me'}), /請先登入/);

  // 申請 → 未核可時讀不到資料（驗收 3）
  assert.equal((await as(a, {op: 'join_request', class_code: cls.code})).status, 'pending');
  await assert.rejects(as(a, {op: 'list', class_id: cls.class_id}), /尚未通過/);
  await assert.rejects(as(a, {op: 'join_request', class_code: 'zzzzzzzz'}), /找不到這個班級代碼/);

  const roster = await as(teacher, {op: 'roster', class_id: cls.class_id});
  const pending = roster.members.find((x: any) => x.email === 'a@example.com');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.full_name, '學生A');           // 老師看得到真名
  await as(teacher, {op: 'approve', class_id: cls.class_id, member_id: pending.id});

  // 核可後要先設暱稱
  await assert.rejects(as(a, {op: 'list', class_id: cls.class_id}), /請先設定暱稱/);
  await as(a, {op: 'set_nickname', class_id: cls.class_id, nickname: '阿光'});
  await assert.rejects(as(a, {op: 'set_nickname', class_id: cls.class_id, nickname: '光'}), /2 到 12/);

  await as(b, {op: 'join_request', class_code: cls.code});
  const bMember = (await as(teacher, {op: 'roster', class_id: cls.class_id})).members.find((x: any) => x.email === 'b@example.com');
  await as(teacher, {op: 'approve', class_id: cls.class_id, member_id: bMember.id});
  await as(b, {op: 'set_nickname', class_id: cls.class_id, nickname: '小美'});
  await assert.rejects(as(b, {op: 'set_nickname', class_id: cls.class_id, nickname: '阿光'}), /已經有人用了/);

  // 11 字的 prompt 存得進去、空白存不進去（驗收 7）
  const short = await as(a, {op: 'save', class_id: cls.class_id, item: item('吉卜力', '把這張照片變成吉卜力風')});
  assert.equal(short.author, '阿光');
  assert.equal(short.body.length, 11);
  await assert.rejects(as(a, {op: 'save', class_id: cls.class_id, item: item('空的', '')}), /格式或長度/);

  // 任務、交件、輸出
  const teams = (await as(teacher, {op: 'roster', class_id: cls.class_id})).teams;
  await as(teacher, {op: 'team_assign', class_id: cls.class_id, member_id: pending.id, team_id: teams[0].id});
  await as(teacher, {op: 'team_assign', class_id: cls.class_id, member_id: bMember.id, team_id: teams[0].id});
  const task = await as(teacher, {op: 'task_create', class_id: cls.class_id, title: '把一句話變成好圖'});
  const pa = await as(a, {op: 'save', class_id: cls.class_id, item: item('我的圖', '畫一隻貓在窗邊曬太陽', {task_id: task.id})});
  const pb = await as(b, {op: 'save', class_id: cls.class_id, item: item('我的圖', '畫一隻狗在草地上奔跑', {task_id: task.id})});
  await as(a, {op: 'output_add', class_id: cls.class_id, prompt_id: pa.id, kind: 'text', text_body: 'AI 回的文字'});
  await as(a, {op: 'output_add', class_id: cls.class_id, prompt_id: pa.id, kind: 'image', image_full: '/9j/' + 'x'.repeat(100), image_thumb: '/9j/' + 'y'.repeat(50)});
  await assert.rejects(as(a, {op: 'output_add', class_id: cls.class_id, prompt_id: pa.id, kind: 'image', image_full: 'iVBOR', image_thumb: '/9j/x'}), /必須是 JPEG/);
  await assert.rejects(as(b, {op: 'output_add', class_id: cls.class_id, prompt_id: pa.id, kind: 'text', text_body: '亂入'}), /只能為自己的 Prompt/);

  // 改版必須寫說明
  await assert.rejects(as(a, {op: 'version', class_id: cls.class_id, id: pa.id, item: item('我的圖 V2', '畫一隻橘貓在窗邊曬太陽，逆光', {task_id: task.id})}), /改了什麼/);
  const v2 = await as(a, {op: 'version', class_id: cls.class_id, id: pa.id,
    item: item('我的圖 V2', '畫一隻橘貓在窗邊曬太陽，逆光', {task_id: task.id, version_note: '加上逆光'})});
  assert.equal(v2.version_no, 2);
  assert.equal(v2.group_id, pa.id);

  // 列表只回最新版；scope 過濾
  const list = await as(a, {op: 'list', class_id: cls.class_id});
  assert.equal(list.filter((x: any) => x.group_id === pa.id).length, 1);
  assert.equal(list.find((x: any) => x.group_id === pa.id).version_no, 2);
  assert.equal((await as(a, {op: 'list', class_id: cls.class_id, scope: 'mine'})).every((x: any) => x.author === '阿光'), true);
  assert.equal((await as(a, {op: 'list', class_id: cls.class_id, task_id: task.id})).length, 2);

  // 學生 A 不能改或刪學生 B 的東西（驗收 4）
  await assert.rejects(as(a, {op: 'edit', class_id: cls.class_id, id: pb.id, item: item('亂改', '亂改內容')}), /只能修改自己/);
  await assert.rejects(as(a, {op: 'delete', class_id: cls.class_id, id: pb.id}), /只能刪除自己/);
  const bOut = await as(b, {op: 'output_add', class_id: cls.class_id, prompt_id: pb.id, kind: 'text', text_body: '小美的結果'});
  await assert.rejects(as(a, {op: 'output_delete', class_id: cls.class_id, id: bOut.id}), /只能刪除自己/);
  // 老師可以刪任何人的（驗收 5）
  assert.equal((await as(teacher, {op: 'output_delete', class_id: cls.class_id, id: bOut.id})).deleted, true);
  assert.equal((await as(teacher, {op: 'delete', class_id: cls.class_id, id: pb.id})).deleted, true);

  // 比較頁：每人一欄，含歷史版本（驗收 9）
  const compare = await as(a, {op: 'compare', class_id: cls.class_id, task_id: task.id});
  assert.equal(compare.columns.length, 1);          // 小美的已被老師刪掉
  assert.equal(compare.columns[0].author, '阿光');
  assert.equal(compare.columns[0].versions.length, 2);
  assert.equal(compare.columns[0].versions[0].outputs.length, 2);

  // 學生只能為自己這組建任務
  await assert.rejects(as(a, {op: 'task_create', class_id: cls.class_id, title: '全班任務'}), /只能為自己這一組/);
  await as(a, {op: 'task_create', class_id: cls.class_id, title: '本組任務', team_id: teams[0].id});

  // 精選與匯出只有老師／助教
  await assert.rejects(as(a, {op: 'feature', class_id: cls.class_id, id: pa.id}), /只有老師/);
  assert.equal((await as(teacher, {op: 'feature', class_id: cls.class_id, id: pa.id})).featured, true);
  const dump = await as(teacher, {op: 'export', class_id: cls.class_id});
  assert.ok(dump.prompts.length >= 2);
  assert.equal(JSON.stringify(dump).includes('@example.com'), false);   // 驗收 11：不含 email
  assert.equal(JSON.stringify(dump).includes('學生A'), false);          // 也不含真名
  await assert.rejects(as(a, {op: 'export', class_id: cls.class_id}), /只有老師/);

  // 學期末清除個資，內容保留
  await as(teacher, {op: 'purge_identities', class_id: cls.class_id});
  const purged = await as(teacher, {op: 'roster', class_id: cls.class_id});
  assert.equal(purged.members.every((x: any) => x.email === '(已清除)' && !x.full_name), true);
  assert.equal((await as(a, {op: 'list', class_id: cls.class_id})).length > 0, true);
  await db.close();
});

test('班級版：跨班隔離、一人多班、人數上限、重產代碼、限流（驗收 6、10、13、14）', async () => {
  const {db, as, user, makeClass} = await setup();
  const richard = await user('richard@example.com', 'Richard');
  const artemis = await user('artemis@example.com', 'Artemis');
  const kid = await user('kid@example.com', '學生');
  const A = await makeClass('Richard 的班', 'richard@example.com', 1);
  const B = await makeClass('Artemis 的班', 'artemis@example.com', 1);

  // 兩班的老師互相看不到對方的班（驗收 13）
  for (const op of ['roster', 'list', 'export', 'task_list'])
    await assert.rejects(as(richard, {op, class_id: B.class_id}), /不屬於這個班級/, op);
  await assert.rejects(as(richard, {op: 'approve', class_id: B.class_id, member_id: crypto.randomUUID()}), /不屬於這個班級/);
  await assert.rejects(as(richard, {op: 'rotate_code', class_id: B.class_id}), /不屬於這個班級/);

  // 同一個人：A 班學生、B 班老師（驗收 14）
  await as(artemis, {op: 'join_request', class_code: A.code});
  const inA = (await as(richard, {op: 'roster', class_id: A.class_id})).members.find((x: any) => x.email === 'artemis@example.com');
  await as(richard, {op: 'approve', class_id: A.class_id, member_id: inA.id});
  await as(artemis, {op: 'set_nickname', class_id: A.class_id, nickname: 'A班的我'});
  const classes = (await as(artemis, {op: 'me'})).classes;
  assert.equal(classes.length, 2);
  assert.deepEqual(classes.map((c: any) => c.role).sort(), ['student', 'teacher']);
  // 在 A 班是學生 → 不能用老師的操作；在 B 班可以
  await assert.rejects(as(artemis, {op: 'roster', class_id: A.class_id}), /只有老師/);
  assert.ok((await as(artemis, {op: 'roster', class_id: B.class_id})).members.length >= 1);

  // A 班的 prompt 在 B 班讀不到（驗收 6）
  const p = await as(artemis, {op: 'save', class_id: A.class_id, item: item('A 班的', 'A 班的內容，只有 A 班看得到')});
  assert.equal((await as(artemis, {op: 'list', class_id: B.class_id})).length, 0);
  await assert.rejects(as(kid, {op: 'list', class_id: A.class_id}), /不屬於這個班級/);
  // B 班老師不能刪 A 班的東西（連 id 都帶了也不行）
  await assert.rejects(as(artemis, {op: 'delete', class_id: B.class_id, id: p.id}), /找不到這個 Prompt/);

  // 人數上限與重產代碼（驗收 10）
  await db.query('UPDATE public.classroom SET max_members=3 WHERE id=$1', [A.class_id]);
  await as(kid, {op: 'join_request', class_code: A.code});          // 第 3 位，剛好額滿
  const fresh = await user('late@example.com', '晚到的');
  await assert.rejects(as(fresh, {op: 'join_request', class_code: A.code}), /人數已滿/);
  const kidRow = (await as(richard, {op: 'roster', class_id: A.class_id})).members.find((x: any) => x.email === 'kid@example.com');
  await as(richard, {op: 'approve', class_id: A.class_id, member_id: kidRow.id});
  await db.query('UPDATE public.classroom SET max_members=2 WHERE id=$1', [A.class_id]);
  await as(richard, {op: 'remove_member', class_id: A.class_id, member_id: kidRow.id});
  await assert.rejects(as(kid, {op: 'join_request', class_code: A.code}), /已被移出/);
  const rotated = await as(richard, {op: 'rotate_code', class_id: A.class_id});
  assert.notEqual(rotated.code, A.code);
  await assert.rejects(as(fresh, {op: 'join_request', class_code: A.code}), /找不到這個班級代碼/);

  // 寫入限流
  for (let i = 0; i < 59; i++) await db.query('INSERT INTO public.write_log(member_id) VALUES($1)', [inA.id]);
  await assert.rejects(as(artemis, {op: 'save', class_id: A.class_id, item: item('太多', '這一筆應該被限流擋下來')}), /太頻繁/);
  await db.close();
});

test('班級版 SQL 不含寫死的管理者或全域查詢（驗收 15）', async () => {
  const sql = await readFile(new URL('../supabase/class/004_class.sql', import.meta.url), 'utf8');
  // 每個讀寫 prompt 的地方都必須同時限制 class_id
  for (const line of sql.split('\n')) {
    if (/FROM public\.prompt\b/.test(line) && !/class_id/.test(line) && !/prompt_output/.test(line))
      assert.fail('查詢沒有限制 class_id：' + line.trim());
  }
  assert.equal(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/.test(
    sql.replace(/00000000-0000-4000-8000-000000000001/g, '')), false, '不應有寫死的使用者 uid');
});
