import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

import {
  type FakeQdrantConfig,
  getAllowedExternalModel,
  ConfigError,
} from "./config.js";

export interface EmbedResult {
  model: string;
  embeddings: number[][];
  dimensions: number;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<EmbedResult>;
  readonly model: string;
  readonly dimensions: number | null;
  readonly mode: "local" | "external";
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly mode = "local" as const;
  private _dimensions: number | null = null;

  constructor(
    private readonly baseUrl: string,
    readonly model: string
  ) {}

  get dimensions(): number | null {
    return this._dimensions;
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const body = JSON.stringify({
      input: texts,
      model: this.model,
    });

    const response = await httpPost(
      `${this.baseUrl}/v1/embeddings`,
      body
    );

    const data = JSON.parse(response) as OpenAIEmbeddingResponse;
    const embeddings = data.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);

    const dimensions = embeddings[0]?.length ?? 0;
    this._dimensions = dimensions;

    return {
      model: data.model ?? this.model,
      embeddings,
      dimensions,
    };
  }
}

export class ExternalEmbeddingProvider implements EmbeddingProvider {
  readonly mode = "external" as const;
  private _dimensions: number | null = null;

  constructor(
    private readonly baseUrl: string,
    readonly model: string
  ) {
    if (model !== getAllowedExternalModel()) {
      throw new ConfigError(
        `External embedding model must be "${getAllowedExternalModel()}", got "${model}".`
      );
    }
  }

  get dimensions(): number | null {
    return this._dimensions;
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const body = JSON.stringify({
      input: texts,
      model: this.model,
    });

    const response = await httpPost(
      `${this.baseUrl}/v1/embeddings`,
      body
    );

    const data = JSON.parse(response) as OpenAIEmbeddingResponse;
    const embeddings = data.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);

    const dimensions = embeddings[0]?.length ?? 0;
    this._dimensions = dimensions;

    return {
      model: data.model ?? this.model,
      embeddings,
      dimensions,
    };
  }
}

export function createProvider(config: FakeQdrantConfig): EmbeddingProvider | null {
  if (config.embeddingProvider === "local") {
    const target = config.localEmbeddingsTarget ?? "http://127.0.0.1:3000";
    return new LocalEmbeddingProvider(target, "Xenova/all-MiniLM-L6-v2");
  }

  if (config.embeddingProvider === "external") {
    if (!config.embeddingBaseUrl) {
      throw new ConfigError(
        "FAKE_QDRANT_EMBEDDING_BASE_URL is required for external provider"
      );
    }
    const model = config.embeddingModel ?? getAllowedExternalModel();
    return new ExternalEmbeddingProvider(config.embeddingBaseUrl, model);
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

function httpPost(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new Error(
                `Embedding request failed with status ${res.statusCode}: ${data}`
              )
            );
            return;
          }
          resolve(data);
        });
      }
    );

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
