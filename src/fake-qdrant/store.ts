import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HNSWIndex, HNSWState } from "./hnsw/index.js";

export type DistanceMetric = "Cosine";

export interface CollectionMeta {
  size: number;
  distance: DistanceMetric;
}

export interface CollectionInfo {
  name: string;
  vectors: CollectionMeta;
}

export interface PointRecord {
  id: string | number;
  vector: number[];
  payload: unknown;
}

export interface QueryOptions {
  limit?: number;
  scoreThreshold?: number;
}

export interface StoreOptions {
  dataDir?: string;
  /** Use HNSW for queries (default: true). Set to false to force brute-force. */
  useHnsw?: boolean;
  /** HNSW efSearch parameter (default: 50) */
  hnswEfSearch?: number;
}

const DEFAULT_DATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "data"
);

export function resolveDataDir(override?: string): string {
  const envDir = process.env.FAKE_QDRANT_DATA_DIR;
  const dir = override ?? envDir ?? DEFAULT_DATA_DIR;
  return path.resolve(dir);
}

interface CollectionCache {
  index: HNSWIndex;
  payloads: Map<string | number, unknown>;
  dirty: boolean;
}

export class Store {
  private indexCache: Map<string, CollectionCache> = new Map();
  private useHnsw: boolean;
  private hnswEfSearch: number;

  static async create(options: StoreOptions = {}): Promise<Store> {
    const baseDir = resolveDataDir(options.dataDir);
    await fs.mkdir(baseDir, { recursive: true });
    return new Store(baseDir, options);
  }

  private constructor(
    private readonly baseDir: string,
    options: StoreOptions = {}
  ) {
    this.useHnsw = options.useHnsw ?? true;
    this.hnswEfSearch = options.hnswEfSearch ?? 50;
  }

  get directory(): string {
    return this.baseDir;
  }

  private collectionDir(name: string): string {
    return path.join(this.baseDir, name);
  }

  private metaPath(name: string): string {
    return path.join(this.collectionDir(name), "meta.json");
  }

  private pointsPath(name: string): string {
    return path.join(this.collectionDir(name), "points.jsonl");
  }

