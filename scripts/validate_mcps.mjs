#!/usr/bin/env node
/**
 * Validate that each Roo/Cursor MCP server starts and answers tools/list.
 * Usage: node scripts/validate_mcps.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const LIFECYCLE_DIST = path.join(ROOT, "src", "mcp-lifecycle", "dist", "index.js");

const SERVERS = [
  {
    name: "central-memory",
    command: NODE,
    args: ["scripts/mcp-launch.mjs", "memory"],
    env: {
      MCP_TAKEOVER: "1",
      MEMORY_FILE_PATH: path.join(ROOT, "data", "memory-validate", "memory.jsonl"),
    },
    expectTools: ["read_graph", "create_entities"],
    callTool: { name: "read_graph", arguments: {} },
    identityDir: path.join(ROOT, "data", "memory-validate"),
    lockDir: path.join(ROOT, "data", "memory-validate", "memory.jsonl.lock"),
  },
  {
    name: "central-filesystem",
    command: NODE,
    args: ["scripts/mcp-launch.mjs", "filesystem", ROOT],
    env: {},
    expectTools: ["list_directory", "read_file"],
    callTool: { name: "list_allowed_directories", arguments: {} },
    timeoutMs: 40000,
  },
  {
    name: "central-sequentialthinking",
    command: NODE,
    args: ["scripts/mcp-launch.mjs", "sequentialthinking"],
    env: {},
    expectTools: ["sequentialthinking"],
  },
  {
    name: "central-everything",
    command: NODE,
    args: ["scripts/mcp-launch.mjs", "everything", "stdio"],
    env: {},
    expectTools: ["echo"],
    callTool: { name: "echo", arguments: { message: "mcp-validate" } },
  },
  {
    name: "central-fake-qdrant",
    command: NODE,
    args: ["scripts/mcp-launch.mjs", "fake-qdrant"],
    env: {
      FAKE_QDRANT_ENABLED: "1",
      FAKE_QDRANT_HTTP_PORT: "16333",
      FAKE_QDRANT_DATA_DIR: path.join(ROOT, "data", "fake-qdrant-validate"),
      MCP_TAKEOVER: "1",
    },
    expectTools: ["fake_qdrant_list_collections", "fake_qdrant_query_points", "fake_qdrant_status"],
    callTool: { name: "fake_qdrant_list_collections", arguments: {} },
    httpHealth: "http://127.0.0.1:16333/healthz",
    expectHealthPid: true,
    identityDir: path.join(ROOT, "data", "fake-qdrant-validate"),
    lockDir: path.join(ROOT, "data", "fake-qdrant-validate", ".write.lock"),
  },
  {
    name: "central-local-embeddings",
    command: NODE,
    args: ["scripts/mcp-launch.mjs", "local-embeddings"],
    env: {
      MODEL_ID: "Xenova/all-MiniLM-L6-v2",
      MODEL_CACHE_DIR: path.join(ROOT, "model-cache"),
      MODEL_ASSETS_DIR: path.join(ROOT, "model-cache"),
      EMBEDDINGS_HTTP_PORT: "13100",
      EMBEDDINGS_HTTP_HOST: "127.0.0.1",
    },
    expectTools: ["embeddings", "prefetch_model", "health"],
    callTool: { name: "health", arguments: {} },
    httpHealth: "http://127.0.0.1:13100/healthz",
    timeoutMs: 45000,
  },
  {
    name: "central-docsearch",
    command: NODE,
    args: ["scripts/mcp-launch.mjs", "docsearch"],
    env: {
      EMBEDDINGS_PROVIDER: "local",
      DOCSEARCH_DATA_DIR: path.join(ROOT, "data", "docsearch-validate"),
      LOCAL_EMBED_MODEL: "Xenova/all-MiniLM-L6-v2",
      LOCAL_MODEL_CACHE_DIR: path.join(ROOT, "model-cache"),
      MCP_TAKEOVER: "1",
    },
    expectTools: ["doc-search", "doc-ingest", "doc-ingest-status"],
    callTool: { name: "doc-ingest-status", arguments: {} },
    timeoutMs: 60000,
    identityDir: path.join(ROOT, "data", "docsearch-validate"),
    lockDir: path.join(ROOT, "data", "docsearch-validate", "index", ".write.lock"),
  },
];

function encodeMessage(obj) {
  return `${JSON.stringify(obj)}\n`;
}

function createFramer() {
  let leftover = "";
  return (chunk) => {
    leftover += chunk.toString("utf8");
    const lines = leftover.split(/\r?\n/);
    leftover = lines.pop() ?? "";
    const messages = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        continue;
      }
      try {
        messages.push(JSON.parse(trimmed));
      } catch {
        // ignore npm/npx banner noise
      }
    }
    return messages;
  };
}

function httpGet(url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: data });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("HTTP timeout"));
    });
    req.on("error", reject);
  });
}

async function waitForHttp(url, attempts = 20) {
  let lastError = "not reached";
  for (let i = 0; i < attempts; i += 1) {
    try {
      const result = await httpGet(url);
      if (result.status >= 200 && result.status < 300) {
        return result;
      }
      lastError = `status ${result.status} ${result.body}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(lastError);
}

function killTree(child) {
  if (!child.pid) {
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
}

function stopChild(child, graceMs = 2000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      killTree(child);
      resolve();
    }, graceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }
    } catch {
      killTree(child);
    }
  });
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

function readPidFile(lockDir) {
  try {
    const raw = fs.readFileSync(path.join(lockDir, "pid"), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

function checkCleanShutdown(name, identityDir, lockDir) {
  if (!identityDir) {
    return { name: `${name}-clean-shutdown`, ok: true, detail: "no identity dir" };
  }
  const leftover = [];
  if (lockDir && fs.existsSync(lockDir)) {
    const pid = readPidFile(lockDir);
    if (pid == null || !isPidAlive(pid)) {
      leftover.push(lockDir);
    }
  }
  const instancePath = path.join(identityDir, "instance.json");
  if (fs.existsSync(instancePath)) {
    let pid;
    try {
      pid = JSON.parse(fs.readFileSync(instancePath, "utf8")).pid;
    } catch {
      pid = undefined;
    }
    if (pid == null || !isPidAlive(pid)) {
      leftover.push(instancePath);
    }
  }
  if (leftover.length === 0) {
    return { name: `${name}-clean-shutdown`, ok: true, detail: "identity cleared" };
  }
  return {
    name: `${name}-clean-shutdown`,
    ok: false,
    detail: leftover.join(", "),
  };
}

function probeServer(spec) {
  const timeoutMs = spec.timeoutMs ?? 25000;
  return new Promise((resolve) => {
    const child = spawn(spec.command ?? NODE, spec.args, {
      cwd: ROOT,
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const stderrChunks = [];
    const parse = createFramer();
    const pending = new Map();
    let nextId = 1;
    let settled = false;
    let tools = [];
    const ready = {
      done: false,
      resolve: () => {},
    };
    const readyPromise = new Promise((resolveReady) => {
      ready.resolve = resolveReady;
    });

    const finish = (ok, detail) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void stopChild(child).then(() => {
        resolve({
          name: spec.name,
          ok,
          detail,
          tools,
          stderr: stderrChunks.join("").slice(-2000),
        });
      });
    };

    const timer = setTimeout(() => {
      finish(false, `timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    child.on("error", (error) => {
      finish(false, `spawn failed: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      if (!settled) {
        finish(false, `exited early code=${code} signal=${signal}`);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk.toString("utf8"));
      if (
        !ready.done &&
        /running on stdio|Starting default \(STDIO\) server/i.test(stderrChunks.join(""))
      ) {
        ready.done = true;
        ready.resolve();
      }
    });
    child.stdout.on("data", (chunk) => {
      for (const message of parse(chunk)) {
        if (message.id != null && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      }
    });

    const rpc = (method, params) =>
      new Promise((resolveRpc, rejectRpc) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, resolveRpc);
        child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
        setTimeout(() => rejectRpc(new Error(`${method} response timeout`)), timeoutMs - 1000);
      });

    (async () => {
      try {
        await Promise.race([
          readyPromise,
          new Promise((_, rejectReady) => {
            setTimeout(
              () => rejectReady(new Error("server did not log ready on stderr")),
              Math.max(timeoutMs - 4000, 5000)
            );
          }),
        ]);
        await new Promise((resolveWait) => setTimeout(resolveWait, 150));
        const init = await rpc("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "mcp-validate", version: "1.0.0" },
        });
        if (init.error) {
          finish(false, `initialize error: ${JSON.stringify(init.error)}`);
          return;
        }
        child.stdin.write(
          encodeMessage({ jsonrpc: "2.0", method: "notifications/initialized" })
        );
        const listed = await rpc("tools/list", {});
        if (listed.error) {
          finish(false, `tools/list error: ${JSON.stringify(listed.error)}`);
          return;
        }
        tools = (listed.result?.tools ?? []).map((tool) => tool.name);
        const missing = (spec.expectTools ?? []).filter((name) => !tools.includes(name));
        if (missing.length > 0) {
          finish(
            false,
            `missing tools ${missing.join(", ")}; got ${tools.join(", ") || "(none)"}`
          );
          return;
        }
        if (spec.callTool) {
          const called = await rpc("tools/call", spec.callTool);
          if (called.error) {
            finish(false, `${spec.callTool.name} error: ${JSON.stringify(called.error)}`);
            return;
          }
          if (called.result?.isError) {
            finish(false, `${spec.callTool.name} returned isError`);
            return;
          }
        }
        if (spec.httpHealth) {
          const health = await waitForHttp(spec.httpHealth);
          if (health.status !== 200) {
            finish(false, `HTTP ${spec.httpHealth} -> ${health.status} ${health.body}`);
            return;
          }
          if (spec.expectHealthPid) {
            let parsed;
            try {
              parsed = JSON.parse(health.body);
            } catch {
              finish(false, `HTTP ${spec.httpHealth} body is not JSON`);
              return;
            }
            if (!Number.isInteger(parsed.pid)) {
              finish(false, `HTTP ${spec.httpHealth} missing pid: ${health.body}`);
              return;
            }
          }
        }
        finish(true, `${tools.length} tools`);
      } catch (error) {
        finish(false, error instanceof Error ? error.message : String(error));
      }
    })();
  });
}

async function runLifecycleChecks() {
  const results = [];
  const dataDir = path.join(ROOT, "data", "fake-qdrant-lifecycle");
  const env = {
    ...process.env,
    FAKE_QDRANT_ENABLED: "1",
    FAKE_QDRANT_HTTP_PORT: "16334",
    FAKE_QDRANT_DATA_DIR: dataDir,
    MCP_TAKEOVER: "1",
  };

  const spawnFq = (extraEnv) =>
    spawn(NODE, ["scripts/mcp-launch.mjs", "fake-qdrant"], {
      cwd: ROOT,
      env: { ...env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

  process.stdout.write("- lifecycle stdin-close ... ");
  const first = spawnFq({});
  let ready = false;
  first.stderr.on("data", (chunk) => {
    if (/running on stdio/i.test(String(chunk))) {
      ready = true;
    }
  });
  const started = Date.now();
  while (!ready && Date.now() - started < 15000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  first.stdin.end();
  const closed = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 4000);
    first.on("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!closed) {
    await stopChild(first);
    results.push({ name: "lifecycle-stdin-close", ok: false, detail: "did not exit within 4s" });
    console.log("FAIL");
  } else {
    results.push({ name: "lifecycle-stdin-close", ok: true, detail: "exited" });
    console.log("OK");
  }

  process.stdout.write("- lifecycle takeover ... ");
  const holder = spawnFq({ MCP_TAKEOVER: "1" });
  ready = false;
  holder.stderr.on("data", (chunk) => {
    if (/running on stdio/i.test(String(chunk))) {
      ready = true;
    }
  });
  const holdStart = Date.now();
  while (!ready && Date.now() - holdStart < 15000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const second = spawnFq({ MCP_TAKEOVER: "1" });
  const secondExit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 8000);
    second.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const health = await waitForHttp("http://127.0.0.1:16334/healthz").catch((error) => ({
    status: 0,
    body: String(error),
  }));
  await stopChild(holder);
  await stopChild(second);
  if (health.status === 200 && secondExit === "timeout") {
    results.push({ name: "lifecycle-takeover", ok: true, detail: "second instance serving" });
    console.log("OK");
  } else {
    results.push({
      name: "lifecycle-takeover",
      ok: false,
      detail: `secondExit=${secondExit} health=${health.status}`,
    });
    console.log("FAIL");
  }

  process.stdout.write("- lifecycle fail-fast ... ");
  const keep = spawnFq({ MCP_TAKEOVER: "1" });
  ready = false;
  keep.stderr.on("data", (chunk) => {
    if (/running on stdio/i.test(String(chunk))) {
      ready = true;
    }
  });
  const keepStart = Date.now();
  while (!ready && Date.now() - keepStart < 15000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const blocked = spawnFq({ MCP_TAKEOVER: "0" });
  const blockedCode = await new Promise((resolve) => {
    const timer = setTimeout(async () => {
      await stopChild(blocked);
      resolve("timeout");
    }, 5000);
    blocked.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  await stopChild(keep);
  if (blockedCode !== 0 && blockedCode !== "timeout") {
    results.push({ name: "lifecycle-fail-fast", ok: true, detail: `exit ${blockedCode}` });
    console.log("OK");
  } else {
    results.push({
      name: "lifecycle-fail-fast",
      ok: false,
      detail: `expected non-zero exit, got ${blockedCode}`,
    });
    console.log("FAIL");
  }
  const lifecycleDir = path.join(ROOT, "data", "fake-qdrant-lifecycle");
  process.stdout.write("- lifecycle-clean-shutdown ... ");
  const cleaned = checkCleanShutdown(
    "lifecycle",
    lifecycleDir,
    path.join(lifecycleDir, ".write.lock")
  );
  results.push(cleaned);
  console.log(cleaned.ok ? `OK (${cleaned.detail})` : `FAIL (${cleaned.detail})`);
  return results;
}

async function main() {
  console.log(`Validating MCP servers from ${ROOT}\n`);
  if (!fs.existsSync(LIFECYCLE_DIST)) {
    console.error(`Missing ${LIFECYCLE_DIST}. Run npm run build -w src/mcp-lifecycle`);
    process.exit(1);
  }
  const results = [];
  for (const spec of SERVERS) {
    process.stdout.write(`- ${spec.name} ... `);
    const result = await probeServer(spec);
    results.push(result);
    if (result.ok) {
      console.log(`OK (${result.detail})`);
    } else {
      console.log(`FAIL (${result.detail})`);
      if (result.stderr.trim()) {
        console.log(result.stderr.trim().split(/\r?\n/).slice(-12).join("\n"));
      }
    }
    if (spec.identityDir) {
      process.stdout.write(`- ${spec.name}-clean-shutdown ... `);
      const cleaned = checkCleanShutdown(spec.name, spec.identityDir, spec.lockDir);
      results.push(cleaned);
      console.log(cleaned.ok ? `OK (${cleaned.detail})` : `FAIL (${cleaned.detail})`);
    }
  }
  results.push(...(await runLifecycleChecks()));

  const failed = results.filter((result) => !result.ok);
  console.log("\nSummary");
  for (const result of results) {
    console.log(
      `  ${result.ok ? "PASS" : "FAIL"}  ${result.name}  ${result.tools?.join(", ") || result.detail}`
    );
  }
  if (failed.length > 0) {
    console.log(`\n${failed.length} of ${results.length} checks failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
