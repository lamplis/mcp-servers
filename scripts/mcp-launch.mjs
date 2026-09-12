#!/usr/bin/env node
/**
 * Local MCP launcher. Never calls npx / the registry.
 * First action: append a line to data/<role>/logs/launcher.log.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ROLES = {
  "fake-qdrant": {
    srcDir: "src/fake-qdrant",
    dataSub: path.join("data", "fake-qdrant"),
    envDefaults: (absData) => ({ FAKE_QDRANT_DATA_DIR: absData }),
  },
  docsearch: {
    srcDir: "src/docsearch",
    dataSub: path.join("data", "docsearch"),
    envDefaults: (absData) => ({ DOCSEARCH_DATA_DIR: absData }),
  },
  memory: {
    srcDir: "src/memory",
    dataSub: path.join("data", "memory"),
    envDefaults: (absData) => ({
      MEMORY_FILE_PATH: path.join(absData, "memory.jsonl"),
    }),
  },
  filesystem: {
    srcDir: "src/filesystem",
    dataSub: path.join("data", "filesystem"),
    envDefaults: () => ({}),
  },
  everything: {
    srcDir: "src/everything",
    dataSub: path.join("data", "everything"),
    envDefaults: () => ({}),
  },
  sequentialthinking: {
    srcDir: "src/sequentialthinking",
    dataSub: path.join("data", "sequentialthinking"),
    envDefaults: () => ({}),
  },
  "local-embeddings": {
    srcDir: "src/local-embeddings",
    dataSub: path.join("data", "local-embeddings"),
    envDefaults: () => ({}),
  },
};

function appendLauncherLog(logFile, record) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`, "utf8");
}

function fail(logFile, message, extra = {}) {
  const record = {
    ts: new Date().toISOString(),
    event: "launcher.error",
    message,
    ...extra,
  };
  try {
    appendLauncherLog(logFile, record);
  } catch {
    // ignore
  }
  console.error(message);
  process.exit(1);
}

function resolveEntry(srcDir) {
  const dist = path.join(ROOT, srcDir, "dist", "index.js");
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const source = path.join(ROOT, srcDir, "index.ts");
  if (fs.existsSync(dist)) {
    return { command: process.execPath, args: [dist] };
  }
  if (fs.existsSync(tsxCli) && fs.existsSync(source)) {
    return { command: process.execPath, args: [tsxCli, source] };
  }
  return null;
}

const role = process.argv[2];
const extraArgs = process.argv.slice(3);
if (!role || !ROLES[role]) {
  console.error(
    `Usage: node scripts/mcp-launch.mjs <${Object.keys(ROLES).join("|")}> [...args]`
  );
  process.exit(1);
}

const spec = ROLES[role];
const absData = path.join(ROOT, spec.dataSub);
const logFile = path.join(absData, "logs", "launcher.log");
const entry = resolveEntry(spec.srcDir);

const launchRecord = {
  ts: new Date().toISOString(),
  event: "launcher.start",
  role,
  pid: process.pid,
  node: process.version,
  cwd: process.cwd(),
  argv: process.argv,
  resolvedEntry: entry,
  env: {
    FAKE_QDRANT_DATA_DIR: process.env.FAKE_QDRANT_DATA_DIR ?? null,
    DOCSEARCH_DATA_DIR: process.env.DOCSEARCH_DATA_DIR ?? null,
    MEMORY_FILE_PATH: process.env.MEMORY_FILE_PATH ?? null,
    MCP_TAKEOVER: process.env.MCP_TAKEOVER ?? null,
  },
};
try {
  appendLauncherLog(logFile, launchRecord);
} catch (error) {
  console.error(`Failed to write launcher log ${logFile}: ${error}`);
}

if (!entry) {
  fail(
    logFile,
    `Cannot start ${role}: missing ${spec.srcDir}/dist/index.js and node_modules/tsx. Run npm install from the internal registry, then npm run build -w ${spec.srcDir}.`,
    { role }
  );
}

const env = { ...process.env };
for (const [key, value] of Object.entries(spec.envDefaults(absData))) {
  if (!process.env[key]) {
    env[key] = value;
  }
}

const child = spawn(entry.command, [...entry.args, ...extraArgs], {
  cwd: ROOT,
  env,
  stdio: "inherit",
  windowsHide: true,
});

const killChild = () => {
  if (!child.pid || child.exitCode != null) {
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGTERM");
};

process.on("SIGINT", killChild);
process.on("SIGTERM", killChild);
if (!process.stdin.isTTY) {
  process.stdin.on("end", killChild);
  process.stdin.on("close", killChild);
}

child.on("exit", (code, signal) => {
  appendLauncherLog(logFile, {
    ts: new Date().toISOString(),
    event: "launcher.exit",
    role,
    childPid: child.pid,
    code,
    signal,
  });
  process.exit(code ?? (signal ? 1 : 0));
});
child.on("error", (error) => {
  fail(logFile, `spawn failed: ${error.message}`, { role });
});
