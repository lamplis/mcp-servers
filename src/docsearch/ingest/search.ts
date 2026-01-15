import { getEmbedder } from './embeddings.js';

import type { DatabaseAdapter, SearchResult } from './adapters/index.js';
import type { SourceType } from '../shared/types.js';

export type SearchMode = 'auto' | 'vector' | 'keyword';

const DEFAULT_TOP_K = 15;
const RECENCY_BOOST_DAYS = 60;
const MAX_RECENCY_BOOST = 0.3;
const LATEST_KEYWORDS = [
  'latest',
  'newest',
  'recent',
  'new',
  "what's new",
  'whats new',
  'current',
  'updated',
  'last version',
];

export interface SearchParams {
  readonly query: string;
  readonly topK?: number;
  readonly source?: SourceType;
  readonly repo?: string;
  readonly pathPrefix?: string;
  readonly mode?: SearchMode;
  readonly includeImages?: boolean;
  readonly imagesOnly?: boolean;
  readonly latest?: boolean;
}

function normalizeVersionsInQuery(query: string): string {
  return query.replace(/(\d+)\.(\d+)/g, '$1 $2');
}

function detectLatestIntent(query: string): boolean {
  const lowered = query.toLowerCase();
  return LATEST_KEYWORDS.some((keyword) => lowered.includes(keyword));
}

function applyRecencyBoost(
  results: SearchResult[],
  now: number,
  mode: SearchMode,
): SearchResult[] {
  return results.map((result) => {
    if (!result.mtime) {
      return result;
    }
    const ageMs = now - result.mtime;
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    if (ageDays > RECENCY_BOOST_DAYS) {
      return result;
    }
    const boost = MAX_RECENCY_BOOST * (1 - ageDays / RECENCY_BOOST_DAYS);
    const boostedScore =
      mode === 'vector' ? result.score * (1 - boost) : result.score * (1 + boost);
    return { ...result, score: boostedScore };
  });
}

function filterRecentResults(results: SearchResult[], now: number): SearchResult[] {
  const cutoff = now - RECENCY_BOOST_DAYS * 24 * 60 * 60 * 1000;
  const recent = results.filter((result) => result.mtime !== null && result.mtime >= cutoff);
  return recent.length > 0 ? recent : results;
}

export async function performSearch(
  adapter: DatabaseAdapter,
  params: SearchParams,
): Promise<SearchResult[]> {
  const topK = params.topK ?? DEFAULT_TOP_K;
  const mode = params.mode ?? 'auto';
  const normalizedQuery = normalizeVersionsInQuery(params.query);
  const latestIntent = params.latest ?? detectLatestIntent(normalizedQuery);
  const now = Date.now();

  const filters = {
    ...(params.source && { source: params.source }),
    ...(params.repo && { repo: params.repo }),
    ...(params.pathPrefix && { pathPrefix: params.pathPrefix }),
    ...(params.includeImages !== undefined && { includeImages: params.includeImages }),
    ...(params.imagesOnly !== undefined && { imagesOnly: params.imagesOnly }),
  };

  switch (mode) {
    case 'keyword': {
      const results = await adapter.keywordSearch(normalizedQuery, topK, filters);
      return latestIntent ? filterRecentResults(results, now) : results;
    }

    case 'vector': {
      const embedder = getEmbedder();
      const queryEmbedding = await embedder.embed([normalizedQuery]);
      const firstEmbedding = queryEmbedding[0];
      if (!firstEmbedding) {
        throw new Error('Failed to generate embedding for query');
      }
      const embedding = Array.from(firstEmbedding);
      const results = await adapter.vectorSearch(embedding, topK, filters);
      return latestIntent ? filterRecentResults(results, now) : results;
    }

    case 'auto':
    default: {
      // For auto mode, combine both keyword and vector search
      const [keywordResults, vectorResults] = await Promise.all([
        adapter.keywordSearch(normalizedQuery, Math.ceil(topK / 2), filters),
        (async () => {
          const embedder = getEmbedder();
          const queryEmbedding = await embedder.embed([normalizedQuery]);
          const firstEmbedding = queryEmbedding[0];
          if (!firstEmbedding) {
            throw new Error('Failed to generate embedding for query');
          }
          const embedding = Array.from(firstEmbedding);
          return await adapter.vectorSearch(embedding, Math.ceil(topK / 2), filters);
        })(),
      ]);

      // Combine and deduplicate results by chunk_id, preferring keyword matches
      const resultMap = new Map<number, SearchResult>();

      // Add vector results first
      for (const result of vectorResults) {
        resultMap.set(result.chunk_id, result);
      }

      // Add keyword results, overwriting vector results for the same chunk
      for (const result of keywordResults) {
        resultMap.set(result.chunk_id, result);
      }

      let results = Array.from(resultMap.values());
      if (latestIntent) {
        results = filterRecentResults(results, now);
      }
      results = applyRecencyBoost(results, now, mode);
      return results
        .sort((a, b) => {
          // Sort by score descending (heuristic)
          return b.score - a.score;
        })
        .slice(0, topK);
    }
  }
}
