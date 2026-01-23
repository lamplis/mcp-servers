import path from 'node:path';
import { fetch } from 'undici';
import { env, pipeline } from '@xenova/transformers';

import { CONFIG } from '../shared/config.js';

// Type for the feature extraction pipeline
type FeatureExtractionPipeline = Awaited<ReturnType<typeof pipeline>>;

export interface Embedder {
  readonly dim: number;
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
}

interface OpenAIEmbeddingData {
  readonly embedding: readonly number[];
}

interface OpenAIEmbeddingResponse {
  readonly data: readonly OpenAIEmbeddingData[];
}

interface TEIEmbeddingData {
  readonly embedding: readonly number[];
}

interface TEIEmbeddingResponse {
  readonly data: readonly TEIEmbeddingData[];
}

export class OpenAIEmbedder implements Embedder {
  public readonly dim: number;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly maxRetries: number = 5;

  constructor() {
    if (!CONFIG.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY missing');
    }
    this.apiKey = CONFIG.OPENAI_API_KEY;
    this.baseURL = CONFIG.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    this.model = CONFIG.OPENAI_EMBED_MODEL;
    this.dim = CONFIG.OPENAI_EMBED_DIM;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private parseRetryAfter(retryAfter: string | null): number {
    if (!retryAfter) {
      return 0;
    }
    const seconds = parseInt(retryAfter, 10);
    return isNaN(seconds) ? 0 : seconds * 1000; // Convert to milliseconds
  }

  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseURL}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            input: texts,
          }),
        });

        if (response.ok) {
          const data = (await response.json()) as OpenAIEmbeddingResponse;
          return data.data.map((d) => new Float32Array(d.embedding));
        }

        // Handle rate limiting (429) with retry
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get('retry-after');
          const remainingRequests = response.headers.get('x-ratelimit-remaining-requests');
          const remainingTokens = response.headers.get('x-ratelimit-remaining-tokens');
          const resetRequests = response.headers.get('x-ratelimit-reset-requests');
          const resetTokens = response.headers.get('x-ratelimit-reset-tokens');

          let waitTime = this.parseRetryAfter(retryAfterHeader);

          // If no retry-after header, use exponential backoff
          if (waitTime === 0) {
            waitTime = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s, 16s
          }

          console.info(`\n⚠️  Rate limit exceeded (attempt ${attempt + 1}/${this.maxRetries})`);
          if (remainingRequests !== null) {
            console.info(`   Remaining requests: ${remainingRequests}`);
          }
          if (remainingTokens !== null) {
            console.info(`   Remaining tokens: ${remainingTokens}`);
          }
          if (resetRequests !== null) {
            console.info(`   Requests reset in: ${resetRequests}s`);
          }
          if (resetTokens !== null) {
            console.info(`   Tokens reset in: ${resetTokens}s`);
          }
          console.info(`   Waiting ${Math.round(waitTime / 1000)}s before retrying...`);

          if (attempt < this.maxRetries - 1) {
            await this.sleep(waitTime);
            continue;
          }
        }

        // Handle other HTTP errors
        const errorText = await response.text();
        lastError = new Error(`Embeddings API error ${response.status}: ${errorText}`);

        // Don't retry non-rate-limit errors
        throw lastError;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Embeddings API error')) {
          // If it's an HTTP error, don't retry (already handled above)
          throw error;
        }

        // If it's a network error, retry with exponential backoff
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxRetries - 1) {
          const waitTime = Math.pow(2, attempt) * 1000;
          console.info(
            `\n🔄 Network error (attempt ${attempt + 1}/${this.maxRetries}): ${lastError.message}`,
          );
          console.info(`   Retrying in ${Math.round(waitTime / 1000)}s...`);
          await this.sleep(waitTime);
          continue;
        }
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }
}

export class TEIEmbedder implements Embedder {
  public readonly dim: number;
  private readonly endpoint: string;

