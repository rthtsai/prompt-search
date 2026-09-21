import { type Filters, type Hit, type Prompt, type Query, type Store, type Usage, searchable } from './domain.ts';
import { cosine, tokens } from './text.ts';

/** Test/demo reference implementation. Production uses PostgreSQL + pg_bigm. */
export class MemoryStore implements Store {
  prompts: Prompt[]; usages: Usage[]; unlocks: {user_id:string;prompt_id:string}[];
  constructor(prompts: Prompt[] = [], usages: Usage[] = [], unlocks: {user_id:string;prompt_id:string}[] = []) { this.prompts = structuredClone(prompts); this.usages = usages; this.unlocks = unlocks; }
  async owned(userId: string) { return structuredClone(this.prompts.filter(p => p.author_id === userId)); }
  async accept(userId: string, incoming: Prompt[]) {
    const next = structuredClone(this.prompts);
    for (const p of incoming) {
      if (p.author_id !== userId) throw new Error('無權寫入其他作者資料');
      const index = next.findIndex(e => e.id === p.id);
      if (index >= 0 && next[index].author_id !== userId) throw new Error('無權修改資料');
      if (next.some(e => e.author_id === userId && e.normalized_hash === p.normalized_hash && e.id !== p.id)) throw new Error('匯入內容已存在，請重新產生預覽');
      if (index >= 0) next[index] = structuredClone(p); else next.push(structuredClone(p));
    }
    for (const p of next) if (p.fork_of && !next.some(e => e.id === p.fork_of)) throw new Error('找不到來源 prompt');
    this.prompts = next;
  }
  async recall(kind: 'vector'|'lexical'|'exact', userId: string, q: Query, vector: number[], model: string, filters: Filters): Promise<Hit[]> {
    const visible = this.prompts.filter(p => p.state === 'active' && (p.author_id === userId || p.visibility === 'public') && (!filters.category || p.category === filters.category) && (!filters.tag || p.tags.includes(filters.tag)) && (!filters.model || p.model_hint.includes(filters.model)));
    const docs = visible.map(p => tokens(searchable(p)));
    const lengths = docs.map(t => t.length), avg = lengths.reduce((a,b) => a+b,0) / (docs.length || 1) || 1;
    const queryTokens = [...new Set(tokens(q.terms.join(' ')))];
    return visible.map((prompt,i) => {
      let signal = 0;
      if (kind === 'vector' && prompt.embedding_model === model) signal = cosine(prompt.embedding, vector);
      if (kind === 'exact') signal = q.tags.filter(t => prompt.tags.some(pt => pt.toLowerCase() === t)).length + q.models.filter(m => prompt.model_hint.includes(m)).length * 2 + Number(q.categories.includes(prompt.category));
      if (kind === 'lexical') for (const t of queryTokens) {
        const tf = docs[i].filter(v => v === t).length;
        const df = docs.filter(d => d.includes(t)).length;
        signal += Math.log(1 + (docs.length - df + 0.5) / (df + 0.5)) * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * lengths[i] / avg));
      }
      return {prompt:structuredClone(prompt),signal};
    }).filter(h => h.signal > (kind === 'vector' ? 0.18 : 0)).sort((a,b) => b.signal - a.signal || a.prompt.id.localeCompare(b.prompt.id)).slice(0,50);
  }
  async history(userId: string, ids: string[]) { return this.usages.filter(u => u.user_id === userId && ids.includes(u.prompt_id)); }
  async unlocked(userId: string, ids: string[]) { return new Set(this.unlocks.filter(u => u.user_id === userId && ids.includes(u.prompt_id)).map(u => u.prompt_id)); }
}
