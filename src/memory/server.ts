import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  parseLogLevel,
  parseRetentionDays,
  type Logger,
  type LogLevel,
} from "./logger.js";
import type { DiskGate } from "./disk-gate.js";
import {
  KnowledgeGraphManager,
  type Entity,
  type Relation,
  type KnowledgeGraph,
  type KnowledgeGraphManagerOptions,
} from "./knowledge-graph.js";

export {
  KnowledgeGraphManager,
  type Entity,
  type Relation,
  type KnowledgeGraph,
  type KnowledgeGraphManagerOptions,
};

export const defaultMemoryPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "memory.jsonl"
);

export function resolveMemoryFilePathFromEnv(
  env: Record<string, string | undefined> = process.env
): string {
  if (env.MEMORY_FILE_PATH) {
    return path.isAbsolute(env.MEMORY_FILE_PATH)
      ? env.MEMORY_FILE_PATH
      : path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          env.MEMORY_FILE_PATH
        );
  }
  return defaultMemoryPath;
}

export interface MemoryLogConfig {
  logDir: string;
  level: LogLevel;
  retentionDays: number;
}

export function resolveMemoryLogConfig(
  memoryFilePath: string,
  env: Record<string, string | undefined> = process.env
): MemoryLogConfig {
  const logDir = env.MEMORY_LOG_DIR
    ? path.resolve(env.MEMORY_LOG_DIR)
    : path.join(path.dirname(path.resolve(memoryFilePath)), "logs");
  return {
    logDir,
    level: parseLogLevel(env.MEMORY_LOG_LEVEL),
    retentionDays: parseRetentionDays(env.MEMORY_LOG_RETENTION_DAYS),
  };
}

export async function ensureMemoryFilePath(
  logger?: Logger
): Promise<string> {
  if (process.env.MEMORY_FILE_PATH) {
    return resolveMemoryFilePathFromEnv();
  }

  const oldMemoryPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "memory.json"
  );
  const newMemoryPath = defaultMemoryPath;

  try {
    await fs.access(oldMemoryPath);
    try {
      await fs.access(newMemoryPath);
      return newMemoryPath;
    } catch {
      const detected =
        "DETECTED: Found legacy memory.json file, migrating to memory.jsonl for JSONL format compatibility";
      const completed =
        "COMPLETED: Successfully migrated memory.json to memory.jsonl";
      if (logger) {
        logger.info("memory.migrate", { from: oldMemoryPath, to: newMemoryPath, message: detected });
      } else {
        console.error(detected);
      }
      await fs.rename(oldMemoryPath, newMemoryPath);
      if (logger) {
        logger.info("memory.migrate", { from: oldMemoryPath, to: newMemoryPath, message: completed });
      } else {
        console.error(completed);
      }
      return newMemoryPath;
    }
  } catch {
    return newMemoryPath;
  }
}

const EntitySchema = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  observations: z
    .array(z.string())
    .describe("An array of observation contents associated with the entity"),
});

