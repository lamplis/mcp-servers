#!/usr/bin/env node
/**
 * Migration utility: Convert existing JSONL data to SQLite format.
 * 
 * Usage:
 *   npx tsx src/fake-qdrant/migrate.ts [data-dir]
 * 
 * If data-dir is not provided, uses FAKE_QDRANT_DATA_DIR or ./data
 */

import fs from "node:fs/promises";
import { Dirent } from "node:fs";
import path from "node:path";
import { Store, resolveDataDir } from "./store.js";

interface OldCollectionMeta {
  size: number;
  distance: string;
}

interface OldPointRecord {
  id: string | number;
  vector: number[];
  payload: unknown;
}

async function migrateCollection(
  store: Store,
  name: string,
  collectionDir: string
): Promise<number> {
  // Read old metadata
  const metaPath = path.join(collectionDir, "meta.json");
  let meta: OldCollectionMeta;
  
  try {
    const metaContent = await fs.readFile(metaPath, "utf8");
    meta = JSON.parse(metaContent);
  } catch (error) {
    console.error(`  Skipping ${name}: Cannot read meta.json`);
    return 0;
  }

  // Read old points from JSONL
  const pointsPath = path.join(collectionDir, "points.jsonl");
  let pointsContent: string;
  
  try {
    pointsContent = await fs.readFile(pointsPath, "utf8");
  } catch (error) {
    console.error(`  Skipping ${name}: Cannot read points.jsonl`);
    return 0;
  }

  // Parse points (deduplicate: latest wins)
  const pointsMap = new Map<string | number, OldPointRecord>();
  const lines = pointsContent.split("\n");
  
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as OldPointRecord;
      pointsMap.set(record.id, record);
    } catch {
      // Skip malformed lines
    }
  }

  const points = Array.from(pointsMap.values());
  
  if (points.length === 0) {
    console.log(`  Collection ${name}: No points to migrate`);
    return 0;
  }

  // Create new collection
  console.log(`  Creating SQLite collection: ${name} (dim=${meta.size})`);
  await store.createCollection(name, {
    size: meta.size,
    distance: meta.distance,
  });

  // Upsert points in batches
  const BATCH_SIZE = 100;
  let migrated = 0;
  
  for (let i = 0; i < points.length; i += BATCH_SIZE) {
    const batch = points.slice(i, i + BATCH_SIZE);
    await store.upsertPoints(name, batch);
    migrated += batch.length;
    
    if (points.length > BATCH_SIZE) {
      console.log(`    Migrated ${migrated}/${points.length} points...`);
    }
  }

  return migrated;
}

async function migrate(dataDir?: string): Promise<void> {
  const baseDir = resolveDataDir(dataDir);
  console.log(`Migration: ${baseDir}`);
  console.log("=".repeat(60));

  // Find old-style collections (directories with meta.json)
  let entries: Dirent[];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch (error) {
    console.error(`Cannot read data directory: ${baseDir}`);
    return;
  }

  const oldCollections: string[] = [];
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    // Check if this is an old-style collection (has meta.json)
    const metaPath = path.join(baseDir, entry.name, "meta.json");
    try {
      await fs.stat(metaPath);
      oldCollections.push(entry.name);
    } catch {
      // Not an old collection
    }
  }

  if (oldCollections.length === 0) {
    console.log("No old-style JSONL collections found to migrate.");
    return;
  }

  console.log(`Found ${oldCollections.length} collection(s) to migrate:`);
  for (const name of oldCollections) {
    console.log(`  - ${name}`);
  }
  console.log();

  // Create store for new SQLite collections
  const store = await Store.create({ dataDir: baseDir });

  let totalMigrated = 0;
  const migratedCollections: string[] = [];
  
  for (const name of oldCollections) {
    const collectionDir = path.join(baseDir, name);
    console.log(`\nMigrating collection: ${name}`);
    
    try {
      const count = await migrateCollection(store, name, collectionDir);
      totalMigrated += count;
      if (count > 0) {
        migratedCollections.push(name);
      }
    } catch (error) {
      console.error(`  Error migrating ${name}:`, error);
    }
  }

  // Close store to flush all writes
  store.close();

  console.log("\n" + "=".repeat(60));
  console.log(`Migration complete!`);
  console.log(`  Collections migrated: ${migratedCollections.length}`);
  console.log(`  Total points: ${totalMigrated}`);
  
  if (migratedCollections.length > 0) {
    console.log("\nOld collection directories can now be safely removed:");
    for (const name of migratedCollections) {
      console.log(`  Remove-Item -Recurse "${path.join(baseDir, name)}"`);
    }
  }
}

// Main
const dataDir = process.argv[2];
migrate(dataDir).catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
