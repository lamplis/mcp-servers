import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "./logger.js";
import {
  DiskGate,
  Mutex,
  ProcessLockBusyError,
  acquireProcessLock,
  atomicWriteFile,
  lockDirForDataDir,
  type ProcessLock,
} from "./disk-gate.js";

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
  logger?: Logger;
  diskGate?: DiskGate;
  acquireLock?: boolean;
  lockRetries?: number;
  lockRetryMs?: number;
}

export const AUTO_COMPACT_MULTIPLIER = 2;
export const AUTO_COMPACT_EXTRA_LINES = 500;
export const QUERY_YIELD_EVERY = 256;

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
  jsonlLines: number;
}

/**
 * File-backed vector store using JSONL (no database binaries).
 * Each collection is a directory with meta.json + points.jsonl.
 */
export class Store {
  private collections: Map<string, LoadedCollection> = new Map();
  private collectionLocks: Map<string, Mutex> = new Map();
  private readonly diskGate: DiskGate;
  private processLock: ProcessLock | null = null;
  private busy = false;
  private busyError: ProcessLockBusyError | null = null;

  static async create(options: StoreOptions = {}): Promise<Store> {
    const baseDir = resolveDataDir(options.dataDir);
    await fs.mkdir(baseDir, { recursive: true });
    const diskGate = options.diskGate ?? new DiskGate();
    const store = new Store(baseDir, options.logger, diskGate);
    if (options.acquireLock !== false) {
      try {
        store.processLock = await acquireProcessLock({
          lockDir: lockDirForDataDir(baseDir),
          retries: options.lockRetries,
          retryMs: options.lockRetryMs,
        });
      } catch (error) {
        if (error instanceof ProcessLockBusyError) {
          store.busy = true;
          store.busyError = error;
          options.logger?.error("store.busy", {
            lockDir: lockDirForDataDir(baseDir),
            holderPid: error.holderPid,
            message: error.message,
          });
        } else {
          throw error;
        }
      }
    }
    await store.warnLeftoverSqliteFiles();
    return store;
  }

  private constructor(
    private readonly baseDir: string,
    private readonly logger: Logger | undefined,
    diskGate: DiskGate
  ) {
    this.diskGate = diskGate;
  }

  get directory(): string {
    return this.baseDir;
  }

  get diskWriter(): DiskGate {
    return this.diskGate;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  assertWritable(): void {
    if (this.busy && this.busyError) {
      throw this.busyError;
    }
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

  private mutexFor(name: string): Mutex {
    let mutex = this.collectionLocks.get(name);
    if (!mutex) {
      mutex = new Mutex();
      this.collectionLocks.set(name, mutex);
    }
    return mutex;
  }

  private async warnLeftoverSqliteFiles(): Promise<void> {
    const entries = await fs
      .readdir(this.baseDir, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".db")) {
        const message =
          `Ignoring leftover SQLite file "${entry.name}". ` +
          "JSONL is the native format; re-upsert points (SQLite cannot be opened on this workstation).";
        if (this.logger) {
          this.logger.warn("store.leftover_sqlite", { file: entry.name, message });
        } else {
          console.error(`[fake-qdrant] ${message}`);
        }
      }
    }
  }

  private async loadCollectionUnlocked(
    name: string
  ): Promise<LoadedCollection | null> {
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
    let jsonlLines = 0;
    try {
      const content = await fs.readFile(this.pointsPath(name), "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        jsonlLines += 1;
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
      jsonlLines,
    };
    this.collections.set(name, loaded);
    return loaded;
  }

  private async writeMeta(name: string, meta: CollectionMeta): Promise<void> {
    await this.diskGate.run(async () => {
      await fs.mkdir(this.collectionDir(name), { recursive: true });
      await atomicWriteFile(
        this.metaPath(name),
        `${JSON.stringify(meta, null, 2)}\n`
      );
    });
  }

  private async rewritePoints(loaded: LoadedCollection): Promise<void> {
    await this.diskGate.run(async () => {
      await fs.mkdir(this.collectionDir(loaded.name), { recursive: true });
      const lines: string[] = [];
      for (const point of loaded.points.values()) {
        lines.push(JSON.stringify(point));
      }
      const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
      await atomicWriteFile(this.pointsPath(loaded.name), body);
    });
    loaded.jsonlLines = loaded.points.size;
    loaded.dirty = false;
  }

  private async appendPoints(
    name: string,
    points: PointRecord[]
  ): Promise<void> {
    const payload = points.map((point) => JSON.stringify(point)).join("\n");
    if (!payload) {
      return;
    }
    await this.diskGate.run(async () => {
      await fs.mkdir(this.collectionDir(name), { recursive: true });
      await fs.appendFile(this.pointsPath(name), `${payload}\n`, "utf8");
    });
  }

  private shouldAutoCompact(loaded: LoadedCollection): boolean {
    const unique = loaded.points.size;
    return (
      loaded.jsonlLines > unique * AUTO_COMPACT_MULTIPLIER ||
      loaded.jsonlLines > unique + AUTO_COMPACT_EXTRA_LINES
    );
  }

  async listCollections(): Promise<CollectionInfo[]> {
    this.assertWritable();
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
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
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
    this.assertWritable();
    return this.mutexFor(name).run(async () => {
      const loaded = await this.loadCollectionUnlocked(name);
      if (!loaded) {
        return null;
      }
      return {
        name,
        vectors: { ...loaded.meta },
      };
    });
  }

  async createCollection(
    name: string,
    meta: { size: number; distance?: string }
  ): Promise<CollectionInfo> {
    this.assertWritable();
    const size = meta.size;
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error("Collection size must be a positive integer");
    }

    const distance = normalizeDistance(meta.distance);
    return this.mutexFor(name).run(async () => {
      await this.deleteCollectionUnlocked(name);

      const loaded: LoadedCollection = {
        name,
        meta: { size, distance },
        points: new Map(),
        dirty: false,
        jsonlLines: 0,
      };
      this.collections.set(name, loaded);
      await this.writeMeta(name, loaded.meta);
      await this.diskGate.run(async () => {
        await atomicWriteFile(this.pointsPath(name), "");
      });

      return { name, vectors: { size, distance } };
    });
  }

