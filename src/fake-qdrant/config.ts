export type EmbeddingProviderMode = "local" | "external";

export interface FakeQdrantConfig {
  httpEnabled: boolean;
  httpHost: string;
  httpPort: number;
  dataDir: string;
  sqliteVecDir: string | null;
  embeddingProvider: EmbeddingProviderMode;
  embeddingBaseUrl: string | null;
  embeddingModel: string | null;
  localEmbeddingsTarget: string | null;
}

const DEFAULT_EXTERNAL_MODEL = "bge-large-en-v1.5";

export function loadConfig(
  env: Record<string, string | undefined> = process.env
): FakeQdrantConfig {
  const providerRaw = env.FAKE_QDRANT_EMBEDDING_PROVIDER ?? "local";
  const provider = parseProviderMode(providerRaw);
  const embeddingBaseUrl = env.FAKE_QDRANT_EMBEDDING_BASE_URL ?? null;
  const embeddingModel = env.FAKE_QDRANT_EMBEDDING_MODEL ?? null;

  if (provider === "external") {
    if (!embeddingBaseUrl) {
      throw new ConfigError(
        "FAKE_QDRANT_EMBEDDING_BASE_URL is required when FAKE_QDRANT_EMBEDDING_PROVIDER=external"
      );
    }
  }

  return {
    httpEnabled: env.FAKE_QDRANT_ENABLED === "1",
    httpHost: env.FAKE_QDRANT_HTTP_HOST ?? "127.0.0.1",
    httpPort: parsePort(env.FAKE_QDRANT_HTTP_PORT, 6333),
    dataDir: env.FAKE_QDRANT_DATA_DIR ?? "./data/fake-qdrant",
    sqliteVecDir: env.FAKE_QDRANT_SQLITE_VEC_DIR ?? null,
    embeddingProvider: provider,
    embeddingBaseUrl,
    embeddingModel,
    localEmbeddingsTarget: env.FAKE_QDRANT_LOCAL_EMBEDDINGS_TARGET ?? null,
  };
}

export function getDefaultExternalModel(): string {
  return DEFAULT_EXTERNAL_MODEL;
}

function parseProviderMode(value: string): EmbeddingProviderMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "local" || normalized === "external") {
    return normalized;
  }
  throw new ConfigError(
    `Invalid FAKE_QDRANT_EMBEDDING_PROVIDER: "${value}". Must be "local" or "external".`
  );
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
