import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Store, type PointRecord } from "./store.js";
import type { EmbeddingProvider } from "./provider.js";
import type { Logger } from "./logger.js";

export type FakeQdrantServerFactoryOptions = {
  store?: Store;
  dataDir?: string;
  embeddingProvider?: EmbeddingProvider | null;
  logger?: Logger;
};

export type FakeQdrantServerFactoryResponse = {
  server: McpServer;
  cleanup: (sessionId?: string) => void;
  store: Store;
  embeddingProvider: EmbeddingProvider | null;
};

export async function createServer(
  options: FakeQdrantServerFactoryOptions = {}
): Promise<FakeQdrantServerFactoryResponse> {
  const store =
    options.store ??
    (await Store.create({ dataDir: options.dataDir, logger: options.logger }));

  const embeddingProvider = options.embeddingProvider ?? null;
  const logger = options.logger;

  const server = new McpServer({
    name: "fake-qdrant-server",
    version: "0.1.0",
  });

  registerTools(server, store, embeddingProvider, logger);

  return {
    server,
    store,
    embeddingProvider,
    cleanup: () => {
      // No background tasks to stop for now.
    },
  };
}

async function runLoggedTool<T>(
  logger: Logger | undefined,
  tool: string,
  fn: () => Promise<T>,
  summarize?: (result: T) => Record<string, unknown>
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    logger?.info("mcp.tool", {
      tool,
      ok: true,
      ms: Date.now() - start,
      ...(summarize ? summarize(result) : {}),
    });
    return result;
  } catch (error) {
    logger?.error("mcp.tool", {
      tool,
      ok: false,
      ms: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function registerTools(
  server: McpServer,
  store: Store,
  _embeddingProvider: EmbeddingProvider | null,
  logger?: Logger
) {
  const PointSchema = z.object({
    id: z.union([z.string(), z.number()]),
    vector: z.array(z.number()),
    payload: z.any().optional(),
  });

  server.registerTool(
    "fake_qdrant_list_collections",
    {
      title: "List Fake Qdrant Collections",
      description: "Returns all locally stored fake Qdrant collections.",
      inputSchema: {},
      outputSchema: {
        collections: z.array(
          z.object({
            name: z.string(),
            size: z.number(),
            distance: z.string(),
          })
        ),
      },
    },
    async () =>
      runLoggedTool(
        logger,
        "fake_qdrant_list_collections",
        async () => {
          const collections = await store.listCollections();
          const payload = collections.map((collection) => ({
            name: collection.name,
            size: collection.vectors.size,
            distance: collection.vectors.distance,
          }));
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(payload, null, 2),
              },
            ],
            structuredContent: { collections: payload },
          };
        },
        (result) => ({
          count: Array.isArray(result.structuredContent?.collections)
            ? result.structuredContent.collections.length
            : 0,
        })
      )
  );

  server.registerTool(
    "fake_qdrant_get_collection",
    {
      title: "Get Fake Qdrant Collection",
      description: "Fetch a specific collection definition.",
      inputSchema: {
        name: z.string().describe("Collection name to load."),
      },
      outputSchema: {
        collection: z
          .object({
            name: z.string(),
            size: z.number(),
            distance: z.string(),
          })
          .nullable(),
      },
    },
    async ({ name }) =>
      runLoggedTool(
        logger,
        "fake_qdrant_get_collection",
        async () => {
          const collection = await store.getCollection(name);
          const result = collection
            ? {
                name: collection.name,
                size: collection.vectors.size,
                distance: collection.vectors.distance,
              }
            : null;
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
            structuredContent: { collection: result },
          };
        },
        (result) => ({
          name,
          found: result.structuredContent?.collection != null,
        })
      )
  );

  server.registerTool(
    "fake_qdrant_create_collection",
    {
      title: "Create Fake Qdrant Collection",
      description:
        "Create (or overwrite) a fake Qdrant collection with a given vector size and distance metric.",
      inputSchema: {
        name: z.string().describe("Collection name."),
        size: z
          .number()
          .int()
          .positive()
          .describe("Vector dimension for this collection."),
        distance: z
          .string()
          .optional()
          .describe("Distance metric (currently only 'Cosine' is supported)."),
      },
      outputSchema: {
        collection: z.object({
          name: z.string(),
          size: z.number(),
          distance: z.string(),
        }),
      },
    },
    async ({ name, size, distance }) =>
      runLoggedTool(
        logger,
        "fake_qdrant_create_collection",
        async () => {
          const collection = await store.createCollection(name, {
            size,
            distance,
          });
          const result = {
            name: collection.name,
            size: collection.vectors.size,
            distance: collection.vectors.distance,
          };
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
            structuredContent: { collection: result },
          };
        },
        () => ({ name, size, distance: distance ?? "Cosine" })
      )
  );

  server.registerTool(
    "fake_qdrant_delete_collection",
    {
      title: "Delete Fake Qdrant Collection",
      description: "Remove a fake Qdrant collection and its stored vectors.",
      inputSchema: {
        name: z.string().describe("Collection name to delete."),
      },
      outputSchema: {
        success: z.boolean(),
      },
    },
    async ({ name }) =>
      runLoggedTool(
        logger,
        "fake_qdrant_delete_collection",
        async () => {
          await store.deleteCollection(name);
          return {
            content: [
              { type: "text" as const, text: `Deleted collection ${name}` },
            ],
            structuredContent: { success: true },
          };
        },
        () => ({ name })
      )
  );

  server.registerTool(
    "fake_qdrant_upsert_points",
    {
      title: "Upsert points into fake Qdrant",
      description:
        "Insert or update vector points in a collection. The latest upsert per id wins.",
      inputSchema: {
        collection: z.string().describe("Collection name."),
        points: z
          .array(PointSchema)
          .min(1, "Provide at least one point to upsert."),
      },
      outputSchema: {
        upserted: z.number(),
      },
    },
    async ({ collection, points }) =>
      runLoggedTool(
        logger,
        "fake_qdrant_upsert_points",
        async () => {
          await store.upsertPoints(collection, points as PointRecord[]);
          return {
            content: [
              {
                type: "text" as const,
                text: `Upserted ${points.length} point(s) into ${collection}`,
              },
            ],
            structuredContent: { upserted: points.length },
          };
        },
        () => ({
          collection,
          upserted: points.length,
          ids: points.map((point) => point.id),
          vectorLength: points[0]?.vector?.length,
        })
      )
  );

  server.registerTool(
    "fake_qdrant_query_points",
    {
      title: "Query fake Qdrant collection",
      description:
        "Run a vector similarity search against a collection (brute-force cosine).",
      inputSchema: {
        collection: z.string().describe("Collection name."),
        vector: z.array(z.number()).describe("Query vector."),
        limit: z.number().int().positive().optional().describe("Top K results."),
        scoreThreshold: z
          .number()
          .optional()
          .describe("Only return results with cosine >= threshold."),
      },
      outputSchema: {
        results: z.array(
          z.object({
            id: z.union([z.string(), z.number()]),
            score: z.number(),
            payload: z.any().nullable(),
          })
        ),
      },
    },
    async ({ collection, vector, limit, scoreThreshold }) =>
      runLoggedTool(
        logger,
        "fake_qdrant_query_points",
        async () => {
          const results = await store.query(collection, vector, {
            limit: limit ?? 20,
            scoreThreshold: scoreThreshold ?? 0,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(results, null, 2),
              },
            ],
            structuredContent: { results },
          };
        },
        (result) => ({
          collection,
          vectorLength: vector.length,
          limit: limit ?? 20,
          scoreThreshold: scoreThreshold ?? 0,
          hits: Array.isArray(result.structuredContent?.results)
            ? result.structuredContent.results.length
            : 0,
        })
      )
  );

  server.registerTool(
    "fake_qdrant_compact_collection",
    {
      title: "Compact fake Qdrant collection",
      description:
        "Rewrite the collection JSONL snapshot (latest id wins). Use this periodically to free disk space and speed up startup.",
      inputSchema: {
        name: z.string().describe("Collection name to compact."),
      },
      outputSchema: {
        uniquePoints: z.number(),
      },
    },
    async ({ name }) =>
      runLoggedTool(
        logger,
        "fake_qdrant_compact_collection",
        async () => {
          const count = await store.compactCollection(name);
          return {
            content: [
              {
                type: "text" as const,
                text: `Compacted ${name}: ${count} unique point(s)`,
              },
            ],
            structuredContent: { uniquePoints: count },
          };
        },
        (result) => ({ name, uniquePoints: result.structuredContent?.uniquePoints })
      )
  );

  server.registerTool(
    "fake_qdrant_persist_indexes",
    {
      title: "Persist collection files",
      description:
        "Flush dirty in-memory collections to compact JSONL files. Useful before shutdown.",
      inputSchema: {},
      outputSchema: {
        success: z.boolean(),
      },
    },
    async () =>
      runLoggedTool(logger, "fake_qdrant_persist_indexes", async () => {
        await store.persistAllIndexes();
        return {
          content: [
            { type: "text" as const, text: "Persisted all collection files" },
          ],
          structuredContent: { success: true },
        };
      })
  );
}

