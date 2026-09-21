import { readFile } from 'node:fs/promises';
import { type AI, type Extracted, type Prompt, searchable, structuralQuality, validateExtracted } from './domain.ts';
import { fingerprint, simhash } from './text.ts';
export const DEMO_USER = '11111111-1111-4111-8111-111111111111';
export const OTHER_USER = '22222222-2222-4222-8222-222222222222';
export async function fixtures(ai: AI, userId = DEMO_USER): Promise<Prompt[]> {
  const definitions: Extracted[] = JSON.parse(await readFile(new URL('../fixtures/prompts.json',import.meta.url),'utf8'));
  return Promise.all(definitions.map(async (p,index) => {
    validateExtracted(p);
    return {...p,id:`aaaaaaaa-aaaa-4aaa-8aaa-${String(index+1).padStart(12,'0')}`,author_id:userId,source:'fixtures/prompts.json',source_body:p.body,visibility:'private',premium:false,quality_score:structuralQuality(p),use_count:0,fork_of:null,embedding:await ai.embed(searchable(p)),embedding_model:ai.embeddingModel,simhash:simhash(p.body),normalized_hash:fingerprint(p.body),created_at:'2026-09-21T00:00:00.000Z',updated_at:'2026-09-21T00:00:00.000Z',state:'active'};
  }));
}
