/**
 * Non-Regression Test (NRT) for the Fake Qdrant HTTP API.
 *
 * Exercises every endpoint in a single sequential flow:
 *   1. GET  /healthz
 *   2. GET  /collections                        (empty)
 *   3. PUT  /collections/{name}                  (create)
 *   4. GET  /collections/{name}                  (get)
 *   5. GET  /collections                         (list 1)
 *   6. PUT  /collections/{name}/points           (upsert)
 *   7. POST /collections/{name}/points/query     (query)
 *   8. POST /collections/{name}/points/query     (query with threshold)
 *   9. POST /collections/{name}/points/delete    (delete by ID)
 *  10. POST /collections/{name}/points/delete    (delete by filter)
 *  11. POST /collections/{name}/compact          (compact)
 *  12. DELETE /collections/{name}                (delete collection)
 *  13. GET  /collections/{name}                  (verify 404)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import fs from "fs/promises";
import path from "path";
import { Store, resolveDataDir } from "../store.js";
import { startQdrantHttpServer, type QdrantHttpServerHandle } from "../qdrant-http.js";

const COLLECTION = "nrt-vectors";
const DIM = 4;

describe("Fake Qdrant NRT (Non-Regression Test)", () => {
  let server: QdrantHttpServerHandle;
  let store: Store;
  let testDataDir: string;
  let baseUrl: string;

  beforeAll(async () => {
    testDataDir = path.join(
      resolveDataDir(),
      `nrt-${Date.now()}-${Math.random().toString(36).substring(7)}`
    );
    await fs.mkdir(testDataDir, { recursive: true });
    store = await Store.create({ dataDir: testDataDir });
    server = await startQdrantHttpServer({
      store,
      host: "127.0.0.1",
      port: 0,
      logger: () => {},
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    store.close();
    await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  function request(
    method: string,
    urlPath: string,
    body?: unknown
  ): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, baseUrl);
      const req = http.request(
        {
          method,
          hostname: url.hostname,
          port: server.port,
          path: url.pathname + url.search,
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          let raw = "";
          res.on("data", (chunk) => (raw += chunk));
          res.on("end", () => {
            try {
              resolve({
                status: res.statusCode ?? 500,
                data: raw ? JSON.parse(raw) : {},
              });
            } catch {
              resolve({ status: res.statusCode ?? 500, data: raw });
            }
          });
        }
      );
      req.on("error", reject);
      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  // --- 1. Health check ---
  it("Step 1: GET /healthz returns ok", async () => {
    const res = await request("GET", "/healthz");
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ status: "ok" });
  });

  // --- 2. List empty collections ---
  it("Step 2: GET /collections returns empty list", async () => {
    const res = await request("GET", "/collections");
    expect(res.status).toBe(200);
    expect(res.data.result.collections).toEqual([]);
  });

  // --- 3. Create collection ---
  it("Step 3: PUT /collections/{name} creates a collection", async () => {
    const res = await request("PUT", `/collections/${COLLECTION}`, {
      vectors: { size: DIM, distance: "Cosine" },
    });
    expect(res.status).toBe(200);
    expect(res.data.result).toBe(true);
  });

  // --- 4. Get collection ---
  it("Step 4: GET /collections/{name} returns collection info", async () => {
    const res = await request("GET", `/collections/${COLLECTION}`);
    expect(res.status).toBe(200);
    expect(res.data.result).toMatchObject({
      name: COLLECTION,
      vectors: { size: DIM, distance: "Cosine" },
      status: "green",
    });
  });

  // --- 5. List collections with 1 result ---
  it("Step 5: GET /collections lists 1 collection", async () => {
    const res = await request("GET", "/collections");
    expect(res.status).toBe(200);
    expect(res.data.result.collections).toHaveLength(1);
    expect(res.data.result.collections[0].name).toBe(COLLECTION);
  });

  // --- 6. Upsert points ---
  it("Step 6: PUT /collections/{name}/points upserts 5 points", async () => {
    const points = [
      { id: 1, vector: [1, 0, 0, 0], payload: { tag: "x" } },
      { id: 2, vector: [0, 1, 0, 0], payload: { tag: "y" } },
      { id: 3, vector: [0, 0, 1, 0], payload: { tag: "z" } },
      { id: 4, vector: [0, 0, 0, 1], payload: { tag: "w" } },
      { id: "s5", vector: [0.5, 0.5, 0, 0], payload: { tag: "xy", path: "/tmp/a.txt" } },
    ];
    const res = await request("PUT", `/collections/${COLLECTION}/points`, {
      points,
    });
    expect(res.status).toBe(200);
    expect(res.data.result.status).toBe("completed");
  });

  // --- 7. Query points ---
  it("Step 7: POST /collections/{name}/points/query returns scored results", async () => {
    const res = await request(
      "POST",
      `/collections/${COLLECTION}/points/query`,
      { vector: [1, 0, 0, 0], limit: 3 }
    );
    expect(res.status).toBe(200);
    expect(res.data.result.length).toBeGreaterThanOrEqual(1);
    expect(res.data.result[0].id).toBe(1);
    expect(res.data.result[0].score).toBeGreaterThan(0.9);
    expect(res.data.result[0].payload).toEqual({ tag: "x" });
  });

  // --- 8. Query with score threshold ---
  it("Step 8: query with score_threshold filters low scores", async () => {
    const res = await request(
      "POST",
      `/collections/${COLLECTION}/points/query`,
      { vector: [1, 0, 0, 0], limit: 10, score_threshold: 0.99 }
    );
    expect(res.status).toBe(200);
    for (const r of res.data.result) {
      expect(r.score).toBeGreaterThanOrEqual(0.99);
    }
  });

  // --- 9. Delete point by ID ---
  it("Step 9: POST /collections/{name}/points/delete removes by ID", async () => {
    const res = await request(
      "POST",
      `/collections/${COLLECTION}/points/delete`,
      { points: [4] }
    );
    expect(res.status).toBe(200);
    expect(res.data.result.status).toBe("completed");

    const query = await request(
      "POST",
      `/collections/${COLLECTION}/points/query`,
      { vector: [0, 0, 0, 1], limit: 10 }
    );
    const ids = query.data.result.map((r: any) => r.id);
    expect(ids).not.toContain(4);
  });

  // --- 10. Delete point by filter ---
  it("Step 10: POST /collections/{name}/points/delete removes by filter", async () => {
    const res = await request(
      "POST",
      `/collections/${COLLECTION}/points/delete`,
      {
        filter: {
          must: [{ key: "path", match: { value: "/tmp/a.txt" } }],
        },
      }
    );
    expect(res.status).toBe(200);
    expect(res.data.result.status).toBe("completed");

    const query = await request(
      "POST",
      `/collections/${COLLECTION}/points/query`,
      { vector: [0.5, 0.5, 0, 0], limit: 10 }
    );
    const ids = query.data.result.map((r: any) => r.id);
    expect(ids).not.toContain("s5");
  });

  // --- 11. Compact collection ---
  it("Step 11: POST /collections/{name}/compact returns point count", async () => {
    const res = await request(
      "POST",
      `/collections/${COLLECTION}/compact`
    );
    expect(res.status).toBe(200);
    expect(res.data.result.unique_points).toBe(3);
  });

  // --- 12. Delete collection ---
  it("Step 12: DELETE /collections/{name} removes the collection", async () => {
    const res = await request("DELETE", `/collections/${COLLECTION}`);
    expect(res.status).toBe(200);
    expect(res.data.result).toBe(true);
  });

  // --- 13. Verify deletion ---
  it("Step 13: GET /collections/{name} returns 404 after deletion", async () => {
    const res = await request("GET", `/collections/${COLLECTION}`);
    expect(res.status).toBe(404);
  });
});
