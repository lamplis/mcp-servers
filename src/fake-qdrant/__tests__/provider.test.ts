import { describe, it, expect } from "vitest";
import http from "http";
import {
  OpenAICompatibleProvider,
  createProvider,
  resolveEmbeddingsUrl,
  resolveProxyUrl,
  classifyEmbeddingFailure,
  EmbeddingError,
  EMBEDDING_PROBE_TEXT,
} from "../provider.js";
import { ConfigError, type FakeQdrantConfig } from "../config.js";

type CapturedRequest = {
  url?: string;
  authorization?: string;
  body: unknown;
};

function createMockEmbeddingServer(
  handler: (
    body: unknown,
    req: http.IncomingMessage
  ) => { status: number; data: unknown }
): Promise<{
  server: http.Server;
  port: number;
  close: () => Promise<void>;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        const body = data ? JSON.parse(data) : {};
        requests.push({
          url: req.url,
          authorization: req.headers.authorization,
          body,
        });
        const result = handler(body, req);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result.data));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        port: addr.port,
        requests,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res()))
          ),
      });
    });
  });
}

const baseConfig: FakeQdrantConfig = {
  httpEnabled: false,
  httpHost: "127.0.0.1",
  httpPort: 6333,
  dataDir: "./data",
  logDir: null,
  logLevel: "info",
  logRetentionDays: 3,
  embeddingProvider: "local",
  embeddingBaseUrl: null,
  embeddingModel: null,
  embeddingApiKey: null,
  embeddingDim: null,
  embeddingTimeoutMs: 30_000,
  localEmbeddingsTarget: null,
  dropEmptyChunks: false,
  flagPayloadPatterns: [],
  slowRequestMs: 1000,
  takeover: true,
  strictCreate: false,
};

describe("resolveEmbeddingsUrl", () => {
  it("appends /v1/embeddings for a bare host", () => {
    expect(resolveEmbeddingsUrl("http://127.0.0.1:3100")).toBe(
      "http://127.0.0.1:3100/v1/embeddings"
    );
    expect(resolveEmbeddingsUrl("http://127.0.0.1:3100/")).toBe(
      "http://127.0.0.1:3100/v1/embeddings"
    );
  });

  it("appends /embeddings when a path is already present", () => {
    expect(resolveEmbeddingsUrl("https://server.com/v1/openai")).toBe(
      "https://server.com/v1/openai/embeddings"
    );
    expect(resolveEmbeddingsUrl("https://server.com/v1/openai/")).toBe(
      "https://server.com/v1/openai/embeddings"
    );
  });
});

