import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { type AI, type Prompt, type Store, searchable, structuralQuality, validateEmbedding, validateExtracted } from './domain.ts';
import { fingerprint, simhash, similarity } from './text.ts';
import { parseInput } from './parser.ts';

export type ImportPreview = { prompts: Prompt[]; skipped: number; errors: { index: number; message: string }[]; total: number; provider: string };
export async function prepareImport(input: string, source: string, userId: string, ai: AI, store: Store, progress: (done: number, total: number) => void = () => {}): Promise<ImportPreview> {
  const parsed = parseInput(input, source);
  const existing = await store.owned(userId);
  const groups: { body: string; source: string; variants: { body: string; source: string }[]; hash: string; sim: string }[] = [];
  let skipped = 0;
  // Collapse the batch before AI calls; only the longest member is enriched.
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i], hash = fingerprint(item.body), sim = simhash(item.body);
    if (existing.some(p => p.normalized_hash === hash)) { skipped++; continue; }
    const group = groups.find(g => g.hash === hash || similarity(g.sim, sim) > 0.9);
    if (group) {
      if (group.hash === hash) { skipped++; continue; }
      if (item.body.length > group.body.length) { group.variants.push({body: group.body, source: group.source}); Object.assign(group, {...item, hash, sim}); }
      else group.variants.push(item);
    } else groups.push({...item, hash, sim, variants: []});
    if (i % 20 === 0) await setImmediate();
  }
  const prompts: Prompt[] = [], errors: ImportPreview['errors'] = [];
  let cursor = 0, completed = 0;
  progress(0, groups.length);
  async function worker() {
    while (cursor < groups.length) {
      const index = cursor++, group = groups[index];
      try {
        const extracted = await ai.extract(group.body); validateExtracted(extracted);
        const embedding = await ai.embed(searchable(extracted)); validateEmbedding(embedding);
        const now = new Date().toISOString();
        const p: Prompt = {...extracted, id: randomUUID(), author_id: userId, source: group.source, source_body: group.body, visibility: 'private', premium: false, quality_score: structuralQuality(extracted), use_count: 0, fork_of: null, embedding, embedding_model: ai.embeddingModel, simhash: group.sim, normalized_hash: group.hash, created_at: now, updated_at: now, state: 'active'};
        const duplicate = existing.filter(e => e.state === 'active').find(e => similarity(e.simhash, group.sim) > 0.9);
        if (duplicate) {
          if (duplicate.source_body.length >= group.body.length) { p.state = 'duplicate'; p.fork_of = duplicate.id; }
          else prompts.push({...duplicate, state: 'duplicate', fork_of: p.id, updated_at: now});
        }
        prompts.push(p);
        for (const variant of group.variants) {
          // Preserve source text as lineage, excluded from search; it inherits the canonical metadata.
          prompts.push({...p, id: randomUUID(), body: variant.body, source_body: variant.body, variables: [], source: variant.source, simhash: simhash(variant.body), normalized_hash: fingerprint(variant.body), state: 'duplicate', fork_of: p.state === 'active' ? p.id : p.fork_of });
        }
      } catch (error) { errors.push({index, message: error instanceof Error ? error.message : '整理失敗'}); }
      progress(++completed, groups.length);
      await setImmediate();
    }
  }
  await Promise.all(Array.from({length: Math.min(4, groups.length)}, worker));
  return {prompts, skipped, errors, total: parsed.length, provider: ai.embeddingModel};
}
