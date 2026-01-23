import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env, pipeline } from "@xenova/transformers";

import { LruCache } from "./lru.js";
import { Semaphore } from "./semaphore.js";

export type Pooling = "mean" | "cls";

export type EmbedOptions = {
  model: string;
  normalize: boolean;
  pooling: Pooling;
};

export type EmbedResult = {
  model: string;
  normalized: boolean;
  embeddings: number[][];
};

type FeatureExtractionPipeline = Awaited<ReturnType<typeof pipeline>>;

export const DEFAULT_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const DEFAULT_MODEL_CACHE_DIR = "./model-cache";
export const DEFAULT_EMBED_CACHE_SIZE = 1000;
export const DEFAULT_EMBED_CONCURRENCY = 2;

const cacheDir = resolveCacheDir(process.env.MODEL_CACHE_DIR);

env.cacheDir = cacheDir;
env.allowLocalModels = true;
env.useBrowserCache = false;

const embedCacheSize = parsePositiveInt(
  process.env.EMBED_CACHE_SIZE,
  DEFAULT_EMBED_CACHE_SIZE
);
const embedConcurrency = parsePositiveInt(
  process.env.EMBED_CONCURRENCY,
  DEFAULT_EMBED_CONCURRENCY
);
const embedCache = new LruCache<number[]>(embedCacheSize);
const embedSemaphore = new Semaphore(embedConcurrency);

const modelPromises = new Map<string, Promise<FeatureExtractionPipeline>>();

export function getCacheDir(): string {
  return cacheDir;
}

export function getDefaultModelId(): string {
  return process.env.MODEL_ID ?? DEFAULT_MODEL_ID;
}

export function getCacheStats(): { entries: number; capacity: number } {
  return { entries: embedCache.size, capacity: embedCache.capacity };
}

export function getLoadedModels(): string[] {
  return Array.from(modelPromises.keys());
}

export function getConcurrencyLimit(): number {
  return embedConcurrency;
}

export async function prefetchModel(modelId: string): Promise<void> {
  await fs.mkdir(cacheDir, { recursive: true });
  const previousAllowRemote = env.allowRemoteModels;
  env.allowRemoteModels = true;
  try {
    await getPipeline(modelId);
  } finally {
    env.allowRemoteModels = previousAllowRemote ?? false;
  }
}

export async function embedTexts(
  texts: readonly string[],
  options: EmbedOptions
): Promise<EmbedResult> {
  const release = await embedSemaphore.acquire();
  try {
    env.allowRemoteModels = false;
    const model = await getPipeline(options.model);
    const cached: number[][] = [];
    const missing: string[] = [];
    const missingIndices: number[] = [];

    for (let i = 0; i < texts.length; i += 1) {
      const text = texts[i] ?? "";
      const cacheKey = buildCacheKey(text, options);
      const hit = embedCache.get(cacheKey);
      if (hit) {
        cached[i] = hit;
      } else {
        missing.push(text);
        missingIndices.push(i);
      }
    }

    if (missing.length > 0) {
      const fresh = await runEmbeddingPipeline(model, missing, options);
      for (let i = 0; i < fresh.length; i += 1) {
        const vec = fresh[i];
        const index = missingIndices[i] ?? -1;
        if (index >= 0) {
          cached[index] = vec;
          const cacheKey = buildCacheKey(missing[i] ?? "", options);
          embedCache.set(cacheKey, vec);
        }
      }
    }

    const embeddings = cached.map((vec, index) => {
      if (!vec) {
        throw new Error(`Missing embedding for index ${index}`);
      }
      return vec;
    });

    return {
      model: options.model,
      normalized: options.normalize,
      embeddings,
    };
  } catch (error) {
    if (isMissingModelError(error)) {
      throw new Error(
        "Model files not found in cache. Run prefetch_model before offline use."
      );
    }
    throw error;
  } finally {
    release();
  }
}

async function getPipeline(modelId: string): Promise<FeatureExtractionPipeline> {
  const existing = modelPromises.get(modelId);
  if (existing) {
    return existing;
  }
  const created = pipeline("feature-extraction", modelId);
  modelPromises.set(modelId, created);
  created.catch(() => {
    modelPromises.delete(modelId);
  });
  return created;
}

