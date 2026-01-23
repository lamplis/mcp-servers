#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main() {
  const { server, cleanup } = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Local Embeddings MCP Server running on stdio");

  process.on("SIGINT", async () => {
    await server.close();
    cleanup();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
