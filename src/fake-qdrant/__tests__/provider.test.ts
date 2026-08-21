import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import {
  ExternalEmbeddingProvider,
  LocalEmbeddingProvider,
  createProvider,
} from "../provider.js";
import { ConfigError, type FakeQdrantConfig } from "../config.js";

function createMockEmbeddingServer(
  handler: (body: unknown) => { status: number; data: unknown }
): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        const body = data ? JSON.parse(data) : {};
        const result = handler(body);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.data));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        port: addr.port,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res()))
          ),
      });
    });
  });
}

describe("ExternalEmbeddingProvider", () => {
  it("should accept any model name", () => {
    const provider = new ExternalEmbeddingProvider(
      "http://localhost:1234",
      "bge-large-en-v1.5"
    );
    expect(provider.model).toBe("bge-large-en-v1.5");
    expect(provider.mode).toBe("external");
    expect(provider.dimensions).toBeNull();
  });

  it("should call the embedding endpoint and return vectors", async () => {
    const mock = await createMockEmbeddingServer(() => ({
      status: 200,
      data: {
        model: "bge-large-en-v1.5",
        data: [
          { index: 0, embedding: [0.1, 0.2, 0.3] },
          { index: 1, embedding: [0.4, 0.5, 0.6] },
        ],
      },
    }));

    try {
      const provider = new ExternalEmbeddingProvider(
        `http://127.0.0.1:${mock.port}`,
        "bge-large-en-v1.5"
      );
      const result = await provider.embed(["hello", "world"]);

      expect(result.model).toBe("bge-large-en-v1.5");
      expect(result.embeddings).toHaveLength(2);
      expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
      expect(result.dimensions).toBe(3);
      expect(provider.dimensions).toBe(3);
    } finally {
      await mock.close();
    }
  });

  it("should throw on server error", async () => {
    const mock = await createMockEmbeddingServer(() => ({
      status: 500,
      data: { error: "internal error" },
    }));

    try {
      const provider = new ExternalEmbeddingProvider(
        `http://127.0.0.1:${mock.port}`,
        "bge-large-en-v1.5"
      );
      await expect(provider.embed(["test"])).rejects.toThrow("status 500");
    } finally {
      await mock.close();
    }
  });
});

describe("LocalEmbeddingProvider", () => {
  it("should call the local embedding endpoint", async () => {
    const mock = await createMockEmbeddingServer((body) => ({
      status: 200,
      data: {
        model: (body as { model: string }).model,
        data: [{ index: 0, embedding: [0.5, 0.5] }],
      },
    }));

    try {
      const provider = new LocalEmbeddingProvider(
        `http://127.0.0.1:${mock.port}`,
        "Xenova/all-MiniLM-L6-v2"
      );
      expect(provider.mode).toBe("local");

      const result = await provider.embed(["hello"]);
      expect(result.embeddings).toHaveLength(1);
      expect(result.dimensions).toBe(2);
    } finally {
      await mock.close();
    }
  });
});

describe("createProvider", () => {
  const baseConfig: FakeQdrantConfig = {
    httpEnabled: false,
    httpHost: "127.0.0.1",
    httpPort: 6333,
    dataDir: "./data",
    embeddingProvider: "local",
    embeddingBaseUrl: null,
    embeddingModel: null,
    localEmbeddingsTarget: null,
  };

  it("should create a LocalEmbeddingProvider for local mode", () => {
    const provider = createProvider({
      ...baseConfig,
      embeddingProvider: "local",
      localEmbeddingsTarget: "http://localhost:5000",
    });
    expect(provider).not.toBeNull();
    expect(provider!.mode).toBe("local");
  });

  it("should create an ExternalEmbeddingProvider for external mode", () => {
    const provider = createProvider({
      ...baseConfig,
      embeddingProvider: "external",
      embeddingBaseUrl: "https://api.example.com",
      embeddingModel: "bge-large-en-v1.5",
    });
    expect(provider).not.toBeNull();
    expect(provider!.mode).toBe("external");
    expect(provider!.model).toBe("bge-large-en-v1.5");
  });

  it("should throw if external mode lacks base URL", () => {
    expect(() =>
      createProvider({
        ...baseConfig,
        embeddingProvider: "external",
        embeddingBaseUrl: null,
      })
    ).toThrow(ConfigError);
  });

  it("should use default local target when not specified", () => {
    const provider = createProvider({
      ...baseConfig,
      embeddingProvider: "local",
    });
    expect(provider).not.toBeNull();
    expect(provider!.mode).toBe("local");
  });
});
