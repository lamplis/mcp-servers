import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { URL } from "node:url";

import {
  type FakeQdrantConfig,
  getDefaultExternalModel,
  ConfigError,
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  DEFAULT_EMBEDDING_BATCH,
} from "./config.js";

export interface EmbedResult {
  model: string;
  embeddings: number[][];
  dimensions: number;
}

export interface EmbeddingProviderInfo {
  mode: "local" | "external";
  model: string;
  baseUrlHost: string;
  dim: number | null;
}

export interface ProxyState {
  envSet: boolean;
  used: boolean;
  host: string | null;
  loopback: boolean;
}

export interface EmbeddingProbeResult {
  ok: boolean;
  configured: boolean;
  ms: number;
  endpointHost: string;
  model: string;
  dim: number | null;
  statusCode?: number;
  error?: string;
  code?: string;
  hint?: string;
  proxy: ProxyState;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<EmbedResult>;
  probe(): Promise<EmbeddingProbeResult>;
  describe(): EmbeddingProviderInfo;
  lastProbe: EmbeddingProbeResult | null;
  readonly model: string;
  readonly dimensions: number | null;
  readonly mode: "local" | "external";
}

export const EMBEDDING_NOT_CONFIGURED =
  "Embedding provider not configured; set FAKE_QDRANT_EMBEDDING_BASE_URL (+ MODEL/DIM/API_KEY) or pass vector";

export const EMBEDDING_PROBE_TEXT = "healthcheck";

export class EmbeddingError extends Error {
  readonly code?: string;
  readonly statusCode?: number;

  constructor(
    message: string,
    options?: { code?: string; statusCode?: number; cause?: unknown }
  ) {
    super(message.startsWith("embedding:") ? message : `embedding: ${message}`);
    this.name = "EmbeddingError";
    this.code = options?.code;
    this.statusCode = options?.statusCode;
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function resolveEmbeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new ConfigError("Embedding base URL is empty");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigError(`Invalid embedding base URL: ${baseUrl}`);
  }
  const rawPath = parsed.pathname.replace(/\/+$/, "");
  const path = rawPath === "" ? "/v1" : rawPath;
  parsed.pathname = `${path}/embeddings`;
  return parsed.toString();
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "::"
  );
}

export function proxyEnvSet(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return Boolean(
    firstNonEmpty(
      env.HTTPS_PROXY,
      env.https_proxy,
      env.HTTP_PROXY,
      env.http_proxy
    )
  );
}

