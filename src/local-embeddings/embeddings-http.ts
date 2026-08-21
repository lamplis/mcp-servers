import http from "node:http";
import { URL } from "node:url";

import {
  embedTexts,
  getCacheDir,
  getDefaultModelId,
} from "./embedder.js";

export interface EmbeddingsHttpServerOptions {
  host?: string;
  port?: number;
  logger?: (message: string) => void;
}

export interface EmbeddingsHttpServerHandle {
  server: http.Server;
  host: string;
  port: number;
  close: () => Promise<void>;
}

export async function startEmbeddingsHttpServer(
  options: EmbeddingsHttpServerOptions = {}
): Promise<EmbeddingsHttpServerHandle> {
  const host = options.host ?? process.env.EMBEDDINGS_HTTP_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.EMBEDDINGS_HTTP_PORT ?? 3100);
  const logger = options.logger ?? ((message: string) => console.error(message));

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (error) {
      logger(
        `[local-embeddings] Request failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      sendJson(res, 500, {
        error: {
          message: "internal server error",
          type: "server_error",
        },
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  logger(`[local-embeddings] HTTP sidecar listening on http://${host}:${actualPort}`);

  return {
    server,
    host,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, {});
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (req.method === "GET" && (path === "/" || path === "/healthz" || path === "/v1/healthz")) {
    return sendJson(res, 200, {
      status: "ok",
      model: getDefaultModelId(),
      cacheDir: getCacheDir(),
    });
  }

  if (req.method === "POST" && (path === "/v1/embeddings" || path === "/embeddings")) {
    let body: { input?: unknown; model?: unknown; encoding_format?: unknown };
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, {
        error: { message: "invalid JSON body", type: "invalid_request_error" },
      });
    }

    const texts = normalizeInput(body.input);
    if (!texts) {
      return sendJson(res, 400, {
        error: { message: "missing input", type: "invalid_request_error" },
      });
    }

    const model =
      typeof body.model === "string" && body.model.trim()
        ? body.model
        : getDefaultModelId();

    const result = await embedTexts(texts, {
      model,
      normalize: true,
      pooling: "mean",
    });

    return sendJson(res, 200, {
      object: "list",
      data: result.embeddings.map((embedding, index) => ({
        object: "embedding",
        embedding,
        index,
      })),
      model: result.model,
      usage: {
        prompt_tokens: 0,
        total_tokens: 0,
      },
    });
  }

  return sendJson(res, 404, {
    error: { message: "not found", type: "invalid_request_error" },
  });
}

function normalizeInput(input: unknown): string[] | null {
  if (typeof input === "string") {
    return [input];
  }
  if (Array.isArray(input) && input.every((item) => typeof item === "string")) {
    return input as string[];
  }
  return null;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload ?? {});
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(body);
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 25 * 1024 * 1024) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
