import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "./logger.js";
import { defaultFakeQdrantDataDir } from "./config.js";
import {
  countPayloadHygiene,
  isWhitespaceOnlyPayload,
} from "./payload-hygiene.js";
import {
  DiskGate,
  Mutex,
  ProcessLockBusyError,
  acquireProcessLock,
  atomicWriteFile,
  lockDirForDataDir,
  type ProcessLock,
} from "./disk-gate.js";
import {
  candidateIdsFromFilter,
  matchFilter,
  payloadFieldString,
  type KeywordPostings,
} from "./qdrant-filter.js";

export type DistanceMetric = "Cosine";

export interface CollectionMeta {
  size: number;
  distance: DistanceMetric;
  indexes?: string[];
  pointsCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CollectionInfo {
  name: string;
  vectors: CollectionMeta;
  pointsCount: number;
}

export interface CollectionStats {
  name: string;
  size: number;
  distance: DistanceMetric;
  pointsCount: number;
  jsonlLines: number;
  indexes: string[];
  postingListSizes: Record<string, number>;
  emptyPayloadPoints: number;
  flaggedPayloadPoints: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface PointRecord {
  id: string | number;
  vector: number[];
  payload: unknown;
}

export interface QueryHit {
  id: string | number;
  score: number;
  payload: unknown;
}

export interface QueryOptions {
  limit?: number;
  scoreThreshold?: number;
  filter?: unknown;
}

export interface ScrollOptions {
  limit?: number;
  offset?: number;
  filter?: unknown;
  withPayload?: boolean;
}

export interface StoreOptions {
  dataDir?: string;
  logger?: Logger;
  diskGate?: DiskGate;
  acquireLock?: boolean;
  existingLock?: ProcessLock | null;
  lockRetries?: number;
  lockRetryMs?: number;
  dropEmptyChunks?: boolean;
  flagPayloadPatterns?: string[];
}

export class CollectionSizeMismatchError extends Error {
  readonly existingSize: number;
  readonly requestedSize: number;

  constructor(name: string, existingSize: number, requestedSize: number) {
    super(
      `Collection ${name} exists with size ${existingSize}, requested ${requestedSize}`
    );
    this.name = "CollectionSizeMismatchError";
    this.existingSize = existingSize;
    this.requestedSize = requestedSize;
  }
}

export const AUTO_COMPACT_MULTIPLIER = 2;
export const AUTO_COMPACT_EXTRA_LINES = 500;
export const QUERY_YIELD_EVERY = 256;

export function resolveDataDir(override?: string): string {
  const envDir = process.env.FAKE_QDRANT_DATA_DIR;
  const dir = override ?? envDir ?? defaultFakeQdrantDataDir();
  return path.resolve(dir);
}

interface LoadedCollection {
  name: string;
  meta: CollectionMeta;
  points: Map<string, PointRecord>;
  postings: KeywordPostings;
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
  private readonly dropEmptyChunks: boolean;
  private readonly flagPayloadPatterns: string[];

  static async create(options: StoreOptions = {}): Promise<Store> {
    const baseDir = resolveDataDir(options.dataDir);
    await fs.mkdir(baseDir, { recursive: true });
    const diskGate = options.diskGate ?? new DiskGate();
    const store = new Store(baseDir, options.logger, diskGate, options);
    if (options.existingLock) {
      store.processLock = options.existingLock;
    } else if (options.acquireLock !== false) {
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
    diskGate: DiskGate,
    options: StoreOptions = {}
  ) {
    this.diskGate = diskGate;
    this.dropEmptyChunks = options.dropEmptyChunks ?? process.env.FAKE_QDRANT_DROP_EMPTY_CHUNKS === "1";
    this.flagPayloadPatterns =
      options.flagPayloadPatterns ??
      (process.env.FAKE_QDRANT_FLAG_PAYLOAD_PATTERNS
        ? process.env.FAKE_QDRANT_FLAG_PAYLOAD_PATTERNS.split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : ["Error converting", "Traceback"]);
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

  private parseIndexes(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.filter((item): item is string => typeof item === "string" && item.length > 0);
  }

  private rebuildPostings(loaded: LoadedCollection): void {
    loaded.postings = new Map();
    for (const point of loaded.points.values()) {
      this.indexPoint(loaded, point);
    }
  }

  private indexPoint(loaded: LoadedCollection, point: PointRecord): void {
    const fields = loaded.meta.indexes ?? [];
    const id = String(point.id);
    for (const field of fields) {
      const value = payloadFieldString(point.payload, field);
      if (value === undefined) {
        continue;
      }
      let byValue = loaded.postings.get(field);
      if (!byValue) {
        byValue = new Map();
        loaded.postings.set(field, byValue);
      }
      let ids = byValue.get(value);
      if (!ids) {
        ids = new Set();
        byValue.set(value, ids);
      }
      ids.add(id);
    }
  }

  private unindexPoint(loaded: LoadedCollection, point: PointRecord): void {
    const fields = loaded.meta.indexes ?? [];
    const id = String(point.id);
    for (const field of fields) {
      const value = payloadFieldString(point.payload, field);
      if (value === undefined) {
        continue;
      }
      const byValue = loaded.postings.get(field);
      const ids = byValue?.get(value);
      if (!ids) {
        continue;
      }
      ids.delete(id);
      if (ids.size === 0) {
        byValue?.delete(value);
      }
    }
  }

  private postingListSizes(loaded: LoadedCollection): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [field, byValue] of loaded.postings) {
      let count = 0;
      for (const ids of byValue.values()) {
        count += ids.size;
      }
      out[field] = count;
    }
    return out;
  }

