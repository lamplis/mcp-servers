#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startQdrantHttpServer, type QdrantHttpServerHandle } from "./qdrant-http.js";

async function main() {
  const { server, store } = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Fake Qdrant MCP server running on stdio");

  let httpHandle: QdrantHttpServerHandle | null = null;

  if (process.env.FAKE_QDRANT_ENABLED === "1") {
    try {
      httpHandle = await startQdrantHttpServer({ store });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("EADDRINUSE")) {
        const port = process.env.FAKE_QDRANT_HTTP_PORT ?? "6333";
        console.error(
          `[fake-qdrant] HTTP shim skipped: port ${port} already in use. MCP tools remain available over stdio.`
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
