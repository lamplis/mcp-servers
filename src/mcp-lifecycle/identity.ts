import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./disk-gate.js";

export const INSTANCE_FILE_NAME = "instance.json";

export interface InstanceInfo {
  role: string;
  pid: number;
  instanceId: string;
  startedAt: string;
  cwd: string;
  argv1: string;
  port: number | null;
  node: string;
}

export function instanceFilePath(dataDir: string): string {
  return path.join(path.resolve(dataDir), INSTANCE_FILE_NAME);
}

export async function readInstanceFile(
  dataDir: string
): Promise<InstanceInfo | null> {
  try {
    const raw = await fs.readFile(instanceFilePath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<InstanceInfo>;
    const pid = parsed.pid;
    if (typeof parsed.role !== "string" || typeof pid !== "number" || !Number.isInteger(pid)) {
      return null;
    }
    return {
      role: parsed.role,
      pid,
      instanceId: typeof parsed.instanceId === "string" ? parsed.instanceId : "",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      argv1: typeof parsed.argv1 === "string" ? parsed.argv1 : "",
      port: typeof parsed.port === "number" ? parsed.port : null,
      node: typeof parsed.node === "string" ? parsed.node : "",
    };
  } catch {
    return null;
  }
}

export async function announceInstance(options: {
  role: string;
  dataDir: string;
  port?: number | null;
  now?: () => Date;
}): Promise<InstanceInfo> {
  process.title = `mcp-${options.role}`;
  const info: InstanceInfo = {
    role: options.role,
    pid: process.pid,
    instanceId: crypto.randomUUID(),
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
    cwd: process.cwd(),
    argv1: process.argv[1] ?? "",
    port: options.port ?? null,
    node: process.version,
  };
  await fs.mkdir(path.resolve(options.dataDir), { recursive: true });
  await atomicWriteFile(
    instanceFilePath(options.dataDir),
    `${JSON.stringify(info, null, 2)}\n`
  );
  return info;
}

export async function removeInstanceFile(dataDir: string): Promise<void> {
  await fs.rm(instanceFilePath(dataDir), { force: true }).catch(() => undefined);
}
