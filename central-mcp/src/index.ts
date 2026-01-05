import express from "express";
import cors from "cors";
import path from "path";
import { createServerRouter } from "./routes/createServerRouter.js";
import { createServer as createMemoryServer } from "../../src/memory/server.js";
import { createServer as createFilesystemServer } from "../../src/filesystem/server.js";
import { createServer as createEverythingServer } from "../../src/everything/server/index.js";
import { createServer as createSequentialThinkingServer } from "../../src/sequentialthinking/server.js";

const PORT = Number(process.env.PORT ?? 3300);
const filesystemAllowedDirs = parseDirectories(process.env.FILESYSTEM_ALLOWED_DIRS);

const app = express();
app.use(
  cors({
    origin: "*",
  })
);
app.use(express.json({ limit: "1mb" }));

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

