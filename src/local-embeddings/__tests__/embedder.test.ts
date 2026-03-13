import { describe, it, expect } from "vitest";
import {
  buildCacheKey,
  coerceEmbeddings,
  getOutputDimensions,
  normalizeVector,
  poolTokens,
} from "../embedder.js";

describe("getOutputDimensions", () => {
  it("should return known dimension for registered models", () => {
    expect(getOutputDimensions("Xenova/all-MiniLM-L6-v2")).toBe(384);
    expect(getOutputDimensions("Xenova/bge-m3")).toBe(1024);
  });

  it("should return null for unknown models", () => {
    expect(getOutputDimensions("unknown/model")).toBeNull();
  });
});

describe("buildCacheKey", () => {
  it("should produce deterministic hashes", () => {
    const opts = { model: "m", normalize: true, pooling: "mean" as const };
    const key1 = buildCacheKey("hello", opts);
    const key2 = buildCacheKey("hello", opts);
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(64);
  });

  it("should differ when options differ", () => {
    const base = { model: "m", normalize: true, pooling: "mean" as const };
    const k1 = buildCacheKey("hello", base);
    const k2 = buildCacheKey("hello", { ...base, normalize: false });
    const k3 = buildCacheKey("hello", { ...base, pooling: "cls" });
    const k4 = buildCacheKey("world", base);

    expect(new Set([k1, k2, k3, k4]).size).toBe(4);
  });
});

describe("normalizeVector", () => {
  it("should normalize a vector to unit length", () => {
    const vec = normalizeVector([3, 4]);
    const magnitude = Math.sqrt(vec[0]! ** 2 + vec[1]! ** 2);
    expect(magnitude).toBeCloseTo(1.0, 10);
    expect(vec[0]).toBeCloseTo(0.6, 10);
    expect(vec[1]).toBeCloseTo(0.8, 10);
  });

  it("should handle zero vector", () => {
    const vec = normalizeVector([0, 0, 0]);
    expect(vec).toEqual([0, 0, 0]);
  });
});

describe("poolTokens", () => {
  it("should return empty array for empty input", () => {
    expect(poolTokens([], "mean")).toEqual([]);
    expect(poolTokens([], "cls")).toEqual([]);
  });

  it("should return first token for cls pooling", () => {
    const tokens = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    expect(poolTokens(tokens, "cls")).toEqual([1, 2, 3]);
  });

  it("should average tokens for mean pooling", () => {
    const tokens = [
      [2, 4],
      [4, 6],
    ];
    expect(poolTokens(tokens, "mean")).toEqual([3, 5]);
  });
});

describe("coerceEmbeddings", () => {
  it("should handle flat number array as single embedding", () => {
    const result = coerceEmbeddings([1, 2, 3], 1, "mean", false);
    expect(result).toEqual([[1, 2, 3]]);
  });

  it("should handle Float32Array", () => {
    const data = new Float32Array([0.1, 0.2, 0.3]);
    const result = coerceEmbeddings(data, 1, "mean", false);
    expect(result.length).toBe(1);
    expect(result[0]!.length).toBe(3);
  });

  it("should handle empty array", () => {
    expect(coerceEmbeddings([], 0, "mean", false)).toEqual([]);
  });

  it("should handle 2D tensor", () => {
    const tensor = {
      data: new Float32Array([1, 0, 0, 1]),
      dims: [2, 2],
    };
    const result = coerceEmbeddings(tensor, 2, "mean", false);
    expect(result).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("should normalize when requested", () => {
    const result = coerceEmbeddings([3, 4], 1, "mean", true);
    expect(result.length).toBe(1);
    const magnitude = Math.sqrt(result[0]![0]! ** 2 + result[0]![1]! ** 2);
    expect(magnitude).toBeCloseTo(1.0, 10);
  });
});
