import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { KnowledgeGraphManager } from "../server.js";
import {
  ProcessLockBusyError,
  acquireProcessLock,
  lockDirForMemoryFile,
} from "../disk-gate.js";

describe("KnowledgeGraphManager concurrency and lock", () => {
  let manager: KnowledgeGraphManager | undefined;
  let testFilePath: string;
  let extraLock: { release(): Promise<void> } | undefined;

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = undefined;
    }
    if (extraLock) {
      await extraLock.release();
      extraLock = undefined;
    }
    if (testFilePath) {
      await fs.unlink(testFilePath).catch(() => undefined);
      await fs
        .rm(`${testFilePath}.lock`, { recursive: true, force: true })
        .catch(() => undefined);
    }
  });

  function makePath(): string {
    testFilePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      `test-memory-conc-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
    );
    return testFilePath;
  }

  it("keeps every concurrent add_observations fact", async () => {
    manager = await KnowledgeGraphManager.create(makePath());
    await manager.createEntities([
      { name: "Alice", entityType: "person", observations: [] },
    ]);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        manager!.addObservations([
          { entityName: "Alice", contents: [`fact-${i}`] },
        ])
      )
    );
    const graph = await manager.readGraph();
    expect(graph.entities).toHaveLength(1);
    expect(graph.entities[0]?.observations).toHaveLength(20);
    expect(new Set(graph.entities[0]?.observations)).toEqual(
      new Set(Array.from({ length: 20 }, (_, i) => `fact-${i}`))
    );
    const raw = await fs.readFile(testFilePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim() !== "");
    expect(lines.every((line) => JSON.parse(line))).toBeTruthy();
  });

  it("marks the manager busy when another live process holds the lock", async () => {
    makePath();
    extraLock = await acquireProcessLock({
      lockDir: lockDirForMemoryFile(testFilePath),
      pid: 424242,
      isAlive: () => true,
      retries: 0,
    });
    manager = await KnowledgeGraphManager.create(testFilePath, {
      lockRetries: 0,
      lockRetryMs: 1,
    });
    expect(manager.isBusy).toBe(true);
    await expect(
      manager.createEntities([
        { name: "Alice", entityType: "person", observations: [] },
      ])
    ).rejects.toBeInstanceOf(ProcessLockBusyError);
  });

  it("steals a stale lockdir pid and becomes writable", async () => {
    makePath();
    const lockDir = lockDirForMemoryFile(testFilePath);
    await fs.mkdir(lockDir, { recursive: true });
    await fs.writeFile(path.join(lockDir, "pid"), "999999991\n", "utf8");
    manager = await KnowledgeGraphManager.create(testFilePath, {
      lockRetries: 2,
      lockRetryMs: 1,
    });
    expect(manager.isBusy).toBe(false);
    await manager.createEntities([
      { name: "Alice", entityType: "person", observations: ["ok"] },
    ]);
    const graph = await manager.readGraph();
    expect(graph.entities[0]?.name).toBe("Alice");
  });
});
