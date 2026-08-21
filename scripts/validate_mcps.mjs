#!/usr/bin/env node
/**
 * Validate that each Roo/Cursor MCP server starts and answers tools/list.
 * Usage: node scripts/validate_mcps.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

const SERVERS = [
  {
    name: "central-memory",
    args: ["tsx", "src/memory/index.ts"],
    env: {},
    expectTools: ["read_graph", "create_entities"],
    callTool: { name: "read_graph", arguments: {} },
  },
  {
    name: "central-filesystem",
    args: ["tsx", "src/filesystem/index.ts", ROOT],
    env: {},
    expectTools: ["list_directory", "read_file"],
    callTool: { name: "list_allowed_directories", arguments: {} },
    timeoutMs: 40000,
  },
  {
    name: "central-sequentialthinking",
    args: ["tsx", "src/sequentialthinking/index.ts"],
    env: {},
    expectTools: ["sequentialthinking"],
  },
  {
    name: "central-everything",
    args: ["tsx", "src/everything/index.ts", "stdio"],
    env: {},
    expectTools: ["echo"],
    callTool: { name: "echo", arguments: { message: "mcp-validate" } },
  },
  {
    name: "central-fake-qdrant",
    args: ["tsx", "src/fake-qdrant/index.ts"],
    env: {
      FAKE_QDRANT_ENABLED: "1",
      FAKE_QDRANT_HTTP_PORT: "16333",
      FAKE_QDRANT_DATA_DIR: path.join(ROOT, "data", "fake-qdrant"),
    },
    expectTools: ["fake_qdrant_list_collections", "fake_qdrant_query_points"],
    callTool: { name: "fake_qdrant_list_collections", arguments: {} },
    httpHealth: "http://127.0.0.1:16333/healthz",
  },
  {
    name: "central-local-embeddings",
    args: ["tsx", "src/local-embeddings/index.ts"],
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
    args: ["tsx", "src/docsearch/index.ts"],
    env: {
      EMBEDDINGS_PROVIDER: "local",
      DOCSEARCH_DATA_DIR: path.join(ROOT, "data", "docsearch"),
      LOCAL_EMBED_MODEL: "Xenova/all-MiniLM-L6-v2",
      LOCAL_MODEL_CACHE_DIR: path.join(ROOT, "model-cache"),
    },
    expectTools: ["doc-search", "doc-ingest", "doc-ingest-status"],
    callTool: { name: "doc-ingest-status", arguments: {} },
    timeoutMs: 60000,
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

function probeServer(spec) {
  const timeoutMs = spec.timeoutMs ?? 25000;
  return new Promise((resolve) => {
    const child = spawn(NPX, spec.args, {
      cwd: ROOT,
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32",
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
      killTree(child);
      setTimeout(() => killTree(child), 500);
      resolve({
        name: spec.name,
        ok,
        detail,
        tools,
        stderr: stderrChunks.join("").slice(-2000),
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
        }
        finish(true, `${tools.length} tools`);
      } catch (error) {
        finish(false, error instanceof Error ? error.message : String(error));
      }
    })();
  });
}

async function main() {
  console.log(`Validating MCP servers from ${ROOT}\n`);
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
  }

  const failed = results.filter((result) => !result.ok);
  console.log("\nSummary");
  for (const result of results) {
    console.log(
      `  ${result.ok ? "PASS" : "FAIL"}  ${result.name}  ${result.tools.join(", ") || result.detail}`
    );
  }
  if (failed.length > 0) {
    console.log(`\n${failed.length} of ${results.length} servers failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} MCP servers started and listed tools.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
