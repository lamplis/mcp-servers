import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isPidAlive, removeLockDir } from "./disk-gate.js";
import { instanceFilePath, readInstanceFile, removeInstanceFile } from "./identity.js";
import type { Logger } from "./logger.js";

export type CleanReason = "lock-dead" | "lock-missing" | "instance-dead" | "instance-own" | "tmp";

export interface CleanRemoval {
  path: string;
  reason: CleanReason;
}

export interface CleanStaleStateOptions {
  dataDir: string;
  lockDir: string;
  role?: string;
  ownPid?: number;
  isAlive?: (pid: number) => boolean;
  logger?: Logger;
}

export interface CleanStaleStateResult {
  removed: string[];
  keptLockPid?: number;
  details: CleanRemoval[];
}

export function readLockPidSync(lockDir: string): number | undefined {
  try {
    const raw = fs.readFileSync(path.join(lockDir, "pid"), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function readInstancePidSync(dataDir: string): number | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(instanceFilePath(dataDir), "utf8")) as {
      pid?: unknown;
    };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid)
      ? parsed.pid
      : undefined;
  } catch {
    return undefined;
  }
}

export function releaseIdentitySync(options: {
  lockDir: string;
  dataDir: string;
  pid: number;
}): void {
  const lockPid = readLockPidSync(options.lockDir);
  if (lockPid === options.pid) {
    fs.rmSync(options.lockDir, { recursive: true, force: true });
  }
  const instancePid = readInstancePidSync(options.dataDir);
  if (instancePid === options.pid) {
    fs.rmSync(instanceFilePath(options.dataDir), { force: true });
  }
}

export async function collectTmpFiles(dataDir: string): Promise<string[]> {
  const hits: string[] = [];
  const root = path.resolve(dataDir);
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === "logs") {
      continue;
    }
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".tmp")) {
      hits.push(full);
      continue;
    }
    if (entry.isDirectory() && entry.name === "collections") {
      const cols = await fsp.readdir(full, { withFileTypes: true }).catch(() => []);
      for (const col of cols) {
        if (!col.isDirectory()) {
          continue;
        }
        const colDir = path.join(full, col.name);
        const files = await fsp.readdir(colDir, { withFileTypes: true }).catch(() => []);
        for (const file of files) {
          if (file.isFile() && file.name.endsWith(".tmp")) {
            hits.push(path.join(colDir, file.name));
          }
        }
      }
    }
  }
  return hits;
}

export async function cleanStaleState(
  options: CleanStaleStateOptions
): Promise<CleanStaleStateResult> {
  const alive = options.isAlive ?? isPidAlive;
  const ownPid = options.ownPid ?? process.pid;
  const details: CleanRemoval[] = [];
  let keptLockPid: number | undefined;

  const lockPid = await readLockHolderPidSafe(options.lockDir);
  const lockExists = await pathExists(options.lockDir);
  if (lockExists) {
    if (lockPid === undefined || !alive(lockPid)) {
      await removeLockDir(options.lockDir);
      details.push({
        path: options.lockDir,
        reason: lockPid === undefined ? "lock-missing" : "lock-dead",
      });
    } else {
      keptLockPid = lockPid;
    }
  }

  const instance = await readInstanceFile(options.dataDir);
  if (instance) {
    if (!alive(instance.pid) || instance.pid === ownPid) {
      await removeInstanceFile(options.dataDir);
      details.push({
        path: instanceFilePath(options.dataDir),
        reason: instance.pid === ownPid ? "instance-own" : "instance-dead",
      });
    }
  }

  for (const tmp of await collectTmpFiles(options.dataDir)) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    details.push({ path: tmp, reason: "tmp" });
  }

  if (details.length > 0) {
    options.logger?.info("lifecycle.clean", {
      role: options.role,
      removed: details.map((item) => item.path),
      reasons: details.map((item) => item.reason),
    });
  }

  return {
    removed: details.map((item) => item.path),
    keptLockPid,
    details,
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readLockHolderPidSafe(lockDir: string): Promise<number | undefined> {
  try {
    const raw = await fsp.readFile(path.join(lockDir, "pid"), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}
