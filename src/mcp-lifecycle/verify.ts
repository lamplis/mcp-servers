import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { isPidAlive } from "./disk-gate.js";
import { readInstanceFile } from "./identity.js";

const execFileAsync = promisify(execFile);

export interface VerifyDeps {
  isAlive?: (pid: number) => boolean;
  listImage?: (pid: number) => Promise<string | undefined>;
  fetchHealth?: (port: number) => Promise<Record<string, unknown> | null>;
}

export function isNodeImage(name: string | undefined): boolean {
  if (!name) {
    return false;
  }
  const lower = name.toLowerCase();
  return lower === "node.exe" || lower === "node" || lower.endsWith("\\node.exe");
}

export async function listProcessImage(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { windowsHide: true, timeout: 5000 }
      );
      const line = stdout.trim().split(/\r?\n/)[0] ?? "";
      const match = line.match(/^"([^"]+)"/);
      return match?.[1];
    }
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="], {
      timeout: 5000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function fetchHealthz(
  host: string,
  port: number,
  timeoutMs = 750
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = http.get({ hostname: host, port, path: "/healthz", timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
        if (data.length > 65536) {
          req.destroy();
        }
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data) as Record<string, unknown>);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

export async function isOurProcess(options: {
  pid: number;
  role: string;
  dataDir: string;
  port?: number;
  sidecar?: string;
  isAlive?: (pid: number) => boolean;
  listImage?: (pid: number) => Promise<string | undefined>;
  fetchHealth?: (port: number) => Promise<Record<string, unknown> | null>;
}): Promise<boolean> {
  const alive = options.isAlive ?? isPidAlive;
  if (!alive(options.pid)) {
    return false;
  }
  const instance = await readInstanceFile(options.dataDir);
  if (!instance || instance.pid !== options.pid || instance.role !== options.role) {
    return false;
  }
  const image = await (options.listImage ?? listProcessImage)(options.pid);
  if (!isNodeImage(image)) {
    return false;
  }
  if (options.port != null) {
    const health = await (options.fetchHealth ??
      ((port) => fetchHealthz("127.0.0.1", port)))(options.port);
    if (!health) {
      return false;
    }
    if (options.sidecar && health.sidecar !== options.sidecar) {
      return false;
    }
    if (health.pid != null && Number(health.pid) !== options.pid) {
      return false;
    }
  }
  return true;
}
