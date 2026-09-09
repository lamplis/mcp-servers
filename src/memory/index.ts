#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
  const logConfig = resolveMemoryLogConfig(memoryFilePath);
  const diskGate = new DiskGate();
  const logger = createFileLogger({
    logDir: logConfig.logDir,
    level: logConfig.level,
    retentionDays: logConfig.retentionDays,
    redactVectors: false,
    diskGate,
  });

  logger.info("lifecycle.start", {
    pid: process.pid,
    cwd: process.cwd(),
    node: process.version,
    memoryFilePath,
    logDir: logger.logDir,
    logFile: logger.currentFilePath(),
  });
  console.error(
    `Knowledge Graph MCP Server running on stdio; logs: ${logger.currentFilePath()}`
  );

  const { server, cleanup } = await createServer({ logger, diskGate });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    logger.info("lifecycle.shutdown", {});
    await server.close();
    await cleanup();
    await logger.flush();
    logger.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (error) => {
    logger.error("process.uncaughtException", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("process.unhandledRejection", {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
