import type { SearchResult } from './adapters/index.js';

export interface RrfList {
  readonly results: SearchResult[];
  readonly weight?: number;
}

export function reciprocalRankFusion(lists: readonly RrfList[], k: number = 60): SearchResult[] {
  const scores = new Map<number, { score: number; result: SearchResult }>();

  for (const list of lists) {
    const weight = list.weight ?? 1;
    list.results.forEach((result, index) => {
      const rankScore = weight / (k + index + 1);
      const existing = scores.get(result.chunk_id);
      scores.set(result.chunk_id, {
        score: (existing?.score ?? 0) + rankScore,
        result: existing?.result ?? result,
      });
    });
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));
}
