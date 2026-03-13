#!/usr/bin/env node

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { embedTexts, getDefaultModelId, getOutputDimensions } from "./embedder.js";

const HTTP_PORT = parseInt(process.env.EMBEDDINGS_HTTP_PORT || "3100", 10);
const HTTP_HOST = process.env.EMBEDDINGS_HTTP_HOST || "127.0.0.1";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleEmbeddings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: { input?: string | string[]; model?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    json(res, 400, { error: { message: "Invalid JSON", type: "invalid_request_error" } });
    return;
  }

  if (!parsed.input) {
    json(res, 400, { error: { message: "Missing required parameter: input", type: "invalid_request_error" } });
    return;
  }

  const texts = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
  const modelId = parsed.model || getDefaultModelId();

  try {
    const result = await embedTexts(texts, { model: modelId, normalize: true, pooling: "mean" });
    json(res, 200, {
      object: "list",
      data: result.embeddings.map((embedding, index) => ({ object: "embedding", embedding, index })),
      model: result.model,
      usage: {
        prompt_tokens: texts.reduce((sum, t) => sum + t.length, 0),
        total_tokens: texts.reduce((sum, t) => sum + t.length, 0),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    json(res, 500, { error: { message: msg, type: "server_error" } });
  }
}

function handleModels(_req: IncomingMessage, res: ServerResponse): void {
  const modelId = getDefaultModelId();
  json(res, 200, {
    object: "list",
    data: [{ id: modelId, object: "model", created: Date.now(), owned_by: "local" }],
  });
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  const modelId = getDefaultModelId();
  json(res, 200, { status: "ok", model: modelId, dimension: getOutputDimensions(modelId) });
}

function startHttpServer(): void {
  const httpServer = createHttpServer(async (req, res) => {
    const method = req.method ?? "";
    const url = req.url ?? "";

    try {
      if (method === "POST" && url === "/v1/embeddings") {
        await handleEmbeddings(req, res);
      } else if (method === "GET" && url === "/v1/models") {
        handleModels(req, res);
      } else if (method === "GET" && url === "/health") {
        handleHealth(req, res);
      } else {
        json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      json(res, 500, { error: { message: msg, type: "server_error" } });
    }
  });

  httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
    console.error(`[local-embeddings] HTTP server ready at http://${HTTP_HOST}:${HTTP_PORT}`);
    console.error(`[local-embeddings] OpenAI-compatible endpoint: POST /v1/embeddings`);
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[local-embeddings] HTTP server skipped: port ${HTTP_PORT} already in use. MCP tools remain available over stdio.`
      );
    } else {
      console.error(`[local-embeddings] HTTP server failed: ${err.message}. MCP tools remain available over stdio.`);
    }
  });

  process.on("SIGINT", () => {
    httpServer.close();
  });
}

async function main() {
  const { server, cleanup } = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Local Embeddings MCP Server running on stdio");

  startHttpServer();

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
