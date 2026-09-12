import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { CollectionSizeMismatchError, Store } from "./store.js";
import { toLogger, type Logger } from "./logger.js";
import { ProcessLockBusyError } from "./disk-gate.js";
import { matchFilter } from "./qdrant-filter.js";
import {
  countPayloadHygiene,
  isWhitespaceOnlyPayload,
} from "./payload-hygiene.js";
import { FAKE_QDRANT_SIDECAR } from "./config.js";
import type { InstanceInfo } from "@modelcontextprotocol/mcp-lifecycle";

export interface QdrantHttpServerOptions {
  store: Store;
  host?: string;
  port?: number;
  logger?: Logger | ((message: string) => void);
  identity?: Pick<InstanceInfo, "pid" | "instanceId" | "startedAt"> & {
    dataDir?: string;
  };
  slowRequestMs?: number;
  flagPayloadPatterns?: string[];
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
  pointsCount?: number;
  emptyChunks?: number;
  flaggedChunks?: number;
}

export interface QdrantHttpServerHandle {
  server: http.Server;
  host: string;
  port: number;
  close: () => Promise<void>;
}

const DELETE_DEDUP_TTL_MS = 60_000;
export const CODE_CHUNK_LOG_CHARS = 200;
const COLLECTION_RECREATE_WINDOW_MS = 60_000;

