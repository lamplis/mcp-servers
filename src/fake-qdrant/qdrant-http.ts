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
      logger(`[fake-qdrant] HTTP shim listening on http://${host}:${port}`);
      resolve();
    });
  });

  return {
    server,
    host,
    port,
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

