import http from "node:http";
import { URL } from "node:url";
import { Store } from "./store.js";

export interface QdrantHttpServerOptions {
  store: Store;
  host?: string;
  port?: number;
  logger?: (message: string) => void;
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
  const logger = options.logger ?? ((message: string) => console.error(message));

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, options.store);
    } catch (error) {
      logger(
        `[fake-qdrant] Request failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      sendJson(res, 500, {
        status: { error: "internal server error" },
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

  // Get the actual port (important when port 0 is used for dynamic assignment)
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  
  logger(`[fake-qdrant] HTTP shim listening on http://${host}:${actualPort}`);

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

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: Store
) {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, {});
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  
  // Debug logging for delete requests
  if (req.method === "POST" && url.pathname.includes("/points/delete")) {
    console.error(`[fake-qdrant] DELETE request: ${req.method} ${url.pathname}`);
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz")) {
    return sendJson(res, 200, { status: "ok" });
  }

  if (req.method === "GET" && url.pathname === "/collections") {
    const collections = await store.listCollections();
    return sendJson(res, 200, {
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

  const match = url.pathname.match(/^\/collections\/([^/]+)(\/.*)?$/);
  if (!match) {
    return sendJson(res, 404, { status: { error: "not found" } });
  }
  const collectionName = decodeURIComponent(match[1]);
  const remainder = match[2] ?? "";

  if (req.method === "GET" && remainder === "") {
    const collection = await store.getCollection(collectionName);
    if (!collection) {
      return sendJson(res, 404, {
        status: { error: "collection not found" },
      });
    }
    return sendJson(res, 200, {
      result: {
        ...collection,
        status: "green",
      },
      status: "ok",
      time: 0,
    });
  }

  if (req.method === "PUT" && remainder === "") {
    const body = await readJsonBody(req);
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
      return sendJson(res, 400, { status: { error: "missing vector size" } });
    }

    try {
      await store.createCollection(collectionName, { size, distance });
      return sendJson(res, 200, { result: true, status: "ok", time: 0 });
    } catch (error) {
      return sendJson(res, 400, {
        status: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  if (req.method === "DELETE" && remainder === "") {
    await store.deleteCollection(collectionName);
    return sendJson(res, 200, { result: true, status: "ok", time: 0 });
  }

  if (req.method === "PUT" && remainder === "/points") {
    const body = await readJsonBody(req);
    const points = Array.isArray(body?.points) ? body.points : null;
    if (!points) {
      return sendJson(res, 400, { status: { error: "missing points[]" } });
    }

    for (const point of points) {
      if (!("id" in point) || !Array.isArray(point.vector)) {
        return sendJson(res, 400, {
          status: { error: "each point must include id and vector" },
        });
      }
      if (
        point.vector.some(
          (value: unknown) => value == null || !Number.isFinite(value as number)
        )
      ) {
        return sendJson(res, 400, {
          status: { error: "vectors must contain finite numbers" },
        });
      }
    }

    try {
      await store.upsertPoints(collectionName, points);
      return sendJson(res, 200, {
        result: { operation_id: 0, status: "completed" },
        status: "ok",
        time: 0,
      });
    } catch (error) {
      return sendJson(res, 400, {
        status: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  if (req.method === "POST" && remainder === "/points/query") {
    const body = await readJsonBody(req);
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
      return sendJson(res, 400, { status: { error: "missing query vector" } });
    }

    try {
      const results = await store.query(collectionName, vector, {
        limit: Number.isFinite(limit) ? limit : 20,
        scoreThreshold: Number.isFinite(scoreThreshold) ? scoreThreshold : 0,
      });
      return sendJson(res, 200, { result: results, status: "ok", time: 0 });
    } catch (error) {
      return sendJson(res, 400, {
        status: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  if (req.method === "POST" && remainder === "/points/delete") {
    const body = await readJsonBody(req);
    const pointIds = body?.points;
    const filter = body?.filter;

    // Check if collection exists first - if not, return success with 0 deleted
    // This makes the API more forgiving for clients that try to clean up
    // points before collections are created (e.g., RooCode's QdrantVectorStore)
    const collection = await store.getCollection(collectionName);
    if (!collection) {
      return sendJson(res, 200, {
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
        return sendJson(res, 400, {
          status: { error: "missing points[] or filter" },
        });
      }

      return sendJson(res, 200, {
        result: { operation_id: 0, status: "completed" },
        status: "ok",
        time: 0,
      });
    } catch (error) {
      return sendJson(res, 400, {
        status: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  // Non-standard: POST /collections/<name>/compact (dedupe + rebuild HNSW)
  if (req.method === "POST" && remainder === "/compact") {
    try {
      const count = await store.compactCollection(collectionName);
      return sendJson(res, 200, {
        result: { unique_points: count },
        status: "ok",
        time: 0,
      });
    } catch (error) {
      return sendJson(res, 400, {
        status: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  return sendJson(res, 404, { status: { error: "not found" } });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
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

