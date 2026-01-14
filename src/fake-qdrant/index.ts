#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execSync } from "child_process";
import { createServer } from "./server.js";
import { startQdrantHttpServer } from "./qdrant-http.js";

async function killProcessesOnPort(port: number): Promise<void> {
  try {
    // Windows: Find processes using the port and kill them
    const command = `powershell -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"`;
    execSync(command, { stdio: "ignore" });
    console.error(`[fake-qdrant] Cleaned up any existing processes on port ${port}`);
  } catch (error) {
    // Ignore errors - port might not be in use
  }
}

async function main() {
  const { server, store } = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Fake Qdrant MCP server running on stdio");

  if (process.env.FAKE_QDRANT_ENABLED === "1") {
    const port = Number(process.env.FAKE_QDRANT_HTTP_PORT ?? 6333);
    await killProcessesOnPort(port);
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

