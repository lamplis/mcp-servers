import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import {
  CollectionExistsError,
  CollectionSizeMismatchError,
  PointNotFoundError,
  Store,
  type QueryHit,
  type PointRecord,
} from "./store.js";
import { toLogger, type Logger } from "./logger.js";
import { ProcessLockBusyError } from "./disk-gate.js";
import { matchFilter, UnsupportedFilterError } from "./qdrant-filter.js";
import {
  countPayloadHygiene,
  isWhitespaceOnlyPayload,
} from "./payload-hygiene.js";
import { FAKE_QDRANT_SIDECAR } from "./config.js";
import type { InstanceInfo } from "@modelcontextprotocol/mcp-lifecycle";
import {
  EmbeddingError,
  EMBEDDING_NOT_CONFIGURED,
  embeddingHealthPayload,
  type EmbeddingProvider,
} from "./provider.js";

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
  strictCreate?: boolean;
  embeddingProvider?: EmbeddingProvider | null;
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
        identity,
        options.strictCreate === true,
        options.embeddingProvider ?? null
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
      } else if (
        error instanceof UnsupportedFilterError ||
        error instanceof UnsupportedQueryError
      ) {
        sendJson(
          res,
          400,
          { status: { error: error.message } },
          requestLog
        );
      } else if (error instanceof CollectionExistsError) {
        sendJson(
          res,
          409,
          { status: { error: error.message } },
          requestLog
        );
      } else if (error instanceof PointNotFoundError) {
        sendJson(
          res,
          404,
          { status: { error: error.message } },
          requestLog
        );
      } else if (error instanceof EmbeddingError) {
        sendJson(
          res,
          502,
          { status: { error: error.message } },
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

const UNSUPPORTED_QUERY_BODY_FIELDS = [
  "prefetch",
  "using",
  "lookup_from",
  "shard_key",
] as const;

const UNSUPPORTED_QUERY_OBJECT_FIELDS = [
  "fusion",
  "recommend",
  "discover",
  "sample",
  "formula",
] as const;

export class UnsupportedQueryError extends Error {
  constructor(field: string) {
    super(`Unsupported query: ${field}`);
    this.name = "UnsupportedQueryError";
  }
}

export type WithPayloadSpec =
  | { mode: "none" }
  | { mode: "all" }
  | { mode: "include"; keys: string[] }
  | { mode: "exclude"; keys: string[] };

export interface ParsedQueryRequest {
  kind: "vector" | "id" | "list" | "text";
  vector?: number[];
  id?: string | number;
  text?: string;
  limit: number;
  offset: number;
  scoreThreshold?: number;
  filter?: unknown;
  withPayload: WithPayloadSpec;
  withVector: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isNumericArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function parseWithPayload(raw: unknown, defaultAll = false): WithPayloadSpec {
  if (raw === undefined || raw === null) {
    return defaultAll ? { mode: "all" } : { mode: "none" };
  }
  if (raw === true) {
    return { mode: "all" };
  }
  if (raw === false) {
    return { mode: "none" };
  }
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
    return { mode: "include", keys: raw };
  }
  if (isRecord(raw)) {
    if (Array.isArray(raw.include)) {
      return {
        mode: "include",
        keys: raw.include.filter((item): item is string => typeof item === "string"),
      };
    }
    if (Array.isArray(raw.exclude)) {
      return {
        mode: "exclude",
        keys: raw.exclude.filter((item): item is string => typeof item === "string"),
      };
    }
  }
  return defaultAll ? { mode: "all" } : { mode: "none" };
}

function projectPayload(payload: unknown, spec: WithPayloadSpec): unknown {
  if (spec.mode === "none") {
    return undefined;
  }
  if (spec.mode === "all") {
    return payload ?? null;
  }
  if (!isRecord(payload)) {
    return spec.mode === "include" ? {} : payload ?? null;
  }
  if (spec.mode === "include") {
    const out: Record<string, unknown> = {};
    for (const key of spec.keys) {
      if (key in payload) {
        out[key] = payload[key];
      }
    }
    return out;
  }
  const out = { ...payload };
  for (const key of spec.keys) {
    delete out[key];
  }
  return out;
}

function shapeScoredPoint(
  hit: QueryHit,
  spec: WithPayloadSpec,
  withVector: boolean
): Record<string, unknown> {
  const point: Record<string, unknown> = {
    id: hit.id,
    version: hit.version ?? 0,
    score: hit.score,
  };
  if (spec.mode !== "none") {
    point.payload = projectPayload(hit.payload, spec);
  }
  if (withVector) {
    point.vector = hit.vector ?? null;
  }
  return point;
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseQueryRequest(
  body: unknown,
  options: { requireVector?: boolean } = {}
): ParsedQueryRequest {
  const record = isRecord(body) ? body : {};
  for (const field of UNSUPPORTED_QUERY_BODY_FIELDS) {
    if (record[field] !== undefined) {
      throw new UnsupportedQueryError(field);
    }
  }
  if (isRecord(record.query)) {
    for (const field of UNSUPPORTED_QUERY_OBJECT_FIELDS) {
      if (record.query[field] !== undefined) {
        throw new UnsupportedQueryError(field);
      }
    }
  } else if (record.query !== undefined && !Array.isArray(record.query) && typeof record.query !== "number" && typeof record.query !== "string") {
    throw new UnsupportedQueryError("query");
  }

  if (isRecord(record.vector) && !Array.isArray(record.vector)) {
    throw new UnsupportedQueryError("using");
  }

  let kind: ParsedQueryRequest["kind"] = "list";
  let vector: number[] | undefined;
  let id: string | number | undefined;
  let text: string | undefined;
  const query = record.query;

  if (isNumericArray(query)) {
    kind = "vector";
    vector = query;
  } else if (typeof query === "number") {
    kind = "id";
    id = query;
  } else if (typeof query === "string") {
    kind = "id";
    id = query;
  } else if (isRecord(query)) {
    const nearestText = inferenceText(query.nearest);
    const queryText = inferenceText(query);
    if (isNumericArray(query.nearest)) {
      kind = "vector";
      vector = query.nearest;
    } else if (typeof query.nearest === "number" || typeof query.nearest === "string") {
      kind = "id";
      id = query.nearest;
    } else if (nearestText) {
      kind = "text";
      text = nearestText;
    } else if (isRecord(query.nearest) && isNumericArray(query.nearest.vector)) {
      kind = "vector";
      vector = query.nearest.vector;
    } else if (queryText) {
      kind = "text";
      text = queryText;
    } else if (isNumericArray(query.vector)) {
      kind = "vector";
      vector = query.vector;
    }
  }

  if (kind === "list") {
    if (isNumericArray(record.vector)) {
      kind = "vector";
      vector = record.vector;
    } else if (isNumericArray(record.query_vector)) {
      kind = "vector";
      vector = record.query_vector;
    }
  }

  if (options.requireVector && kind !== "vector" && kind !== "text") {
    throw new Error("missing query vector");
  }

  const rawThreshold = record.score_threshold ?? (isRecord(query) ? query.score_threshold : undefined);
  const parsedThreshold =
    rawThreshold === undefined || rawThreshold === null ? undefined : Number(rawThreshold);

  return {
    kind,
    vector,
    id,
    text,
    limit: Math.max(1, finiteNumber(record.limit ?? record.top, 10)),
    offset: Math.max(0, finiteNumber(record.offset, 0)),
    scoreThreshold: parsedThreshold !== undefined && Number.isFinite(parsedThreshold) ? parsedThreshold : undefined,
    filter: record.filter,
    withPayload: parseWithPayload(record.with_payload, false),
    withVector: record.with_vector === true,
  };
}

async function runParsedQuery(
  store: Store,
  collectionName: string,
  parsed: ParsedQueryRequest,
  provider: EmbeddingProvider | null
): Promise<QueryHit[]> {
  const options = {
    limit: parsed.limit,
    offset: parsed.offset,
    scoreThreshold: parsed.scoreThreshold,
    filter: parsed.filter,
    withVector: parsed.withVector,
  };
  if (parsed.kind === "text") {
    const vector = await embedText(provider, parsed.text ?? "");
    return store.query(collectionName, vector, options);
  }
  if (parsed.kind === "list") {
    return store.listByIds(collectionName, options);
  }
  if (parsed.kind === "id") {
    if (parsed.id === undefined) {
      throw new Error("missing query vector");
    }
    return store.query(collectionName, { id: parsed.id }, options);
  }
  if (!parsed.vector) {
    throw new Error("missing query vector");
  }
  return store.query(collectionName, parsed.vector, options);
}

function inferenceText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return typeof value.text === "string" && value.text.length > 0 ? value.text : undefined;
}

async function embedText(
  provider: EmbeddingProvider | null,
  text: string
): Promise<number[]> {
  if (!provider) {
    throw new Error(EMBEDDING_NOT_CONFIGURED);
  }
  const result = await provider.embed([text]);
  const vector = result.embeddings[0];
  if (!vector || vector.length === 0) {
    throw new EmbeddingError("empty embedding response");
  }
  return vector;
}

async function embedUpsertPoints(
  points: Array<Record<string, unknown>>,
  provider: EmbeddingProvider | null
): Promise<PointRecord[]> {
  const texts: string[] = [];
  const textIndexes: number[] = [];
  const resolved: PointRecord[] = [];

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (!point || !("id" in point)) {
      throw new Error("each point must include id and vector");
    }
    const id = point.id;
    if (typeof id !== "string" && typeof id !== "number") {
      throw new Error("each point must include id and vector");
    }
    if (Array.isArray(point.vector)) {
      if (
        !isNumericArray(point.vector) ||
        point.vector.some((value) => !Number.isFinite(value))
      ) {
        throw new Error("vectors must contain finite numbers");
      }
      resolved[i] = { id, vector: point.vector, payload: point.payload ?? null };
      continue;
    }
    const fromVector = inferenceText(point.vector);
    const fromText = typeof point.text === "string" ? point.text : undefined;
    const text = fromVector ?? fromText;
    if (!text) {
      throw new Error("each point must include id and vector");
    }
    textIndexes.push(i);
    texts.push(text);
    resolved[i] = { id, vector: [], payload: point.payload ?? null };
  }

  if (texts.length > 0) {
    if (!provider) {
      throw new Error(EMBEDDING_NOT_CONFIGURED);
    }
    const result = await provider.embed(texts);
    for (let i = 0; i < textIndexes.length; i += 1) {
      const index = textIndexes[i] ?? 0;
      const vector = result.embeddings[i];
      if (!vector || vector.length === 0) {
        throw new EmbeddingError("empty embedding response");
      }
      const existing = resolved[index];
      if (existing) {
        existing.vector = vector;
      }
    }
  }
  return resolved.filter((item): item is PointRecord => Boolean(item));
}

function payloadOpResult(operationId: number): Record<string, unknown> {
  return {
    result: { operation_id: operationId, status: "completed" },
    status: "ok",
    time: 0,
  };
}

function parsePointSelector(body: Record<string, unknown> | undefined): {
  ids?: (string | number)[];
  filter?: unknown;
  key?: string;
} {
  const ids = Array.isArray(body?.points)
    ? (body.points as unknown[]).filter(
        (item): item is string | number => typeof item === "string" || typeof item === "number"
      )
    : undefined;
  return {
    ids: ids && ids.length > 0 ? ids : undefined,
    filter: body?.filter,
    key: typeof body?.key === "string" ? body.key : undefined,
  };
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
    },
    strictCreate: boolean,
    embeddingProvider: EmbeddingProvider | null
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
      embedding: embeddingHealthPayload(embeddingProvider),
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

  if (isRead(req.method) && remainder === "/exists") {
    const collection = await store.getCollection(collectionName);
    return json(200, {
      result: { exists: Boolean(collection) },
      status: "ok",
      time: 0,
    });
  }

  if (req.method === "GET" && remainder === "") {
    const collection = await store.getCollectionInfoQdrant(collectionName);
    if (!collection) {
      return json(404, {
        status: { error: "collection not found" },
      });
    }
    return json(200, {
      result: collection,
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
      await store.ensureCollection(collectionName, { size, distance, strict: strictCreate });
      return json(200, { result: true, status: "ok", time: 0 });
    } catch (error) {
      rethrowIfBusy(error);
      if (error instanceof CollectionSizeMismatchError || error instanceof CollectionExistsError) {
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

    try {
      const resolved = await embedUpsertPoints(points, embeddingProvider);
      await store.upsertPoints(collectionName, resolved);
      return json(200, {
        result: { operation_id: 0, status: "completed" },
        status: "ok",
        time: 0,
      });
    } catch (error) {
      return queryHttpError(error, json);
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

  if (req.method === "POST" && remainder === "/points/query/batch") {
    const body = requestLog.reqBody as { searches?: unknown[] } | undefined;
    const searches = Array.isArray(body?.searches) ? body.searches : null;
    if (!searches) {
      return json(400, { status: { error: "missing searches[]" } });
    }
    try {
      const result = [];
      for (const item of searches) {
        const parsed = parseQueryRequest(item);
        const hits = await runParsedQuery(store, collectionName, parsed, embeddingProvider);
        result.push({
          points: hits.map((hit) =>
            shapeScoredPoint(hit, parsed.withPayload, parsed.withVector)
          ),
        });
      }
      return json(200, { result, status: "ok", time: 0 });
    } catch (error) {
      return queryHttpError(error, json);
    }
  }

  if (req.method === "POST" && remainder === "/points/search/batch") {
    const body = requestLog.reqBody as { searches?: unknown[] } | undefined;
    const searches = Array.isArray(body?.searches) ? body.searches : null;
    if (!searches) {
      return json(400, { status: { error: "missing searches[]" } });
    }
    try {
      const result = [];
      for (const item of searches) {
        const parsed = parseQueryRequest(item, { requireVector: true });
        const hits = await runParsedQuery(store, collectionName, parsed, embeddingProvider);
        result.push(hits.map((hit) => shapeScoredPoint(hit, parsed.withPayload, parsed.withVector)));
      }
      return json(200, { result, status: "ok", time: 0 });
    } catch (error) {
      return queryHttpError(error, json);
    }
  }

  if (req.method === "POST" && remainder === "/points/query") {
    const body = requestLog.reqBody as any;
    try {
      const parsed = parseQueryRequest(body);
      const hits = await runParsedQuery(store, collectionName, parsed, embeddingProvider);
      return json(200, {
        result: {
          points: hits.map((hit) =>
            shapeScoredPoint(hit, parsed.withPayload, parsed.withVector)
          ),
        },
        status: "ok",
        time: 0,
      });
    } catch (error) {
      return queryHttpError(error, json);
    }
  }

  if (req.method === "POST" && remainder === "/points/search") {
    const body = requestLog.reqBody as any;
    try {
      const parsed = parseQueryRequest(body, { requireVector: true });
      const hits = await runParsedQuery(store, collectionName, parsed, embeddingProvider);
      return json(200, {
        result: hits.map((hit) =>
          shapeScoredPoint(hit, parsed.withPayload, parsed.withVector)
        ),
        status: "ok",
        time: 0,
      });
    } catch (error) {
      return queryHttpError(error, json);
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

  if (req.method === "POST" && remainder === "/points/payload/delete") {
    const body = (requestLog.reqBody ?? {}) as Record<string, unknown>;
    const keys = Array.isArray(body.keys) ? body.keys : null;
    if (!keys) {
      return json(400, { status: { error: "missing keys[]" } });
    }
    const selector = parsePointSelector(body);
    if (!selector.ids && selector.filter === undefined) {
      return json(400, { status: { error: "missing points[] or filter" } });
    }
    try {
      const result = await store.updatePayload(collectionName, selector, "delete", keys);
      return json(200, payloadOpResult(result.operationId));
    } catch (error) {
      return queryHttpError(error, json);
    }
  }

  if (req.method === "POST" && remainder === "/points/payload/clear") {
    const body = (requestLog.reqBody ?? {}) as Record<string, unknown>;
    const selector = parsePointSelector(body);
    if (!selector.ids && selector.filter === undefined) {
      return json(400, { status: { error: "missing points[] or filter" } });
    }
    try {
      const result = await store.updatePayload(collectionName, selector, "clear");
      return json(200, payloadOpResult(result.operationId));
    } catch (error) {
      return queryHttpError(error, json);
    }
  }

  if (
    (req.method === "POST" || req.method === "PUT") &&
    remainder === "/points/payload"
  ) {
    const body = (requestLog.reqBody ?? {}) as Record<string, unknown>;
    if (!isRecord(body.payload) && req.method === "POST" && typeof body.key !== "string") {
      return json(400, { status: { error: "missing payload" } });
    }
    const selector = parsePointSelector(body);
    if (!selector.ids && selector.filter === undefined) {
      return json(400, { status: { error: "missing points[] or filter" } });
    }
    try {
      const mode = req.method === "PUT" ? "overwrite" : "set";
      const result = await store.updatePayload(
        collectionName,
        selector,
        mode,
        body.payload
      );
      return json(200, payloadOpResult(result.operationId));
    } catch (error) {
      return queryHttpError(error, json);
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
          (payload, id) => matchFilter(payload, filter, id),
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
      return queryHttpError(error, json);
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

function queryHttpError(
  error: unknown,
  json: (status: number, payload: unknown) => void
): void {
  rethrowIfBusy(error);
  if (error instanceof UnsupportedFilterError || error instanceof UnsupportedQueryError) {
    json(400, { status: { error: error.message } });
    return;
  }
  if (error instanceof CollectionExistsError || error instanceof CollectionSizeMismatchError) {
    json(409, { status: { error: error.message } });
    return;
  }
  if (error instanceof PointNotFoundError) {
    json(404, { status: { error: error.message } });
    return;
  }
  if (error instanceof EmbeddingError) {
    json(502, { status: { error: error.message } });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === "missing query vector" || message === EMBEDDING_NOT_CONFIGURED) {
    json(400, { status: { error: message } });
    return;
  }
  json(400, { status: { error: message } });
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
