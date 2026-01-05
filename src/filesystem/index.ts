#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const args = process.argv.slice(2);

async function main() {
  const { server } = await createServer({
    initialAllowedDirectories: args,
    validateInitialDirectories: true,
    allowEmptyDirectories: false,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Secure MCP Filesystem Server running on stdio");
  if (args.length === 0) {
    console.error(
      "Started without allowed directories - waiting for client to provide roots via MCP protocol"
    );
  }
}

main().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});

