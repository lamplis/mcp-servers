import { describe, it, expect } from "vitest";
import { LruCache } from "../lru.js";

describe("LruCache", () => {
  it("should reject non-positive capacity", () => {
    expect(() => new LruCache(0)).toThrow("positive integer");
    expect(() => new LruCache(-1)).toThrow("positive integer");
    expect(() => new LruCache(1.5)).toThrow("positive integer");
  });

  it("should store and retrieve values", () => {
    const cache = new LruCache<string>(10);
    cache.set("a", "alpha");
    cache.set("b", "beta");

    expect(cache.get("a")).toBe("alpha");
    expect(cache.get("b")).toBe("beta");
    expect(cache.size).toBe(2);
    expect(cache.capacity).toBe(10);
  });

  it("should return undefined for missing keys", () => {
    const cache = new LruCache<string>(5);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("should evict the least recently used entry when full", () => {
    const cache = new LruCache<string>(2);
    cache.set("a", "alpha");
    cache.set("b", "beta");
    cache.set("c", "charlie");

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("beta");
    expect(cache.get("c")).toBe("charlie");
    expect(cache.size).toBe(2);
  });

  it("should refresh entry on get (LRU behavior)", () => {
    const cache = new LruCache<string>(2);
    cache.set("a", "alpha");
    cache.set("b", "beta");

    cache.get("a");

    cache.set("c", "charlie");

    expect(cache.get("a")).toBe("alpha");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("charlie");
  });

  it("should overwrite existing key without growing size", () => {
    const cache = new LruCache<string>(3);
    cache.set("a", "v1");
    cache.set("b", "v2");
    cache.set("a", "v3");

    expect(cache.get("a")).toBe("v3");
    expect(cache.size).toBe(2);
  });
});
