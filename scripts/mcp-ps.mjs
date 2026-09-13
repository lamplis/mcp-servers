#!/usr/bin/env node
/**
 * Inspect / kill MCP lifecycle processes (verified, never "all node.exe").
 * Usage:
 *   node scripts/mcp-ps.mjs list
 *   node scripts/mcp-ps.mjs kill <role>|all
 *   node scripts/mcp-ps.mjs doctor
 *   node scripts/mcp-ps.mjs clean [role]|all
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ROLES = [
  {
    role: "fake-qdrant",
    dataDir: path.join(ROOT, "data", "fake-qdrant"),
    lockDir: path.join(ROOT, "data", "fake-qdrant", ".write.lock"),
    port: 6333,
  },
  {
    role: "docsearch",
    dataDir: path.join(ROOT, "data", "docsearch"),
    lockDir: path.join(ROOT, "data", "docsearch", "index", ".write.lock"),
    port: null,
  },
  {
    role: "memory",
    dataDir: path.join(ROOT, "data", "memory"),
    lockDir: (() => {
      const memoryFile =
        process.env.MEMORY_FILE_PATH ||
        path.join(ROOT, "data", "memory", "memory.jsonl");
      return `${memoryFile}.lock`;
    })(),
    port: null,
  },
];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readPid(lockDir) {
  try {
    const raw = fs.readFileSync(path.join(lockDir, "pid"), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tasklistImage(pid) {
  if (process.platform !== "win32") {
    return undefined;
  }
  try {
    const stdout = execFileSync(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true }
    );
    const line = stdout.trim().split(/\r?\n/)[0] ?? "";
    const match = line.match(/^"([^"]+)"/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function portOwner(port) {
  try {
    const stdout = execFileSync("netstat", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      windowsHide: true,
    });
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes(`:${port} `) && !line.includes(`:${port}\t`)) {
        continue;
      }
      if (!/LISTENING/i.test(line)) {
        continue;
      }
      const parts = line.trim().split(/\s+/);
      const pid = Number.parseInt(parts[parts.length - 1], 10);
      if (Number.isInteger(pid)) {
        return pid;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function fetchHealthz(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/healthz", timeout: 750 },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function leftoverTmp(dir) {
  const hits = [];
  if (!fs.existsSync(dir)) {
    return hits;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const entry of entries) {
    if (entry.name === "logs") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".tmp")) {
      hits.push(full);
    } else if (entry.isDirectory() && entry.name === "collections") {
      let cols = [];
      try {
        cols = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const col of cols) {
        if (!col.isDirectory()) {
          continue;
        }
        const colDir = path.join(full, col.name);
        let files = [];
        try {
          files = fs.readdirSync(colDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const file of files) {
          if (file.isFile() && file.name.endsWith(".tmp")) {
            hits.push(path.join(colDir, file.name));
          }
        }
      }
    }
  }
  return hits;
}

function leftoverDb(dir) {
  const hits = [];
  if (!fs.existsSync(dir)) {
    return hits;
  }
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") {
          continue;
        }
        walk(full);
      } else if (/\.db(-wal|-shm)?$/.test(entry.name)) {
        hits.push(full);
      }
    }
  };
  walk(dir);
  return hits;
}

async function describeRole(spec) {
  const instance = readJson(path.join(spec.dataDir, "instance.json"));
  const lockPid = fs.existsSync(spec.lockDir) ? readPid(spec.lockDir) : undefined;
  const instanceAlive = instance?.pid ? isPidAlive(instance.pid) : false;
  const lockAlive = lockPid ? isPidAlive(lockPid) : false;
  const image = instance?.pid ? tasklistImage(instance.pid) : undefined;
  const listening = spec.port ? portOwner(spec.port) : undefined;
  const health = spec.port ? await fetchHealthz(spec.port) : null;
  return {
    role: spec.role,
    dataDir: spec.dataDir,
    instance,
    instanceAlive,
    lockPid,
    lockAlive,
    image,
    port: spec.port,
    portOwner: listening,
    health,
    leftoverDb: leftoverDb(spec.dataDir),
    leftoverTmp: leftoverTmp(spec.dataDir),
  };
}

function printList(rows) {
  for (const row of rows) {
    console.log(`${row.role}`);
    console.log(`  instance pid: ${row.instance?.pid ?? "-"} alive=${row.instanceAlive} image=${row.image ?? "-"}`);
    console.log(`  lock pid: ${row.lockPid ?? "-"} alive=${row.lockAlive}`);
    if (row.port) {
      console.log(`  port ${row.port} owner=${row.portOwner ?? "-"} health.pid=${row.health?.pid ?? "-"} sidecar=${row.health?.sidecar ?? "-"}`);
    }
  }
}

async function doctor(rows) {
  let issues = 0;
  for (const row of rows) {
    if (row.lockPid && !row.lockAlive) {
      console.log(`STALE LOCK ${row.role} holder ${row.lockPid}`);
      issues += 1;
    }
    if (row.instance?.pid && !row.instanceAlive) {
      console.log(`STALE INSTANCE ${row.role} pid ${row.instance.pid}`);
      issues += 1;
    }
    if (row.port && row.portOwner && row.instance?.pid && row.portOwner !== row.instance.pid) {
      console.log(`PORT SPLIT ${row.role} port ${row.port} owner ${row.portOwner} instance ${row.instance.pid}`);
      issues += 1;
    }
    for (const file of row.leftoverDb) {
      console.log(`LEFTOVER DB ${file}`);
    }
  }
  if (issues === 0) {
    console.log("doctor: no stale locks or instance files.");
  } else {
    console.log("Run: node scripts/mcp-ps.mjs clean all");
  }
  return issues;
}

function cleanRole(spec, row) {
  const liveLock = row.lockPid && row.lockAlive;
  const liveInstance = row.instance?.pid && row.instanceAlive;
  if (liveLock || liveInstance) {
    console.error(
      `${spec.role}: refusing to clean; pid ${row.lockPid ?? row.instance?.pid} is alive. Use kill first.`
    );
    return false;
  }
  let removed = 0;
  if (fs.existsSync(spec.lockDir)) {
    fs.rmSync(spec.lockDir, { recursive: true, force: true });
    console.log(`${spec.role}: removed lock ${spec.lockDir}`);
    removed += 1;
  }
  const instancePath = path.join(spec.dataDir, "instance.json");
  if (fs.existsSync(instancePath)) {
    fs.rmSync(instancePath, { force: true });
    console.log(`${spec.role}: removed ${instancePath}`);
    removed += 1;
  }
  for (const tmp of leftoverTmp(spec.dataDir)) {
    fs.rmSync(tmp, { force: true });
    console.log(`${spec.role}: removed ${tmp}`);
    removed += 1;
  }
  if (removed === 0) {
    console.log(`${spec.role}: nothing to clean`);
  }
  return true;
}

function killPid(pid) {
  try {
    process.kill(pid);
  } catch {
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/F", "/PID", String(pid)], {
          stdio: "ignore",
          windowsHide: true,
        });
      } catch {
        // ignore
      }
    }
  }
}

async function killRole(spec, row) {
  const pid = row.instance?.pid ?? row.lockPid ?? row.portOwner;
  if (!pid) {
    console.log(`${spec.role}: nothing to kill`);
    return;
  }
  const image = tasklistImage(pid);
  const nodeish = !image || /node/i.test(image);
  if (!nodeish) {
    console.error(`${spec.role}: refusing to kill pid ${pid} image=${image}`);
    return;
  }
  if (row.instance && row.instance.role !== spec.role) {
    console.error(`${spec.role}: instance role mismatch`);
    return;
  }
  killPid(pid);
  console.log(`${spec.role}: killed ${pid}`);
}

const command = process.argv[2] ?? "list";
const target = process.argv[3];

const rows = [];
for (const spec of ROLES) {
  rows.push(await describeRole(spec));
}

if (command === "list") {
  printList(rows);
} else if (command === "doctor") {
  const issues = await doctor(rows);
  process.exit(issues > 0 ? 1 : 0);
} else if (command === "kill") {
  const wanted = target === "all" ? ROLES.map((item) => item.role) : [target];
  if (!wanted[0]) {
    console.error("Usage: node scripts/mcp-ps.mjs kill <role>|all");
    process.exit(1);
  }
  for (const role of wanted) {
    const spec = ROLES.find((item) => item.role === role);
    const row = rows.find((item) => item.role === role);
    if (!spec || !row) {
      console.error(`Unknown role ${role}`);
      process.exit(1);
    }
    await killRole(spec, row);
  }
} else if (command === "clean") {
  const wanted = target === "all" || !target ? ROLES.map((item) => item.role) : [target];
  let refused = false;
  for (const role of wanted) {
    const spec = ROLES.find((item) => item.role === role);
    const row = rows.find((item) => item.role === role);
    if (!spec || !row) {
      console.error(`Unknown role ${role}`);
      process.exit(1);
    }
    if (!cleanRole(spec, row)) {
      refused = true;
    }
  }
  process.exit(refused ? 1 : 0);
} else {
  console.error("Usage: node scripts/mcp-ps.mjs list|kill|doctor|clean [role|all]");
  process.exit(1);
}
