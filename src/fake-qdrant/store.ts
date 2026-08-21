import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

interface LoadedCollection {
  name: string;
  meta: CollectionMeta;
  points: Map<string, PointRecord>;
  dirty: boolean;
}

/**
 * File-backed vector store using JSONL (no database binaries).
 * Each collection is a directory with meta.json + points.jsonl.
 */
export class Store {
  private collections: Map<string, LoadedCollection> = new Map();
  private writeLocks: Map<string, Promise<void>> = new Map();

  static async create(options: StoreOptions = {}): Promise<Store> {
    const baseDir = resolveDataDir(options.dataDir);
    await fs.mkdir(baseDir, { recursive: true });
    const store = new Store(baseDir);
    await store.warnLeftoverSqliteFiles();
    return store;
  }

  private constructor(private readonly baseDir: string) {}

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

  private async warnLeftoverSqliteFiles(): Promise<void> {
    const entries = await fs
      .readdir(this.baseDir, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".db")) {
        console.error(
          `[fake-qdrant] Ignoring leftover SQLite file "${entry.name}". ` +
            "JSONL is the native format; re-upsert points (SQLite cannot be opened on this workstation)."
        );
      }
    }
  }

  private async withWriteLock(name: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.writeLocks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.writeLocks.set(
      name,
      previous.then(() => gate).catch(() => gate)
    );
    await previous.catch(() => undefined);
    try {
      await fn();
    } finally {
      release();
    }
  }

  private async loadCollection(name: string): Promise<LoadedCollection | null> {
    const cached = this.collections.get(name);
    if (cached) {
      return cached;
    }

    const metaFile = this.metaPath(name);
    let metaRaw: string;
    try {
      metaRaw = await fs.readFile(metaFile, "utf8");
    } catch {
      return null;
    }

    let parsed: { size?: unknown; distance?: unknown };
    try {
      parsed = JSON.parse(metaRaw) as { size?: unknown; distance?: unknown };
    } catch {
      return null;
    }

    const size = Number(parsed.size);
    if (!Number.isInteger(size) || size <= 0) {
      return null;
    }

    const distance = normalizeDistance(
      typeof parsed.distance === "string" ? parsed.distance : undefined
    );

    const points = new Map<string, PointRecord>();
    try {
      const content = await fs.readFile(this.pointsPath(name), "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          const record = JSON.parse(line) as PointRecord;
          if (!isValidPointId(record.id) || !Array.isArray(record.vector)) {
            continue;
          }
          points.set(String(record.id), record);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Missing points.jsonl is an empty collection
    }

    const loaded: LoadedCollection = {
      name,
      meta: { size, distance },
      points,
      dirty: false,
    };
    this.collections.set(name, loaded);
    return loaded;
  }

  private async writeMeta(name: string, meta: CollectionMeta): Promise<void> {
    await fs.mkdir(this.collectionDir(name), { recursive: true });
    const tmp = `${this.metaPath(name)}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    await fs.rename(tmp, this.metaPath(name)).catch(async () => {
      await fs.rm(this.metaPath(name), { force: true }).catch(() => undefined);
      await fs.rename(tmp, this.metaPath(name));
    });
  }

  private async rewritePoints(loaded: LoadedCollection): Promise<void> {
    await fs.mkdir(this.collectionDir(loaded.name), { recursive: true });
    const dest = this.pointsPath(loaded.name);
    const tmp = `${dest}.tmp`;
    const lines: string[] = [];
    for (const point of loaded.points.values()) {
      lines.push(JSON.stringify(point));
    }
    const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, dest).catch(async () => {
      await fs.rm(dest, { force: true }).catch(() => undefined);
      await fs.rename(tmp, dest);
    });
    loaded.dirty = false;
  }

  private async appendPoints(
    name: string,
    points: PointRecord[]
  ): Promise<void> {
    await fs.mkdir(this.collectionDir(name), { recursive: true });
    const payload = points.map((point) => JSON.stringify(point)).join("\n");
    if (!payload) {
      return;
    }
    await fs.appendFile(this.pointsPath(name), `${payload}\n`, "utf8");
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const entries = await fs
      .readdir(this.baseDir, { withFileTypes: true })
      .catch((error) => {
        if ("code" in (error as Error) && (error as { code?: string }).code === "ENOENT") {
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
    const loaded = await this.loadCollection(name);
    if (!loaded) {
      return null;
    }
    return {
      name,
      vectors: { ...loaded.meta },
    };
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
    await this.deleteCollection(name);

    const loaded: LoadedCollection = {
      name,
      meta: { size, distance },
      points: new Map(),
      dirty: false,
    };
    this.collections.set(name, loaded);
    await this.writeMeta(name, loaded.meta);
    await fs.writeFile(this.pointsPath(name), "", "utf8");

    return { name, vectors: { size, distance } };
  }

  async deleteCollection(name: string): Promise<void> {
    this.collections.delete(name);
    await fs.rm(this.collectionDir(name), { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(path.join(this.baseDir, `${name}.db`), { force: true }).catch(() => undefined);
    await fs.rm(path.join(this.baseDir, `${name}.db-wal`), { force: true }).catch(() => undefined);
    await fs.rm(path.join(this.baseDir, `${name}.db-shm`), { force: true }).catch(() => undefined);
  }

  /**
   * Delete points from a collection by IDs or by filter.
   */
  async deletePoints(
    name: string,
    pointIds?: (string | number)[],
    filter?: (payload: unknown) => boolean
  ): Promise<number> {
    const loaded = await this.loadCollection(name);
    if (!loaded) {
      return 0;
    }

    const toDelete = new Set<string>();
    if (pointIds && pointIds.length > 0) {
      for (const id of pointIds) {
        toDelete.add(String(id));
      }
    }
    if (filter) {
      for (const [key, point] of loaded.points) {
        if (filter(point.payload ?? null)) {
          toDelete.add(key);
        }
      }
    }

    let deletedCount = 0;
    for (const key of toDelete) {
      if (loaded.points.delete(key)) {
        deletedCount += 1;
      }
    }

    if (deletedCount > 0) {
      await this.withWriteLock(name, async () => {
        await this.rewritePoints(loaded);
      });
    }

    return deletedCount;
  }

  async upsertPoints(name: string, points: PointRecord[]): Promise<void> {
    const loaded = await this.loadCollection(name);
    if (!loaded) {
      throw new Error(`Collection not found: ${name}`);
    }

    const dimension = loaded.meta.size;
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

    await this.withWriteLock(name, async () => {
      for (const point of points) {
        loaded.points.set(String(point.id), {
          id: point.id,
          vector: point.vector,
          payload: point.payload,
        });
      }
      loaded.dirty = true;
      await this.appendPoints(name, points);
    });
  }

  async query(name: string, queryVector: number[], options: QueryOptions = {}) {
    const loaded = await this.loadCollection(name);
    if (!loaded) {
      throw new Error(`Collection not found: ${name}`);
    }

    const dimension = loaded.meta.size;
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

    const scored: Array<{ id: string | number; score: number; payload: unknown }> =
      [];
    for (const point of loaded.points.values()) {
      const score = cosineSimilarity(queryVector, point.vector);
      if (score >= scoreThreshold) {
        scored.push({
          id: point.id,
          score,
          payload: point.payload ?? null,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Compact the collection by rewriting unique points (latest id wins).
   */
  async compactCollection(name: string): Promise<number> {
    const loaded = await this.loadCollection(name);
    if (!loaded) {
      throw new Error(`Collection not found: ${name}`);
    }

    await this.withWriteLock(name, async () => {
      await this.rewritePoints(loaded);
    });
    return loaded.points.size;
  }

  /**
   * Flush dirty collections to a compact JSONL snapshot.
   */
  async persistAllIndexes(): Promise<void> {
    for (const loaded of this.collections.values()) {
      if (!loaded.dirty) {
        continue;
      }
      await this.withWriteLock(loaded.name, async () => {
        await this.rewritePoints(loaded);
      });
    }
  }

  /**
   * Drop in-memory collections. Call this before shutdown.
   */
  close(): void {
    this.collections.clear();
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) {
    return 0;
  }
  return dot / denom;
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
