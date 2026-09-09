import http from "node:http";
import { URL } from "node:url";
import { Store } from "./store.js";
import { toLogger, type Logger } from "./logger.js";
import { ProcessLockBusyError } from "./disk-gate.js";

export interface QdrantHttpServerOptions {
  store: Store;
  host?: string;
  port?: number;
  logger?: Logger | ((message: string) => void);
}

interface HttpRequestLog {
  method: string;
  path: string;
  rawUrl: string;
  userAgent?: string;
  contentLength?: string;
  reqBody?: unknown;
  status?: number;
  resBody?: unknown;
  health?: boolean;
}

export interface QdrantHttpServerHandle {
  server: http.Server;
  host: string;
  port: number;
  close: () => Promise<void>;
}

export async function startQdrantHttpServer(
  options: QdrantHttpServerOptions
): Promise<QdrantHttpServerHandle> {
  if (!options.store) {
    throw new Error("A store instance is required to start the fake Qdrant HTTP server.");
  }

  const host = options.host ?? process.env.FAKE_QDRANT_HTTP_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.FAKE_QDRANT_HTTP_PORT ?? 6333);
  const logger = toLogger(options.logger);

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const path = requestPath(req);
    const requestLog: HttpRequestLog = {
      method: (req.method ?? "").toUpperCase(),
      path,
      rawUrl: req.url ?? "",
      userAgent: headerValue(req, "user-agent"),
      contentLength: headerValue(req, "content-length"),
      health: isRead(req.method) && isHealthPath(path),
    };
    try {
      await handleRequest(req, res, options.store, requestLog);
    } catch (error) {
      if (error instanceof ProcessLockBusyError) {
        options.store && logger.error("store.busy", {
          holderPid: error.holderPid,
          message: error.message,
        });
        sendJson(
          res,
          503,
          {
            status: {
              error: "service busy",
              message: error.message,
            },
          },
          requestLog
        );
      } else {
        sendJson(
          res,
          500,
          {
            status: {
              error: "internal server error",
              message: error instanceof Error ? error.message : String(error),
            },
          },
          requestLog
        );
      }
    }
    emitHttpLog(logger, requestLog, Date.now() - started);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  // Get the actual port (important when port 0 is used for dynamic assignment)
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  
  logger.info("http.listen", { host, port: actualPort });

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

