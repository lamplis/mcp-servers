import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { Store, resolveDataDir } from "../store.js";

describe("Fake Qdrant JSONL store", () => {
  let store: Store;
  let testDataDir: string;

  beforeEach(async () => {
    testDataDir = path.join(
      resolveDataDir(),
      `store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(testDataDir, { recursive: true });
    store = await Store.create({ dataDir: testDataDir });
  });

  afterEach(async () => {
    store.close();
    await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("creates, lists, and deletes collections", async () => {
    await store.createCollection("alpha", { size: 3, distance: "Cosine" });
    const listed = await store.listCollections();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: "alpha",
      vectors: { size: 3, distance: "Cosine" },
    });

    await store.deleteCollection("alpha");
    expect(await store.listCollections()).toEqual([]);
  });

  it("upserts, queries by cosine, and deletes points", async () => {
    await store.createCollection("vecs", { size: 3 });
    await store.upsertPoints("vecs", [
      { id: 1, vector: [1, 0, 0], payload: { name: "a" } },
      { id: 2, vector: [0, 1, 0], payload: { name: "b" } },
    ]);

    const results = await store.query("vecs", [1, 0, 0], { limit: 2 });
    expect(results[0]?.id).toBe(1);
    expect(results[0]?.score).toBeGreaterThan(0.99);

    const deleted = await store.deletePoints("vecs", [1]);
    expect(deleted).toBe(1);
    const remaining = await store.query("vecs", [1, 0, 0], { limit: 10 });
    expect(remaining.map((r) => r.id)).not.toContain(1);
    expect(remaining.map((r) => r.id)).toContain(2);
  });

  it("compacts duplicate ids and reloads from JSONL", async () => {
    await store.createCollection("dupes", { size: 2 });
    await store.upsertPoints("dupes", [
      { id: "p", vector: [1, 0], payload: { v: 1 } },
    ]);
    await store.upsertPoints("dupes", [
      { id: "p", vector: [0, 1], payload: { v: 2 } },
    ]);

    const unique = await store.compactCollection("dupes");
    expect(unique).toBe(1);

    store.close();
    const reloaded = await Store.create({ dataDir: testDataDir });
    const info = await reloaded.getCollection("dupes");
    expect(info?.vectors.size).toBe(2);
    const results = await reloaded.query("dupes", [0, 1], { limit: 1 });
    expect(results[0]?.payload).toEqual({ v: 2 });
    reloaded.close();
  });

  it("persists dirty collections to disk", async () => {
    await store.createCollection("flush", { size: 1 });
    await store.upsertPoints("flush", [{ id: 7, vector: [1], payload: null }]);
    await store.persistAllIndexes();
    const pointsFile = await fs.readFile(
      path.join(testDataDir, "flush", "points.jsonl"),
      "utf8"
    );
    expect(pointsFile).toContain('"id":7');
  });
});
