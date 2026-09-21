import type { Query } from './domain.ts';
export const normalize = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
export function tokens(s: string): string[] {
  const result: string[] = [];
  for (const match of s.normalize('NFKC').toLowerCase().matchAll(/[\p{Script=Han}]+|[a-z0-9]+/gu)) {
    const part = match[0];
    if (/\p{Script=Han}/u.test(part)) {
      if (part.length === 1) result.push(part);
      for (let i = 0; i < part.length - 1; i++) result.push(part.slice(i, i + 2));
    } else result.push(part);
  }
  return result;
}
const concepts = [
  { aliases: ['季度報告','季報','季度業績','季度成果'], terms: ['季度報告','季報','季度','報告'], category: '報告文書' },
  { aliases: ['履歷','簡歷','resume','cv'], terms: ['履歷','簡歷','resume'], category: '報告文書' },
  { aliases: ['把文章變短','縮短','精簡','濃縮','摘要','簡短'], terms: ['精簡','縮短','摘要','濃縮'], category: '翻譯與潤稿' },
  { aliases: ['日系','日式','日本風','anime'], terms: ['日系','日式','插畫'], category: '圖像生成' },
];
export function rewrite(original: string): Query {
  if (typeof original !== 'string' || original.length > 24000) throw new Error('搜尋文字不可超過 24,000 字');
  const lower = original.normalize('NFKC').toLowerCase().trim();
  const cleaned = lower.replace(/^(我想要找|我要找|我想找|上次那個|上次用過的|幫我找|那個)/, '').replace(/的$/, '').trim();
  const expanded = concepts.filter(c => c.aliases.some(a => lower.includes(a)));
  const models = ['midjourney','claude','gpt'].filter(m => lower.includes(m));
  const terms = [...new Set([...expanded.flatMap(c => c.terms), ...models, ...tokens(cleaned)])].filter(t => !['那個','我要','要找','上次','寫的'].includes(t)).slice(0, 80);
  return { original, text: [cleaned, ...expanded.flatMap(c => c.terms)].join(' '), terms, categories: [...new Set(expanded.map(c => c.category))], tags: expanded.flatMap(c => c.terms), models, recent: /上次|最近|用過/.test(lower) };
}
export function cosine(a: number[], b: number[]): number {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
export function snippet(text: string, terms: string[]): { text: string; ranges: [number, number][] } {
  const sentences = text.split(/(?<=[。！？\n])/u).filter(Boolean);
  const sortedTerms = [...terms].sort((a,b) => b.length - a.length);
  const score = (s: string) => sortedTerms.reduce((n,t) => n + (s.toLowerCase().includes(t) ? t.length : 0), 0);
  const sentence = sentences.sort((a,b) => score(b) - score(a))[0] ?? '';
  const first = sortedTerms.map(t => sentence.toLowerCase().indexOf(t)).filter(n => n >= 0).sort((a,b) => a-b)[0] ?? 0;
  const start = Math.max(0, first - 50);
  const value = (start ? '…' : '') + sentence.slice(start, start + 220) + (sentence.length > start + 220 ? '…' : '');
  const ranges: [number,number][] = [];
  for (let i = 0; i < value.length;) {
    const term = sortedTerms.find(t => value.toLowerCase().startsWith(t, i));
    if (term) { ranges.push([i, i + term.length]); i += term.length; } else i++;
  }
  // Return text + offsets rather than interpolating untrusted prompt text into HTML.
  return { text: value, ranges };
}
