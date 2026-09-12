#!/usr/bin/env node

import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  announceInstance,
  installShutdownHooks,
  lockDirForMemoryFile,
  parseTakeoverPolicy,
  removeInstanceFile,
  resolveContention,
} from "@modelcontextprotocol/mcp-lifecycle";
import {
  createServer,
  defaultMemoryPath,
  ensureMemoryFilePath,
  KnowledgeGraphManager,
  resolveMemoryFilePathFromEnv,
  resolveMemoryLogConfig,
} from "./server.js";
import { createFileLogger } from "./logger.js";
import { DiskGate } from "./disk-gate.js";

export {
  defaultMemoryPath,
  ensureMemoryFilePath,
  KnowledgeGraphManager,
  resolveMemoryFilePathFromEnv,
  resolveMemoryLogConfig,
};

async function main() {
  const memoryFilePath = resolveMemoryFilePathFromEnv();
  const dataDir = path.dirname(path.resolve(memoryFilePath));
  const logConfig = resolveMemoryLogConfig(memoryFilePath);
  const diskGate = new DiskGate();
  const logger = createFileLogger({
    logDir: logConfig.logDir,
    level: logConfig.level,
    retentionDays: logConfig.retentionDays,
    redactVectors: false,
    diskGate,
  });

  process.title = "mcp-memory";
  const processLock = await resolveContention({
    lockDir: lockDirForMemoryFile(memoryFilePath),
    dataDir,
    role: "memory",
    policy: parseTakeoverPolicy(),
    logger,
  });
  const identity = await announceInstance({
    role: "memory",
    dataDir,
  });

  logger.info("lifecycle.start", {
    pid: process.pid,
    instanceId: identity.instanceId,
    role: identity.role,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cwd: process.cwd(),
    node: process.version,
    memoryFilePath,
    logDir: logger.logDir,
    logFile: logger.currentFilePath(),
  });
  console.error(
    `Knowledge Graph MCP Server running on stdio; logs: ${logger.currentFilePath()}`
  );

  const { server, cleanup } = await createServer({
    logger,
    diskGate,
    acquireLock: false,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  installShutdownHooks({
    logger,
    transport,
    onShutdown: async () => {
      await server.close();
      await cleanup();
      await processLock.release();
      await removeInstanceFile(dataDir);
      await logger.flush();
      logger.close();
    },
  });
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
