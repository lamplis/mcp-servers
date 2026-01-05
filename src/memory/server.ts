import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const defaultMemoryPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "memory.jsonl"
);

export async function ensureMemoryFilePath(): Promise<string> {
  if (process.env.MEMORY_FILE_PATH) {
    return path.isAbsolute(process.env.MEMORY_FILE_PATH)
      ? process.env.MEMORY_FILE_PATH
      : path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          process.env.MEMORY_FILE_PATH
        );
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
      console.error(
        "DETECTED: Found legacy memory.json file, migrating to memory.jsonl for JSONL format compatibility"
      );
      await fs.rename(oldMemoryPath, newMemoryPath);
      console.error(
        "COMPLETED: Successfully migrated memory.json to memory.jsonl"
      );
      return newMemoryPath;
    }
  } catch {
    return newMemoryPath;
  }
}

export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

export class KnowledgeGraphManager {
  constructor(private memoryFilePath: string) {}

  private async loadGraph(): Promise<KnowledgeGraph> {
    try {
      const data = await fs.readFile(this.memoryFilePath, "utf-8");
      const lines = data.split("\n").filter((line) => line.trim() !== "");
      return lines.reduce(
        (graph: KnowledgeGraph, line) => {
          const item = JSON.parse(line);
          if (item.type === "entity") graph.entities.push(item as Entity);
          if (item.type === "relation") graph.relations.push(item as Relation);
          return graph;
        },
        { entities: [], relations: [] }
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as any).code === "ENOENT"
      ) {
        return { entities: [], relations: [] };
      }
      throw error;
    }
  }

  private async saveGraph(graph: KnowledgeGraph): Promise<void> {
    const lines = [
      ...graph.entities.map((e) =>
        JSON.stringify({
          type: "entity",
          name: e.name,
          entityType: e.entityType,
          observations: e.observations,
        })
      ),
      ...graph.relations.map((r) =>
        JSON.stringify({
          type: "relation",
          from: r.from,
          to: r.to,
          relationType: r.relationType,
        })
      ),
    ];
    await fs.writeFile(this.memoryFilePath, lines.join("\n"));
  }

  async createEntities(entities: Entity[]): Promise<Entity[]> {
    const graph = await this.loadGraph();
    const newEntities = entities.filter(
      (entity) =>
        !graph.entities.some(
          (existingEntity) => existingEntity.name === entity.name
        )
    );
    graph.entities.push(...newEntities);
    await this.saveGraph(graph);
    return newEntities;
  }

  async createRelations(relations: Relation[]): Promise<Relation[]> {
    const graph = await this.loadGraph();
    const newRelations = relations.filter(
      (relation) =>
        !graph.relations.some(
          (existingRelation) =>
            existingRelation.from === relation.from &&
            existingRelation.to === relation.to &&
            existingRelation.relationType === relation.relationType
        )
    );
    graph.relations.push(...newRelations);
    await this.saveGraph(graph);
    return newRelations;
  }

  async addObservations(
    observations: { entityName: string; contents: string[] }[]
  ): Promise<{ entityName: string; addedObservations: string[] }[]> {
    const graph = await this.loadGraph();
    const results = observations.map((observation) => {
      const entity = graph.entities.find(
        (existingEntity) => existingEntity.name === observation.entityName
      );
      if (!entity) {
        throw new Error(
          `Entity with name ${observation.entityName} not found`
        );
      }
      const newObservations = observation.contents.filter(
        (content) => !entity.observations.includes(content)
      );
      entity.observations.push(...newObservations);
      return { entityName: observation.entityName, addedObservations: newObservations };
    });
    await this.saveGraph(graph);
    return results;
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    const graph = await this.loadGraph();
    graph.entities = graph.entities.filter(
      (entity) => !entityNames.includes(entity.name)
    );
    graph.relations = graph.relations.filter(
      (relation) =>
        !entityNames.includes(relation.from) &&
        !entityNames.includes(relation.to)
    );
    await this.saveGraph(graph);
  }

  async deleteObservations(
    deletions: { entityName: string; observations: string[] }[]
  ): Promise<void> {
    const graph = await this.loadGraph();
    deletions.forEach((deletion) => {
      const entity = graph.entities.find(
        (existingEntity) => existingEntity.name === deletion.entityName
      );
      if (entity) {
        entity.observations = entity.observations.filter(
          (observation) => !deletion.observations.includes(observation)
        );
      }
    });
    await this.saveGraph(graph);
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    const graph = await this.loadGraph();
    graph.relations = graph.relations.filter(
      (relation) =>
        !relations.some(
          (deletion) =>
            relation.from === deletion.from &&
            relation.to === deletion.to &&
            relation.relationType === deletion.relationType
        )
    );
    await this.saveGraph(graph);
  }

  async readGraph(): Promise<KnowledgeGraph> {
    return this.loadGraph();
  }

  async searchNodes(query: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    const filteredEntities = graph.entities.filter(
      (entity) =>
        entity.name.toLowerCase().includes(query.toLowerCase()) ||
        entity.entityType.toLowerCase().includes(query.toLowerCase()) ||
        entity.observations.some((observation) =>
          observation.toLowerCase().includes(query.toLowerCase())
        )
    );

    const filteredEntityNames = new Set(filteredEntities.map((entity) => entity.name));
    const filteredRelations = graph.relations.filter(
      (relation) =>
        filteredEntityNames.has(relation.from) &&
        filteredEntityNames.has(relation.to)
    );

    return {
      entities: filteredEntities,
      relations: filteredRelations,
    };
  }

  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();
    const filteredEntities = graph.entities.filter((entity) =>
      names.includes(entity.name)
    );

    const filteredEntityNames = new Set(filteredEntities.map((entity) => entity.name));
    const filteredRelations = graph.relations.filter(
      (relation) =>
        filteredEntityNames.has(relation.from) &&
        filteredEntityNames.has(relation.to)
    );

    return {
      entities: filteredEntities,
      relations: filteredRelations,
    };
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

function registerTools(server: McpServer, manager: KnowledgeGraphManager) {
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
    async ({ entities }) => {
      const result = await manager.createEntities(entities);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
        structuredContent: { entities: result },
      };
    }
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
    async ({ relations }) => {
      const result = await manager.createRelations(relations);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
        structuredContent: { relations: result },
      };
    }
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
    async ({ observations }) => {
      const result = await manager.addObservations(observations);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
        structuredContent: { results: result },
      };
    }
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
    async ({ entityNames }) => {
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
    }
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
    async ({ deletions }) => {
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
    }
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
    async ({ relations }) => {
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
    }
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
    async () => {
      const graph = await manager.readGraph();
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(graph, null, 2) },
        ],
        structuredContent: { ...graph },
      };
    }
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
    async ({ query }) => {
      const graph = await manager.searchNodes(query);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(graph, null, 2) },
        ],
        structuredContent: { ...graph },
      };
    }
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
    async ({ names }) => {
      const graph = await manager.openNodes(names);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(graph, null, 2) },
        ],
        structuredContent: { ...graph },
      };
    }
  );
}

export type MemoryServerFactoryResponse = {
  server: McpServer;
  cleanup: (sessionId?: string) => void;
};

export async function createServer(): Promise<MemoryServerFactoryResponse> {
  const memoryFilePath = await ensureMemoryFilePath();
  const knowledgeGraphManager = new KnowledgeGraphManager(memoryFilePath);
  const server = new McpServer({
    name: "memory-server",
    version: "0.6.3",
  });

  registerTools(server, knowledgeGraphManager);

  return {
    server,
    cleanup: () => {
      // No background tasks to clean up for this server at the moment.
    },
  };
}

