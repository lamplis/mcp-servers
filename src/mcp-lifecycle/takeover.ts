import net from "node:net";
import {
  ProcessLockBusyError,
  acquireProcessLock,
  isPidAlive,
  readLockHolderPid,
  sleep,
  type ProcessLock,
} from "./disk-gate.js";
import type { Logger } from "./logger.js";
import { isNodeImage, isOurProcess, listProcessImage, type VerifyDeps } from "./verify.js";

export type TakeoverPolicy = "takeover" | "fail-fast";

export const DEFAULT_TAKEOVER_WAIT_MS = 5000;

export class ContentionForeignError extends Error {
  readonly holderPid?: number;
  readonly port?: number;

  constructor(message: string, holderPid?: number, port?: number) {
    super(message);
    this.name = "ContentionForeignError";
    this.holderPid = holderPid;
    this.port = port;
  }
}

export function parseTakeoverPolicy(
  value: string | undefined = process.env.MCP_TAKEOVER
): TakeoverPolicy {
  const normalized = (value ?? "1").trim().toLowerCase();
  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "fail" ||
    normalized === "fail-fast"
  ) {
    return "fail-fast";
  }
  return "takeover";
}

export interface TakeoverDeps extends VerifyDeps {
  kill?: (pid: number) => void;
  sleepFn?: (ms: number) => Promise<void>;
  isPortFree?: (host: string, port: number) => Promise<boolean>;
  now?: () => number;
}

export function killProcess(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // Already gone.
  }
}

export function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export function takeoverKillCommand(role: string): string {
  return `node scripts/mcp-ps.mjs kill ${role}`;
}

export async function resolveContention(options: {
  lockDir: string;
  dataDir: string;
  role: string;
  port?: number;
  sidecar?: string;
  policy?: TakeoverPolicy;
  logger?: Logger;
  pid?: number;
  waitMs?: number;
  deps?: TakeoverDeps;
}): Promise<ProcessLock> {
  const policy = options.policy ?? parseTakeoverPolicy();
  const waitMs = options.waitMs ?? DEFAULT_TAKEOVER_WAIT_MS;
  const deps = options.deps ?? {};
  const alive = deps.isAlive ?? isPidAlive;
  const kill = deps.kill ?? killProcess;
  const sleepFn = deps.sleepFn ?? sleep;

  try {
    return await acquireProcessLock({
      lockDir: options.lockDir,
      pid: options.pid,
      isAlive: alive,
      retries: 4,
      retryMs: 25,
    });
  } catch (error) {
    if (!(error instanceof ProcessLockBusyError)) {
      throw error;
    }
    const holderPid = error.holderPid;
    const ours =
      holderPid != null &&
      (await isOurProcess({
        pid: holderPid,
        role: options.role,
        dataDir: options.dataDir,
        port: options.port,
        sidecar: options.sidecar,
        isAlive: alive,
        listImage: deps.listImage,
        fetchHealth: deps.fetchHealth,
      }));
    if (!ours) {
      options.logger?.error("lifecycle.contention_foreign", {
        holderPid,
        lockDir: options.lockDir,
        port: options.port,
        role: options.role,
      });
      throw new ContentionForeignError(
        `Data directory is locked by process ${holderPid ?? "unknown"} (not this MCP role). ${takeoverKillCommand(options.role)}`,
        holderPid,
        options.port
      );
    }
    if (policy === "fail-fast") {
      options.logger?.error("lifecycle.contention_foreign", {
        holderPid,
        lockDir: options.lockDir,
        policy,
        role: options.role,
      });
      throw new ContentionForeignError(
        `Data directory is locked by our process ${holderPid}. Set MCP_TAKEOVER=1 to replace it, or ${takeoverKillCommand(options.role)}`,
        holderPid,
        options.port
      );
    }
    options.logger?.info("lifecycle.takeover", {
      holderPid,
      role: options.role,
      lockDir: options.lockDir,
      port: options.port,
    });
    if (holderPid != null) {
      kill(holderPid);
    }
    await waitUntil(
      async () => {
        const stillAlive = holderPid != null && alive(holderPid);
        const remaining = await readLockHolderPid(options.lockDir);
        return !stillAlive && (remaining === undefined || remaining === options.pid);
      },
      waitMs,
      sleepFn
    );
    return acquireProcessLock({
      lockDir: options.lockDir,
      pid: options.pid,
      isAlive: alive,
      retries: 20,
      retryMs: 50,
    });
  }
}

export async function resolvePortContention(options: {
  host: string;
  port: number;
  role: string;
  dataDir: string;
  sidecar?: string;
  policy?: TakeoverPolicy;
  logger?: Logger;
  waitMs?: number;
  deps?: TakeoverDeps;
}): Promise<void> {
  const policy = options.policy ?? parseTakeoverPolicy();
  const waitMs = options.waitMs ?? DEFAULT_TAKEOVER_WAIT_MS;
  const deps = options.deps ?? {};
  const alive = deps.isAlive ?? isPidAlive;
  const kill = deps.kill ?? killProcess;
  const sleepFn = deps.sleepFn ?? sleep;
  const portFree = deps.isPortFree ?? isPortFree;
  const fetchHealth =
    deps.fetchHealth ??
    (async () => {
      const { fetchHealthz } = await import("./verify.js");
      return fetchHealthz(options.host, options.port);
    });

  const health = await fetchHealth(options.port);
  const healthPid = Number(health?.pid);
  const holderPid = Number.isInteger(healthPid) ? healthPid : undefined;
  const image =
    holderPid != null
      ? await (deps.listImage ?? listProcessImage)(holderPid)
      : undefined;
  const sidecarOk = !options.sidecar || health?.sidecar === options.sidecar;
  const ours =
    holderPid != null &&
    alive(holderPid) &&
    sidecarOk &&
    isNodeImage(image);

  if (!ours) {
    options.logger?.error("lifecycle.contention_foreign", {
      holderPid,
      port: options.port,
      role: options.role,
      sidecar: health?.sidecar,
    });
    throw new ContentionForeignError(
      `Port ${options.port} is in use by process ${holderPid ?? "unknown"} (not this MCP role). ${takeoverKillCommand(options.role)}`,
      holderPid,
      options.port
    );
  }
  if (policy === "fail-fast") {
    options.logger?.error("lifecycle.contention_foreign", {
      holderPid,
      port: options.port,
      policy,
      role: options.role,
    });
    throw new ContentionForeignError(
      `Port ${options.port} is held by our process ${holderPid}. Set MCP_TAKEOVER=1 to replace it, or ${takeoverKillCommand(options.role)}`,
      holderPid,
      options.port
    );
  }
  options.logger?.info("lifecycle.takeover", {
    holderPid,
    role: options.role,
    port: options.port,
  });
  if (holderPid != null) {
    kill(holderPid);
  }
  await waitUntil(
    () => portFree(options.host, options.port),
    waitMs,
    sleepFn
  );
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  waitMs: number,
  sleepFn: (ms: number) => Promise<void>
): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleepFn(50);
  }
}
