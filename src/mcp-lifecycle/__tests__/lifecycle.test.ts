import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  announceInstance,
  readInstanceFile,
  removeInstanceFile,
  instanceFilePath,
} from "../identity.js";
import { isOurProcess, isNodeImage } from "../verify.js";
import {
  ContentionForeignError,
  TakeoverFailedError,
  parseTakeoverPolicy,
  resolveContention,
  resolvePortContention,
} from "../takeover.js";
import { installShutdownHooks } from "../shutdown.js";
import { acquireProcessLock, lockDirForDataDir, atomicWriteFile } from "../disk-gate.js";
import { createNoopLogger } from "../logger.js";

describe("identity", () => {
  let dataDir: string;
  const previousTitle = process.title;

  afterEach(async () => {
    process.title = previousTitle;
    if (dataDir) {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("sets process.title and writes instance.json", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-ident-"));
    const info = await announceInstance({ role: "fake-qdrant", dataDir, port: 6333 });
    expect(process.title).toBe("mcp-fake-qdrant");
    expect(info.pid).toBe(process.pid);
    expect(info.port).toBe(6333);
    const read = await readInstanceFile(dataDir);
    expect(read?.instanceId).toBe(info.instanceId);
    await removeInstanceFile(dataDir);
    expect(await readInstanceFile(dataDir)).toBeNull();
  });
});

describe("verify", () => {
  it("rejects non-node images", () => {
    expect(isNodeImage("chrome.exe")).toBe(false);
    expect(isNodeImage("node.exe")).toBe(true);
  });

  it("requires matching instance pid/role, node image, and optional healthz", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-verify-"));
    await announceInstance({ role: "fake-qdrant", dataDir: dir, port: 6333 });
    const ours = await isOurProcess({
      pid: process.pid,
      role: "fake-qdrant",
      dataDir: dir,
      port: 6333,
      sidecar: "fake-qdrant-mcp",
      isAlive: () => true,
      listImage: async () => "node.exe",
      fetchHealth: async () => ({ sidecar: "fake-qdrant-mcp", pid: process.pid }),
      commandLine: async () => undefined,
    });
    expect(ours).toBe(true);
    const foreignHealth = await isOurProcess({
      pid: process.pid,
      role: "fake-qdrant",
      dataDir: dir,
      port: 6333,
      sidecar: "fake-qdrant-mcp",
      isAlive: () => true,
      listImage: async () => "node.exe",
      fetchHealth: async () => ({ sidecar: "other", pid: process.pid }),
      commandLine: async () => undefined,
    });
    expect(foreignHealth).toBe(false);
    const missingArgv = await isOurProcess({
      pid: process.pid,
      role: "fake-qdrant",
      dataDir: dir,
      isAlive: () => true,
      listImage: async () => "node.exe",
      commandLine: async () => "C:\\Windows\\System32\\cmd.exe",
    });
    expect(missingArgv).toBe(false);
    const unknownCmd = await isOurProcess({
      pid: process.pid,
      role: "fake-qdrant",
      dataDir: dir,
      isAlive: () => true,
      listImage: async () => "node.exe",
      commandLine: async () => undefined,
    });
    expect(unknownCmd).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("takeover", () => {
  let dataDir: string;

  afterEach(async () => {
    if (dataDir) {
      await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("parses MCP_TAKEOVER", () => {
    expect(parseTakeoverPolicy("1")).toBe("takeover");
    expect(parseTakeoverPolicy("0")).toBe("fail-fast");
    expect(parseTakeoverPolicy(undefined)).toBe("takeover");
  });

  it("kills a verified holder and re-acquires the lock", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-take-"));
    const identity = await announceInstance({ role: "fake-qdrant", dataDir, port: 6333 });
    await atomicWriteFile(
      instanceFilePath(dataDir),
      `${JSON.stringify({ ...identity, pid: 424242 }, null, 2)}\n`
    );
    const lockDir = lockDirForDataDir(dataDir);
    const holder = await acquireProcessLock({
      lockDir,
      pid: 424242,
      isAlive: () => true,
      retries: 0,
    });
    const killed: number[] = [];
    const lock = await resolveContention({
      lockDir,
      dataDir,
      role: "fake-qdrant",
      port: 6333,
      sidecar: "fake-qdrant-mcp",
      policy: "takeover",
      logger: createNoopLogger(),
      pid: 424243,
      waitMs: 200,
      deps: {
        isAlive: (pid) => (pid === 424242 ? killed.length === 0 : true),
        listImage: async () => "node.exe",
        fetchHealth: async () => ({ sidecar: "fake-qdrant-mcp", pid: 424242 }),
        commandLine: async () => undefined,
        kill: (pid) => {
          killed.push(pid);
          void holder.release();
        },
        sleepFn: async () => undefined,
      },
    });
    expect(killed).toEqual([424242]);
    expect(lock.pid).toBe(424243);
    await lock.release();
  });

  it("refuses to kill a foreign holder", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-foreign-"));
    const lockDir = lockDirForDataDir(dataDir);
    const holder = await acquireProcessLock({
      lockDir,
      pid: 111,
      isAlive: () => true,
      retries: 0,
    });
    await expect(
      resolveContention({
        lockDir,
        dataDir,
        role: "fake-qdrant",
        policy: "takeover",
        pid: 222,
        deps: {
          isAlive: () => true,
          listImage: async () => "chrome.exe",
          commandLine: async () => undefined,
          sleepFn: async () => undefined,
        },
      })
    ).rejects.toBeInstanceOf(ContentionForeignError);
    await holder.release();
  });

  it("fail-fast refuses even a verified holder", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-fail-"));
    const identity = await announceInstance({ role: "docsearch", dataDir });
    await atomicWriteFile(
      instanceFilePath(dataDir),
      `${JSON.stringify({ ...identity, pid: 333 }, null, 2)}\n`
    );
    const lockDir = lockDirForDataDir(dataDir);
    const holder = await acquireProcessLock({
      lockDir,
      pid: 333,
      isAlive: () => true,
      retries: 0,
    });
    await expect(
      resolveContention({
        lockDir,
        dataDir,
        role: "docsearch",
        policy: "fail-fast",
        pid: 444,
        deps: {
          isAlive: () => true,
          listImage: async () => "node.exe",
          commandLine: async () => undefined,
          sleepFn: async () => undefined,
        },
      })
    ).rejects.toBeInstanceOf(ContentionForeignError);
    await holder.release();
  });

  it("takes over a verified HTTP port holder", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-port-"));
    const identity = await announceInstance({ role: "fake-qdrant", dataDir, port: 16333 });
    await atomicWriteFile(
      instanceFilePath(dataDir),
      `${JSON.stringify({ ...identity, pid: process.pid }, null, 2)}\n`
    );
    const killed: number[] = [];
    await resolvePortContention({
      host: "127.0.0.1",
      port: 16333,
      role: "fake-qdrant",
      dataDir,
      sidecar: "fake-qdrant-mcp",
      policy: "takeover",
      waitMs: 200,
      deps: {
        isAlive: () => true,
        listImage: async () => "node.exe",
        fetchHealth: async () => ({ sidecar: "fake-qdrant-mcp", pid: process.pid }),
        kill: (pid) => killed.push(pid),
        isPortFree: async () => true,
        sleepFn: async () => undefined,
      },
    });
    expect(killed).toEqual([process.pid]);
  });

  it("throws TakeoverFailedError when the holder never dies", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-take-fail-"));
    const identity = await announceInstance({ role: "fake-qdrant", dataDir, port: 6333 });
    await atomicWriteFile(
      instanceFilePath(dataDir),
      `${JSON.stringify({ ...identity, pid: 424242 }, null, 2)}\n`
    );
    const lockDir = lockDirForDataDir(dataDir);
    const holder = await acquireProcessLock({
      lockDir,
      pid: 424242,
      isAlive: () => true,
      retries: 0,
    });
    await expect(
      resolveContention({
        lockDir,
        dataDir,
        role: "fake-qdrant",
        port: 6333,
        sidecar: "fake-qdrant-mcp",
        policy: "takeover",
        logger: createNoopLogger(),
        pid: 424243,
        waitMs: 0,
        deps: {
          isAlive: () => true,
          listImage: async () => "node.exe",
          fetchHealth: async () => ({ sidecar: "fake-qdrant-mcp", pid: 424242 }),
          commandLine: async () => undefined,
          kill: () => undefined,
          sleepFn: async () => undefined,
        },
      })
    ).rejects.toBeInstanceOf(TakeoverFailedError);
    await holder.release();
  });

  it("throws TakeoverFailedError when the HTTP port never frees", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-port-fail-"));
    await expect(
      resolvePortContention({
        host: "127.0.0.1",
        port: 16333,
        role: "fake-qdrant",
        dataDir,
        sidecar: "fake-qdrant-mcp",
        policy: "takeover",
        waitMs: 0,
        deps: {
          isAlive: () => true,
          listImage: async () => "node.exe",
          fetchHealth: async () => ({ sidecar: "fake-qdrant-mcp", pid: process.pid }),
          kill: () => undefined,
          isPortFree: async () => false,
          sleepFn: async () => undefined,
        },
      })
    ).rejects.toBeInstanceOf(TakeoverFailedError);
  });
});

describe("shutdown", () => {
  it("runs onShutdown when stdin ends", async () => {
    const stdin = new EventEmitter() as EventEmitter & NodeJS.ReadableStream;
    const exits: number[] = [];
    let shutdowns = 0;
    const uninstall = installShutdownHooks({
      stdin,
      hardExitMs: 50,
      exit: (code) => exits.push(code),
      onShutdown: async () => {
        shutdowns += 1;
      },
    });
    stdin.emit("end");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shutdowns).toBe(1);
    expect(exits).toEqual([0]);
    uninstall();
  });

  it("runs onExitSync on the process exit fallback", () => {
    let syncs = 0;
    const uninstall = installShutdownHooks({
      stdin: new EventEmitter() as EventEmitter & NodeJS.ReadableStream,
      hardExitMs: 50,
      exit: () => undefined,
      onShutdown: async () => undefined,
      onExitSync: () => {
        syncs += 1;
      },
    });
    process.emit("exit", 0);
    expect(syncs).toBe(1);
    uninstall();
  });
});
