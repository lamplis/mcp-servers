import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { Store, resolveDataDir } from "../store.js";
import { matchFilter } from "../qdrant-filter.js";

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
    await store.close();
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

    await store.close();
    const reloaded = await Store.create({ dataDir: testDataDir });
    const info = await reloaded.getCollection("dupes");
    expect(info?.vectors.size).toBe(2);
    const results = await reloaded.query("dupes", [0, 1], { limit: 1 });
    expect(results[0]?.payload).toEqual({ v: 2 });
    await reloaded.close();
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

  it("ensureCollection is idempotent and rejects size mismatch", async () => {
    const first = await store.ensureCollection("keep", { size: 2 });
    expect(first.created).toBe(true);
    await store.upsertPoints("keep", [{ id: 1, vector: [1, 0], payload: null }]);
    const second = await store.ensureCollection("keep", { size: 2 });
    expect(second.created).toBe(false);
    expect(second.info.pointsCount).toBe(1);
    await expect(store.ensureCollection("keep", { size: 8 })).rejects.toMatchObject({
      name: "CollectionSizeMismatchError",
    });
  });

  it("persists payload indexes and rebuilds them after reload", async () => {
    await store.createCollection("idx", { size: 2 });
    expect(await store.ensurePayloadIndex("idx", "type")).toBe(true);
    await store.upsertPoints("idx", [
      { id: 1, vector: [1, 0], payload: { type: "code" } },
    ]);
    await store.close();
    const reloaded = await Store.create({ dataDir: testDataDir });
    const info = await reloaded.getCollection("idx");
    expect(info?.vectors.indexes).toEqual(["type"]);
    const stats = await reloaded.getCollectionStats("idx");
    expect(stats[0]?.postingListSizes.type).toBe(1);
    await reloaded.close();
  });

  it("appends tombstones on delete and compact restores unique live lines", async () => {
    await store.createCollection("tomb", { size: 2 });
    await store.upsertPoints("tomb", [
      { id: 1, vector: [1, 0], payload: { path: "/a" } },
      { id: 2, vector: [0, 1], payload: { path: "/b" } },
      { id: 3, vector: [1, 1], payload: { path: "/c" } },
    ]);
    const deleted = await store.deletePoints("tomb", [1]);
    expect(deleted).toBe(1);
    const raw = await fs.readFile(
      path.join(testDataDir, "tomb", "points.jsonl"),
      "utf8"
    );
    expect(raw).toContain('"op":"delete"');
    const unique = await store.compactCollection("tomb");
    expect(unique).toBe(2);
    const compacted = await fs.readFile(
      path.join(testDataDir, "tomb", "points.jsonl"),
      "utf8"
    );
    expect(compacted).not.toContain('"op":"delete"');
    expect(compacted.split("\n").filter((line) => line.trim()).length).toBe(2);
  });

  it("filters query and delete by nested payload fields", async () => {
    await store.createCollection("roo", { size: 2 });
    await store.ensurePayloadIndex("roo", "pathSegments.0");
    await store.upsertPoints("roo", [
      { id: 1, vector: [1, 0], payload: { pathSegments: ["config.py"] } },
      { id: 2, vector: [0, 1], payload: { pathSegments: ["keep.py"] } },
    ]);
    const filter = {
      should: [{ must: [{ key: "pathSegments.0", match: { value: "config.py" } }] }],
    };
    const hits = await store.query("roo", [1, 0], { filter, limit: 10 });
    expect(hits.map((hit) => hit.id)).toEqual([1]);
    const removed = await store.deletePoints(
      "roo",
      undefined,
      (payload) => matchFilter(payload, filter),
      filter
    );
    expect(removed).toBe(1);
    expect(await store.countPoints("roo")).toBe(1);
  });

  it("increments point version on re-upsert and survives reload", async () => {
    await store.createCollection("ver", { size: 2 });
    await store.upsertPoints("ver", [{ id: 1, vector: [1, 0], payload: { v: 1 } }]);
    const first = await store.query("ver", [1, 0], { limit: 1 });
    expect(first[0]?.version).toBe(1);
    await store.upsertPoints("ver", [{ id: 1, vector: [0, 1], payload: { v: 2 } }]);
    const second = await store.query("ver", [0, 1], { limit: 1 });
    expect(second[0]?.version).toBe(2);
    await store.close();
    const reloaded = await Store.create({ dataDir: testDataDir });
    const after = await reloaded.query("ver", [0, 1], { limit: 1 });
    expect(after[0]?.version).toBe(2);
    expect(after[0]?.payload).toEqual({ v: 2 });
    await reloaded.close();
  });

  it("updates payload with set, overwrite, delete, and clear", async () => {
    await store.createCollection("pay", { size: 2 });
    await store.upsertPoints("pay", [
      { id: 1, vector: [1, 0], payload: { a: 1, b: 2 } },
      { id: 2, vector: [0, 1], payload: { a: 3 } },
    ]);
    await store.updatePayload("pay", { ids: [1] }, "set", { c: 3 });
    const setHits = await store.retrieve("pay", [1]);
    expect(setHits[0]?.payload).toEqual({ a: 1, b: 2, c: 3 });
    await store.updatePayload("pay", { ids: [1] }, "overwrite", { only: true });
    expect((await store.retrieve("pay", [1]))[0]?.payload).toEqual({ only: true });
    await store.updatePayload("pay", { ids: [1] }, "delete", ["only"]);
    expect((await store.retrieve("pay", [1]))[0]?.payload).toEqual({});
    await store.updatePayload("pay", { filter: { key: "a", match: { value: 3 } } }, "clear");
    expect((await store.retrieve("pay", [2]))[0]?.payload).toEqual({});
  });

  it("rejects ensureCollection in strict mode when the name exists", async () => {
    await store.ensureCollection("keep", { size: 2 });
    await expect(
      store.ensureCollection("keep", { size: 2, strict: true })
    ).rejects.toMatchObject({ name: "CollectionExistsError" });
  });
});