const RelationSchema = z.object({
  from: z.string().describe("The name of the entity where the relation starts"),
  to: z.string().describe("The name of the entity where the relation ends"),
  relationType: z.string().describe("The type of the relation"),
});

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
  manager: KnowledgeGraphManager,
  logger?: Logger
) {
  server.registerTool(
    "create_entities",
    {
      title: "Create Entities",
      description: "Create multiple new entities in the knowledge graph",
      inputSchema: {
        entities: z.array(EntitySchema),
      },
      outputSchema: {
        entities: z.array(EntitySchema),
      },
    },
    async ({ entities }) =>
      runLoggedTool(
        logger,
        "create_entities",
        async () => {
          const result = await manager.createEntities(entities);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result, null, 2) },
            ],
            structuredContent: { entities: result },
          };
        },
        (result) => ({
          requested: entities.length,
          created: result.structuredContent.entities.length,
          skipped: entities.length - result.structuredContent.entities.length,
          names: result.structuredContent.entities.map((entity) => entity.name),
        })
      )
  );

  server.registerTool(
    "create_relations",
    {
      title: "Create Relations",
      description:
        "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
      inputSchema: {
        relations: z.array(RelationSchema),
      },
      outputSchema: {
        relations: z.array(RelationSchema),
      },
    },
    async ({ relations }) =>
      runLoggedTool(
        logger,
        "create_relations",
        async () => {
          const result = await manager.createRelations(relations);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result, null, 2) },
            ],
            structuredContent: { relations: result },
          };
        },
        (result) => ({
          requested: relations.length,
          created: result.structuredContent.relations.length,
          skipped: relations.length - result.structuredContent.relations.length,
          relations: result.structuredContent.relations.map((relation) => ({
            from: relation.from,
            to: relation.to,
            relationType: relation.relationType,
          })),
        })
      )
  );

  server.registerTool(
    "add_observations",
    {
      title: "Add Observations",
      description: "Add new observations to existing entities in the knowledge graph",
      inputSchema: {
        observations: z.array(
          z.object({
            entityName: z.string().describe(
              "The name of the entity to add the observations to"
            ),
            contents: z
              .array(z.string())
              .describe("An array of observation contents to add"),
          })
        ),
      },
      outputSchema: {
        results: z.array(
          z.object({
            entityName: z.string(),
            addedObservations: z.array(z.string()),
          })
        ),
      },
    },
    async ({ observations }) =>
      runLoggedTool(
        logger,
        "add_observations",
        async () => {
          const result = await manager.addObservations(observations);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result, null, 2) },
            ],
            structuredContent: { results: result },
          };
        },
        (result) => ({
          entityNames: result.structuredContent.results.map((row) => row.entityName),
          added: result.structuredContent.results.reduce(
            (sum, row) => sum + row.addedObservations.length,
            0
          ),
          requested: observations.reduce((sum, row) => sum + row.contents.length, 0),
        })
      )
  );

  server.registerTool(
    "delete_entities",
    {
      title: "Delete Entities",
      description:
        "Delete multiple entities and their associated relations from the knowledge graph",
      inputSchema: {
        entityNames: z
          .array(z.string())
          .describe("An array of entity names to delete"),
      },
      outputSchema: {
        success: z.boolean(),
        message: z.string(),
      },
    },
    async ({ entityNames }) =>
      runLoggedTool(
        logger,
        "delete_entities",
        async () => {
          await manager.deleteEntities(entityNames);
          return {
            content: [
              { type: "text" as const, text: "Entities deleted successfully" },
            ],
            structuredContent: {
              success: true,
              message: "Entities deleted successfully",
            },
          };
        },
        () => ({ entityNames })
      )
  );

  server.registerTool(
    "delete_observations",
    {
      title: "Delete Observations",
      description:
        "Delete specific observations from entities in the knowledge graph",
      inputSchema: {
        deletions: z.array(
          z.object({
            entityName: z
              .string()
              .describe("The name of the entity containing the observations"),
            observations: z
              .array(z.string())
              .describe("An array of observations to delete"),
          })
        ),
      },
      outputSchema: {
        success: z.boolean(),
        message: z.string(),
      },
    },
    async ({ deletions }) =>
      runLoggedTool(
        logger,
        "delete_observations",
        async () => {
          await manager.deleteObservations(deletions);
          return {
            content: [
              { type: "text" as const, text: "Observations deleted successfully" },
            ],
            structuredContent: {
              success: true,
              message: "Observations deleted successfully",
            },
          };
        },
        () => ({
          entityNames: deletions.map((row) => row.entityName),
          counts: deletions.map((row) => ({
            entityName: row.entityName,
            requested: row.observations.length,
          })),
        })
      )
  );

  server.registerTool(
    "delete_relations",
    {
      title: "Delete Relations",
      description: "Delete multiple relations from the knowledge graph",
      inputSchema: {
        relations: z
          .array(RelationSchema)
          .describe("An array of relations to delete"),
      },
      outputSchema: {
        success: z.boolean(),
        message: z.string(),
      },
    },
    async ({ relations }) =>
      runLoggedTool(
        logger,
        "delete_relations",
        async () => {
          await manager.deleteRelations(relations);
          return {
            content: [
              { type: "text" as const, text: "Relations deleted successfully" },
            ],
            structuredContent: {
              success: true,
              message: "Relations deleted successfully",
            },
          };
        },
        () => ({
          relations: relations.map((relation) => ({
            from: relation.from,
            to: relation.to,
            relationType: relation.relationType,
          })),
        })
      )
  );

  server.registerTool(
    "read_graph",
    {
      title: "Read Graph",
      description: "Read the entire knowledge graph",
      inputSchema: {},
      outputSchema: {
        entities: z.array(EntitySchema),
        relations: z.array(RelationSchema),
      },
    },
    async () =>
      runLoggedTool(
        logger,
        "read_graph",
        async () => {
          const graph = await manager.readGraph();
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(graph, null, 2) },
            ],
            structuredContent: { ...graph },
          };
        },
        (result) => ({
          entityCount: result.structuredContent.entities.length,
          relationCount: result.structuredContent.relations.length,
        })
      )
  );

  server.registerTool(
    "search_nodes",
    {
      title: "Search Nodes",
      description:
        "Search for nodes in the knowledge graph based on a query",
      inputSchema: {
        query: z
          .string()
          .describe(
            "The search query to match against entity names, types, and observation content"
          ),
      },
      outputSchema: {
        entities: z.array(EntitySchema),
        relations: z.array(RelationSchema),
      },
    },
    async ({ query }) =>
      runLoggedTool(
        logger,
        "search_nodes",
        async () => {
          const graph = await manager.searchNodes(query);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(graph, null, 2) },
            ],
            structuredContent: { ...graph },
          };
        },
        (result) => ({
          query,
          entityCount: result.structuredContent.entities.length,
          relationCount: result.structuredContent.relations.length,
        })
      )
  );

  server.registerTool(
    "open_nodes",
    {
      title: "Open Nodes",
      description:
        "Open specific nodes in the knowledge graph by their names",
      inputSchema: {
        names: z
          .array(z.string())
          .describe("An array of entity names to retrieve"),
      },
      outputSchema: {
        entities: z.array(EntitySchema),
        relations: z.array(RelationSchema),
      },
    },
    async ({ names }) =>
      runLoggedTool(
        logger,
        "open_nodes",
        async () => {
          const graph = await manager.openNodes(names);
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(graph, null, 2) },
            ],
            structuredContent: { ...graph },
          };
        },
        (result) => ({
          requested: names,
          found: result.structuredContent.entities.map((entity) => entity.name),
          entityCount: result.structuredContent.entities.length,
          relationCount: result.structuredContent.relations.length,
        })
      )
  );
}

export type MemoryServerFactoryOptions = {
  logger?: Logger;
  diskGate?: DiskGate;
  acquireLock?: boolean;
};

export type MemoryServerFactoryResponse = {
  server: McpServer;
  cleanup: (sessionId?: string) => void | Promise<void>;
};

export async function createServer(
  options: MemoryServerFactoryOptions = {}
): Promise<MemoryServerFactoryResponse> {
  const memoryFilePath = await ensureMemoryFilePath(options.logger);
  const knowledgeGraphManager = await KnowledgeGraphManager.create(
    memoryFilePath,
    {
      logger: options.logger,
      diskGate: options.diskGate,
      acquireLock: options.acquireLock,
    }
  );
  const server = new McpServer({
    name: "memory-server",
    version: "0.6.3",
  });

  registerTools(server, knowledgeGraphManager, options.logger);

  return {
    server,
    cleanup: () => knowledgeGraphManager.close(),
  };
}