export async function startQdrantHttpServer(
  options: QdrantHttpServerOptions
): Promise<QdrantHttpServerHandle> {
  if (!options.store) {
    throw new Error("A store instance is required to start the fake Qdrant HTTP server.");
  }

  const host = options.host ?? process.env.FAKE_QDRANT_HTTP_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.FAKE_QDRANT_HTTP_PORT ?? 6333);
  const logger = toLogger(options.logger);
  const deleteDedup = new Map<string, number>();
  const recentlyDeleted = new Map<string, { at: number; pointsCount: number }>();
  const slowRequestMs = options.slowRequestMs ?? Number(process.env.FAKE_QDRANT_SLOW_MS ?? 1000);
  const flagPayloadPatterns =
    options.flagPayloadPatterns ?? ["Error converting", "Traceback"];
  const identity = options.identity ?? {
    pid: process.pid,
    instanceId: "",
    startedAt: new Date().toISOString(),
    dataDir: undefined as string | undefined,
  };

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
      await handleRequest(
        req,
        res,
        options.store,
        requestLog,
        logger,
        deleteDedup,
        recentlyDeleted,
        identity
      );
    } catch (error) {
      if (error instanceof ProcessLockBusyError) {
        logger.error("store.busy", {
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
    requestLog.reqBody = summarizeHttpBody(requestLog.reqBody);
    const ms = Date.now() - started;
    if (
      requestLog.method === "PUT" &&
      requestLog.path.includes("/points") &&
      requestLog.reqBody &&
      typeof requestLog.reqBody === "object"
    ) {
      const body = requestLog.reqBody as { points?: unknown[] };
      const points = Array.isArray(body?.points) ? body.points : [];
      requestLog.pointsCount = points.length;
      requestLog.emptyChunks = points.filter((point) =>
        isWhitespaceOnlyPayload((point as { payload?: unknown })?.payload)
      ).length;
      requestLog.flaggedChunks = countPayloadHygiene(
        points.map((point) => ({
          payload: (point as { payload?: unknown })?.payload,
        })),
        flagPayloadPatterns
      ).flaggedPayloadPoints;
    }
    emitHttpLog(logger, requestLog, ms, slowRequestMs);
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

export function summarizeHttpBody(value: unknown): unknown {
  return summarizeValue(value);
}

function summarizeValue(value: unknown, key?: string): unknown {
  if (typeof value === "string" && key === "codeChunk") {
    if (value.length <= CODE_CHUNK_LOG_CHARS) {
      return value;
    }
    return {
      truncated: true,
      length: value.length,
      preview: value.slice(0, CODE_CHUNK_LOG_CHARS),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarizeValue(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, nested] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = summarizeValue(nested, childKey);
    }
    return out;
  }
  return value;
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

function emitHttpLog(
  logger: Logger,
  log: HttpRequestLog,
  ms: number,
  slowRequestMs: number
): void {
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
  if (log.pointsCount != null) {
    fields.pointsCount = log.pointsCount;
    fields.bytes = log.contentLength ? Number(log.contentLength) : undefined;
    fields.emptyChunks = log.emptyChunks;
    fields.flaggedChunks = log.flaggedChunks;
  }
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
  if (ms >= slowRequestMs && !log.health) {
    logger.warn("http.slow_request", {
      method: log.method,
      path: log.path,
      ms,
      status,
      pointsCount: log.pointsCount,
      bytes: log.contentLength ? Number(log.contentLength) : undefined,
    });
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

function filterDedupKey(collectionName: string, filter: unknown): string {
  return crypto
    .createHash("sha256")
    .update(`${collectionName}\0${JSON.stringify(filter)}`)
    .digest("hex");
}

function pruneDedup(map: Map<string, number>, now: number): void {
  for (const [key, seen] of map) {
    if (now - seen >= DELETE_DEDUP_TTL_MS) {
      map.delete(key);
    }
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: Store,
  requestLog: HttpRequestLog,
  logger: Logger,
  deleteDedup: Map<string, number>,
  recentlyDeleted: Map<string, { at: number; pointsCount: number }>,
    identity: {
      pid: number;
      instanceId: string;
      startedAt: string;
      dataDir?: string;
    }
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
      sidecar: FAKE_QDRANT_SIDECAR,
      title: "qdrant - vector search engine",
      version: "1.12.0",
      pid: identity.pid,
      instanceId: identity.instanceId,
      dataDir: identity.dataDir,
      startedAt: identity.startedAt,
    });
  }

  if (isRead(req.method) && path === "/metrics") {
    const collections = await store.getCollectionStats();
    return json(200, {
      result: {
        busy: store.isBusy,
        collections,
      },
      status: "ok",
      time: 0,
    });
  }

  if (isRead(req.method) && path === "/collections") {
    const collections = await store.listCollections();
    return json(200, {
      result: {
        collections: collections.map((collection) => ({
          name: collection.name,
          points_count: collection.pointsCount,
          indexed_vectors_count: collection.pointsCount,
          vectors_count: collection.pointsCount,
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
        points_count: collection.pointsCount,
        indexed_vectors_count: collection.pointsCount,
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
      const deletedAgo = recentlyDeleted.get(collectionName);
      if (deletedAgo && Date.now() - deletedAgo.at < COLLECTION_RECREATE_WINDOW_MS) {
        logger.warn("collection.recreate", {
          collection: collectionName,
          previousPointsCount: deletedAgo.pointsCount,
          ageMs: Date.now() - deletedAgo.at,
        });
        recentlyDeleted.delete(collectionName);
      }
      await store.ensureCollection(collectionName, { size, distance });
      return json(200, { result: true, status: "ok", time: 0 });
    } catch (error) {
      rethrowIfBusy(error);
      if (error instanceof CollectionSizeMismatchError) {
        return json(409, {
          status: { error: error.message },
        });
      }
      return json(400, {
        status: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  if (req.method === "DELETE" && remainder === "") {
    const existing = await store.getCollection(collectionName);
    const pointsCount = existing?.pointsCount ?? 0;
    await store.deleteCollection(collectionName);
    recentlyDeleted.set(collectionName, { at: Date.now(), pointsCount });
    logger.warn("collection.delete", {
      collection: collectionName,
      pointsCount,
    });
    return json(200, { result: true, status: "ok", time: 0 });
  }

  if (req.method === "PUT" && remainder === "/index") {
    const body = requestLog.reqBody as any;
    const fieldName = body?.field_name ?? body?.fieldName;
    if (typeof fieldName !== "string" || !fieldName) {
      return json(400, { status: { error: "missing field_name" } });
    }
    try {
      const ok = await store.ensurePayloadIndex(collectionName, fieldName);
      if (ok == null) {
        return json(404, { status: { error: "collection not found" } });
      }
      return json(200, { result: true, status: "ok", time: 0 });
    } catch (error) {
      rethrowIfBusy(error);
      return json(400, {
        status: { error: error instanceof Error ? error.message : String(error) },
      });
    }
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

  if (req.method === "POST" && remainder === "/points") {
    const body = requestLog.reqBody as any;
    const ids = Array.isArray(body?.ids) ? body.ids : null;
    if (!ids) {
      return json(400, { status: { error: "missing ids[]" } });
    }
    try {
      const points = await store.retrieve(
        collectionName,
        ids,
        body?.with_payload !== false
      );
      return json(200, {
        result: { points },
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
      const points = await store.query(collectionName, vector, {
        limit: Number.isFinite(limit) ? limit : 20,
        scoreThreshold: Number.isFinite(scoreThreshold) ? scoreThreshold : 0,
        filter: body?.filter,
      });
      return json(200, { result: { points }, status: "ok", time: 0 });
    } catch (error) {
      rethrowIfBusy(error);
      return json(400, {
        status: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  if (req.method === "POST" && remainder === "/points/scroll") {
    const body = requestLog.reqBody as any;
    try {
      const result = await store.scroll(collectionName, {
        limit: Number(body?.limit ?? 20),
        offset: Number(body?.offset ?? 0),
        filter: body?.filter,
        withPayload: body?.with_payload !== false,
      });
      return json(200, {
        result: {
          points: result.points,
          next_page_offset: result.nextOffset,
        },
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

  if (req.method === "POST" && remainder === "/points/count") {
    const body = requestLog.reqBody as any;
    try {
      const count = await store.countPoints(collectionName, body?.filter);
      return json(200, {
        result: { count },
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

  if (req.method === "POST" && remainder === "/points/delete") {
    const body = requestLog.reqBody as any;
    const pointIds = body?.points;
    const filter = body?.filter;

    const collection = await store.getCollection(collectionName);
    if (!collection) {
      return json(200, {
        result: { operation_id: 0, status: "completed", deleted: 0 },
        status: "ok",
        time: 0,
      });
    }

    try {
      let deletedCount = 0;

      if (Array.isArray(pointIds) && pointIds.length > 0) {
        deletedCount = await store.deletePoints(collectionName, pointIds);
      } else if (filter) {
        const now = Date.now();
        pruneDedup(deleteDedup, now);
        const key = filterDedupKey(collectionName, filter);
        const seen = deleteDedup.get(key);
        if (seen !== undefined && now - seen < DELETE_DEDUP_TTL_MS) {
          logger.debug("http.delete_dedup", {
            collection: collectionName,
            ageMs: now - seen,
          });
          return json(200, {
            result: { operation_id: 0, status: "completed", deleted: 0, dedup: true },
            status: "ok",
            time: 0,
          });
        }
        deleteDedup.set(key, now);
        deletedCount = await store.deletePoints(
          collectionName,
          undefined,
          (payload) => matchFilter(payload, filter),
          filter
        );
      } else {
        return json(400, {
          status: { error: "missing points[] or filter" },
        });
      }

      logger.info("http.delete", {
        collection: collectionName,
        deletedCount,
        byFilter: Boolean(filter),
      });

      return json(200, {
        result: { operation_id: 0, status: "completed", deleted: deletedCount },
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
    sidecar: FAKE_QDRANT_SIDECAR,
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
