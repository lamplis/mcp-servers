import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer, resolveQueryVector, resolveToolPoints } from "../server.js";
import { resolveDataDir } from "../store.js";
import { EMBEDDING_NOT_CONFIGURED, type EmbeddingProvider, type EmbeddingProbeResult } from "../provider.js";

const stubProxy = {
  envSet: false,
  used: false,
  host: null as string | null,
  loopback: true,
};

const stubProvider: EmbeddingProvider = {
  mode: "external",
  model: "bge-m3",
  dimensions: 3,
  lastProbe: null,
  describe: () => ({
    mode: "external",
    model: "bge-m3",
    baseUrlHost: "stub.example",
    dim: 3,
  }),
  embed: async (texts) => ({
    model: "bge-m3",
    embeddings: texts.map(() => [1, 0, 0]),
    dimensions: 3,
  }),
  async probe(): Promise<EmbeddingProbeResult> {
    const result: EmbeddingProbeResult = {
      ok: true,
      configured: true,
      ms: 0,
      endpointHost: "stub.example",
      model: "bge-m3",
      dim: 3,
      proxy: stubProxy,
    };
    stubProvider.lastProbe = result;
    return result;
  },
};

describe("fake-qdrant MCP factory", () => {
  let testDataDir: string;
  let cleanup: (() => void) | undefined;
  let storeClose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    cleanup?.();
    if (storeClose) {
      await storeClose();
    }
    if (testDataDir) {
      await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("delete_points and collection_stats use the upgraded store", async () => {
    testDataDir = path.join(
      resolveDataDir(),
      `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(testDataDir, { recursive: true });
    const created = await createServer({ dataDir: testDataDir });
    cleanup = created.cleanup;
    storeClose = () => created.store.close();
    await created.store.createCollection("mcp", { size: 2 });
    await created.store.upsertPoints("mcp", [
      { id: 1, vector: [1, 0], payload: { path: "/a" } },
      { id: 2, vector: [0, 1], payload: { path: "/b" } },
    ]);
    const deleted = await created.store.deletePoints("mcp", [1]);
    expect(deleted).toBe(1);
    const stats = await created.store.getCollectionStats("mcp");
    expect(stats[0]?.pointsCount).toBe(1);
    expect(stats[0]?.jsonlLines).toBeGreaterThanOrEqual(1);
  });

  it("exposes embedding info on the created server", async () => {
    testDataDir = path.join(
      resolveDataDir(),
      `mcp-embed-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(testDataDir, { recursive: true });
    const created = await createServer({
      dataDir: testDataDir,
      embeddingProvider: stubProvider,
    });
    cleanup = created.cleanup;
    storeClose = () => created.store.close();
    expect(created.embeddingProvider?.describe()).toEqual({
      mode: "external",
      model: "bge-m3",
      baseUrlHost: "stub.example",
      dim: 3,
    });
  });

  it("embeds query text and upserts text points through the MCP helpers", async () => {
    const vector = await resolveQueryVector(undefined, "hello", stubProvider);
    expect(vector).toEqual([1, 0, 0]);
    const resolved = await resolveToolPoints(
      [{ id: 1, text: "hello", payload: { path: "/a" } }],
      stubProvider
    );
    expect(resolved.embeddedCount).toBe(1);
    expect(resolved.points[0]?.vector).toEqual([1, 0, 0]);
  });

  it("errors when text is used without a provider", async () => {
    await expect(resolveQueryVector(undefined, "hello", null)).rejects.toThrow(
      EMBEDDING_NOT_CONFIGURED
    );
    await expect(
      resolveToolPoints([{ id: 1, text: "hello" }], null)
    ).rejects.toThrow(EMBEDDING_NOT_CONFIGURED);
  });
});
