#!/usr/bin/env node

import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  announceInstance,
  installShutdownHooks,
  lockDirForDataDir,
  parseTakeoverPolicy,
  releaseIdentitySync,
  removeInstanceFile,
  resolveContention,
  resolvePortContention,
  type InstanceInfo,
} from "@modelcontextprotocol/mcp-lifecycle";
import { loadConfig, FAKE_QDRANT_SIDECAR, ConfigError } from "./config.js";
import { createServer } from "./server.js";
import { startQdrantHttpServer, type QdrantHttpServerHandle } from "./qdrant-http.js";
import { createFileLogger } from "./logger.js";
import { DiskGate } from "./disk-gate.js";
import {
  createProvider,
  describeProxyState,
  embeddingProbeLogFields,
  OpenAICompatibleProvider,
} from "./provider.js";

async function main() {
  const config = loadConfig();
  const dataDir = path.resolve(config.dataDir);
  const logDir = path.resolve(config.logDir ?? path.join(dataDir, "logs"));
  const diskGate = new DiskGate();
  const logger = createFileLogger({
    logDir,
    level: config.logLevel,
    retentionDays: config.logRetentionDays,
    redactVectors: true,
    diskGate,
  });

  process.title = "mcp-fake-qdrant";
  const lockDir = lockDirForDataDir(dataDir);
  const policy = parseTakeoverPolicy();
  const processLock = await resolveContention({
    lockDir,
    dataDir,
    role: "fake-qdrant",
    policy,
    logger,
  });
  const identity: InstanceInfo = await announceInstance({
    role: "fake-qdrant",
    dataDir,
    port: config.httpEnabled ? config.httpPort : null,
  });

  logger.info("lifecycle.start", {
    pid: process.pid,
    instanceId: identity.instanceId,
    role: identity.role,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cwd: process.cwd(),
    node: process.version,
    dataDir,
    logDir: logger.logDir,
    logFile: logger.currentFilePath(),
    httpEnabled: config.httpEnabled,
    httpHost: config.httpHost,
    httpPort: config.httpPort,
    takeover: policy,
  });
  console.error(
    `Fake Qdrant MCP server running on stdio; logs: ${logger.currentFilePath()}`
  );

  const runtimeStatus = {
    identity,
    httpBound: false,
    httpHost: config.httpHost,
    httpPort: config.httpEnabled ? config.httpPort : null,
    logFile: logger.currentFilePath(),
    lockDir,
  };

  let embeddingProvider = null;
  try {
    embeddingProvider = createProvider(config);
    if (embeddingProvider) {
      const proxy =
        embeddingProvider instanceof OpenAICompatibleProvider
          ? describeProxyState(new URL(embeddingProvider.endpoint))
          : undefined;
      logger.info("embedding.provider", {
        ...embeddingProvider.describe(),
        proxy,
      });
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error("embedding.provider_error", {
        message: error.message,
      });
      embeddingProvider = null;
    } else {
      throw error;
    }
  }

  const { server, store } = await createServer({
    dataDir: config.dataDir,
    logger,
    diskGate,
    existingLock: processLock,
    acquireLock: false,
    dropEmptyChunks: config.dropEmptyChunks,
    runtimeStatus,
    embeddingProvider,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (embeddingProvider) {
    void embeddingProvider
      .probe()
      .then((result) => {
        const fields = embeddingProbeLogFields(result);
        if (result.ok) {
          logger.info("embedding.health", fields);
        } else {
          logger.error("embedding.health", fields);
          const detail = [result.error, result.hint].filter(Boolean).join(" — ");
          console.error(`embedding.health failed: ${detail}`);
        }
      })
      .catch((error) => {
        logger.error("embedding.health", {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  let httpHandle: QdrantHttpServerHandle | null = null;

  const bindHttp = () =>
    startQdrantHttpServer({
      store,
      host: config.httpHost,
      port: config.httpPort,
      logger,
      identity: {
        pid: identity.pid,
        instanceId: identity.instanceId,
        startedAt: identity.startedAt,
        dataDir,
      },
      slowRequestMs: config.slowRequestMs,
      flagPayloadPatterns: config.flagPayloadPatterns,
      strictCreate: config.strictCreate,
      embeddingProvider,
    });

  if (config.httpEnabled) {
    try {
      httpHandle = await bindHttp();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("EADDRINUSE")) {
        logger.error("http.bind_failed", {
          code: "EADDRINUSE",
          port: config.httpPort,
          message: `Port ${config.httpPort} in use; attempting verified takeover (${policy}).`,
        });
        await resolvePortContention({
          host: config.httpHost,
          port: config.httpPort,
          role: "fake-qdrant",
          dataDir,
          sidecar: FAKE_QDRANT_SIDECAR,
          policy,
          logger,
        });
        httpHandle = await bindHttp();
      } else {
        throw err;
      }
    }
    runtimeStatus.httpBound = Boolean(httpHandle);
    runtimeStatus.httpPort = httpHandle?.port ?? config.httpPort;
  } else {
    logger.info("http.disabled", {
      message: "Set FAKE_QDRANT_ENABLED=1 to expose the Qdrant-compatible HTTP shim.",
    });
    console.error(
      "Set FAKE_QDRANT_ENABLED=1 to expose the Qdrant-compatible HTTP shim."
    );
  }

  installShutdownHooks({
    logger,
    transport,
    onShutdown: async () => {
      if (httpHandle) {
        await httpHandle.close().catch(() => {});
      }
      await store.close();
      await server.close();
      await removeInstanceFile(dataDir);
      await logger.flush();
      logger.close();
    },
    onExitSync: () =>
      releaseIdentitySync({
        lockDir,
        dataDir,
        pid: process.pid,
      }),
  });
}

main().catch((error) => {
  console.error("Fatal error in fake Qdrant MCP server:", error);
  process.exit(1);
});
