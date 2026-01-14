#!/usr/bin/env node
/**
 * Stdio wrapper that ensures central-mcp HTTP server is running,
 * then proxies a single MCP server over stdio.
 * 
 * Usage in mcp.json:
 *   "command": "node",
 *   "args": ["scripts/start-central-mcp-stdio.js", "everything"]
 */

import { spawn } from "child_process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import http from "http";

const SERVER_ARG = process.argv[2] || "everything";
const PORT = parseInt(process.env.PORT || "3300", 10);
const CHECK_URL = `http://127.0.0.1:${PORT}/health`;

// Dynamic import for the requested server
const SERVER_MODULES = {
  memory: "../../src/memory/server.js",
  filesystem: "../../src/filesystem/server.js",
  everything: "../../src/everything/server/index.js",
  sequentialthinking: "../../src/sequentialthinking/server.js",
  "fake-qdrant": "../../src/fake-qdrant/server.js",
};

async function checkServerRunning() {
  return new Promise((resolve) => {
    const req = http.get(CHECK_URL, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function startCentralServer() {
  const isRunning = await checkServerRunning();
  if (isRunning) {
    console.error(`[stdio-wrapper] central-mcp already running on port ${PORT}`);
    return null;
  }

  console.error(`[stdio-wrapper] Starting central-mcp on port ${PORT}...`);
  
  const child = spawn("npx", ["tsx", "central-mcp/src/index.ts"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    shell: true,
    env: { ...process.env, PORT: String(PORT) },
  });

  child.unref();
  
  // Wait for server to be ready
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await checkServerRunning()) {
      console.error(`[stdio-wrapper] central-mcp is ready`);
      return child;
    }
  }
  
  throw new Error("central-mcp failed to start within 15 seconds");
}

async function runStdioServer() {
  const modulePath = SERVER_MODULES[SERVER_ARG];
  if (!modulePath) {
    console.error(`Unknown server: ${SERVER_ARG}`);
    console.error(`Available: ${Object.keys(SERVER_MODULES).join(", ")}`);
    process.exit(1);
  }

  const { createServer } = await import(modulePath);
  
  let serverResult;
  if (SERVER_ARG === "filesystem") {
    serverResult = await createServer({
      initialAllowedDirectories: process.env.FILESYSTEM_ALLOWED_DIRS?.split(";").filter(Boolean) || [],
      validateInitialDirectories: true,
      allowEmptyDirectories: true,
    });
  } else if (SERVER_ARG === "fake-qdrant") {
    serverResult = await createServer();
  } else {
    serverResult = await createServer();
  }

  const transport = new StdioServerTransport();
  await serverResult.server.connect(transport);
  console.error(`[stdio-wrapper] ${SERVER_ARG} server running on stdio`);
}

async function main() {
  try {
    // Optionally start HTTP server in background (if you want both)
    // await startCentralServer();
    
    // Run the selected server directly over stdio
    await runStdioServer();
  } catch (error) {
    console.error("[stdio-wrapper] Fatal error:", error);
    process.exit(1);
  }
}

main();
