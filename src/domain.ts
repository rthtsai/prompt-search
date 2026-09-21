export const CATEGORIES = ['寫作', '報告文書', '翻譯與潤稿', '程式', '資料分析', '圖像生成', '影音', '行銷文案', '教學備課', '生活雜務', '角色與人設', '其他'] as const;
export type Category = typeof CATEGORIES[number];
export type Variable = { name: string; label: string; example: string; required: boolean };
export type Extracted = {
  title: string; body: string; summary: string; use_case: string; category: Category;
  tags: string[]; lang: 'zh-Hant' | 'zh-Hans' | 'en'; model_hint: string[]; variables: Variable[];
};
export type Prompt = Extracted & {
  id: string; author_id: string; source: string; source_body: string; visibility: 'private' | 'shared' | 'public';
  premium: boolean; quality_score: number; use_count: number; fork_of: string | null;
  embedding: number[]; embedding_model: string; simhash: string; normalized_hash: string;
  created_at: string; updated_at: string; state: 'active' | 'duplicate';
};
export type Usage = { user_id: string; prompt_id: string; used_at: string; filled_vars: Record<string, string> };
export type Query = { original: string; text: string; terms: string[]; tags: string[]; categories: string[]; models: string[]; recent: boolean };
export type Filters = { category?: string; tag?: string; model?: string };
export type Hit = { prompt: Prompt; signal: number };
export interface AI {
  readonly embeddingModel: string;
  extract(body: string): Promise<Extracted>;
  embed(text: string): Promise<number[]>;
}
export interface Store {
  owned(userId: string): Promise<Prompt[]>;
  accept(userId: string, prompts: Prompt[]): Promise<void>;
  recall(kind: 'vector' | 'lexical' | 'exact', userId: string, query: Query, embedding: number[], model: string, filters: Filters): Promise<Hit[]>;
  history(userId: string, ids: string[]): Promise<Usage[]>;
  unlocked(userId: string, ids: string[]): Promise<Set<string>>;
}
export function validateEmbedding(value: unknown): asserts value is number[] {
  if (!Array.isArray(value) || value.length !== 1536 || !value.every(v => typeof v === 'number' && Number.isFinite(v)) || value.every(v => v === 0)) throw new Error('向量必須是 1536 維有限數值，且不可全為 0');
}
export function validateExtracted(value: unknown): asserts value is Extracted {
  if (!value || typeof value !== 'object') throw new Error('AI 整理格式錯誤');
  const p = value as Extracted;
  for (const key of ['title','body','summary','use_case'] as const) if (typeof p[key] !== 'string' || !p[key].trim()) throw new Error(`缺少 ${key}`);
  if (p.body.length < 20 || p.body.length > 24000 || p.title.length > 160) throw new Error('整理結果長度不合法');
  if (!CATEGORIES.includes(p.category) || !['zh-Hant','zh-Hans','en'].includes(p.lang)) throw new Error('分類或語言不合法');
  for (const a of [p.tags, p.model_hint]) if (!Array.isArray(a) || a.length > 20 || a.some(v => typeof v !== 'string' || !v.trim() || v.length > 100)) throw new Error('標籤格式錯誤');
  if (!Array.isArray(p.variables) || p.variables.length > 40) throw new Error('變數格式錯誤');
  const names = new Set<string>();
  for (const v of p.variables) {
    if (!v || typeof v.name !== 'string' || !/^[\p{L}\p{N}_ -]{1,60}$/u.test(v.name) || v.name !== v.name.trim() || typeof v.label !== 'string' || typeof v.example !== 'string' || typeof v.required !== 'boolean' || names.has(v.name)) throw new Error('變數格式錯誤或重複');
    names.add(v.name);
  }
  const placeholders = new Set([...p.body.matchAll(/\{\{([^{}]+)\}\}/g)].map(m => m[1]));
  if ([...names].some(n => !placeholders.has(n)) || [...placeholders].some(n => !names.has(n))) throw new Error('本文與變數定義不一致');
}
export function searchable(p: Extracted): string {
  return [p.title, p.summary, p.use_case, p.tags.join(' '), p.model_hint.join(' '), p.body].join('\n');
}
export function structuralQuality(p: Extracted): number {
  return 0.2 * (Number(p.variables.length > 0) + Number(/請|你是|扮演|write|create|generate/i.test(p.body)) + Number(/格式|表格|條列|json|markdown|輸出|output/i.test(p.body))) / 3;
}
