#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { startQdrantHttpServer, type QdrantHttpServerHandle } from "./qdrant-http.js";

async function main() {
  const config = loadConfig();
  const { server, store } = await createServer({ dataDir: config.dataDir });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Fake Qdrant MCP server running on stdio");

  let httpHandle: QdrantHttpServerHandle | null = null;

  if (config.httpEnabled) {
    try {
      httpHandle = await startQdrantHttpServer({
        store,
        host: config.httpHost,
        port: config.httpPort,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("EADDRINUSE")) {
        console.error(
          `[fake-qdrant] HTTP shim skipped: port ${config.httpPort} already in use. MCP tools remain available over stdio.`
        );
      } else {
        console.error(`[fake-qdrant] HTTP shim failed to start: ${msg}. MCP tools remain available over stdio.`);
      }
    }
  } else {
    console.error(
      "Set FAKE_QDRANT_ENABLED=1 to expose the Qdrant-compatible HTTP shim."
    );
  }

  const shutdown = async () => {
    console.error("[fake-qdrant] Shutting down...");
    if (httpHandle) {
      await httpHandle.close().catch(() => {});
    }
    store.close();
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Fatal error in fake Qdrant MCP server:", error);
  process.exit(1);
});