  private toInfo(loaded: LoadedCollection): CollectionInfo {
    return {
      name: loaded.name,
      vectors: { ...loaded.meta },
      pointsCount: loaded.points.size,
    };
  }

  private async readMetaFile(name: string): Promise<CollectionMeta | null> {
    try {
      const raw = await fs.readFile(this.metaPath(name), "utf8");
      const parsed = JSON.parse(raw) as {
        size?: unknown;
        distance?: unknown;
        indexes?: unknown;
        pointsCount?: unknown;
        createdAt?: unknown;
        updatedAt?: unknown;
      };
      const size = Number(parsed.size);
      if (!Number.isInteger(size) || size <= 0) {
        return null;
      }
      const distance = normalizeDistance(
        typeof parsed.distance === "string" ? parsed.distance : undefined
      );
      const pointsCount = Number(parsed.pointsCount);
      return {
        size,
        distance,
        indexes: this.parseIndexes(parsed.indexes),
        pointsCount: Number.isInteger(pointsCount) && pointsCount >= 0 ? pointsCount : 0,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : undefined,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
      };
    } catch {
      return null;
    }
  }

  private async loadCollectionUnlocked(
    name: string
  ): Promise<LoadedCollection | null> {
    const cached = this.collections.get(name);
    if (cached) {
      return cached;
    }

    const meta = await this.readMetaFile(name);
    if (!meta) {
      return null;
    }

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
          const record = JSON.parse(line) as PointRecord & {
            op?: string;
            id?: unknown;
          };
          if (record.op === "delete" && isValidPointId(record.id)) {
            points.delete(String(record.id));
            continue;
          }
          if (!isValidPointId(record.id) || !Array.isArray(record.vector)) {
            continue;
          }
          points.set(String(record.id), {
            id: record.id,
            vector: record.vector,
            payload: record.payload,
          });
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // Missing points.jsonl is an empty collection
    }

    const loaded: LoadedCollection = {
      name,
      meta: { ...meta, pointsCount: points.size },
      points,
      postings: new Map(),
      dirty: false,
      jsonlLines,
    };
    this.rebuildPostings(loaded);
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

  private async persistMetaCounts(loaded: LoadedCollection): Promise<void> {
    loaded.meta.pointsCount = loaded.points.size;
    await this.writeMeta(loaded.name, loaded.meta);
  }

  private async rewritePoints(loaded: LoadedCollection): Promise<void> {
    await this.diskGate.run(async () => {
      await fs.mkdir(this.collectionDir(loaded.name), { recursive: true });
      const lines: string[] = [];
      for (const point of loaded.points.values()) {
        lines.push(JSON.stringify({ id: point.id, vector: point.vector, payload: point.payload }));
      }
      const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
      await atomicWriteFile(this.pointsPath(loaded.name), body);
    });
    loaded.jsonlLines = loaded.points.size;
    loaded.dirty = false;
    loaded.meta.pointsCount = loaded.points.size;
    this.rebuildPostings(loaded);
    await this.writeMeta(loaded.name, loaded.meta);
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

  private async appendTombstones(
    name: string,
    ids: string[]
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const payload = ids
      .map((id) => JSON.stringify({ op: "delete", id }))
      .join("\n");
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
      const cached = this.collections.get(entry.name);
      if (cached) {
        result.push(this.toInfo(cached));
        continue;
      }
      const meta = await this.readMetaFile(entry.name);
      if (!meta) {
        continue;
      }
      result.push({
        name: entry.name,
        vectors: meta,
        pointsCount: meta.pointsCount ?? 0,
      });
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
      return this.toInfo(loaded);
    });
  }

