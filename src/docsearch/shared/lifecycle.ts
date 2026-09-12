import path from "node:path";
import {
  announceInstance,
  createFileLogger,
  DiskGate,
  installShutdownHooks,
  lockDirForDataDir,
  parseLogLevel,
  parseRetentionDays,
  parseTakeoverPolicy,
  resolveContention,
  type InstanceInfo,
  type Logger,
  type ProcessLock,
} from "@modelcontextprotocol/mcp-lifecycle";
import { CONFIG } from "./config.js";

export const DOCSEARCH_ROLE = "docsearch";

export interface DocsearchLifecycle {
  logger: Logger;
  diskGate: DiskGate;
  identity: InstanceInfo;
  processLock: ProcessLock;
  dataDir: string;
}

export async function startDocsearchLifecycle(): Promise<DocsearchLifecycle> {
  const dataDir = path.resolve(CONFIG.DATA_DIR);
  const logDir = path.resolve(
    process.env.DOCSEARCH_LOG_DIR ?? path.join(dataDir, "logs"),
  );
  const diskGate = new DiskGate();
  const logger = createFileLogger({
    logDir,
    level: parseLogLevel(process.env.DOCSEARCH_LOG_LEVEL),
    retentionDays: parseRetentionDays(process.env.DOCSEARCH_LOG_RETENTION_DAYS),
    redactVectors: true,
    diskGate,
  });
  process.title = `mcp-${DOCSEARCH_ROLE}`;
  const processLock = await resolveContention({
    lockDir: lockDirForDataDir(CONFIG.DB_PATH),
    dataDir,
    role: DOCSEARCH_ROLE,
    policy: parseTakeoverPolicy(),
    logger,
  });
  const identity = await announceInstance({ role: DOCSEARCH_ROLE, dataDir });
  logger.info("lifecycle.start", {
    pid: process.pid,
    instanceId: identity.instanceId,
    role: identity.role,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cwd: process.cwd(),
    node: process.version,
    dataDir,
    logDir: logger.logDir,
    logFile: logger.currentFilePath(),
  });
  return { logger, diskGate, identity, processLock, dataDir };
}

export function installDocsearchShutdown(
  lifecycle: DocsearchLifecycle,
  transport: { onclose?: (() => void) | null },
  onShutdown: () => Promise<void> | void,
): () => void {
  return installShutdownHooks({
    logger: lifecycle.logger,
    transport,
    onShutdown,
  });
}
