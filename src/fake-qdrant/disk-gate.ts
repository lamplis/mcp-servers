import fs from "node:fs/promises";
import path from "node:path";

/**
 * Serial promise mutex. Used as the process-wide disk writer (one write at a
 * time) and as a per-collection / graph mutation lock.
 */
export class Mutex {
  private chain: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(() => fn());
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  drain(): Promise<void> {
    return this.run(() => undefined);
  }
}

/** Process-wide single disk writer. */
export class DiskGate extends Mutex {}

export class ProcessLockBusyError extends Error {
  readonly holderPid?: number;

  constructor(message: string, holderPid?: number) {
    super(message);
    this.name = "ProcessLockBusyError";
    this.holderPid = holderPid;
  }
}

export interface ProcessLock {
  readonly lockDir: string;
  readonly pid: number;
  release(): Promise<void>;
}

export function isPidAlive(
  pid: number,
  killFn: (pid: number, signal: 0) => void = (id, signal) => {
    process.kill(id, signal);
  }
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    killFn(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function lockDirForDataDir(dataDir: string): string {
  return path.join(dataDir, ".write.lock");
}

export function lockDirForMemoryFile(memoryFilePath: string): string {
  return `${memoryFilePath}.lock`;
}

async function readHolderPid(lockDir: string): Promise<number | undefined> {
  try {
    const raw = await fs.readFile(path.join(lockDir, "pid"), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function removeLockDir(lockDir: string): Promise<void> {
  await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
}

export interface AcquireProcessLockOptions {
  lockDir: string;
  pid?: number;
  retries?: number;
  retryMs?: number;
  isAlive?: (pid: number) => boolean;
}

/**
 * Exclusive lock via mkdir (atomic on NTFS). Stores a pid file so a dead
 * holder can be stolen. Waits with backoff, then throws ProcessLockBusyError.
 */
export async function acquireProcessLock(
  options: AcquireProcessLockOptions
): Promise<ProcessLock> {
  const lockDir = path.resolve(options.lockDir);
  const pid = options.pid ?? process.pid;
  const retries = options.retries ?? 20;
  const retryMs = options.retryMs ?? 50;
  const alive = options.isAlive ?? isPidAlive;
  await fs.mkdir(path.dirname(lockDir), { recursive: true });

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(path.join(lockDir, "pid"), `${pid}\n`, "utf8");
      return {
        lockDir,
        pid,
        release: async () => {
          await removeLockDir(lockDir);
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      const holderPid = await readHolderPid(lockDir);
      const stale =
        holderPid === undefined ||
        (holderPid !== pid && !alive(holderPid));
      if (stale) {
        await removeLockDir(lockDir);
        continue;
      }
      if (holderPid === pid) {
        return {
          lockDir,
          pid,
          release: async () => {
            await removeLockDir(lockDir);
          },
        };
      }
      if (attempt === retries) {
        throw new ProcessLockBusyError(
          `Data directory is locked by process ${holderPid ?? "unknown"}`,
          holderPid
        );
      }
      await sleep(retryMs * (attempt + 1));
    }
  }

  throw new ProcessLockBusyError("Data directory is locked");
}

export async function atomicWriteFile(
  filePath: string,
  content: string
): Promise<void> {
  const dest = path.resolve(filePath);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  try {
    await fs.rename(tmp, dest);
  } catch {
    await fs.rm(dest, { force: true }).catch(() => undefined);
    await fs.rename(tmp, dest);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
