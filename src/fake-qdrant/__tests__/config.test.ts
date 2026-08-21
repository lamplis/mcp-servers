import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError, getDefaultExternalModel } from "../config.js";

describe("loadConfig", () => {
  it("should return defaults when no env vars are set", () => {
    const config = loadConfig({});
    expect(config.httpEnabled).toBe(false);
    expect(config.httpHost).toBe("127.0.0.1");
    expect(config.httpPort).toBe(6333);
    expect(config.dataDir).toBe("./data/fake-qdrant");
    expect(config.embeddingProvider).toBe("local");
    expect(config.embeddingBaseUrl).toBeNull();
    expect(config.embeddingModel).toBeNull();
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
});

describe("getDefaultExternalModel", () => {
  it("should return bge-large-en-v1.5 as default", () => {
    expect(getDefaultExternalModel()).toBe("bge-large-en-v1.5");
  });
});
