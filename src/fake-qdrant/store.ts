import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

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

/**
 * SQLite-based vector store using sqlite-vec extension.
 * Each collection is stored as a separate .db file.
 */
export class Store {
  private dbs: Map<string, Database.Database> = new Map();

  static async create(options: StoreOptions = {}): Promise<Store> {
    const baseDir = resolveDataDir(options.dataDir);
    await fs.mkdir(baseDir, { recursive: true });
    return new Store(baseDir);
  }

  private constructor(private readonly baseDir: string) {}

  get directory(): string {
    return this.baseDir;
  }

  private dbPath(name: string): string {
    return path.join(this.baseDir, `${name}.db`);
  }

  /**
   * Get or open a database connection for a collection.
   * Returns null if the collection doesn't exist.
   */
  private getDb(name: string): Database.Database | null {
    // Check cache first
    let db = this.dbs.get(name);
    if (db) {
      return db;
    }

    // Try to open existing database
    const dbFile = this.dbPath(name);
    try {
      // Check if file exists synchronously (better-sqlite3 is sync)
      const stats = require("fs").statSync(dbFile);
      if (!stats.isFile()) {
        return null;
      }
    } catch {
      return null;
    }

    db = new Database(dbFile);
    db.pragma("journal_mode = WAL");
    sqliteVec.load(db);
    this.dbs.set(name, db);
    return db;
  }

  /**
   * Create a new database for a collection.
   */
  private createDb(name: string, dimension: number): Database.Database {
    // Close existing if any
    const existing = this.dbs.get(name);
    if (existing) {
      existing.close();
      this.dbs.delete(name);
    }

    const dbFile = this.dbPath(name);
    const db = new Database(dbFile);
    db.pragma("journal_mode = WAL");
    sqliteVec.load(db);

    // Create metadata table
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // Store collection metadata
    const insertMeta = db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
    );
    insertMeta.run("size", String(dimension));
    insertMeta.run("distance", "Cosine");