function requestPath(req: http.IncomingMessage): string {
  const raw = req.url ?? "/";
  let pathname = "/";
  try {
    pathname = new URL(raw, "http://127.0.0.1").pathname;
  } catch {
    pathname = raw.split("?")[0] || "/";
  }
  return (
    pathname
      .replace(/\\/g, "/")
      .replace(/\/+/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase() || "/"
  );
}

function headerValue(
  req: http.IncomingMessage,
  name: string
): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function emitHttpLog(logger: Logger, log: HttpRequestLog, ms: number): void {
  const status = log.status ?? 0;
  const fields: Record<string, unknown> = {
    method: log.method,
    path: log.path,
    rawUrl: log.rawUrl,
    status,
    ms,
    userAgent: log.userAgent,
    contentLength: log.contentLength,
  };
  if (!log.health) {
    fields.reqBody = log.reqBody;
    fields.resBody = log.resBody;
  }
  if (status >= 500) {
    logger.error("http.request", fields);
  } else if (status >= 400) {
    logger.warn("http.request", fields);
  } else {
    logger.info("http.request", fields);
  }
}

function isRead(method: string | undefined): boolean {
  const m = (method ?? "").toUpperCase();
  return m === "GET" || m === "HEAD";
}

function isHealthPath(path: string): boolean {
  return (
    path === "/" ||
    path === "/health" ||
    path === "/healthz" ||
    path === "/readyz" ||
    path === "/livez" ||
    path.endsWith("/health") ||
    path.endsWith("/healthz") ||
    path.endsWith("/readyz") ||
    path.endsWith("/livez")
  );
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: Store,
  requestLog: HttpRequestLog
) {
  const json = (status: number, payload: unknown) =>
    sendJson(res, status, payload, requestLog);

  if (req.method === "OPTIONS") {
    return json(200, {});
  }
  const path = requestPath(req);
  requestLog.path = path;

  const method = (req.method ?? "").toUpperCase();
  if (method === "PUT" || method === "POST") {
    requestLog.reqBody = await readJsonBody(req);
  }

  if (isRead(req.method) && isHealthPath(path)) {
    return json(200, {
      status: "ok",
      sidecar: "fake-qdrant-mcp",
      title: "qdrant - vector search engine",
      version: "1.12.0",
    });
  }

  if (isRead(req.method) && path === "/collections") {
    const collections = await store.listCollections();
    return json(200, {
      result: {
        collections: collections.map((collection) => ({
          name: collection.name,
          vectors_count: 0,
          status: "green",
          config: {
            params: {
              vectors: {
                size: collection.vectors.size,
                distance: collection.vectors.distance,
              },
            },
          },
        })),
      },
      status: "ok",
      time: 0,
    });
  }

  const match = path.match(/^\/collections\/([^/]+)(\/.*)?$/);
  if (!match) {
    return json(404, { status: { error: "not found" } });
  }
  const collectionName = decodeURIComponent(match[1]);
  const remainder = match[2] ?? "";

  if (req.method === "GET" && remainder === "") {
    const collection = await store.getCollection(collectionName);
    if (!collection) {
      return json(404, {
        status: { error: "collection not found" },
      });
    }
    return json(200, {
      result: {
        ...collection,
        status: "green",
      },
      status: "ok",
      time: 0,
    });
  }

  if (req.method === "PUT" && remainder === "") {
    const body = requestLog.reqBody as any;
    const vectors =
      body?.vectors ??
      body?.config?.params?.vectors ??
      body?.params?.vectors;
    const size =
      vectors?.size ??
      vectors?.params?.size ??
      body?.vector_size ??
      body?.dimension;
    const distance = vectors?.distance ?? vectors?.params?.distance ?? body?.distance;
    if (!Number.isFinite(size)) {
      return json(400, { status: { error: "missing vector size" } });
    }

    try {
      await store.createCollection(collectionName, { size, distance });
      return json(200, { result: true, status: "ok", time: 0 });
    } catch (error) {
      rethrowIfBusy(error);
      return json(400, {
        status: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  if (req.method === "DELETE" && remainder === "") {
    await store.deleteCollection(collectionName);
    return json(200, { result: true, status: "ok", time: 0 });
  }

  if (req.method === "PUT" && remainder === "/points") {
    const body = requestLog.reqBody as any;
    const points = Array.isArray(body?.points) ? body.points : null;
    if (!points) {
      return json(400, { status: { error: "missing points[]" } });
    }

    for (const point of points) {
      if (!("id" in point) || !Array.isArray(point.vector)) {
        return json(400, {
          status: { error: "each point must include id and vector" },
        });
      }
      if (
        point.vector.some(
          (value: unknown) => value == null || !Number.isFinite(value as number)
        )
      ) {
        return json(400, {
          status: { error: "vectors must contain finite numbers" },
        });
      }
    }

    try {
      await store.upsertPoints(collectionName, points);
      return json(200, {
        result: { operation_id: 0, status: "completed" },
        status: "ok",
        time: 0,
      });
    } catch (error) {
      rethrowIfBusy(error);
      return json(400, {
        status: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  if (req.method === "POST" && remainder === "/points/query") {
    const body = requestLog.reqBody as any;
    const vector =
      body?.query?.vector ??
      body?.vector ??
      body?.query_vector ??
      body?.query?.nearest?.vector;
    const limit = Number(body?.limit ?? body?.top ?? 20);
    const scoreThreshold = Number(
      body?.score_threshold ?? body?.query?.score_threshold ?? 0
    );

    if (!Array.isArray(vector)) {
      return json(400, { status: { error: "missing query vector" } });
    }

    try {
      const results = await store.query(collectionName, vector, {
        limit: Number.isFinite(limit) ? limit : 20,
        scoreThreshold: Number.isFinite(scoreThreshold) ? scoreThreshold : 0,
      });
      return json(200, { result: results, status: "ok", time: 0 });
    } catch (error) {
      rethrowIfBusy(error);
      return json(400, {
        status: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  if (req.method === "POST" && remainder === "/points/delete") {
    const body = requestLog.reqBody as any;
    const pointIds = body?.points;
    const filter = body?.filter;

    // Check if collection exists first - if not, return success with 0 deleted
    // This makes the API more forgiving for clients that try to clean up
    // points before collections are created (e.g., RooCode's QdrantVectorStore)
    const collection = await store.getCollection(collectionName);
    if (!collection) {
      return json(200, {
        result: { operation_id: 0, status: "completed" },
        status: "ok",
        time: 0,
      });
    }

    try {
      let deletedCount = 0;

      if (Array.isArray(pointIds) && pointIds.length > 0) {
        // Delete by point IDs
        deletedCount = await store.deletePoints(collectionName, pointIds);
      } else if (filter) {
        // Delete by filter (e.g., file path in payload)
        // Support Qdrant filter format: { must: [{ key: "path", match: { value: "..." } }] }
        const filterFn = (payload: unknown): boolean => {
          if (!payload || typeof payload !== "object") {
            return false;
          }
          const p = payload as Record<string, unknown>;
          
          // Helper to get nested value by key path
          const getNestedValue = (obj: unknown, keyPath: string): unknown => {
            const keys = keyPath.split(".");
            let value: unknown = obj;
            for (const key of keys) {
              if (value && typeof value === "object" && key in value) {
                value = (value as Record<string, unknown>)[key];
              } else {
                return undefined;
              }
            }
            return value;
          };
          
          // Support filter.must (all conditions must match)
          if (Array.isArray(filter.must)) {
            for (const condition of filter.must) {
              if (condition.key && condition.match) {
                const value = getNestedValue(p, condition.key);
                if (value === undefined) {
                  return false; // Key path doesn't exist
                }
                // Match value
                if (condition.match.value !== undefined) {
                  const matchValue = condition.match.value;
                  if (String(value) !== String(matchValue)) {
                    return false; // Value doesn't match
                  }
                }
              }
            }
            return true; // All must conditions passed
          }
          
          // Support filter.should (at least one condition must match)
          if (Array.isArray(filter.should)) {
            for (const condition of filter.should) {
              if (condition.key && condition.match) {
                const value = getNestedValue(p, condition.key);
                if (value !== undefined && condition.match.value !== undefined) {
                  if (String(value) === String(condition.match.value)) {
                    return true; // At least one should condition passed
                  }
                }
              }
            }
            return false; // No should conditions matched
          }
          
          // Support direct key-value matching (legacy format)
          if (filter.key && filter.match) {
            const value = getNestedValue(p, filter.key);
            if (value !== undefined && filter.match.value !== undefined) {
              return String(value) === String(filter.match.value);
            }
          }
          
          return false;
        };
        deletedCount = await store.deletePoints(collectionName, undefined, filterFn);
      } else {
        return json(400, {
          status: { error: "missing points[] or filter" },
        });
      }

      return json(200, {
        result: { operation_id: 0, status: "completed" },
        status: "ok",
        time: 0,
      });
    } catch (error) {
      rethrowIfBusy(error);
      return json(400, {
        status: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  // Non-standard: POST /collections/<name>/compact (rewrite unique JSONL snapshot)
  if (req.method === "POST" && remainder === "/compact") {
    try {
      const count = await store.compactCollection(collectionName);
      return json(200, {
        result: { unique_points: count },
        status: "ok",
        time: 0,
      });
    } catch (error) {
      rethrowIfBusy(error);
      return json(400, {
        status: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  return json(404, {
    status: { error: "not found" },
    method: req.method ?? "",
    path,
    rawUrl: req.url ?? "",
    sidecar: "fake-qdrant-mcp",
  });
}

function rethrowIfBusy(error: unknown): void {
  if (error instanceof ProcessLockBusyError) {
    throw error;
  }
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  requestLog?: HttpRequestLog
) {
  if (requestLog) {
    requestLog.status = status;
    requestLog.resBody = payload;
  }
  const body = JSON.stringify(payload ?? {});
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,PUT,POST,DELETE,OPTIONS",
  });
  res.end(body);
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
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
        resolve(data ? JSON.parse(data) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

