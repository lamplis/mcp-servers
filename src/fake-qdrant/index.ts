#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startQdrantHttpServer } from "./qdrant-http.js";

async function main() {
  const { server, store } = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Fake Qdrant MCP server running on stdio");

  if (process.env.FAKE_QDRANT_ENABLED === "1") {
    await startQdrantHttpServer({ store });
  } else {
    console.error(
      "Set FAKE_QDRANT_ENABLED=1 to expose the Qdrant-compatible HTTP shim."
    );
  }
}

main().catch((error) => {
  console.error("Fatal error in fake Qdrant MCP server:", error);
  process.exit(1);
});

