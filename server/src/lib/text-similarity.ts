import { normalizeName } from './normalize';

export function levenshtein(a: string, b: string): number {
  const s = String(a ?? '');
  const t = String(b ?? '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  let previous = Array.from({ length: t.length + 1 }, (_, i) => i);
  let current = new Array<number>(t.length + 1);

  for (let i = 1; i <= s.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s.charAt(i - 1) === t.charAt(j - 1) ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[t.length];
}

export const levenshteinDistance = levenshtein;

export function levenshteinSimilarity(a: string, b: string): number {
  const s = String(a ?? '');
  const t = String(b ?? '');
  const max = Math.max(s.length, t.length);
  if (max === 0) return 1;
  return 1 - levenshtein(s, t) / max;
}

export function tokenJaccard(a: string, b: string): number {
  const tokensA = new Set(normalizeName(a).split(' ').filter(Boolean));
  const tokensB = new Set(normalizeName(b).split(' ').filter(Boolean));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  if (union === 0) return 0;
  return intersection / union;
}

export const jaccard = tokenJaccard;
export const jaccardSimilarity = tokenJaccard;
export const tokenJaccardSimilarity = tokenJaccard;

export default {
  levenshtein,
  levenshteinDistance,
  levenshteinSimilarity,
  tokenJaccard,
  jaccard,
  jaccardSimilarity,
  tokenJaccardSimilarity,
};