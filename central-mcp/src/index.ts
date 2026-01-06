import express from "express";
import cors from "cors";
import path from "path";
import { createServerRouter } from "./routes/createServerRouter.js";
import { createServer as createMemoryServer } from "../../src/memory/server.js";
import { createServer as createFilesystemServer } from "../../src/filesystem/server.js";
import { createServer as createEverythingServer } from "../../src/everything/server/index.js";
import { createServer as createSequentialThinkingServer } from "../../src/sequentialthinking/server.js";
import { createServer as createFakeQdrantServer } from "../../src/fake-qdrant/server.js";
import { Store as FakeQdrantStore } from "../../src/fake-qdrant/store.js";
import { startQdrantHttpServer } from "../../src/fake-qdrant/qdrant-http.js";

const PORT = Number(process.env.PORT ?? 3300);
const filesystemAllowedDirs = parseDirectories(process.env.FILESYSTEM_ALLOWED_DIRS);
const fakeQdrantEnabled = process.env.FAKE_QDRANT_ENABLED === "1";
const fakeQdrantHost = process.env.FAKE_QDRANT_HTTP_HOST;
const fakeQdrantPort = process.env.FAKE_QDRANT_HTTP_PORT
  ? Number(process.env.FAKE_QDRANT_HTTP_PORT)
  : undefined;

let fakeQdrantStorePromise: Promise<FakeQdrantStore> | null = null;

function ensureFakeQdrantStore() {
  if (!fakeQdrantStorePromise) {
    fakeQdrantStorePromise = FakeQdrantStore.create();
  }
  return fakeQdrantStorePromise;
}

const app = express();
app.use(
  cors({
    origin: "*",
  })
);
// Note: Do NOT add global express.json() here - the SSE transport needs raw request streams

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(
  "/memory",
  createServerRouter({
    name: "memory",
    messagePath: "/memory/message",
    factory: () => createMemoryServer(),
  })
);

app.use(
  "/filesystem",
  createServerRouter({
    name: "filesystem",
    messagePath: "/filesystem/message",
    factory: () =>
      createFilesystemServer({
        initialAllowedDirectories: filesystemAllowedDirs,
        validateInitialDirectories: true,
        allowEmptyDirectories: filesystemAllowedDirs.length === 0,
      }),
  })
);

app.use(
  "/everything",
  createServerRouter({
    name: "everything",
    messagePath: "/everything/message",
    factory: () => createEverythingServer(),
  })
);

app.use(
  "/sequentialthinking",
  createServerRouter({
    name: "sequentialthinking",
    messagePath: "/sequentialthinking/message",
    factory: () => createSequentialThinkingServer(),
  })
);

app.use(
  "/fake-qdrant",
  createServerRouter({
    name: "fake-qdrant",
    messagePath: "/fake-qdrant/message",
    factory: async () => {
      const store = await ensureFakeQdrantStore();
      return createFakeQdrantServer({ store });
    },
  })
);

if (fakeQdrantEnabled) {
  ensureFakeQdrantStore()
    .then((store) =>
      startQdrantHttpServer({
        store,
        host: fakeQdrantHost,
        port: fakeQdrantPort,
        logger: (message) => console.error(message),
      })
    )
    .catch((error) => {
      console.error("[fake-qdrant] Failed to start HTTP shim:", error);
    });
}

app.listen(PORT, () => {
  console.error(`central-mcp listening on http://localhost:${PORT}`);
});

function parseDirectories(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0);
}

