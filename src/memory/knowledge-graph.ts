import { promises as fs } from "fs";
import type { Logger } from "./logger.js";
import {
  DiskGate,
  Mutex,
  ProcessLockBusyError,
  acquireProcessLock,
  atomicWriteFile,
  lockDirForMemoryFile,
  type ProcessLock,
} from "./disk-gate.js";

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

export interface KnowledgeGraphManagerOptions {
  logger?: Logger;
  diskGate?: DiskGate;
  acquireLock?: boolean;
  lockRetries?: number;
  lockRetryMs?: number;
}

export class KnowledgeGraphManager {
  private cache: KnowledgeGraph | null = null;
  private readonly mutex = new Mutex();
  private readonly diskGate: DiskGate;
  private readonly logger?: Logger;
  private processLock: ProcessLock | null = null;
  private busy = false;
  private busyError: ProcessLockBusyError | null = null;

  constructor(
    private memoryFilePath: string,
    logger?: Logger,
    options: KnowledgeGraphManagerOptions = {}
  ) {
    this.logger = logger ?? options.logger;
    this.diskGate = options.diskGate ?? new DiskGate();
  }

  static async create(
    memoryFilePath: string,
    options: KnowledgeGraphManagerOptions = {}
  ): Promise<KnowledgeGraphManager> {
    const manager = new KnowledgeGraphManager(
      memoryFilePath,
      options.logger,
      options
    );
    if (options.acquireLock !== false) {
      try {
        manager.processLock = await acquireProcessLock({
          lockDir: lockDirForMemoryFile(memoryFilePath),
          retries: options.lockRetries,
          retryMs: options.lockRetryMs,
        });
      } catch (error) {
        if (error instanceof ProcessLockBusyError) {
          manager.busy = true;
          manager.busyError = error;
          options.logger?.error("store.busy", {
            lockDir: lockDirForMemoryFile(memoryFilePath),
            holderPid: error.holderPid,
            message: error.message,
          });
        } else {
          throw error;
        }
      }
    }
    return manager;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  private assertWritable(): void {
    if (this.busy && this.busyError) {
      throw this.busyError;
    }
  }

  private async loadGraphFromDisk(): Promise<KnowledgeGraph> {
    try {
      const data = await fs.readFile(this.memoryFilePath, "utf-8");
      const lines = data.split("\n").filter((line) => line.trim() !== "");
      return lines.reduce(
        (graph: KnowledgeGraph, line, index) => {
          try {
            const item = JSON.parse(line);
            if (item.type === "entity") graph.entities.push(item as Entity);
            if (item.type === "relation") graph.relations.push(item as Relation);
            return graph;
          } catch (error) {
            this.logger?.error("memory.jsonl.parse", {
              line: index + 1,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
        { entities: [], relations: [] }
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
      ) {
        return { entities: [], relations: [] };
      }
      throw error;
    }
  }

  private async ensureCache(): Promise<KnowledgeGraph> {
    if (!this.cache) {
      this.cache = await this.loadGraphFromDisk();
    }
    return this.cache;
  }

  private cloneGraph(graph: KnowledgeGraph): KnowledgeGraph {
    return {
      entities: graph.entities.map((entity) => ({
        ...entity,
        observations: [...entity.observations],
      })),
      relations: graph.relations.map((relation) => ({ ...relation })),
    };
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
    const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    await this.diskGate.run(() => atomicWriteFile(this.memoryFilePath, body));
  }

  private async mutate<T>(
    fn: (graph: KnowledgeGraph) => T | Promise<T>
  ): Promise<T> {
    this.assertWritable();
    return this.mutex.run(async () => {
      const graph = await this.ensureCache();
      const result = await fn(graph);
      await this.saveGraph(graph);
      return result;
    });
  }

  private async readCached<T>(
    fn: (graph: KnowledgeGraph) => T | Promise<T>
  ): Promise<T> {
    this.assertWritable();
    return this.mutex.run(async () => {
      const graph = await this.ensureCache();
      return fn(graph);
    });
  }

  async createEntities(entities: Entity[]): Promise<Entity[]> {
    return this.mutate((graph) => {
      const newEntities = entities.filter(
        (entity) =>
          !graph.entities.some(
            (existingEntity) => existingEntity.name === entity.name
          )
      );
      graph.entities.push(...newEntities);
      return newEntities;
    });
  }

  async createRelations(relations: Relation[]): Promise<Relation[]> {
    return this.mutate((graph) => {
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
      return newRelations;
    });
  }

  async addObservations(
    observations: { entityName: string; contents: string[] }[]
  ): Promise<{ entityName: string; addedObservations: string[] }[]> {
    return this.mutate((graph) =>
      observations.map((observation) => {
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
        return {
          entityName: observation.entityName,
          addedObservations: newObservations,
        };
      })
    );
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    await this.mutate((graph) => {
      graph.entities = graph.entities.filter(
        (entity) => !entityNames.includes(entity.name)
      );
      graph.relations = graph.relations.filter(
        (relation) =>
          !entityNames.includes(relation.from) &&
          !entityNames.includes(relation.to)
      );
    });
  }

  async deleteObservations(
    deletions: { entityName: string; observations: string[] }[]
  ): Promise<void> {
    await this.mutate((graph) => {
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
    });
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    await this.mutate((graph) => {
      graph.relations = graph.relations.filter(
        (relation) =>
          !relations.some(
            (deletion) =>
              relation.from === deletion.from &&
              relation.to === deletion.to &&
              relation.relationType === deletion.relationType
          )
      );
    });
  }

  async readGraph(): Promise<KnowledgeGraph> {
    return this.readCached((graph) => this.cloneGraph(graph));
  }

  async searchNodes(query: string): Promise<KnowledgeGraph> {
    return this.readCached((graph) => {
      const filteredEntities = graph.entities.filter(
        (entity) =>
          entity.name.toLowerCase().includes(query.toLowerCase()) ||
          entity.entityType.toLowerCase().includes(query.toLowerCase()) ||
          entity.observations.some((observation) =>
            observation.toLowerCase().includes(query.toLowerCase())
          )
      );
      const filteredEntityNames = new Set(
        filteredEntities.map((entity) => entity.name)
      );
      const filteredRelations = graph.relations.filter(
        (relation) =>
          filteredEntityNames.has(relation.from) &&
          filteredEntityNames.has(relation.to)
      );
      return {
        entities: filteredEntities,
        relations: filteredRelations,
      };
    });
  }

  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    return this.readCached((graph) => {
      const filteredEntities = graph.entities.filter((entity) =>
        names.includes(entity.name)
      );
      const filteredEntityNames = new Set(
        filteredEntities.map((entity) => entity.name)
      );
      const filteredRelations = graph.relations.filter(
        (relation) =>
          filteredEntityNames.has(relation.from) &&
          filteredEntityNames.has(relation.to)
      );
      return {
        entities: filteredEntities,
        relations: filteredRelations,
      };
    });
  }

  async close(): Promise<void> {
    if (this.processLock) {
      await this.processLock.release();
      this.processLock = null;
    }
  }
}
