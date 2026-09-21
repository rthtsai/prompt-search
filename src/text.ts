import { createHash } from 'node:crypto';
import { normalize, tokens } from './text-shared.ts';
export { normalize, tokens, rewrite, cosine, snippet } from './text-shared.ts';
export const fingerprint = (s: string) => createHash('sha256').update(normalize(s)).digest('hex');
export function simhash(s: string): string {
  const weights = new Array<number>(64).fill(0);
  for (const token of tokens(normalize(s))) {
    const h = createHash('sha256').update(token).digest().readBigUInt64BE();
    for (let i = 0; i < 64; i++) weights[i] += (h >> BigInt(i)) & 1n ? 1 : -1;
  }
  let hash = 0n;
  weights.forEach((w, i) => { if (w > 0) hash |= 1n << BigInt(i); });
  return hash.toString(16).padStart(16, '0');
}
export function similarity(a: string, b: string): number {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b), count = 0;
  while (x) { x &= x - 1n; count++; }
  return 1 - count / 64;
}

