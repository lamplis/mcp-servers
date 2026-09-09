import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "../server.js";
import { resolveDataDir } from "../store.js";

describe("fake-qdrant MCP factory", () => {
  let testDataDir: string;
  let cleanup: (() => void) | undefined;
  let storeClose: (() => Promise<void>) | undefined;

  afterEach(async () => {
    cleanup?.();
    if (storeClose) {
      await storeClose();
    }
    if (testDataDir) {
      await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("delete_points and collection_stats use the upgraded store", async () => {
    testDataDir = path.join(
      resolveDataDir(),
      `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(testDataDir, { recursive: true });
    const created = await createServer({ dataDir: testDataDir });
    cleanup = created.cleanup;
    storeClose = () => created.store.close();
    await created.store.createCollection("mcp", { size: 2 });
    await created.store.upsertPoints("mcp", [
      { id: 1, vector: [1, 0], payload: { path: "/a" } },
      { id: 2, vector: [0, 1], payload: { path: "/b" } },
    ]);
    const deleted = await created.store.deletePoints("mcp", [1]);
    expect(deleted).toBe(1);
    const stats = await created.store.getCollectionStats("mcp");
    expect(stats[0]?.pointsCount).toBe(1);
    expect(stats[0]?.jsonlLines).toBeGreaterThanOrEqual(1);
  });
});
