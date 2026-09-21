import pg from 'pg';
import { type Filters, type Hit, type Prompt, type Query, type Store, type Usage, validateEmbedding, validateExtracted } from './domain.ts';

function promptRow(row: any): Prompt {
  const {category_id,search_text,signal,...rest} = row;
  return {...rest,embedding:typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding,created_at:new Date(row.created_at).toISOString(),updated_at:new Date(row.updated_at).toISOString()};
}
export class PostgresStore implements Store {
  pool: pg.Pool;
  constructor(connectionString: string) { this.pool = new pg.Pool({connectionString,max:8,connectionTimeoutMillis:5000}); }
  async asUser<T>(userId: string, run: (client:pg.PoolClient) => Promise<T>): Promise<T> {
    if (!/^[a-f0-9-]{36}$/i.test(userId)) throw new Error('userId 格式錯誤');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id',$1,true), set_config('statement_timeout','5000',true)",[userId]);
      const result = await run(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async owned(userId: string): Promise<Prompt[]> {
    return this.asUser(userId,async c => (await c.query('SELECT p.*, c.name AS category FROM prompt p JOIN category c ON c.id=p.category_id WHERE author_id=$1',[userId])).rows.map(promptRow));
  }
  async accept(userId: string, prompts: Prompt[]): Promise<void> {
    await this.asUser(userId,async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[userId]);
      for (const p of prompts) {
        if (p.author_id !== userId) throw new Error('無权寫入其他作者資料');
        if (p.state === 'active') validateExtracted(p);
        validateEmbedding(p.embedding);
        const fields = ['id','title','body','summary','use_case','model_hint','variables','tags','lang','visibility','author_id','source','quality_score','use_count','fork_of','embedding','embedding_model','normalized_hash','simhash','premium','state','created_at','updated_at','source_body'] as const;
        const values: unknown[] = fields.map(k => k === 'embedding' || k === 'variables' ? JSON.stringify(p[k]) : p[k]);
        values.push(p.category);
        // Category lookup must resolve exactly one fixed root; a missing category fails the transaction.
        const result = await client.query(`INSERT INTO prompt (${fields.join(',')}, category_id, search_text)
          VALUES (${fields.map((_,i) => '$'+(i+1)).join(',')}, (SELECT id FROM category WHERE name=$25 AND parent_id IS NULL), '')
          ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,fork_of=EXCLUDED.fork_of,updated_at=EXCLUDED.updated_at
          WHERE prompt.author_id=$11 RETURNING id`,values);
        if (result.rowCount !== 1) throw new Error('無權修改資料');
      }
    });
  }
  async recall(kind: 'vector'|'lexical'|'exact', userId: string, q: Query, embedding: number[], model: string, filters: Filters): Promise<Hit[]> {
    return this.asUser(userId,async client => {
      const values: unknown[] = [userId, filters.category ?? null, filters.tag ?? null, filters.model ?? null];
      const visible = "p.state='active' AND (p.author_id=$1 OR p.visibility='public') AND ($2::text IS NULL OR c.name=$2) AND ($3::text IS NULL OR p.tags @> ARRAY[$3::text]) AND ($4::text IS NULL OR p.model_hint @> ARRAY[$4::text])";
      let sql: string;
      if (kind === 'vector') {
        validateEmbedding(embedding); values.push(JSON.stringify(embedding),model);
        // ORDER BY distance directly is required for the HNSW index path.
        sql = `SELECT p.*,c.name AS category,1-(p.embedding <=> $5::vector) AS signal FROM prompt p JOIN category c ON c.id=p.category_id WHERE ${visible} AND p.embedding_model=$6 AND 1-(p.embedding <=> $5::vector)>0.18 ORDER BY p.embedding <=> $5::vector LIMIT 50`;
      } else if (kind === 'lexical') {
        if (!q.terms.length) return [];
        values.push(q.terms);
        // Constant LIKE expressions let pg_bigm use its GIN index; likequery escapes %, _ and backslash.
        const matches = q.terms.map((_,i) => `p.search_text LIKE likequery(($5::text[])[${i+1}])`).join(' OR ');
        sql = `SELECT p.*,c.name AS category,(SELECT sum(bigm_similarity(p.search_text,term)) FROM unnest($5::text[]) term) AS signal FROM prompt p JOIN category c ON c.id=p.category_id WHERE ${visible} AND (${matches}) ORDER BY signal DESC,p.id LIMIT 50`;
      } else {
        values.push(q.tags,q.models,q.categories);
        sql = `SELECT p.*,c.name AS category, ((SELECT count(*) FROM unnest(p.tags) t WHERE t=ANY($5::text[])) + 2*(SELECT count(*) FROM unnest(p.model_hint) m WHERE m=ANY($6::text[])) + CASE WHEN c.name=ANY($7::text[]) THEN 1 ELSE 0 END) AS signal FROM prompt p JOIN category c ON c.id=p.category_id WHERE ${visible} AND (p.tags && $5::text[] OR p.model_hint && $6::text[] OR c.name=ANY($7::text[])) ORDER BY signal DESC,p.id LIMIT 50`;
      }
      return (await client.query(sql,values)).rows.map(r => ({prompt:promptRow(r),signal:Number(r.signal)}));
    });
  }
  async history(userId: string, ids: string[]): Promise<Usage[]> {
    if (!ids.length) return [];
    return this.asUser(userId,async c => (await c.query('SELECT user_id,prompt_id,max(used_at) AS used_at FROM usage_log WHERE user_id=$1 AND prompt_id=ANY($2::uuid[]) GROUP BY user_id,prompt_id',[userId,ids])).rows.map(r => ({...r,used_at:new Date(r.used_at).toISOString(),filled_vars:{}})));
  }
  async unlocked(userId: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    return this.asUser(userId,async c => new Set((await c.query('SELECT prompt_id FROM unlock WHERE user_id=$1 AND prompt_id=ANY($2::uuid[])',[userId,ids])).rows.map(r => r.prompt_id)));
  }
  async close() { await this.pool.end(); }
}
