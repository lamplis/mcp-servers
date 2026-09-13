import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { announceInstance, instanceFilePath } from "../identity.js";
import { acquireProcessLock, atomicWriteFile, lockDirForDataDir } from "../disk-gate.js";
import { createCallbackLogger, createNoopLogger } from "../logger.js";
import { cleanStaleState, releaseIdentitySync } from "../clean.js";

describe("cleanStaleState", () => {
  let dataDir: string;

  afterEach(async () => {
    if (dataDir) {
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("removes a dead lock, instance.json, and tmp files and logs lifecycle.clean", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-clean-"));
    const lockDir = lockDirForDataDir(dataDir);
    await acquireProcessLock({
      lockDir,
      pid: 424242,
      isAlive: () => true,
      retries: 0,
    });
    await announceInstance({ role: "fake-qdrant", dataDir });
    await atomicWriteFile(path.join(dataDir, "scratch.tmp"), "tmp\n");
    await fs.mkdir(path.join(dataDir, "collections", "demo"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "collections", "demo", "points.jsonl.tmp"), "x\n");
    await fs.mkdir(path.join(dataDir, "logs"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "logs", "keep.tmp"), "keep\n");

    const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const logger = createCallbackLogger((line) => {
      events.push(JSON.parse(line) as { event: string; fields?: Record<string, unknown> });
    });

    const result = await cleanStaleState({
      dataDir,
      lockDir,
      role: "fake-qdrant",
      ownPid: 1,
      isAlive: () => false,
      logger,
    });

    expect(result.removed.length).toBeGreaterThanOrEqual(3);
    expect(await fs.stat(lockDir).catch(() => null)).toBeNull();
    expect(await fs.stat(instanceFilePath(dataDir)).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(dataDir, "scratch.tmp")).catch(() => null)).toBeNull();
    expect(
      await fs.stat(path.join(dataDir, "collections", "demo", "points.jsonl.tmp")).catch(() => null)
    ).toBeNull();
    expect(await fs.readFile(path.join(dataDir, "logs", "keep.tmp"), "utf8")).toBe("keep\n");
    expect(events.some((item) => item.event === "lifecycle.clean")).toBe(true);
  });

  it("keeps a lock whose pid is still alive", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-clean-live-"));
    const lockDir = lockDirForDataDir(dataDir);
    const holder = await acquireProcessLock({
      lockDir,
      pid: 111,
      isAlive: () => true,
      retries: 0,
    });
    const result = await cleanStaleState({
      dataDir,
      lockDir,
      ownPid: 222,
      isAlive: () => true,
      logger: createNoopLogger(),
    });
    expect(result.keptLockPid).toBe(111);
    expect(await fs.readFile(path.join(lockDir, "pid"), "utf8")).toBe("111\n");
    await holder.release();
  });

  it("releaseIdentitySync only removes files that record the given pid", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-clean-sync-"));
    const lockDir = lockDirForDataDir(dataDir);
    await acquireProcessLock({
      lockDir,
      pid: 50,
      isAlive: () => true,
      retries: 0,
    });
    await announceInstance({ role: "memory", dataDir });
    await atomicWriteFile(
      instanceFilePath(dataDir),
      `${JSON.stringify({ role: "memory", pid: 50 }, null, 2)}\n`
    );
    releaseIdentitySync({ lockDir, dataDir, pid: 99 });
    expect(await fs.readFile(path.join(lockDir, "pid"), "utf8")).toBe("50\n");
    expect(JSON.parse(await fs.readFile(instanceFilePath(dataDir), "utf8")).pid).toBe(50);
    releaseIdentitySync({ lockDir, dataDir, pid: 50 });
    expect(await fs.stat(lockDir).catch(() => null)).toBeNull();
    expect(await fs.stat(instanceFilePath(dataDir)).catch(() => null)).toBeNull();
  });
});