function buildCacheKey(text: string, options: EmbedOptions): string {
  const payload = `${options.model}|${options.normalize}|${options.pooling}|${text}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

async function runEmbeddingPipeline(
  model: FeatureExtractionPipeline,
  texts: readonly string[],
  options: EmbedOptions
): Promise<number[][]> {
  // Convert readonly to mutable array and cast for pipeline compatibility
  const inputTexts = [...texts] as string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (model as any)(inputTexts, {
    pooling: options.pooling,
    normalize: options.normalize,
  });
  return coerceEmbeddings(result, texts.length, options.pooling, options.normalize);
}

function coerceEmbeddings(
  result: unknown,
  expected: number,
  pooling: Pooling,
  normalize: boolean
): number[][] {
  if (Array.isArray(result)) {
    if (result.length === 0) {
      return [];
    }
    const first = result[0];
    if (typeof first === "number" || first instanceof Float32Array) {
      const single = coerceSingleEmbedding(result, pooling);
      return [normalize ? normalizeVector(single) : single];
    }
    const vectors = result.map((item) => coerceSingleEmbedding(item, pooling));
    return vectors.map((vec) => (normalize ? normalizeVector(vec) : vec));
  }

  const tensor = result as { data?: Float32Array; dims?: number[] } | null;
  if (tensor?.data && tensor?.dims) {
    return fromTensor(tensor.data, tensor.dims, pooling, normalize);
  }

  const single = coerceSingleEmbedding(result, pooling);
  if (expected === 1) {
    return [normalize ? normalizeVector(single) : single];
  }
  throw new Error("Unexpected embedding output format");
}

function coerceSingleEmbedding(value: unknown, pooling: Pooling): number[] {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [];
    }
    if (typeof value[0] === "number") {
      return value as number[];
    }
    const tokens = value as number[][];
    return poolTokens(tokens, pooling);
  }

  if (value instanceof Float32Array) {
    return Array.from(value);
  }

  const tensor = value as { data?: Float32Array; dims?: number[] } | null;
  if (tensor?.data && tensor?.dims) {
    const vectors = fromTensor(tensor.data, tensor.dims, pooling, false);
    return vectors[0] ?? [];
  }

  throw new Error("Unsupported embedding output format");
}

function fromTensor(
  data: Float32Array,
  dims: number[],
  pooling: Pooling,
  normalize: boolean
): number[][] {
  if (dims.length === 2) {
    const [batch, hidden] = dims;
    const vectors: number[][] = [];
    for (let i = 0; i < batch; i += 1) {
      const start = i * hidden;
      const slice = Array.from(data.slice(start, start + hidden));
      vectors.push(normalize ? normalizeVector(slice) : slice);
    }
    return vectors;
  }

  if (dims.length === 3) {
    const [batch, tokens, hidden] = dims;
    const vectors: number[][] = [];
    let offset = 0;
    for (let b = 0; b < batch; b += 1) {
      const tokenVectors: number[][] = [];
      for (let t = 0; t < tokens; t += 1) {
        const slice = Array.from(data.slice(offset, offset + hidden));
        tokenVectors.push(slice);
        offset += hidden;
      }
      const pooled = poolTokens(tokenVectors, pooling);
      vectors.push(normalize ? normalizeVector(pooled) : pooled);
    }
    return vectors;
  }

  throw new Error("Unsupported tensor dimensions for embeddings");
}

function poolTokens(tokens: number[][], pooling: Pooling): number[] {
  if (tokens.length === 0) {
    return [];
  }
  if (pooling === "cls") {
    return tokens[0] ?? [];
  }

  const dim = tokens[0]?.length ?? 0;
  const sums = new Array<number>(dim).fill(0);
  for (const token of tokens) {
    for (let i = 0; i < dim; i += 1) {
      sums[i] += token[i] ?? 0;
    }
  }
  return sums.map((value) => value / tokens.length);
}

function normalizeVector(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum) || 1;
  return vector.map((value) => value / norm);
}

function resolveCacheDir(value?: string): string {
  const dir = value ?? DEFAULT_MODEL_CACHE_DIR;
  return path.resolve(process.cwd(), dir);
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function isMissingModelError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("local model") ||
    message.includes("not found") ||
    message.includes("no such file") ||
    message.includes("missing files")
  );
}
