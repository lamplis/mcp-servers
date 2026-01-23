import { fetch } from 'undici';

import { CONFIG } from '../shared/config.js';
import type { SearchResult } from './adapters/index.js';

interface OpenAIChatResponse {
  readonly choices: Array<{
    readonly message?: {
      readonly content?: string;
    };
  }>;
}

interface RerankPayload {
  readonly ranking?: unknown;
}

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_MAX_CANDIDATES = 20;

function parseRanking(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as RerankPayload;
    if (!Array.isArray(parsed.ranking)) {
      return [];
    }
    return parsed.ranking
      .map((value) => (typeof value === 'number' ? value : Number(value)))
      .filter((value) => Number.isFinite(value));
  } catch {
    return [];
  }
}

export async function rerankResults(
  query: string,
  results: SearchResult[],
  maxCandidates: number = DEFAULT_MAX_CANDIDATES,
): Promise<SearchResult[]> {
  if (!CONFIG.OPENAI_API_KEY || results.length <= 1) {
    return results;
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return results;
  }

  const candidates = results.slice(0, Math.min(maxCandidates, results.length));
  const baseURL = CONFIG.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.OPENAI_RERANK_MODEL || DEFAULT_MODEL;

  const candidateText = candidates
    .map((result) => {
      const title = result.title || result.path || result.uri;
      const snippet = String(result.snippet || '').replace(/\s+/g, ' ').slice(0, 300);
      return `[${result.chunk_id}] ${title}\n${snippet}`;
    })
    .join('\n\n');

  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Rank the document snippets by relevance to the query. Return JSON only: {"ranking":[chunk_id,...]}.',
          },
          {
            role: 'user',
            content: `Query: ${trimmed}\n\nDocuments:\n${candidateText}`,
          },
        ],
        max_tokens: 200,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      return results;
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const content = data.choices?.[0]?.message?.content ?? '';
    const ranking = parseRanking(content);
    if (ranking.length === 0) {
      return results;
    }

    const candidateMap = new Map<number, SearchResult>(
      candidates.map((result) => [result.chunk_id, result]),
    );
    const seen = new Set<number>();
    const reordered: SearchResult[] = [];

    for (const id of ranking) {
      const result = candidateMap.get(id);
      if (result && !seen.has(id)) {
        reordered.push(result);
        seen.add(id);
      }
    }

    const remainingCandidates = candidates.filter((result) => !seen.has(result.chunk_id));
    const remainder = results.slice(candidates.length);
    return [...reordered, ...remainingCandidates, ...remainder];
  } catch {
    return results;
  }
}