  constructor() {
    if (!CONFIG.TEI_ENDPOINT) {
      throw new Error('TEI_ENDPOINT missing');
    }
    this.endpoint = CONFIG.TEI_ENDPOINT.replace(/\/$/, '');
    this.dim = CONFIG.OPENAI_EMBED_DIM;
  }

  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: texts }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`TEI error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as TEIEmbeddingResponse;
    return data.data.map((d) => new Float32Array(d.embedding));
  }
}

export class NoOpEmbedder implements Embedder {
  public readonly dim: number = 1536;

  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    // Return zero vectors for testing/when no embeddings are needed
    return texts.map(() => new Float32Array(this.dim).fill(0.1));
  }
}

// Singleton promise for model loading (prevents race conditions)
let localModelPromise: Promise<FeatureExtractionPipeline> | null = null;
let localModelId: string | null = null;

export class LocalEmbedder implements Embedder {
  public readonly dim: number;
  private readonly modelId: string;
  private readonly cacheDir: string;
  private initialized: boolean = false;

  constructor() {
    this.modelId = CONFIG.LOCAL_EMBED_MODEL;
    this.dim = CONFIG.LOCAL_EMBED_DIM;
    this.cacheDir = path.resolve(process.cwd(), CONFIG.LOCAL_MODEL_CACHE_DIR);
  }

  private initializeEnv(): void {
    if (this.initialized) {
      return;
    }
    env.cacheDir = this.cacheDir;
    env.allowLocalModels = true;
    env.useBrowserCache = false;
    // Disable remote access for offline mode - model must be pre-downloaded
    env.allowRemoteModels = false;
    this.initialized = true;
  }

  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    this.initializeEnv();

    // If same model is already loading/loaded, reuse it
    if (localModelPromise && localModelId === this.modelId) {
      return localModelPromise;
    }

    // Create new loading promise
    localModelId = this.modelId;
    localModelPromise = pipeline('feature-extraction', this.modelId);

    // Clear on error so retry is possible
    localModelPromise.catch(() => {
      localModelPromise = null;
      localModelId = null;
    });

    return localModelPromise;
  }

  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    try {
      const model = await this.getPipeline();

      // Convert readonly to mutable array for pipeline
      const inputTexts = [...texts] as string[];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (model as any)(inputTexts, {
        pooling: 'mean',
        normalize: true,
      });

      return this.coerceToFloat32Arrays(result, texts.length);
    } catch (error) {
      if (this.isMissingModelError(error)) {
        throw new Error(
          `Model "${this.modelId}" not found in cache directory "${this.cacheDir}". ` +
            `Download it first with network access, then use offline.`,
        );
      }
      throw error;
    }
  }

  private coerceToFloat32Arrays(result: unknown, expected: number): Float32Array[] {
    // Handle array output
    if (Array.isArray(result)) {
      if (result.length === 0) {
        return [];
      }
      const first = result[0];
      // If first element is a Float32Array, it's an array of embeddings
      if (first instanceof Float32Array) {
        return result as Float32Array[];
      }
      // If first element is a number, it's a single embedding as flat array
      if (typeof first === 'number') {
        return [new Float32Array(result as number[])];
      }
      // Multiple embeddings (array of arrays or other formats)
      return result.map((item) => this.toFloat32Array(item));
    }

    // Handle tensor output
    const tensor = result as { data?: Float32Array; dims?: number[] } | null;
    if (tensor?.data && tensor?.dims) {
      return this.fromTensor(tensor.data, tensor.dims);
    }

    // Single result fallback
    if (expected === 1) {
      return [this.toFloat32Array(result)];
    }

    throw new Error('Unexpected embedding output format');
  }

  private toFloat32Array(value: unknown): Float32Array {
    if (value instanceof Float32Array) {
      return value;
    }
    if (Array.isArray(value)) {
      // Check if it's a nested array (token embeddings) that needs pooling
      if (value.length > 0 && Array.isArray(value[0])) {
        // Mean pooling over tokens
        const tokens = value as number[][];
        const firstToken = tokens[0];
        const dim = firstToken?.length ?? 0;
        const sums = new Float32Array(dim);
        for (const token of tokens) {
          for (let i = 0; i < dim; i++) {
            const sumsVal = sums[i];
            const tokenVal = token[i];
            if (sumsVal !== undefined && tokenVal !== undefined) {
              sums[i] = sumsVal + tokenVal;
            }
          }
        }
        for (let i = 0; i < dim; i++) {
          const sumsVal = sums[i];
          if (sumsVal !== undefined) {
            sums[i] = sumsVal / tokens.length;
          }
        }
        return sums;
      }
      return new Float32Array(value as number[]);
    }

    // Handle tensor-like object
    const tensor = value as { data?: Float32Array; dims?: number[] } | null;
    if (tensor?.data && tensor?.dims) {
      const vecs = this.fromTensor(tensor.data, tensor.dims);
      return vecs[0] ?? new Float32Array(this.dim);
    }

    throw new Error('Unsupported embedding output format');
  }

  private fromTensor(data: Float32Array, dims: number[]): Float32Array[] {
    if (dims.length === 2) {
      // [batch, hidden]
      const batchSize = dims[0] ?? 0;
      const hiddenSize = dims[1] ?? 0;
      const vectors: Float32Array[] = [];
      for (let i = 0; i < batchSize; i++) {
        const start = i * hiddenSize;
        vectors.push(data.slice(start, start + hiddenSize));
      }
      return vectors;
    }

    if (dims.length === 3) {
      // [batch, tokens, hidden] - need to pool
      const batchSize = dims[0] ?? 0;
      const tokenCount = dims[1] ?? 0;
      const hiddenSize = dims[2] ?? 0;
      const vectors: Float32Array[] = [];
      let offset = 0;
      for (let b = 0; b < batchSize; b++) {
        const pooled = new Float32Array(hiddenSize);
        for (let t = 0; t < tokenCount; t++) {
          for (let h = 0; h < hiddenSize; h++) {
            const currentVal = pooled[h] ?? 0;
            const dataVal = data[offset + h] ?? 0;
            pooled[h] = currentVal + dataVal;
          }
          offset += hiddenSize;
        }
        for (let h = 0; h < hiddenSize; h++) {
          const currentVal = pooled[h] ?? 0;
          pooled[h] = currentVal / tokenCount;
        }
        vectors.push(pooled);
      }
      return vectors;
    }

    throw new Error('Unsupported tensor dimensions for embeddings');
  }

  private isMissingModelError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    return (
      message.includes('local model') ||
      message.includes('not found') ||
      message.includes('no such file') ||
      message.includes('missing files')
    );
  }
}

/**
 * Get the embedding dimension for the configured provider.
 * Use this when creating the database schema.
 */
export function getEmbeddingDimension(): number {
  if (CONFIG.EMBEDDINGS_PROVIDER === 'local') {
    return CONFIG.LOCAL_EMBED_DIM;
  }
  // OpenAI and TEI use the same dimension config
  return CONFIG.OPENAI_EMBED_DIM;
}

export function getEmbedder(): Embedder {
  // Local embeddings (default, offline-first)
  if (CONFIG.EMBEDDINGS_PROVIDER === 'local') {
    return new LocalEmbedder();
  }

  // TEI (Text Embeddings Inference) provider
  if (CONFIG.EMBEDDINGS_PROVIDER === 'tei') {
    return new TEIEmbedder();
  }

  // OpenAI provider
  if (CONFIG.EMBEDDINGS_PROVIDER === 'openai') {
    if (!CONFIG.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY required when EMBEDDINGS_PROVIDER is "openai"');
    }
    return new OpenAIEmbedder();
  }

  // Fallback to local embedder
  return new LocalEmbedder();
}
