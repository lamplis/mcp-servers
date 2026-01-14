#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startServer } from "./server/mcp.js";

// Re-export useful components for programmatic usage
export { startServer } from "./server/mcp.js";
export { CONFIG } from "./shared/config.js";
export { getDatabase } from "./ingest/database.js";
export { performSearch } from "./ingest/search.js";

async function main() {
  await startServer();
  console.error("Docsearch MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
