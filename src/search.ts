import { type AI, type Filters, type Prompt, type Store, validateEmbedding } from './domain.ts';
import { rewrite, snippet } from './text.ts';

export type SearchResult = {
  id:string; title:string; summary:string; category:string; tags:string[]; model_hint:string[];
  author_id:string; locked:boolean; body?:string; variables?:Prompt['variables'];
  highlight:{text:string;ranges:[number,number][]}; score:number; channels:string[];
};
export class SearchService {
  private store: Store; private ai: AI;
  private cache = new Map<string, {at:number; vector:number[]}>();
  constructor(store: Store, ai: AI) { this.store = store; this.ai = ai; }
  async search(userId: string, text: string, filters: Filters = {}, now = Date.now()): Promise<{results:SearchResult[];degraded:boolean;duration_ms:number}> {
    const start = performance.now(), q = rewrite(text);
    if (!q.terms.length || !text.trim()) return {results:[],degraded:false,duration_ms:performance.now()-start};
    let degraded = false;
    const lexical = this.store.recall('lexical', userId, q, [], this.ai.embeddingModel, filters);
    const exact = this.store.recall('exact', userId, q, [], this.ai.embeddingModel, filters);
    const vectorRecall = (async () => {
      let embedding: number[];
      try {
        // Query embeddings are cached per user; prompt bodies never enter a global query cache.
        const key = `${userId}:${this.ai.embeddingModel}:${q.text}`, cached = this.cache.get(key);
        if (cached && Date.now() - cached.at < 300000) embedding = cached.vector;
        else {
          embedding = await this.ai.embed(q.text); validateEmbedding(embedding);
          if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(key,{at:Date.now(),vector:embedding});
        }
      } catch { degraded = true; return []; }
      return this.store.recall('vector', userId, q, embedding, this.ai.embeddingModel, filters);
    })();
    const lists = await Promise.all([vectorRecall, lexical, exact]);
    const candidates = new Map<string, {prompt:Prompt; score:number; channels:string[]}>();
    lists.forEach((list, channel) => list.forEach((hit,index) => {
      const entry = candidates.get(hit.prompt.id) ?? {prompt:hit.prompt,score:0,channels:[]};
      entry.score += 1 / (60 + index + 1); entry.channels.push(['vector','lexical','exact'][channel]);
      candidates.set(hit.prompt.id,entry);
    }));
    const ids = [...candidates.keys()];
    const [history, unlocked] = await Promise.all([this.store.history(userId,ids),this.store.unlocked(userId,ids)]);
    for (const item of candidates.values()) {
      const used = history.filter(h => h.prompt_id === item.prompt.id);
      const last = Math.max(0,...used.map(h => Date.parse(h.used_at)));
      const recency = last ? Math.exp(-Math.max(0,now-last) / (30*86400000)) : 0;
      // Bounded multiplicative signals cannot pull unrelated documents into the result set.
      item.score *= 1 + (used.length ? 0.06 : 0) + recency * (q.recent ? 0.25 : 0.10) + Math.min(0.08,Math.log1p(item.prompt.use_count)*0.008) + Math.min(1,Math.max(0,item.prompt.quality_score))*0.08;
    }
    const results = [...candidates.values()].sort((a,b) => b.score - a.score || a.prompt.id.localeCompare(b.prompt.id)).slice(0,10).map(({prompt:p,score,channels}): SearchResult => {
      const locked = p.author_id !== userId && p.premium && !unlocked.has(p.id);
      return {id:p.id,title:p.title,summary:p.summary,category:p.category,tags:p.tags,model_hint:p.model_hint,author_id:p.author_id,locked,
        ...(locked ? {} : {body:p.body,variables:p.variables}),highlight:snippet(locked ? p.summary : p.body,q.terms),score,channels};
    });
    return {results,degraded,duration_ms:performance.now()-start};
  }
}