  async deleteCollection(name: string): Promise<void> {
    this.assertWritable();
    await this.mutexFor(name).run(async () => {
      await this.deleteCollectionUnlocked(name);
    });
  }

  private async deleteCollectionUnlocked(name: string): Promise<void> {
    this.collections.delete(name);
    await this.diskGate.run(async () => {
      await fs
        .rm(this.collectionDir(name), { recursive: true, force: true })
        .catch(() => undefined);
      await fs.rm(path.join(this.baseDir, `${name}.db`), { force: true }).catch(() => undefined);
      await fs
        .rm(path.join(this.baseDir, `${name}.db-wal`), { force: true })
        .catch(() => undefined);
      await fs
        .rm(path.join(this.baseDir, `${name}.db-shm`), { force: true })
        .catch(() => undefined);
    });
  }

  /**
   * Delete points from a collection by IDs or by filter.
   */
  async deletePoints(
    name: string,
    pointIds?: (string | number)[],
    filter?: (payload: unknown) => boolean
  ): Promise<number> {
    this.assertWritable();
    return this.mutexFor(name).run(async () => {
      const loaded = await this.loadCollectionUnlocked(name);
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
        loaded.dirty = true;
        await this.rewritePoints(loaded);
      }

      return deletedCount;
    });
  }

  async upsertPoints(name: string, points: PointRecord[]): Promise<void> {
    this.assertWritable();
    await this.mutexFor(name).run(async () => {
      const loaded = await this.loadCollectionUnlocked(name);
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

      for (const point of points) {
        loaded.points.set(String(point.id), {
          id: point.id,
          vector: point.vector,
          payload: point.payload,
        });
      }
      loaded.dirty = true;
      await this.appendPoints(name, points);
      loaded.jsonlLines += points.length;
      if (this.shouldAutoCompact(loaded)) {
        await this.rewritePoints(loaded);
      }
    });
  }

  async query(name: string, queryVector: number[], options: QueryOptions = {}) {
    this.assertWritable();
    const snapshot = await this.mutexFor(name).run(async () => {
      const loaded = await this.loadCollectionUnlocked(name);
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

      return {
        dimension,
        points: [...loaded.points.values()],
      };
    });

    const limit = Math.max(1, options.limit ?? 20);
    const scoreThreshold = options.scoreThreshold ?? 0;
    const scored: Array<{ id: string | number; score: number; payload: unknown }> =
      [];

    for (let i = 0; i < snapshot.points.length; i += 1) {
      if (i > 0 && i % QUERY_YIELD_EVERY === 0) {
        await yieldEventLoop();
      }
      const point = snapshot.points[i];
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
    this.assertWritable();
    return this.mutexFor(name).run(async () => {
      const loaded = await this.loadCollectionUnlocked(name);
      if (!loaded) {
        throw new Error(`Collection not found: ${name}`);
      }
      await this.rewritePoints(loaded);
      return loaded.points.size;
    });
  }

  /**
   * Flush dirty collections to a compact JSONL snapshot.
   */
  async persistAllIndexes(): Promise<void> {
    this.assertWritable();
    const names = [...this.collections.keys()];
    for (const name of names) {
      await this.mutexFor(name).run(async () => {
        const loaded = this.collections.get(name);
        if (!loaded || !loaded.dirty) {
          return;
        }
        await this.rewritePoints(loaded);
      });
    }
  }

  /**
   * Drop in-memory collections and release the process lock.
   */
  async close(): Promise<void> {
    this.collections.clear();
    if (this.processLock) {
      await this.processLock.release();
      this.processLock = null;
    }
  }
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
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
