import { describe, it, expect } from "vitest";
import path from "node:path";
import { loadConfig, ConfigError, getDefaultExternalModel } from "../config.js";

describe("loadConfig", () => {
  it("should return defaults when no env vars are set", () => {
    const config = loadConfig({});
    expect(config.httpEnabled).toBe(false);
    expect(config.httpHost).toBe("127.0.0.1");
    expect(config.httpPort).toBe(6333);
    expect(path.isAbsolute(config.dataDir)).toBe(true);
    expect(config.dataDir.replace(/\\/g, "/")).toMatch(/data\/fake-qdrant$/);
    expect(config.dropEmptyChunks).toBe(false);
    expect(config.takeover).toBe(true);
    expect(config.strictCreate).toBe(false);
    expect(config.logDir).toBeNull();
    expect(config.logLevel).toBe("info");
    expect(config.logRetentionDays).toBe(3);
    expect(config.embeddingProvider).toBe("local");
    expect(config.embeddingBaseUrl).toBeNull();
    expect(config.embeddingModel).toBeNull();
    expect(config.embeddingApiKey).toBeNull();
    expect(config.embeddingDim).toBeNull();
    expect(config.embeddingTimeoutMs).toBe(30_000);
    expect(config.localEmbeddingsTarget).toBeNull();
  });

  it("should parse FAKE_QDRANT_ENABLED=1", () => {
    const config = loadConfig({ FAKE_QDRANT_ENABLED: "1" });
    expect(config.httpEnabled).toBe(true);
  });

  it("should parse custom host and port", () => {
    const config = loadConfig({
      FAKE_QDRANT_HTTP_HOST: "0.0.0.0",
      FAKE_QDRANT_HTTP_PORT: "7333",
    });
    expect(config.httpHost).toBe("0.0.0.0");
    expect(config.httpPort).toBe(7333);
  });

  it("should fall back to default port for invalid values", () => {
    const config = loadConfig({ FAKE_QDRANT_HTTP_PORT: "not_a_number" });
    expect(config.httpPort).toBe(6333);
  });

  it("should parse data dir", () => {
    const config = loadConfig({ FAKE_QDRANT_DATA_DIR: "/tmp/vectors" });
    expect(config.dataDir).toBe("/tmp/vectors");
  });

  it("should parse log dir, level, and retention", () => {
    const config = loadConfig({
      FAKE_QDRANT_LOG_DIR: "C:\\logs\\fake-qdrant",
      FAKE_QDRANT_LOG_LEVEL: "debug",
      FAKE_QDRANT_LOG_RETENTION_DAYS: "5",
    });
    expect(config.logDir).toBe("C:\\logs\\fake-qdrant");
    expect(config.logLevel).toBe("debug");
    expect(config.logRetentionDays).toBe(5);
  });

  it("should fall back for invalid log level and retention", () => {
    const config = loadConfig({
      FAKE_QDRANT_LOG_LEVEL: "verbose",
      FAKE_QDRANT_LOG_RETENTION_DAYS: "nope",
    });
    expect(config.logLevel).toBe("info");
    expect(config.logRetentionDays).toBe(3);
  });

  it("should parse local embedding provider", () => {
    const config = loadConfig({ FAKE_QDRANT_EMBEDDING_PROVIDER: "local" });
    expect(config.embeddingProvider).toBe("local");
  });

  it("should parse external embedding provider with valid config", () => {
    const config = loadConfig({
      FAKE_QDRANT_EMBEDDING_PROVIDER: "external",
      FAKE_QDRANT_EMBEDDING_BASE_URL: "https://api.example.com",
      FAKE_QDRANT_EMBEDDING_MODEL: "bge-large-en-v1.5",
    });
    expect(config.embeddingProvider).toBe("external");
    expect(config.embeddingBaseUrl).toBe("https://api.example.com");
    expect(config.embeddingModel).toBe("bge-large-en-v1.5");
  });

  it("should accept external provider without explicit model (defaults to allowed)", () => {
    const config = loadConfig({
      FAKE_QDRANT_EMBEDDING_PROVIDER: "external",
      FAKE_QDRANT_EMBEDDING_BASE_URL: "https://api.example.com",
    });
    expect(config.embeddingProvider).toBe("external");
  });

  it("should reject external provider without base URL", () => {
    expect(() =>
      loadConfig({ FAKE_QDRANT_EMBEDDING_PROVIDER: "external" })
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ FAKE_QDRANT_EMBEDDING_PROVIDER: "external" })
    ).toThrow("FAKE_QDRANT_EMBEDDING_BASE_URL is required");
  });

  it("should accept external provider with any model name", () => {
    const config = loadConfig({
      FAKE_QDRANT_EMBEDDING_PROVIDER: "external",
      FAKE_QDRANT_EMBEDDING_BASE_URL: "https://api.example.com",
      FAKE_QDRANT_EMBEDDING_MODEL: "text-embedding-3-small",
    });
    expect(config.embeddingModel).toBe("text-embedding-3-small");
  });

  it("should reject invalid provider mode", () => {
    expect(() =>
      loadConfig({ FAKE_QDRANT_EMBEDDING_PROVIDER: "magic" })
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ FAKE_QDRANT_EMBEDDING_PROVIDER: "magic" })
    ).toThrow('Must be "local" or "external"');
  });

  it("should parse local embeddings target", () => {
    const config = loadConfig({
      FAKE_QDRANT_LOCAL_EMBEDDINGS_TARGET: "http://localhost:4000",
    });
    expect(config.localEmbeddingsTarget).toBe("http://localhost:4000");
  });

  it("should parse FAKE_QDRANT_STRICT_CREATE=1", () => {
    const config = loadConfig({ FAKE_QDRANT_STRICT_CREATE: "1" });
    expect(config.strictCreate).toBe(true);
  });

  it("falls back to OPENAI_EMBED_* when FAKE_QDRANT_EMBEDDING_* is unset", () => {
    const config = loadConfig({
      OPENAI_EMBED_BASE_URL: "https://server.com/v1/openai",
      OPENAI_EMBED_MODEL: "bge-m3",
      OPENAI_EMBED_API_KEY: "shared-key",
      OPENAI_EMBED_DIM: "1024",
    });
    expect(config.embeddingProvider).toBe("external");
    expect(config.embeddingBaseUrl).toBe("https://server.com/v1/openai");
    expect(config.embeddingModel).toBe("bge-m3");
    expect(config.embeddingApiKey).toBe("shared-key");
    expect(config.embeddingDim).toBe(1024);
  });

  it("prefers FAKE_QDRANT_EMBEDDING_* over OPENAI_EMBED_*", () => {
    const config = loadConfig({
      FAKE_QDRANT_EMBEDDING_BASE_URL: "http://fq.example",
      FAKE_QDRANT_EMBEDDING_MODEL: "fq-model",
      FAKE_QDRANT_EMBEDDING_API_KEY: "fq-key",
      FAKE_QDRANT_EMBEDDING_DIM: "384",
      OPENAI_EMBED_BASE_URL: "https://server.com/v1/openai",
      OPENAI_EMBED_MODEL: "bge-m3",
      OPENAI_EMBED_API_KEY: "shared-key",
      OPENAI_EMBED_DIM: "1024",
    });
    expect(config.embeddingBaseUrl).toBe("http://fq.example");
    expect(config.embeddingModel).toBe("fq-model");
    expect(config.embeddingApiKey).toBe("fq-key");
    expect(config.embeddingDim).toBe(384);
  });

  it("parses FAKE_QDRANT_EMBEDDING_TIMEOUT_MS", () => {
    const config = loadConfig({ FAKE_QDRANT_EMBEDDING_TIMEOUT_MS: "15000" });
    expect(config.embeddingTimeoutMs).toBe(15_000);
  });
});

describe("getDefaultExternalModel", () => {
  it("should return bge-large-en-v1.5 as default", () => {
    expect(getDefaultExternalModel()).toBe("bge-large-en-v1.5");
  });
});