  async getCollectionStats(name?: string): Promise<CollectionStats[]> {
    this.assertWritable();
    const names = name
      ? [name]
      : (await this.listCollections()).map((item) => item.name);
    const stats: CollectionStats[] = [];
    for (const collectionName of names) {
      const item = await this.mutexFor(collectionName).run(async () => {
        const loaded = await this.loadCollectionUnlocked(collectionName);
        if (!loaded) {
          return null;
        }
        return {
          name: loaded.name,
          size: loaded.meta.size,
          distance: loaded.meta.distance,
          pointsCount: loaded.points.size,
          jsonlLines: loaded.jsonlLines,
          indexes: [...(loaded.meta.indexes ?? [])],
          postingListSizes: this.postingListSizes(loaded),
          createdAt: loaded.meta.createdAt,
          updatedAt: loaded.meta.updatedAt,
          ...countPayloadHygiene(loaded.points.values(), this.flagPayloadPatterns),
        } satisfies CollectionStats;
      });
      if (item) {
        stats.push(item);
      }
    }
    return stats;
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

      const now = new Date().toISOString();
      const loaded: LoadedCollection = {
        name,
        meta: { size, distance, indexes: [], pointsCount: 0, createdAt: now, updatedAt: now },
        points: new Map(),
        postings: new Map(),
        dirty: false,
        jsonlLines: 0,
      };
      this.collections.set(name, loaded);
      await this.writeMeta(name, loaded.meta);
      await this.diskGate.run(async () => {
        await atomicWriteFile(this.pointsPath(name), "");
      });

      return this.toInfo(loaded);
    });
  }

  async ensureCollection(
    name: string,
    meta: { size: number; distance?: string }
  ): Promise<{ created: boolean; info: CollectionInfo }> {
    this.assertWritable();
    const size = meta.size;
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error("Collection size must be a positive integer");
    }
    const distance = normalizeDistance(meta.distance);
    return this.mutexFor(name).run(async () => {
      const existing = await this.loadCollectionUnlocked(name);
      if (existing) {
        if (existing.meta.size !== size) {
          throw new CollectionSizeMismatchError(name, existing.meta.size, size);
        }
        return { created: false, info: this.toInfo(existing) };
      }
      const now = new Date().toISOString();
      const loaded: LoadedCollection = {
        name,
        meta: { size, distance, indexes: [], pointsCount: 0, createdAt: now, updatedAt: now },
        points: new Map(),
        postings: new Map(),
        dirty: false,
        jsonlLines: 0,
      };
      this.collections.set(name, loaded);
      await this.writeMeta(name, loaded.meta);
      await this.diskGate.run(async () => {
        await atomicWriteFile(this.pointsPath(name), "");
      });
      return { created: true, info: this.toInfo(loaded) };
    });
  }

  async ensurePayloadIndex(name: string, fieldName: string): Promise<boolean | null> {
    this.assertWritable();
    if (!fieldName || typeof fieldName !== "string") {
      throw new Error("field_name is required");
    }
    return this.mutexFor(name).run(async () => {
      const loaded = await this.loadCollectionUnlocked(name);
      if (!loaded) {
        return null;
      }
      const indexes = loaded.meta.indexes ?? [];
      if (!indexes.includes(fieldName)) {
        loaded.meta.indexes = [...indexes, fieldName];
        this.rebuildPostings(loaded);
        await this.writeMeta(name, loaded.meta);
      }
      return true;
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
   * Delete points from a collection by IDs and/or a Qdrant payload filter.
   */
  async deletePoints(
    name: string,
    pointIds?: (string | number)[],
    filterFn?: (payload: unknown) => boolean,
    filterAst?: unknown
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
      if (filterFn) {
        const candidates =
          filterAst !== undefined
            ? candidateIdsFromFilter(filterAst, loaded.postings)
            : null;
        if (candidates) {
          for (const key of candidates) {
            const point = loaded.points.get(key);
            if (point && filterFn(point.payload ?? null)) {
              toDelete.add(key);
            }
          }
        } else {
          for (const [key, point] of loaded.points) {
            if (filterFn(point.payload ?? null)) {
              toDelete.add(key);
            }
          }
        }
      }

      const deletedIds: string[] = [];
      for (const key of toDelete) {
        const existing = loaded.points.get(key);
        if (!existing) {
          continue;
        }
        this.unindexPoint(loaded, existing);
        loaded.points.delete(key);
        deletedIds.push(key);
      }

      if (deletedIds.length > 0) {
        loaded.dirty = true;
        await this.appendTombstones(name, deletedIds);
        loaded.jsonlLines += deletedIds.length;
        loaded.meta.pointsCount = loaded.points.size;
        await this.persistMetaCounts(loaded);
        if (this.shouldAutoCompact(loaded)) {
          await this.rewritePoints(loaded);
        }
      }

      return deletedIds.length;
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

      const toWrite: PointRecord[] = [];
      for (const point of points) {
        if (this.dropEmptyChunks && isWhitespaceOnlyPayload(point.payload)) {
          this.logger?.info("store.drop_empty_chunk", {
            collection: name,
            id: point.id,
          });
          continue;
        }
        const key = String(point.id);
        const previous = loaded.points.get(key);
        if (previous) {
          this.unindexPoint(loaded, previous);
        }
        const record: PointRecord = {
          id: point.id,
          vector: point.vector,
          payload: point.payload,
        };
        loaded.points.set(key, record);
        this.indexPoint(loaded, record);
        toWrite.push(record);
      }
      if (toWrite.length === 0) {
        return;
      }
      loaded.dirty = true;
      loaded.meta.updatedAt = new Date().toISOString();
      await this.appendPoints(name, toWrite);
      loaded.jsonlLines += toWrite.length;
      loaded.meta.pointsCount = loaded.points.size;
      await this.persistMetaCounts(loaded);
      if (this.shouldAutoCompact(loaded)) {
        await this.rewritePoints(loaded);
      }
    });
  }

  async query(
    name: string,
    queryVector: number[],
    options: QueryOptions = {}
  ): Promise<QueryHit[]> {
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

      let points = [...loaded.points.values()];
      if (options.filter !== undefined) {
        const candidates = candidateIdsFromFilter(options.filter, loaded.postings);
        if (candidates) {
          points = [...candidates]
            .map((id) => loaded.points.get(id))
            .filter((point): point is PointRecord => Boolean(point));
        }
        points = points.filter((point) => matchFilter(point.payload ?? null, options.filter));
      }

      return { points };
    });

    const limit = Math.max(1, options.limit ?? 20);
    const scoreThreshold = options.scoreThreshold ?? 0;
    const scored: QueryHit[] = [];

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

  async scroll(
    name: string,
    options: ScrollOptions = {}
  ): Promise<{ points: PointRecord[]; nextOffset: number | null }> {
    this.assertWritable();
    return this.mutexFor(name).run(async () => {
      const loaded = await this.loadCollectionUnlocked(name);
      if (!loaded) {
        throw new Error(`Collection not found: ${name}`);
      }
      const withPayload = options.withPayload !== false;
      let points = [...loaded.points.values()];
      if (options.filter !== undefined) {
        points = points.filter((point) =>
          matchFilter(point.payload ?? null, options.filter)
        );
      }
      const offset = Math.max(0, options.offset ?? 0);
      const limit = Math.max(1, options.limit ?? 20);
      const slice = points.slice(offset, offset + limit);
      const nextOffset = offset + slice.length < points.length ? offset + slice.length : null;
      return {
        points: slice.map((point) => ({
          id: point.id,
          vector: point.vector,
          payload: withPayload ? point.payload ?? null : null,
        })),
        nextOffset,
      };
    });
  }

  async retrieve(
    name: string,
    ids: (string | number)[],
    withPayload = true
  ): Promise<PointRecord[]> {
    this.assertWritable();
    return this.mutexFor(name).run(async () => {
      const loaded = await this.loadCollectionUnlocked(name);
      if (!loaded) {
        throw new Error(`Collection not found: ${name}`);
      }
      const result: PointRecord[] = [];
      for (const id of ids) {
        const point = loaded.points.get(String(id));
        if (!point) {
          continue;
        }
        result.push({
          id: point.id,
          vector: point.vector,
          payload: withPayload ? point.payload ?? null : null,
        });
      }
      return result;
    });
  }

  async countPoints(name: string, filter?: unknown): Promise<number> {
    this.assertWritable();
    return this.mutexFor(name).run(async () => {
      const loaded = await this.loadCollectionUnlocked(name);
      if (!loaded) {
        throw new Error(`Collection not found: ${name}`);
      }
      if (filter === undefined) {
        return loaded.points.size;
      }
      let count = 0;
      for (const point of loaded.points.values()) {
        if (matchFilter(point.payload ?? null, filter)) {
          count += 1;
        }
      }
      return count;
    });
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
