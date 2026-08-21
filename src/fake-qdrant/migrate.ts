#!/usr/bin/env node
/**
 * Scan a fake-qdrant data directory and report leftover SQLite files.
 * JSONL (meta.json + points.jsonl per collection) is the native format.
 *
 * Usage:
 *   npx tsx src/fake-qdrant/migrate.ts [data-dir]
 *
 * If data-dir is not provided, uses FAKE_QDRANT_DATA_DIR or the package data dir.
 */

import fs from "node:fs/promises";
import { Dirent } from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./store.js";

async function migrate(dataDir?: string): Promise<void> {
  const baseDir = resolveDataDir(dataDir);
  console.log(`Fake Qdrant data directory: ${baseDir}`);
  console.log("=".repeat(60));

  let entries: Dirent[];
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    console.error(`Cannot read data directory: ${baseDir}`);
    return;
  }

  const jsonlCollections: string[] = [];
  const sqliteFiles: string[] = [];

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".db")) {
      sqliteFiles.push(entry.name);
      continue;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    const metaPath = path.join(baseDir, entry.name, "meta.json");
    try {
      await fs.stat(metaPath);
      jsonlCollections.push(entry.name);
    } catch {
      // Not a collection directory
    }
  }

  if (jsonlCollections.length > 0) {
    console.log(`JSONL collections (native format, no migration needed):`);
    for (const name of jsonlCollections) {
      console.log(`  - ${name}`);
    }
  } else {
    console.log("No JSONL collections found.");
  }

  if (sqliteFiles.length > 0) {
    console.log();
    console.log("Leftover SQLite files cannot be converted on this workstation");
    console.log("(database binaries are blocked). Re-upsert points into JSONL collections.");
    for (const name of sqliteFiles) {
      console.log(`  - ${name}`);
    }
  }

  console.log();
  console.log("Nothing to migrate. JSONL is the native persistence format.");
}

const dataDir = process.argv[2];
migrate(dataDir).catch((error) => {
  console.error("Scan failed:", error);
  process.exit(1);
});
