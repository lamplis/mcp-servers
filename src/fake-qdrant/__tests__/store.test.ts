import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { Store, resolveDataDir } from "../store.js";

describe("Store", () => {
  let store: Store;
  let testDataDir: string;

  beforeEach(async () => {
    testDataDir = path.join(
      resolveDataDir(),
      `test-store-${Date.now()}-${Math.random().toString(36).substring(7)}`
    );
    await fs.mkdir(testDataDir, { recursive: true });
    store = await Store.create({ dataDir: testDataDir });
  });

  afterEach(async () => {
    store.close();
    try {
      await fs.rm(testDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("Collection CRUD", () => {
    it("should create a collection", async () => {
      const col = await store.createCollection("test", { size: 128 });
      expect(col.name).toBe("test");
      expect(col.vectors.size).toBe(128);
      expect(col.vectors.distance).toBe("Cosine");
    });

    it("should list collections", async () => {
      await store.createCollection("alpha", { size: 64 });
      await store.createCollection("beta", { size: 128 });
      const list = await store.listCollections();
      const names = list.map((c) => c.name).sort();
      expect(names).toEqual(["alpha", "beta"]);
    });

    it("should get a specific collection", async () => {
      await store.createCollection("myCol", { size: 256 });
      const col = await store.getCollection("myCol");
      expect(col).not.toBeNull();
      expect(col!.vectors.size).toBe(256);
    });

    it("should return null for non-existent collection", async () => {
      const col = await store.getCollection("nope");
      expect(col).toBeNull();
    });

    it("should delete a collection", async () => {
      await store.createCollection("toDelete", { size: 32 });
      await store.deleteCollection("toDelete");
      const col = await store.getCollection("toDelete");
      expect(col).toBeNull();
    });

    it("should overwrite collection on re-create", async () => {
      await store.createCollection("dup", { size: 64 });
      await store.upsertPoints("dup", [
        { id: "p1", vector: new Array(64).fill(0.1), payload: { x: 1 } },
      ]);
      await store.createCollection("dup", { size: 128 });
      const col = await store.getCollection("dup");
      expect(col!.vectors.size).toBe(128);
    });

    it("should reject invalid size", async () => {
      await expect(store.createCollection("bad", { size: 0 })).rejects.toThrow(
        "positive integer"
      );
      await expect(store.createCollection("bad", { size: -1 })).rejects.toThrow(
        "positive integer"
      );
    });

    it("should reject unsupported distance metric", async () => {
      await expect(
        store.createCollection("bad", { size: 3, distance: "Euclidean" })
      ).rejects.toThrow("Unsupported distance metric");
    });
  });

  describe("Point upsert and query", () => {
    beforeEach(async () => {
      await store.createCollection("vec3", { size: 3 });
    });

    it("should upsert and query points", async () => {
      await store.upsertPoints("vec3", [
        { id: "a", vector: [1, 0, 0], payload: { tag: "x-axis" } },
        { id: "b", vector: [0, 1, 0], payload: { tag: "y-axis" } },
        { id: "c", vector: [0, 0, 1], payload: { tag: "z-axis" } },
      ]);

      const results = await store.query("vec3", [1, 0, 0], { limit: 2 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.id).toBe("a");
      expect(results[0]!.score).toBeCloseTo(1.0, 1);
      expect(results[0]!.payload).toEqual({ tag: "x-axis" });
    });

    it("should overwrite existing point on upsert", async () => {
      await store.upsertPoints("vec3", [
        { id: "x", vector: [1, 0, 0], payload: { v: 1 } },
      ]);
      await store.upsertPoints("vec3", [
        { id: "x", vector: [0, 1, 0], payload: { v: 2 } },
      ]);

      const results = await store.query("vec3", [0, 1, 0], { limit: 1 });
      expect(results[0]!.id).toBe("x");
      expect(results[0]!.payload).toEqual({ v: 2 });
    });

    it("should respect score threshold", async () => {
      await store.upsertPoints("vec3", [
        { id: "a", vector: [1, 0, 0], payload: null },
        { id: "b", vector: [0, 1, 0], payload: null },
      ]);

      const results = await store.query("vec3", [1, 0, 0], {
        limit: 10,
        scoreThreshold: 0.9,
      });
      expect(results.every((r) => r.score >= 0.9)).toBe(true);
    });

    it("should reject vector with wrong dimension", async () => {
      await expect(
        store.upsertPoints("vec3", [
          { id: "bad", vector: [1, 0], payload: null },
        ])
      ).rejects.toThrow("3 finite numbers");
    });

    it("should reject upsert into non-existent collection", async () => {
      await expect(
        store.upsertPoints("ghost", [
          { id: "x", vector: [1], payload: null },
        ])
      ).rejects.toThrow("Collection not found");
    });

    it("should reject query on non-existent collection", async () => {
      await expect(store.query("ghost", [1, 0, 0])).rejects.toThrow(
        "Collection not found"
      );
    });

    it("should reject query vector with wrong dimension", async () => {
      await expect(store.query("vec3", [1, 0])).rejects.toThrow(
        "3 finite numbers"
      );
    });

    it("should return empty results on empty collection", async () => {
      const results = await store.query("vec3", [1, 0, 0], { limit: 5 });
      expect(results).toEqual([]);
    });

    it("should support numeric point IDs", async () => {
      await store.upsertPoints("vec3", [
        { id: 42, vector: [1, 0, 0], payload: null },
      ]);
      const results = await store.query("vec3", [1, 0, 0], { limit: 1 });
      expect(results[0]!.id).toBe(42);
    });
  });

  describe("Point delete", () => {
    beforeEach(async () => {
      await store.createCollection("del", { size: 3 });
      await store.upsertPoints("del", [
        { id: "1", vector: [1, 0, 0], payload: { path: "/a.txt" } },
        { id: "2", vector: [0, 1, 0], payload: { path: "/b.txt" } },
        { id: "3", vector: [0, 0, 1], payload: { path: "/c.txt" } },
      ]);
    });

    it("should delete points by IDs", async () => {
      const deleted = await store.deletePoints("del", ["1", "2"]);
      expect(deleted).toBe(2);

      const results = await store.query("del", [0, 0, 1], { limit: 10 });
      expect(results).toHaveLength(1);
      expect(String(results[0]!.id)).toBe("3");
    });

    it("should delete points by filter", async () => {
      const deleted = await store.deletePoints("del", undefined, (payload) => {
        return (payload as { path: string })?.path === "/a.txt";
      });
      expect(deleted).toBe(1);
    });

    it("should return 0 for non-existent collection", async () => {
      const deleted = await store.deletePoints("ghost", ["1"]);
      expect(deleted).toBe(0);
    });
  });

  describe("Compact and persist", () => {
    it("should compact a collection", async () => {
      await store.createCollection("cmp", { size: 3 });
      await store.upsertPoints("cmp", [
        { id: "a", vector: [1, 0, 0], payload: null },
        { id: "b", vector: [0, 1, 0], payload: null },
      ]);
      const count = await store.compactCollection("cmp");
      expect(count).toBe(2);
    });

    it("should reject compact on non-existent collection", async () => {
      await expect(store.compactCollection("ghost")).rejects.toThrow(
        "Collection not found"
      );
    });

    it("should persist all indexes without error", async () => {
      await store.createCollection("per", { size: 3 });
      await store.upsertPoints("per", [
        { id: "a", vector: [1, 0, 0], payload: null },
      ]);
      await expect(store.persistAllIndexes()).resolves.not.toThrow();
    });
  });
});