describe("OpenAICompatibleProvider", () => {
  it("posts Bearer auth, records the embeddings path, and returns vectors", async () => {
    const mock = await createMockEmbeddingServer(() => ({
      status: 200,
      data: {
        model: "bge-m3",
        data: [
          { index: 0, embedding: [0.1, 0.2, 0.3] },
          { index: 1, embedding: [0.4, 0.5, 0.6] },
        ],
      },
    }));

    try {
      const provider = new OpenAICompatibleProvider(
        "external",
        `http://127.0.0.1:${mock.port}/v1/openai`,
        "bge-m3",
        "secret-key",
        3,
        5_000
      );
      const result = await provider.embed(["hello", "world"]);

      expect(result.model).toBe("bge-m3");
      expect(result.embeddings).toEqual([
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ]);
      expect(result.dimensions).toBe(3);
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]?.url).toBe("/v1/openai/embeddings");
      expect(mock.requests[0]?.authorization).toBe("Bearer secret-key");
      const info = provider.describe();
      expect(info).toEqual({
        mode: "external",
        model: "bge-m3",
        baseUrlHost: `127.0.0.1:${mock.port}`,
        dim: 3,
      });
      expect(JSON.stringify(info)).not.toContain("secret-key");
    } finally {
      await mock.close();
    }
  });

  it("batches more than 64 inputs into multiple POSTs", async () => {
    const mock = await createMockEmbeddingServer((body) => {
      const input = (body as { input: string[] }).input;
      return {
        status: 200,
        data: {
          model: "bge-m3",
          data: input.map((_, index) => ({
            index,
            embedding: [1, 0, 0],
          })),
        },
      };
    });

    try {
      const provider = new OpenAICompatibleProvider(
        "external",
        `http://127.0.0.1:${mock.port}`,
        "bge-m3",
        null,
        3,
        5_000
      );
      const texts = Array.from({ length: 65 }, (_, i) => `t${i}`);
      const result = await provider.embed(texts);
      expect(result.embeddings).toHaveLength(65);
      expect(mock.requests).toHaveLength(2);
      expect((mock.requests[0]?.body as { input: string[] }).input).toHaveLength(64);
      expect((mock.requests[1]?.body as { input: string[] }).input).toHaveLength(1);
      expect(mock.requests[0]?.authorization).toBeUndefined();
    } finally {
      await mock.close();
    }
  });

  it("throws on dimension mismatch", async () => {
    const mock = await createMockEmbeddingServer(() => ({
      status: 200,
      data: {
        model: "bge-m3",
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      },
    }));

    try {
      const provider = new OpenAICompatibleProvider(
        "external",
        `http://127.0.0.1:${mock.port}`,
        "bge-m3",
        null,
        1024,
        5_000
      );
      await expect(provider.embed(["ping"])).rejects.toThrow(EmbeddingError);
      await expect(provider.embed(["ping"])).rejects.toThrow(
        "Embedding dimension mismatch: expected 1024, got 3"
      );
    } finally {
      await mock.close();
    }
  });

  it("throws on server error", async () => {
    const mock = await createMockEmbeddingServer(() => ({
      status: 500,
      data: { error: "internal error" },
    }));

    try {
      const provider = new OpenAICompatibleProvider(
        "external",
        `http://127.0.0.1:${mock.port}`,
        "bge-m3",
        null,
        null,
        5_000
      );
      await expect(provider.embed(["test"])).rejects.toThrow("status 500");
    } finally {
      await mock.close();
    }
  });

  it("uses the local target in local mode", async () => {
    const mock = await createMockEmbeddingServer((body) => ({
      status: 200,
      data: {
        model: (body as { model: string }).model,
        data: [{ index: 0, embedding: [0.5, 0.5] }],
      },
    }));

    try {
      const provider = new OpenAICompatibleProvider(
        "local",
        `http://127.0.0.1:${mock.port}`,
        "Xenova/all-MiniLM-L6-v2",
        null,
        null,
        5_000
      );
      expect(provider.mode).toBe("local");
      const result = await provider.embed(["hello"]);
      expect(result.embeddings).toHaveLength(1);
      expect(result.dimensions).toBe(2);
      expect(mock.requests[0]?.url).toBe("/v1/embeddings");
    } finally {
      await mock.close();
    }
  });
});

