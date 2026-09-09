import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DiskGate,
  Mutex,
  ProcessLockBusyError,
  acquireProcessLock,
  atomicWriteFile,
  lockDirForMemoryFile,
} from "../disk-gate.js";

describe("Mutex / DiskGate", () => {
  it("runs work in series", async () => {
    const mutex = new Mutex();
    const order: number[] = [];
    await Promise.all([
      mutex.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(1);
      }),
      mutex.run(async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });

  it("drains queued DiskGate work", async () => {
    const gate = new DiskGate();
    let done = false;
    void gate.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      done = true;
    });
    await gate.drain();
    expect(done).toBe(true);
  });
});

describe("atomicWriteFile", () => {
  it("replaces the destination with a complete file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-mem-atomic-"));
    const dest = path.join(dir, "memory.jsonl");
    await atomicWriteFile(dest, "first\n");
    await atomicWriteFile(dest, "second\n");
    expect(await fs.readFile(dest, "utf8")).toBe("second\n");
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("acquireProcessLock", () => {
  let lockDir: string;

  afterEach(async () => {
    if (lockDir) {
      await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("throws ProcessLockBusyError when another live pid holds the lock", async () => {
    const memoryFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "mcp-mem-lock-")),
      "memory.jsonl"
    );
    lockDir = lockDirForMemoryFile(memoryFile);
    const first = await acquireProcessLock({
      lockDir,
      pid: 424242,
      isAlive: () => true,
      retries: 0,
    });
    await expect(
      acquireProcessLock({
        lockDir,
        pid: 424243,
        isAlive: () => true,
        retries: 0,
        retryMs: 1,
      })
    ).rejects.toBeInstanceOf(ProcessLockBusyError);
    await first.release();
  });

  it("steals a stale pid", async () => {
    const memoryFile = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "mcp-mem-stale-")),
      "memory.jsonl"
    );
    lockDir = lockDirForMemoryFile(memoryFile);
    await acquireProcessLock({
      lockDir,
      pid: 1,
      isAlive: () => false,
      retries: 0,
    });
    const stolen = await acquireProcessLock({
      lockDir,
      pid: 2,
      isAlive: () => false,
      retries: 2,
      retryMs: 1,
    });
    expect(stolen.pid).toBe(2);
    const pidRaw = await fs.readFile(path.join(lockDir, "pid"), "utf8");
    expect(pidRaw.trim()).toBe("2");
    await stolen.release();
  });
});
