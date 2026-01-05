#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createServer,
  defaultMemoryPath,
  ensureMemoryFilePath,
  KnowledgeGraphManager,
} from "./server.js";

export { defaultMemoryPath, ensureMemoryFilePath, KnowledgeGraphManager };

async function main() {
  const { server } = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
