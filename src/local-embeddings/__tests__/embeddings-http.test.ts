import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";

import { startEmbeddingsHttpServer, type EmbeddingsHttpServerHandle } from "../embeddings-http.js";

describe("local-embeddings HTTP sidecar", () => {
  let server: EmbeddingsHttpServerHandle | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  async function start() {
    server = await startEmbeddingsHttpServer({
      host: "127.0.0.1",
      port: 0,
      logger: () => {},
    });
    return server;
  }

  function request(
    handle: EmbeddingsHttpServerHandle,
    method: string,
    urlPath: string
  ): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          method,
          hostname: handle.host,
          port: handle.port,
          path: urlPath,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk.toString();
          });
          res.on("end", () => {
            try {
              resolve({
                status: res.statusCode || 500,
                data: data ? JSON.parse(data) : {},
              });
            } catch (error) {
              reject(error);
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("returns ok on GET /health", async () => {
    const handle = await start();
    const res = await request(handle, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ status: "ok" });
  });

  it("returns ok on GET /healthz", async () => {
    const handle = await start();
    const res = await request(handle, "GET", "/healthz");
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ status: "ok", sidecar: "local-embeddings-mcp" });
  });

  it("collapses duplicate slashes on /healthz", async () => {
    const handle = await start();
    const res = await request(handle, "GET", "//healthz");
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ status: "ok" });
  });

  it("returns ok on trailing slash and HEAD", async () => {
    const handle = await start();
    const slash = await request(handle, "GET", "/healthz/");
    expect(slash.status).toBe(200);
    expect(slash.data).toMatchObject({ status: "ok" });
    const head = await request(handle, "HEAD", "/healthz");
    expect(head.status).toBe(200);
  });

  it("lists the local model on GET /v1/models", async () => {
    const handle = await start();
    const res = await request(handle, "GET", "/v1/models");
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ object: "list" });
    const payload = res.data as { data: Array<{ id: string }> };
    expect(payload.data[0]?.id).toBeTruthy();
  });
});
