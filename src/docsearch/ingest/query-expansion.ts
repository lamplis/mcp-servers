import { fetch } from 'undici';

import { CONFIG } from '../shared/config.js';

interface OpenAIChatResponse {
  readonly choices: Array<{
    readonly message?: {
      readonly content?: string;
    };
  }>;
}

interface QueryExpansionPayload {
  readonly queries?: unknown;
}

const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_EXPANSIONS = 3;

function extractQueries(raw: string, originalQuery: string): string[] {
  try {
    const parsed = JSON.parse(raw) as QueryExpansionPayload;
    const queries = Array.isArray(parsed.queries) ? parsed.queries : [];
    const normalizedOriginal = originalQuery.trim().toLowerCase();

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const item of queries) {
      if (typeof item !== 'string') {
        continue;
      }
      const trimmed = item.trim();
      if (!trimmed) {
        continue;
      }
      const key = trimmed.toLowerCase();
      if (key === normalizedOriginal || seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(trimmed);
      if (deduped.length >= MAX_EXPANSIONS) {
        break;
      }
    }

    return deduped;
  } catch {
    return [];
  }
}

export async function expandQuery(query: string): Promise<string[]> {
  if (process.env.NODE_ENV === 'test') {
    return [];
  }

  if (!CONFIG.OPENAI_API_KEY) {
    return [];
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const baseURL = CONFIG.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.OPENAI_QUERY_EXPANSION_MODEL || DEFAULT_MODEL;

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
              'Generate 2-3 short alternative search queries for the user query. Return JSON only: {"queries":["..."]}.',
          },
          { role: 'user', content: trimmed },
        ],
        max_tokens: 120,
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const content = data.choices?.[0]?.message?.content ?? '';
    return extractQueries(content, trimmed);
  } catch {
    return [];
  }
}