describe("createProvider", () => {
  it("should create a local OpenAI-compatible provider", () => {
    const provider = createProvider({
      ...baseConfig,
      embeddingProvider: "local",
      localEmbeddingsTarget: "http://localhost:5000",
    });
    expect(provider).not.toBeNull();
    expect(provider!.mode).toBe("local");
  });

  it("should create an external OpenAI-compatible provider", () => {
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

describe("proxy routing", () => {
  it("skips proxy for loopback even when HTTP_PROXY is set", () => {
    const proxy = resolveProxyUrl(new URL("http://127.0.0.1:3100/v1/embeddings"), {
      HTTP_PROXY: "http://proxy.corp:8080",
    });
    expect(proxy).toBeNull();
  });

  it("uses HTTP_PROXY for a non-loopback HTTP target", () => {
    const proxy = resolveProxyUrl(new URL("http://embeddings.internal.test/v1/embeddings"), {
      HTTP_PROXY: "http://proxy.corp:8080",
    });
    expect(proxy?.host).toBe("proxy.corp:8080");
  });

  it("honors NO_PROXY", () => {
    const proxy = resolveProxyUrl(new URL("https://embeddings.internal.test/v1/embeddings"), {
      HTTPS_PROXY: "http://proxy.corp:8080",
      NO_PROXY: "internal.test",
    });
    expect(proxy).toBeNull();
  });
});

describe("classifyEmbeddingFailure", () => {
  const emptyEnv: NodeJS.ProcessEnv = {};

  it("hints that local embeddings is not listening on loopback ECONNREFUSED", () => {
    const diagnosed = classifyEmbeddingFailure(
      new EmbeddingError("connect ECONNREFUSED 127.0.0.1:3100", { code: "ECONNREFUSED" }),
      "http://127.0.0.1:3100/v1/embeddings",
      emptyEnv
    );
    expect(diagnosed.hint).toMatch(/local-embeddings/);
  });

  it("hints PAC vs explicit HTTPS_PROXY when a remote host times out", () => {
    const diagnosed = classifyEmbeddingFailure(
      new EmbeddingError("request timed out after 30000ms", { code: "ETIMEDOUT" }),
      "https://intranet.example.com/v1/embeddings",
      emptyEnv
    );
    expect(diagnosed.hint).toMatch(/PAC\/WPAD/);
    expect(diagnosed.hint).toMatch(/HTTPS_PROXY/);
  });

  it("hints a broken proxy when HTTPS_PROXY is set and the request still fails", () => {
    const diagnosed = classifyEmbeddingFailure(
      new EmbeddingError("connect ECONNREFUSED", { code: "ECONNREFUSED" }),
      "https://intranet.example.com/v1/embeddings",
      { HTTPS_PROXY: "http://proxy.corp:8080" }
    );
    expect(diagnosed.hint).toMatch(/proxy\.corp:8080/);
    expect(diagnosed.hint).toMatch(/NO_PROXY/);
  });
});

describe("OpenAICompatibleProvider.probe", () => {
  it("POSTs a tiny ping and caches lastProbe on success", async () => {
    const mock = await createMockEmbeddingServer(() => ({
      status: 200,
      data: {
        model: "bge-m3",
        data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
      },
    }));
    try {
      const provider = new OpenAICompatibleProvider(
        "external",
        `http://127.0.0.1:${mock.port}`,
        "bge-m3",
        null,
        3,
        5_000
      );
      const probe = await provider.probe();
      expect(probe.ok).toBe(true);
      expect(probe.dim).toBe(3);
      expect(probe.proxy.loopback).toBe(true);
      expect(provider.lastProbe).toEqual(probe);
      expect((mock.requests[0]?.body as { input: string[] }).input).toEqual([
        EMBEDDING_PROBE_TEXT,
      ]);
    } finally {
      await mock.close();
    }
  });

  it("returns a structured failure for loopback ECONNREFUSED", async () => {
    const provider = new OpenAICompatibleProvider(
      "local",
      "http://127.0.0.1:1",
      "Xenova/all-MiniLM-L6-v2",
      null,
      null,
      1_000
    );
    const probe = await provider.probe();
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe("ECONNREFUSED");
    expect(probe.hint).toMatch(/local-embeddings/);
    expect(provider.lastProbe?.ok).toBe(false);
  });

  it("does not send loopback requests through HTTP_PROXY", async () => {
    const mock = await createMockEmbeddingServer(() => ({
      status: 200,
      data: {
        model: "bge-m3",
        data: [{ index: 0, embedding: [1, 0, 0] }],
      },
    }));
    const previous = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    try {
      const provider = new OpenAICompatibleProvider(
        "external",
        `http://127.0.0.1:${mock.port}`,
        "bge-m3",
        null,
        3,
        5_000
      );
      const result = await provider.embed(["hello"]);
      expect(result.embeddings).toEqual([[1, 0, 0]]);
      expect(mock.requests).toHaveLength(1);
    } finally {
      if (previous === undefined) {
        delete process.env.HTTP_PROXY;
      } else {
        process.env.HTTP_PROXY = previous;
      }
      await mock.close();
    }
  });

  it("sends non-loopback HTTP through HTTP_PROXY", async () => {
    const mock = await createMockEmbeddingServer(() => ({
      status: 200,
      data: {
        model: "bge-m3",
        data: [{ index: 0, embedding: [1, 0, 0] }],
      },
    }));
    const previousHttp = process.env.HTTP_PROXY;
    const previousHttps = process.env.HTTPS_PROXY;
    process.env.HTTP_PROXY = `http://127.0.0.1:${mock.port}`;
    delete process.env.HTTPS_PROXY;
    try {
      const provider = new OpenAICompatibleProvider(
        "external",
        "http://embeddings.internal.test",
        "bge-m3",
        null,
        3,
        5_000
      );
      const result = await provider.embed(["ping"]);
      expect(result.embeddings).toEqual([[1, 0, 0]]);
      expect(mock.requests[0]?.url).toBe(
        "http://embeddings.internal.test/v1/embeddings"
      );
    } finally {
      if (previousHttp === undefined) {
        delete process.env.HTTP_PROXY;
      } else {
        process.env.HTTP_PROXY = previousHttp;
      }
      if (previousHttps === undefined) {
        delete process.env.HTTPS_PROXY;
      } else {
        process.env.HTTPS_PROXY = previousHttps;
      }
      await mock.close();
    }
  });
});
