import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

import {
  type FakeQdrantConfig,
  getDefaultExternalModel,
  ConfigError,
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  DEFAULT_EMBEDDING_BATCH,
} from "./config.js";

export interface EmbedResult {
  model: string;
  embeddings: number[][];
  dimensions: number;
}

export interface EmbeddingProviderInfo {
  mode: "local" | "external";
  model: string;
  baseUrlHost: string;
  dim: number | null;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<EmbedResult>;
  describe(): EmbeddingProviderInfo;
  readonly model: string;
  readonly dimensions: number | null;
  readonly mode: "local" | "external";
}

export const EMBEDDING_NOT_CONFIGURED =
  "Embedding provider not configured; set FAKE_QDRANT_EMBEDDING_BASE_URL (+ MODEL/DIM/API_KEY) or pass vector";

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message.startsWith("embedding:") ? message : `embedding: ${message}`);
    this.name = "EmbeddingError";
  }
}

export function resolveEmbeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new ConfigError("Embedding base URL is empty");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigError(`Invalid embedding base URL: ${baseUrl}`);
  }
  const rawPath = parsed.pathname.replace(/\/+$/, "");
  const path = rawPath === "" ? "/v1" : rawPath;
  parsed.pathname = `${path}/embeddings`;
  return parsed.toString();
}

export class OpenAICompatibleProvider implements EmbeddingProvider {
  private _dimensions: number | null;
  readonly endpoint: string;
  readonly baseUrlHost: string;

  constructor(
    readonly mode: "local" | "external",
    private readonly baseUrl: string,
    readonly model: string,
    private readonly apiKey: string | null,
    expectedDim: number | null,
    private readonly timeoutMs: number
  ) {
    this.endpoint = resolveEmbeddingsUrl(baseUrl);
    this._dimensions = expectedDim;
    this.baseUrlHost = hostOf(this.endpoint);
  }

  get dimensions(): number | null {
    return this._dimensions;
  }

  describe(): EmbeddingProviderInfo {
    return {
      mode: this.mode,
      model: this.model,
      baseUrlHost: this.baseUrlHost,
      dim: this._dimensions,
    };
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) {
      return { model: this.model, embeddings: [], dimensions: this._dimensions ?? 0 };
    }

    const embeddings: number[][] = new Array(texts.length);
    let model = this.model;
    for (let offset = 0; offset < texts.length; offset += DEFAULT_EMBEDDING_BATCH) {
      const batch = texts.slice(offset, offset + DEFAULT_EMBEDDING_BATCH);
      const result = await this.embedBatch(batch);
      model = result.model;
      for (let i = 0; i < result.embeddings.length; i += 1) {
        embeddings[offset + i] = result.embeddings[i] ?? [];
      }
    }

    const dimensions = embeddings[0]?.length ?? 0;
    if (this._dimensions != null && dimensions !== this._dimensions) {
      throw new EmbeddingError(
        `Embedding dimension mismatch: expected ${this._dimensions}, got ${dimensions}`
      );
    }
    this._dimensions = dimensions;

    return { model, embeddings, dimensions };
  }

  private async embedBatch(texts: string[]): Promise<EmbedResult> {
    const body = JSON.stringify({
      input: texts,
      model: this.model,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await httpPost(this.endpoint, body, headers, this.timeoutMs);
    const data = JSON.parse(response) as OpenAIEmbeddingResponse;
    if (!Array.isArray(data.data)) {
      throw new EmbeddingError("embedding response missing data[]");
    }
    const ordered = data.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
    if (ordered.length !== texts.length) {
      throw new EmbeddingError(
        `embedding response size mismatch: expected ${texts.length}, got ${ordered.length}`
      );
    }
    const dimensions = ordered[0]?.length ?? 0;
    return {
      model: data.model ?? this.model,
      embeddings: ordered,
      dimensions,
    };
  }
}

export function createProvider(config: FakeQdrantConfig): EmbeddingProvider | null {
  if (config.embeddingProvider === "local") {
    const target = config.localEmbeddingsTarget ?? "http://127.0.0.1:3100";
    return new OpenAICompatibleProvider(
      "local",
      target,
      "Xenova/all-MiniLM-L6-v2",
      config.embeddingApiKey,
      config.embeddingDim,
      config.embeddingTimeoutMs
    );
  }

  if (config.embeddingProvider === "external") {
    if (!config.embeddingBaseUrl) {
      throw new ConfigError(
        "FAKE_QDRANT_EMBEDDING_BASE_URL is required for external provider"
      );
    }
    const model = config.embeddingModel ?? getDefaultExternalModel();
    return new OpenAICompatibleProvider(
      "external",
      config.embeddingBaseUrl,
      model,
      config.embeddingApiKey,
      config.embeddingDim,
      config.embeddingTimeoutMs
    );
  }

  return null;
}

interface OpenAIEmbeddingResponse {
  model?: string;
  data: Array<{
    index: number;
    embedding: number[];
  }>;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function httpPost(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new EmbeddingError(
                `request failed with status ${res.statusCode}: ${data.slice(0, 500)}`
              )
            );
            return;
          }
          resolve(data);
        });
      }
    );

    req.setTimeout(timeoutMs > 0 ? timeoutMs : DEFAULT_EMBEDDING_TIMEOUT_MS, () => {
      req.destroy(new EmbeddingError(`request timed out after ${timeoutMs}ms`));
    });
    req.on("error", (error) => {
      reject(
        error instanceof EmbeddingError
          ? error
          : new EmbeddingError(error instanceof Error ? error.message : String(error))
      );
    });
    req.write(body);
    req.end();
  });
}
