import type { FtsColumn } from '../store/schema';

/** §6.3 ranking constants (R6.8). Hidden settings `searchie.search.weights.*` may override the weights. */

export type Weights = Record<FtsColumn, number>;

export const DEFAULT_WEIGHTS: Weights = { title: 5, prompt: 4, response: 1, tools: 1.5, files: 2, aux: 0.5 };
export const DEFAULT_RECENCY_BOOST = 0.2;
export const RECENCY_DAYS = 90;
export const NOISE_FACTOR = 0.2;
export const MATCH_COUNT_FACTOR = 0.25;
export const TURNS_PER_SESSION = 3;
export const DEFAULT_PAGE = 50;
export const SNIPPET_TOKENS = 24;

export function mergeWeights(overrides: Partial<Record<string, unknown>> | undefined): Weights {
  const w = { ...DEFAULT_WEIGHTS };
  if (!overrides) return w;
  for (const k of Object.keys(w) as FtsColumn[]) {
    const v = overrides[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) w[k] = v;
  }
  return w;
}

/** Turn score `-bm25 · r · n` given the raw (negative) bm25 value. */
export function turnScore(bm25: number, ts: number, noise: boolean, now: number, beta: number): number {
  const ageDays = Math.max(0, now - ts) / 86_400_000;
  return -bm25 * (1 + beta * Math.exp(-ageDays / RECENCY_DAYS)) * (noise ? NOISE_FACTOR : 1);
}

export const sessionScore = (best: number, matches: number): number => best + MATCH_COUNT_FACTOR * Math.log(matches);