  private hnswIndexPath(name: string): string {
    return path.join(this.collectionDir(name), "hnsw.json");
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const entries = await fs
      .readdir(this.baseDir, { withFileTypes: true })
      .catch((error) => {
        if ("code" in (error as Error) && (error as any).code === "ENOENT") {
          return [];
        }
        throw error;
      });

    const result: CollectionInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const info = await this.getCollection(entry.name);
      if (info) {
        result.push(info);
      }
    }
    return result;
  }

  async getCollection(name: string): Promise<CollectionInfo | null> {
    try {
      const meta = JSON.parse(
        await fs.readFile(this.metaPath(name), "utf8")
      ) as CollectionMeta;
      return { name, vectors: meta };
    } catch (error) {
      if ("code" in (error as Error) && (error as any).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async createCollection(
    name: string,
    meta: { size: number; distance?: string }
  ): Promise<CollectionInfo> {
    const size = meta.size;
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error("Collection size must be a positive integer");
    }

    const distance = normalizeDistance(meta.distance);

    await fs.mkdir(this.collectionDir(name), { recursive: true });
    const collectionMeta: CollectionMeta = { size, distance };
    await fs.writeFile(
      this.metaPath(name),
      JSON.stringify(collectionMeta, null, 2),
      "utf8"
    );
    await fs.appendFile(this.pointsPath(name), "", "utf8");

    // Clear any cached index
    this.indexCache.delete(name);

    return { name, vectors: collectionMeta };
  }

  async deleteCollection(name: string): Promise<void> {
    this.indexCache.delete(name);
    await fs.rm(this.collectionDir(name), { recursive: true, force: true });
  }

  async upsertPoints(name: string, points: PointRecord[]): Promise<void> {
    const collection = await this.getCollection(name);
    if (!collection) {
      throw new Error(`Collection not found: ${name}`);
    }

    const dimension = collection.vectors.size;
    for (const point of points) {
      if (!isValidPointId(point.id)) {
        throw new Error("Point id must be a string or number");
      }
      if (
        !Array.isArray(point.vector) ||
        point.vector.length !== dimension ||
        point.vector.some((value) => !Number.isFinite(value))
      ) {
        throw new Error(
          `Vector must contain ${dimension} finite numbers for collection ${name}`
        );
      }
    }

    // Append to JSONL (source of truth)
    const lines = points
      .map((point) =>
        JSON.stringify({
          id: point.id,
          vector: point.vector,
          payload: point.payload ?? null,
        })
      )
      .join("\n");
    await fs.appendFile(this.pointsPath(name), `${lines}\n`, "utf8");

    // Update in-memory HNSW index if cached
    const cache = this.indexCache.get(name);
    if (cache) {
      for (const point of points) {
        cache.index.insert(point.id, point.vector);
        cache.payloads.set(point.id, point.payload ?? null);
      }
      cache.dirty = true;
    }
  }

  async query(name: string, queryVector: number[], options: QueryOptions = {}) {
    const collection = await this.getCollection(name);
    if (!collection) {
      throw new Error(`Collection not found: ${name}`);
    }
    const dimension = collection.vectors.size;
    if (
      !Array.isArray(queryVector) ||
      queryVector.length !== dimension ||
      queryVector.some((value) => !Number.isFinite(value))
    ) {
      throw new Error(
        `Query vector must contain ${dimension} finite numbers for collection ${name}`
      );
    }

    const limit = Math.max(1, options.limit ?? 20);
    const scoreThreshold = options.scoreThreshold ?? 0;

    if (this.useHnsw) {
      return this.queryWithHnsw(name, queryVector, limit, scoreThreshold);
    }
    return this.queryBruteForce(name, queryVector, limit, scoreThreshold);
  }

  /**
   * Compact the points file by deduplicating (latest wins) and optionally
   * rebuild the HNSW index. Returns the number of unique points after compaction.
   */
  async compactCollection(name: string): Promise<number> {
    const collection = await this.getCollection(name);
    if (!collection) {
      throw new Error(`Collection not found: ${name}`);
    }

    const points = await this.loadLatestPoints(name);
    const compactedLines = Array.from(points.values())
      .map((p) => JSON.stringify(p))
      .join("\n");

    // Write compacted file atomically
    const tempPath = this.pointsPath(name) + ".tmp";
    await fs.writeFile(tempPath, compactedLines + "\n", "utf8");
    await fs.rename(tempPath, this.pointsPath(name));

    // Rebuild and persist HNSW index
    const cache = await this.ensureIndex(name, points);
    await this.persistHnswIndex(name, cache.index);

    return points.size;
  }

  /**
   * Persist the current HNSW index to disk.
   */
  async persistHnswIndex(name: string, index?: HNSWIndex): Promise<void> {
    const cache = this.indexCache.get(name);
    const targetIndex = index ?? cache?.index;
    if (!targetIndex) {
      return;
    }
    const state = targetIndex.serialize();
    await fs.writeFile(
      this.hnswIndexPath(name),
      JSON.stringify(state),
      "utf8"
    );
    if (cache) {
      cache.dirty = false;
    }
  }

  /**
   * Persist all dirty HNSW indexes to disk.
   */
  async persistAllIndexes(): Promise<void> {
    for (const [name, cache] of this.indexCache) {
      if (cache.dirty) {
        await this.persistHnswIndex(name, cache.index);
      }
    }
  }

  // --- Private methods ---

  private async queryWithHnsw(
    name: string,
    queryVector: number[],
    limit: number,
    scoreThreshold: number
  ) {
    const cache = await this.ensureIndex(name);

    if (cache.index.isEmpty) {
      return [];
    }

    // Request more results to allow for threshold filtering
    const searchLimit = Math.max(limit * 2, 50);
    const results = cache.index.search(queryVector, searchLimit, this.hnswEfSearch);

    const filtered = [];
    for (const result of results) {
      if (result.score >= scoreThreshold) {
        filtered.push({
          id: result.id,
          score: result.score,
          payload: cache.payloads.get(result.id) ?? null,
        });
      }
      if (filtered.length >= limit) {
        break;
      }
    }
    return filtered;
  }

  private async queryBruteForce(
    name: string,
    queryVector: number[],
    limit: number,
    scoreThreshold: number
  ) {
    const points = await this.loadLatestPoints(name);
    const scored = [];
    for (const record of points.values()) {
      const score = cosineSimilarity(queryVector, record.vector);
      if (score >= scoreThreshold) {
        scored.push({
          id: record.id,
          payload: record.payload ?? null,
          score,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  private async ensureIndex(
    name: string,
    preloadedPoints?: Map<string | number, PointRecord>
  ): Promise<CollectionCache> {
    let cache = this.indexCache.get(name);
    if (cache) {
      return cache;
    }

    // Try loading persisted index
    let index: HNSWIndex | null = null;
    try {
      const data = await fs.readFile(this.hnswIndexPath(name), "utf8");
      const state = JSON.parse(data) as HNSWState;
      index = HNSWIndex.deserialize(state);
    } catch {
      // No persisted index or invalid; will rebuild
    }

    const points = preloadedPoints ?? (await this.loadLatestPoints(name));
    const payloads = new Map<string | number, unknown>();
    for (const [id, record] of points) {
      payloads.set(id, record.payload);
    }

    if (!index || index.size !== points.size) {
      // Build fresh index from points
      index = new HNSWIndex({ metric: "cosine" });
      for (const [id, record] of points) {
        index.insert(id, record.vector);
      }
    }

    cache = {
      index,
      payloads,
      dirty: false,
    };
    this.indexCache.set(name, cache);
    return cache;
  }

  private async loadLatestPoints(
    name: string
  ): Promise<Map<string | number, PointRecord>> {
    const map = new Map<string | number, PointRecord>();
    let fileContent: string;
    try {
      fileContent = await fs.readFile(this.pointsPath(name), "utf8");
    } catch (error) {
      if ("code" in (error as Error) && (error as any).code === "ENOENT") {
        return map;
      }
      throw error;
    }

    const lines = fileContent.split("\n");
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line) as PointRecord;
        map.set(record.id, record);
      } catch {
        // Ignore malformed lines; they can be cleaned up via compaction later.
      }
    }
    return map;
  }
}

function normalizeDistance(value?: string): DistanceMetric {
  if (!value) {
    return "Cosine";
  }
  const normalized = value.toLowerCase();
  if (normalized === "cosine") {
    return "Cosine";
  }
  throw new Error(`Unsupported distance metric: ${value}`);
}

function isValidPointId(id: unknown): id is string | number {
  return typeof id === "string" || typeof id === "number";
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
