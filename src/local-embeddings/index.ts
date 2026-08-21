#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { startEmbeddingsHttpServer } from "./embeddings-http.js";

async function main() {
  const { server, cleanup } = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Local Embeddings MCP Server running on stdio");

  if (process.env.EMBEDDINGS_HTTP_PORT) {
    try {
      await startEmbeddingsHttpServer();
    } catch (error) {
      console.error(
        "[local-embeddings] HTTP sidecar failed to start; stdio MCP is still available:",
        error
      );
    }
  }

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