export function resolveProxyUrl(
  target: URL,
  env: NodeJS.ProcessEnv = process.env
): URL | null {
  if (isLoopbackHost(target.hostname)) {
    return null;
  }
  if (noProxyMatches(target.hostname, env)) {
    return null;
  }
  const raw =
    target.protocol === "https:"
      ? firstNonEmpty(env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy)
      : firstNonEmpty(env.HTTP_PROXY, env.http_proxy, env.HTTPS_PROXY, env.https_proxy);
  if (!raw) {
    return null;
  }
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function describeProxyState(
  target: URL,
  env: NodeJS.ProcessEnv = process.env
): ProxyState {
  const loopback = isLoopbackHost(target.hostname);
  const proxy = resolveProxyUrl(target, env);
  return {
    envSet: proxyEnvSet(env),
    used: Boolean(proxy),
    host: proxy ? proxy.host : null,
    loopback,
  };
}

export function classifyEmbeddingFailure(
  error: unknown,
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env
): { error: string; code?: string; statusCode?: number; hint?: string } {
  const err = error instanceof Error ? error : new Error(String(error));
  const embeddingError = error instanceof EmbeddingError ? error : null;
  const code =
    embeddingError?.code ??
    (error as NodeJS.ErrnoException).code ??
    causeCode(error);
  const statusCode = embeddingError?.statusCode;
  const message = err.message.replace(/^embedding:\s*/i, "");
  let parsed: URL | null = null;
  try {
    parsed = new URL(endpoint);
  } catch {
    parsed = null;
  }
  const loopback = parsed ? isLoopbackHost(parsed.hostname) : false;
  const proxy = parsed
    ? describeProxyState(parsed, env)
    : describeProxyState(new URL("http://127.0.0.1"), env);
  const timedOut = /timed out/i.test(message) || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT";
  const refused = code === "ECONNREFUSED";
  const reset = code === "ECONNRESET";
  const notFound = code === "ENOTFOUND" || code === "EAI_AGAIN";
  const tlsFail =
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "CERT_HAS_EXPIRED" ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    /certificate|ssl|tls/i.test(message);

  let hint: string | undefined;
  if (refused && loopback) {
    hint =
      "Nothing is listening on this loopback port. Start central-local-embeddings (HTTP :3100) or fix FAKE_QDRANT_LOCAL_EMBEDDINGS_TARGET.";
  } else if ((timedOut || reset || notFound || refused) && !loopback && !proxy.envSet) {
    hint =
      "Node does not follow PAC/WPAD. If this host needs the corporate proxy, set HTTPS_PROXY to an explicit proxy URL (not WPAD) and restart the MCP.";
  } else if ((timedOut || reset || refused) && !loopback && proxy.envSet) {
    hint = `HTTPS_PROXY/HTTP_PROXY is set (${proxy.host ?? "unparsed"}) but the request still failed. Check the proxy host/port and NO_PROXY.`;
  } else if (tlsFail) {
    hint = "TLS to the embedding API failed (corporate CA or wrong host).";
  } else if (statusCode === 401 || statusCode === 403) {
    hint = "Embedding API rejected the Bearer token. Check FAKE_QDRANT_EMBEDDING_API_KEY / OPENAI_EMBED_API_KEY (never logged).";
  } else if (statusCode === 404) {
    hint = "Embedding path not found. Base URL should be the OpenAI-compatible root (no trailing /embeddings).";
  }

  return {
    error: message,
    code,
    statusCode,
    hint,
  };
}

export function embeddingProbeLogFields(
  result: EmbeddingProbeResult
): Record<string, unknown> {
  return {
    ok: result.ok,
    configured: result.configured,
    ms: result.ms,
    endpointHost: result.endpointHost,
    model: result.model,
    dim: result.dim,
    statusCode: result.statusCode,
    error: result.error,
    code: result.code,
    hint: result.hint,
    proxyEnvSet: result.proxy.envSet,
    proxyUsed: result.proxy.used,
    proxyHost: result.proxy.host,
    loopback: result.proxy.loopback,
  };
}

export function embeddingHealthPayload(
  provider: EmbeddingProvider | null
): Record<string, unknown> {
  if (!provider) {
    return {
      ok: null,
      configured: false,
      message: EMBEDDING_NOT_CONFIGURED,
    };
  }
  const probe = provider.lastProbe;
  if (!probe) {
    return {
      ok: null,
      configured: true,
      endpointHost: provider.describe().baseUrlHost,
      model: provider.model,
      dim: provider.dimensions,
      message: "not probed yet",
    };
  }
  return { ...probe } as Record<string, unknown>;
}

export class OpenAICompatibleProvider implements EmbeddingProvider {
  private _dimensions: number | null;
  readonly endpoint: string;
  readonly baseUrlHost: string;
  lastProbe: EmbeddingProbeResult | null = null;

  constructor(
    readonly mode: "local" | "external",
    private readonly baseUrl: string,
    readonly model: string,
    private readonly apiKey: string | null,
    expectedDim: number | null,
    private readonly timeoutMs: number
  ) {
    this.endpoint = resolveEmbeddingsUrl(baseUrl);
    this._dimensions = expectedDim;
    this.baseUrlHost = hostOf(this.endpoint);
  }

  get dimensions(): number | null {
    return this._dimensions;
  }

  describe(): EmbeddingProviderInfo {
    return {
      mode: this.mode,
      model: this.model,
      baseUrlHost: this.baseUrlHost,
      dim: this._dimensions,
    };
  }

  async probe(): Promise<EmbeddingProbeResult> {
    const started = Date.now();
    const proxy = describeProxyState(new URL(this.endpoint));
    try {
      const result = await this.embed([EMBEDDING_PROBE_TEXT]);
      const probe: EmbeddingProbeResult = {
        ok: true,
        configured: true,
        ms: Date.now() - started,
        endpointHost: this.baseUrlHost,
        model: result.model,
        dim: result.dimensions,
        proxy,
      };
      this.lastProbe = probe;
      return probe;
    } catch (error) {
      const diagnosed = classifyEmbeddingFailure(error, this.endpoint);
      const probe: EmbeddingProbeResult = {
        ok: false,
        configured: true,
        ms: Date.now() - started,
        endpointHost: this.baseUrlHost,
        model: this.model,
        dim: this._dimensions,
        proxy,
        ...diagnosed,
      };
      this.lastProbe = probe;
      return probe;
    }
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) {
      return { model: this.model, embeddings: [], dimensions: this._dimensions ?? 0 };
    }

    const embeddings: number[][] = new Array(texts.length);
    let model = this.model;
    for (let offset = 0; offset < texts.length; offset += DEFAULT_EMBEDDING_BATCH) {
      const batch = texts.slice(offset, offset + DEFAULT_EMBEDDING_BATCH);
      const result = await this.embedBatch(batch);
      model = result.model;
      for (let i = 0; i < result.embeddings.length; i += 1) {
        embeddings[offset + i] = result.embeddings[i] ?? [];
      }
    }

    const dimensions = embeddings[0]?.length ?? 0;
    if (this._dimensions != null && dimensions !== this._dimensions) {
      throw new EmbeddingError(
        `Embedding dimension mismatch: expected ${this._dimensions}, got ${dimensions}`
      );
    }
    this._dimensions = dimensions;

    return { model, embeddings, dimensions };
  }

  private async embedBatch(texts: string[]): Promise<EmbedResult> {
    const body = JSON.stringify({
      input: texts,
      model: this.model,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await httpPost(this.endpoint, body, headers, this.timeoutMs);
    const data = JSON.parse(response) as OpenAIEmbeddingResponse;
    if (!Array.isArray(data.data)) {
      throw new EmbeddingError("embedding response missing data[]");
    }
    const ordered = data.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
    if (ordered.length !== texts.length) {
      throw new EmbeddingError(
        `embedding response size mismatch: expected ${texts.length}, got ${ordered.length}`
      );
    }
    const dimensions = ordered[0]?.length ?? 0;
    return {
      model: data.model ?? this.model,
      embeddings: ordered,
      dimensions,
    };
  }
}

export function createProvider(config: FakeQdrantConfig): EmbeddingProvider | null {
  if (config.embeddingProvider === "local") {
    const target = config.localEmbeddingsTarget ?? "http://127.0.0.1:3100";
    return new OpenAICompatibleProvider(
      "local",
      target,
      "Xenova/all-MiniLM-L6-v2",
      config.embeddingApiKey,
      config.embeddingDim,
      config.embeddingTimeoutMs
    );
  }

  if (config.embeddingProvider === "external") {
    if (!config.embeddingBaseUrl) {
      throw new ConfigError(
        "FAKE_QDRANT_EMBEDDING_BASE_URL is required for external provider"
      );
    }
    const model = config.embeddingModel ?? getDefaultExternalModel();
    return new OpenAICompatibleProvider(
      "external",
      config.embeddingBaseUrl,
      model,
      config.embeddingApiKey,
      config.embeddingDim,
      config.embeddingTimeoutMs
    );
  }

  return null;
}

interface OpenAIEmbeddingResponse {
  model?: string;
  data: Array<{
    index: number;
    embedding: number[];
  }>;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function noProxyMatches(hostname: string, env: NodeJS.ProcessEnv): boolean {
  const raw = firstNonEmpty(env.NO_PROXY, env.no_proxy);
  if (!raw) {
    return false;
  }
  const host = hostname.toLowerCase();
  for (const item of raw.split(",")) {
    const token = item.trim().toLowerCase();
    if (!token) {
      continue;
    }
    if (token === "*") {
      return true;
    }
    const suffix = token.startsWith(".") ? token : `.${token}`;
    if (host === token.replace(/^\./, "") || host.endsWith(suffix)) {
      return true;
    }
  }
  return false;
}

function causeCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("cause" in error)) {
    return undefined;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function proxyAuthHeaders(proxy: URL): Record<string, string> {
  if (!proxy.username && !proxy.password) {
    return {};
  }
  const token = Buffer.from(
    `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
  ).toString("base64");
  return { "Proxy-Authorization": `Basic ${token}` };
}

function httpPost(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const timeout = timeoutMs > 0 ? timeoutMs : DEFAULT_EMBEDDING_TIMEOUT_MS;
    const proxy = resolveProxyUrl(parsed);
    const fail = (error: unknown) => {
      reject(toEmbeddingError(error));
    };

    const onResponse = (res: http.IncomingMessage) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          fail(
            new EmbeddingError(
              `request failed with status ${res.statusCode}: ${data.slice(0, 500)}`,
              { statusCode: res.statusCode }
            )
          );
          return;
        }
        resolve(data);
      });
    };

    if (!proxy) {
      const transport = parsed.protocol === "https:" ? https : http;
      const req = transport.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: "POST",
          headers,
        },
        onResponse
      );
      req.setTimeout(timeout, () => {
        req.destroy(new EmbeddingError(`request timed out after ${timeout}ms`, { code: "ETIMEDOUT" }));
      });
      req.on("error", fail);
      req.write(body);
      req.end();
      return;
    }

    if (parsed.protocol === "http:") {
      const req = http.request(
        {
          hostname: proxy.hostname,
          port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
          path: parsed.href,
          method: "POST",
          headers: {
            ...headers,
            Host: parsed.host,
            ...proxyAuthHeaders(proxy),
          },
        },
        onResponse
      );
      req.setTimeout(timeout, () => {
        req.destroy(new EmbeddingError(`request timed out after ${timeout}ms`, { code: "ETIMEDOUT" }));
      });
      req.on("error", fail);
      req.write(body);
      req.end();
      return;
    }

    const connectPort =
      Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80);
    const connectReq = http.request({
      hostname: proxy.hostname,
      port: connectPort,
      method: "CONNECT",
      path: `${parsed.hostname}:${parsed.port || 443}`,
      headers: {
        Host: `${parsed.hostname}:${parsed.port || 443}`,
        ...proxyAuthHeaders(proxy),
      },
    });
    connectReq.setTimeout(timeout, () => {
      connectReq.destroy(
        new EmbeddingError(`proxy CONNECT timed out after ${timeout}ms`, { code: "ETIMEDOUT" })
      );
    });
    connectReq.on("error", fail);
    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        fail(
          new EmbeddingError(`proxy CONNECT failed with status ${res.statusCode ?? 0}`, {
            statusCode: res.statusCode,
          })
        );
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: parsed.hostname }, () => {
        // TLS is already done on the tunneled socket; speak HTTP/1.1 over it.
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: "POST",
            headers,
            createConnection: () => tlsSocket,
          },
          onResponse
        );
        req.setTimeout(timeout, () => {
          req.destroy(new EmbeddingError(`request timed out after ${timeout}ms`, { code: "ETIMEDOUT" }));
        });
        req.on("error", fail);
        req.write(body);
        req.end();
      });
      tlsSocket.on("error", fail);
    });
    connectReq.end();
  });
}

function toEmbeddingError(error: unknown): EmbeddingError {
  if (error instanceof EmbeddingError) {
    return error;
  }
  const err = error as NodeJS.ErrnoException;
  const message = error instanceof Error ? error.message : String(error);
  return new EmbeddingError(message, { code: err.code, cause: error });
}
