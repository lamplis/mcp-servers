import { getEmbedder } from './embeddings.js';
import { expandQuery } from './query-expansion.js';
import { reciprocalRankFusion } from './rrf.js';

import type { DatabaseAdapter, SearchFilters, SearchResult } from './adapters/index.js';
import type { SourceType } from '../shared/types.js';

export type SearchMode = 'auto' | 'vector' | 'keyword';

const DEFAULT_TOP_K = 15;
const CANDIDATE_MULTIPLIER = 2;
const RRF_K = 60;
const MAX_EXPANDED_QUERIES = 3;
const EXPANDED_QUERY_WEIGHT = 0.6;
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

function applyRecencyBoost(results: SearchResult[], now: number): SearchResult[] {
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
    return { ...result, score: result.score * (1 + boost) };
  });
}

function filterRecentResults(results: SearchResult[], now: number): SearchResult[] {
  const cutoff = now - RECENCY_BOOST_DAYS * 24 * 60 * 60 * 1000;
  const recent = results.filter((result) => result.mtime !== null && result.mtime >= cutoff);
  return recent.length > 0 ? recent : results;
}

function uniqueQueries(queries: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const query of queries) {
    const trimmed = query.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

async function runVectorSearch(
  adapter: DatabaseAdapter,
  normalizedQuery: string,
  limit: number,
  filters: SearchFilters,
): Promise<SearchResult[]> {
  const embedder = getEmbedder();
  const queryEmbedding = await embedder.embed([normalizedQuery]);
  const firstEmbedding = queryEmbedding[0];
  if (!firstEmbedding) {
    throw new Error('Failed to generate embedding for query');
  }
  const embedding = Array.from(firstEmbedding);
  return adapter.vectorSearch(embedding, limit, filters);
}

async function runKeywordSearch(
  adapter: DatabaseAdapter,
  normalizedQuery: string,
  rawQuery: string,
  limit: number,
  filters: SearchFilters,
): Promise<SearchResult[]> {
  const expandedQueries = await expandQuery(rawQuery);
  const normalizedExpansions = expandedQueries.map((query) => normalizeVersionsInQuery(query));
  const allQueries = uniqueQueries([normalizedQuery, ...normalizedExpansions]).slice(
    0,
    1 + MAX_EXPANDED_QUERIES,
  );

  if (allQueries.length === 1) {
    return adapter.keywordSearch(allQueries[0] ?? normalizedQuery, limit, filters);
  }

  const resultsByQuery = await Promise.all(
    allQueries.map((query) => adapter.keywordSearch(query, limit, filters)),
  );

  const lists = resultsByQuery.map((results, index) => ({
    results,
    weight: index === 0 ? 1 : EXPANDED_QUERY_WEIGHT,
  }));

  return reciprocalRankFusion(lists, RRF_K);
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
      const results = await runKeywordSearch(adapter, normalizedQuery, params.query, topK, filters);
      return latestIntent ? filterRecentResults(results, now) : results;
    }

    case 'vector': {
      const results = await runVectorSearch(adapter, normalizedQuery, topK, filters);
      return latestIntent ? filterRecentResults(results, now) : results;
    }

    case 'auto':
    default: {
      const candidateLimit = topK * CANDIDATE_MULTIPLIER;
      const [keywordResults, vectorResults] = await Promise.all([
        runKeywordSearch(adapter, normalizedQuery, params.query, candidateLimit, filters),
        runVectorSearch(adapter, normalizedQuery, candidateLimit, filters),
      ]);

      let results = reciprocalRankFusion(
        [
          { results: keywordResults },
          { results: vectorResults },
        ],
        RRF_K,
      );
      if (latestIntent) {
        results = filterRecentResults(results, now);
      }
      results = applyRecencyBoost(results, now);
      return results
        .sort((a, b) => {
          // Sort by score descending (heuristic)
          return b.score - a.score;
        })
        .slice(0, topK);
    }
  }
}