    // Create vectors virtual table with cosine distance metric
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING vec0(
        point_id TEXT PRIMARY KEY,
        embedding FLOAT[${dimension}] DISTANCE_METRIC=cosine
      )
    `);

    // Create payloads table
    db.exec(`
      CREATE TABLE IF NOT EXISTS payloads (
        point_id TEXT PRIMARY KEY,
        payload TEXT
      )
    `);

    this.dbs.set(name, db);
    return db;
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
      if (!entry.isFile() || !entry.name.endsWith(".db")) {
        continue;
      }
      const name = entry.name.slice(0, -3); // Remove .db extension
      const info = await this.getCollection(name);
      if (info) {
        result.push(info);
      }
    }
    return result;
  }

  async getCollection(name: string): Promise<CollectionInfo | null> {
    const db = this.getDb(name);
    if (!db) {
      return null;
    }

    try {
      const sizeRow = db
        .prepare("SELECT value FROM meta WHERE key = 'size'")
        .get() as { value: string } | undefined;
      const distanceRow = db
        .prepare("SELECT value FROM meta WHERE key = 'distance'")
        .get() as { value: string } | undefined;

      if (!sizeRow) {
        return null;
      }

      return {
        name,
        vectors: {
          size: parseInt(sizeRow.value, 10),
          distance: (distanceRow?.value as DistanceMetric) || "Cosine",
        },
      };
    } catch {
      return null;
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

    // Delete existing collection if any
    await this.deleteCollection(name);

    // Create new database with vec0 table
    this.createDb(name, size);

    return { name, vectors: { size, distance } };
  }

  async deleteCollection(name: string): Promise<void> {
    // Close database connection if open
    const db = this.dbs.get(name);
    if (db) {
      db.close();
      this.dbs.delete(name);
    }

    // Delete database file
    const dbFile = this.dbPath(name);
    await fs.rm(dbFile, { force: true }).catch(() => {});
    // Also remove WAL and SHM files if they exist
    await fs.rm(dbFile + "-wal", { force: true }).catch(() => {});
    await fs.rm(dbFile + "-shm", { force: true }).catch(() => {});
  }

  /**
   * Delete points from a collection by IDs or by filter.
   * @param name Collection name
   * @param pointIds Optional array of point IDs to delete
   * @param filter Optional filter function to match points by payload
   * @returns Number of points deleted (0 if collection doesn't exist)
   */
  async deletePoints(
    name: string,
    pointIds?: (string | number)[],
    filter?: (payload: unknown) => boolean
  ): Promise<number> {
    const db = this.getDb(name);
    if (!db) {
      return 0;
    }

    let deletedCount = 0;

    // Delete by IDs
    if (pointIds && pointIds.length > 0) {
      const deleteVector = db.prepare("DELETE FROM vectors WHERE point_id = ?");
      const deletePayload = db.prepare(
        "DELETE FROM payloads WHERE point_id = ?"
      );

      const deleteById = db.transaction((ids: (string | number)[]) => {
        for (const id of ids) {
          const idStr = String(id);
          const result = deleteVector.run(idStr);
          deletePayload.run(idStr);
          deletedCount += result.changes;
        }
      });

      deleteById(pointIds);
    }

    // Delete by filter (requires scanning payloads)
    if (filter) {
      const allPayloads = db
        .prepare("SELECT point_id, payload FROM payloads")
        .all() as Array<{ point_id: string; payload: string | null }>;

      const idsToDelete: string[] = [];
      for (const row of allPayloads) {
        const payload = row.payload ? JSON.parse(row.payload) : null;
        if (filter(payload)) {
          idsToDelete.push(row.point_id);
        }
      }

      if (idsToDelete.length > 0) {
        const deleteVector = db.prepare(
          "DELETE FROM vectors WHERE point_id = ?"
        );
        const deletePayload = db.prepare(
          "DELETE FROM payloads WHERE point_id = ?"
        );

        const deleteByFilter = db.transaction((ids: string[]) => {
          for (const id of ids) {
            const result = deleteVector.run(id);
            deletePayload.run(id);
            deletedCount += result.changes;
          }
        });

        deleteByFilter(idsToDelete);
      }
    }

    return deletedCount;
  }

  async upsertPoints(name: string, points: PointRecord[]): Promise<void> {
    const collection = await this.getCollection(name);
    if (!collection) {
      throw new Error(`Collection not found: ${name}`);
    }

    const db = this.getDb(name)!;
    const dimension = collection.vectors.size;

    // Validate points
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

    // Prepare statements for upsert
    // For vec0 tables, we need to delete then insert (no UPDATE support)
    const deleteVector = db.prepare("DELETE FROM vectors WHERE point_id = ?");
    const insertVector = db.prepare(
      "INSERT INTO vectors (point_id, embedding) VALUES (?, ?)"
    );
    const upsertPayload = db.prepare(
      "INSERT OR REPLACE INTO payloads (point_id, payload) VALUES (?, ?)"
    );

    // Use a transaction for atomic upsert
    const upsert = db.transaction((pts: PointRecord[]) => {
      for (const point of pts) {
        const idStr = String(point.id);

        // Delete existing vector if present (vec0 doesn't support UPDATE)
        deleteVector.run(idStr);

        // Insert vector as JSON string
        insertVector.run(idStr, JSON.stringify(point.vector));

        // Upsert payload
        const payloadJson =
          point.payload !== undefined ? JSON.stringify(point.payload) : null;
        upsertPayload.run(idStr, payloadJson);
      }
    });

    upsert(points);
  }

  async query(name: string, queryVector: number[], options: QueryOptions = {}) {
    const collection = await this.getCollection(name);
    if (!collection) {
      throw new Error(`Collection not found: ${name}`);
    }

    const db = this.getDb(name)!;
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

    // Query using vec0 MATCH syntax
    // sqlite-vec returns cosine distance (0 = identical, 2 = opposite)
    // We convert to similarity: similarity = 1 - distance
    const stmt = db.prepare(`
      SELECT 
        v.point_id,
        v.distance,
        p.payload
      FROM vectors v
      LEFT JOIN payloads p ON v.point_id = p.point_id
      WHERE v.embedding MATCH ?
        AND k = ?
      ORDER BY v.distance ASC
    `);

    // Request more results to filter by threshold
    const searchLimit = Math.max(limit * 2, 50);
    const rows = stmt.all(JSON.stringify(queryVector), searchLimit) as Array<{
      point_id: string;
      distance: number;
      payload: string | null;
    }>;

    const results: Array<{
      id: string | number;
      score: number;
      payload: unknown;
    }> = [];

    for (const row of rows) {
      // Convert distance to similarity score
      const score = 1 - row.distance;

      if (score >= scoreThreshold) {
        // Try to parse ID back to number if it was originally a number
        let id: string | number = row.point_id;
        const numId = Number(row.point_id);
        if (!isNaN(numId) && String(numId) === row.point_id) {
          id = numId;
        }

        results.push({
          id,
          score,
          payload: row.payload ? JSON.parse(row.payload) : null,
        });

        if (results.length >= limit) {
          break;
        }
      }
    }

    return results;
  }

  /**
   * Compact the collection by running SQLite VACUUM.
   * Returns the number of unique points in the collection.
   */
  async compactCollection(name: string): Promise<number> {
    const collection = await this.getCollection(name);
    if (!collection) {
      throw new Error(`Collection not found: ${name}`);
    }

    const db = this.getDb(name)!;

    // Run VACUUM to reclaim space and optimize database
    db.exec("VACUUM");

    // Count points
    const countRow = db
      .prepare("SELECT COUNT(*) as count FROM vectors")
      .get() as { count: number };

    return countRow.count;
  }

  /**
   * Persist all indexes to disk.
   * With SQLite, this performs a WAL checkpoint to ensure durability.
   */
  async persistAllIndexes(): Promise<void> {
    for (const db of this.dbs.values()) {
      // Force WAL checkpoint to ensure all changes are written to main database file
      db.pragma("wal_checkpoint(TRUNCATE)");
    }
  }

  /**
   * Close all database connections. Call this before shutdown.
   */
  close(): void {
    for (const db of this.dbs.values()) {
      db.close();
    }
    this.dbs.clear();
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
