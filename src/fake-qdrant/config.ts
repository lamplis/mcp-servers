import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLogLevel, parseRetentionDays, type LogLevel } from "./logger.js";

export type EmbeddingProviderMode = "local" | "external";

export const FAKE_QDRANT_SIDECAR = "fake-qdrant-mcp";
export const DEFAULT_FLAG_PAYLOAD_PATTERNS = ["Error converting", "Traceback"];

export interface FakeQdrantConfig {
  httpEnabled: boolean;
  httpHost: string;
  httpPort: number;
  dataDir: string;
  logDir: string | null;
  logLevel: LogLevel;
  logRetentionDays: number;
  embeddingProvider: EmbeddingProviderMode;
  embeddingBaseUrl: string | null;
  embeddingModel: string | null;
  localEmbeddingsTarget: string | null;
  dropEmptyChunks: boolean;
  flagPayloadPatterns: string[];
  slowRequestMs: number;
  takeover: boolean;
}

const DEFAULT_EXTERNAL_MODEL = "bge-large-en-v1.5";

export function packageRootFrom(metaUrl: string): string {
  const here = path.dirname(fileURLToPath(metaUrl));
  return path.basename(here) === "dist" ? path.dirname(here) : here;
}

export function defaultFakeQdrantDataDir(metaUrl = import.meta.url): string {
  return path.resolve(packageRootFrom(metaUrl), "..", "..", "data", "fake-qdrant");
}

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
    dataDir: env.FAKE_QDRANT_DATA_DIR ?? defaultFakeQdrantDataDir(),
    logDir: env.FAKE_QDRANT_LOG_DIR ?? null,
    logLevel: parseLogLevel(env.FAKE_QDRANT_LOG_LEVEL),
    logRetentionDays: parseRetentionDays(env.FAKE_QDRANT_LOG_RETENTION_DAYS),
    embeddingProvider: provider,
    embeddingBaseUrl,
    embeddingModel,
    localEmbeddingsTarget: env.FAKE_QDRANT_LOCAL_EMBEDDINGS_TARGET ?? null,
    dropEmptyChunks: env.FAKE_QDRANT_DROP_EMPTY_CHUNKS === "1",
    flagPayloadPatterns: parseCsv(
      env.FAKE_QDRANT_FLAG_PAYLOAD_PATTERNS,
      DEFAULT_FLAG_PAYLOAD_PATTERNS
    ),
    slowRequestMs: parsePositiveInt(env.FAKE_QDRANT_SLOW_MS, 1000),
    takeover: env.MCP_TAKEOVER !== "0",
  };
}

export function getDefaultExternalModel(): string {
  return DEFAULT_EXTERNAL_MODEL;
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value || !value.trim()) {
    return fallback;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
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
