import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import {
  AUTO_COMPACT_EXTRA_LINES,
  Store,
  resolveDataDir,
} from "../store.js";
import {
  ProcessLockBusyError,
  acquireProcessLock,
  lockDirForDataDir,
} from "../disk-gate.js";

async function countJsonlLines(filePath: string): Promise<number> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  return raw.split("\n").filter((line) => line.trim() !== "").length;
}

async function parseJsonl(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

describe("Fake Qdrant store concurrency and auto-compact", () => {
  let store: Store | undefined;
  let testDataDir: string;
  let extraLock: { release(): Promise<void> } | undefined;

  afterEach(async () => {
    if (store) {
      await store.close();
      store = undefined;
    }
    if (extraLock) {
      await extraLock.release();
      extraLock = undefined;
    }
    if (testDataDir) {
      await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeDir(): Promise<string> {
    testDataDir = path.join(
      resolveDataDir(),
      `store-conc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(testDataDir, { recursive: true });
    return testDataDir;
  }

  it("keeps valid JSONL and all ids after concurrent upserts", async () => {
    await makeDir();
    store = await Store.create({ dataDir: testDataDir });
    await store.createCollection("vecs", { size: 2 });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store!.upsertPoints("vecs", [
          { id: i, vector: [1, 0], payload: { n: i } },
        ])
      )
    );
    const records = await parseJsonl(path.join(testDataDir, "vecs", "points.jsonl"));
    expect(records.length).toBeGreaterThanOrEqual(20);
    const results = await store.query("vecs", [1, 0], { limit: 50 });
    expect(new Set(results.map((row) => row.id))).toEqual(
      new Set(Array.from({ length: 20 }, (_, i) => i))
    );
  });

  it("lets the latest concurrent upsert for an id win", async () => {
    await makeDir();
    store = await Store.create({ dataDir: testDataDir });
    await store.createCollection("vecs", { size: 2 });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store!.upsertPoints("vecs", [
          { id: "same", vector: [1, 0], payload: { v: i } },
        ])
      )
    );
    const results = await store.query("vecs", [1, 0], { limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("same");
    const payload = results[0]?.payload as { v: number };
    expect(payload.v).toBeGreaterThanOrEqual(0);
    expect(payload.v).toBeLessThan(12);
    const records = await parseJsonl(path.join(testDataDir, "vecs", "points.jsonl"));
    expect(records.every((row) => typeof row === "object" && row !== null)).toBe(
      true
    );
  });

  it("auto-compacts after an upsert storm past the extra-line threshold", async () => {
    await makeDir();
    store = await Store.create({ dataDir: testDataDir });
    await store.createCollection("dupes", { size: 2 });
    const storm = Array.from({ length: AUTO_COMPACT_EXTRA_LINES + 2 }, () => ({
      id: "p",
      vector: [0, 1] as number[],
      payload: { v: 2 },
    }));
    await store.upsertPoints("dupes", storm);
    const lines = await countJsonlLines(
      path.join(testDataDir, "dupes", "points.jsonl")
    );
    expect(lines).toBe(1);
    const results = await store.query("dupes", [0, 1], { limit: 1 });
    expect(results[0]?.payload).toEqual({ v: 2 });
  });

  it("marks the store busy when another live process holds the lock", async () => {
    await makeDir();
    extraLock = await acquireProcessLock({
      lockDir: lockDirForDataDir(testDataDir),
      pid: 424242,
      isAlive: () => true,
      retries: 0,
    });
    store = await Store.create({
      dataDir: testDataDir,
      lockRetries: 0,
      lockRetryMs: 1,
    });
    expect(store.isBusy).toBe(true);
    await expect(
      store.createCollection("blocked", { size: 2 })
    ).rejects.toBeInstanceOf(ProcessLockBusyError);
  });

  it("steals a stale lockdir pid and becomes writable", async () => {
    await makeDir();
    const lockDir = lockDirForDataDir(testDataDir);
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(path.join(lockDir, "pid"), "999999991\n", "utf8");
    store = await Store.create({
      dataDir: testDataDir,
      lockRetries: 2,
      lockRetryMs: 1,
    });
    expect(store.isBusy).toBe(false);
    await store.createCollection("ok", { size: 2 });
    expect(await store.listCollections()).toHaveLength(1);
  });
});
