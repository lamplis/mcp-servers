#!/usr/bin/env node

import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { startQdrantHttpServer, type QdrantHttpServerHandle } from "./qdrant-http.js";
import { createFileLogger } from "./logger.js";
import { DiskGate } from "./disk-gate.js";

async function main() {
  const config = loadConfig();
  const dataDir = path.resolve(config.dataDir);
  const logDir = path.resolve(config.logDir ?? path.join(dataDir, "logs"));
  const diskGate = new DiskGate();
  const logger = createFileLogger({
    logDir,
    level: config.logLevel,
    retentionDays: config.logRetentionDays,
    redactVectors: true,
    diskGate,
  });

  logger.info("lifecycle.start", {
    pid: process.pid,
    cwd: process.cwd(),
    node: process.version,
    dataDir,
    logDir: logger.logDir,
    logFile: logger.currentFilePath(),
    httpEnabled: config.httpEnabled,
    httpHost: config.httpHost,
    httpPort: config.httpPort,
  });
  console.error(
    `Fake Qdrant MCP server running on stdio; logs: ${logger.currentFilePath()}`
  );

  const { server, store } = await createServer({
    dataDir: config.dataDir,
    logger,
    diskGate,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let httpHandle: QdrantHttpServerHandle | null = null;

  if (config.httpEnabled) {
    try {
      httpHandle = await startQdrantHttpServer({
        store,
        host: config.httpHost,
        port: config.httpPort,
        logger,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("EADDRINUSE")) {
        logger.error("http.bind_failed", {
          code: "EADDRINUSE",
          port: config.httpPort,
          message:
            `HTTP shim skipped: port ${config.httpPort} already in use. MCP tools remain available over stdio. A stale process is still serving :${config.httpPort}; browser /healthz will hit that old process. Stop all node.exe, then reload the IDE.`,
        });
      } else {
        logger.error("http.bind_failed", {
          port: config.httpPort,
          message: `HTTP shim failed to start: ${msg}. MCP tools remain available over stdio.`,
        });
      }
    }
  } else {
    logger.info("http.disabled", {
      message: "Set FAKE_QDRANT_ENABLED=1 to expose the Qdrant-compatible HTTP shim.",
    });
    console.error(
      "Set FAKE_QDRANT_ENABLED=1 to expose the Qdrant-compatible HTTP shim."
    );
  }

  const shutdown = async () => {
    logger.info("lifecycle.shutdown", {});
    if (httpHandle) {
      await httpHandle.close().catch(() => {});
    }
    await store.close();
    await server.close();
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
  console.error("Fatal error in fake Qdrant MCP server:", error);
  process.exit(1);
});
