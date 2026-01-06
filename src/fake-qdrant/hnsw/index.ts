/**
 * HNSW (Hierarchical Navigable Small World) Index
 * Pure TypeScript implementation - no external dependencies.
 *
 * Based on the paper: "Efficient and robust approximate nearest neighbor search
 * using Hierarchical Navigable Small World graphs" by Malkov & Yashunin (2016)
 */

import {
  PointId,
  HNSWNode,
  HNSWConfig,
  HNSWState,
  SearchResult,
  DEFAULT_HNSW_CONFIG,
} from "./types.js";

export * from "./types.js";

export class HNSWIndex {
  private config: HNSWConfig;
  private nodes: Map<PointId, HNSWNode> = new Map();
  private entryPoint: PointId | null = null;
  private maxLevel: number = 0;

  constructor(config: Partial<HNSWConfig> = {}) {
    this.config = { ...DEFAULT_HNSW_CONFIG, ...config };
  }

  get size(): number {
    return this.nodes.size;
  }

  get isEmpty(): boolean {
    return this.nodes.size === 0;
  }

  /**
   * Insert a vector into the index
   */
  insert(id: PointId, vector: number[]): void {
    if (this.nodes.has(id)) {
      // Update existing node
      const existing = this.nodes.get(id)!;
      existing.vector = vector;
      return;
    }

    const level = this.randomLevel();
    const node: HNSWNode = {
      id,
      vector,
      layer: level,
      neighbors: new Map(),
    };

    for (let l = 0; l <= level; l++) {
      node.neighbors.set(l, new Set());
    }

    this.nodes.set(id, node);

    if (this.entryPoint === null) {
      this.entryPoint = id;
      this.maxLevel = level;
      return;
    }

    let currentNode = this.entryPoint;

    // Traverse from top to the level of the new node
    for (let l = this.maxLevel; l > level; l--) {
      currentNode = this.greedyClosest(vector, currentNode, l);
    }

    // Insert at each level from level down to 0
    for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
      const neighbors = this.searchLayer(
        vector,
        [currentNode],
        this.config.efConstruction,
        l
      );

      const maxConnections = l === 0 ? this.config.Mmax0 : this.config.M;
      const selectedNeighbors = this.selectNeighbors(
        vector,
        neighbors,
        maxConnections
      );

      // Connect new node to selected neighbors
      for (const neighborId of selectedNeighbors) {
        node.neighbors.get(l)!.add(neighborId);
        const neighbor = this.nodes.get(neighborId);
        if (neighbor && neighbor.neighbors.has(l)) {
          neighbor.neighbors.get(l)!.add(id);
          // Prune if necessary
          if (neighbor.neighbors.get(l)!.size > maxConnections) {
            this.pruneConnections(neighbor, l, maxConnections);
          }
        }
      }

      if (neighbors.length > 0) {
        currentNode = neighbors[0].id;
      }
    }

    // Update entry point if new node has higher level
    if (level > this.maxLevel) {
      this.entryPoint = id;
      this.maxLevel = level;
    }
  }

  /**
   * Search for k nearest neighbors
   */
  search(queryVector: number[], k: number, efSearch?: number): SearchResult[] {
    if (this.entryPoint === null) {
      return [];
    }

    const ef = efSearch ?? this.config.efSearch;
    let currentNode = this.entryPoint;

    // Traverse from top to layer 1
    for (let l = this.maxLevel; l > 0; l--) {
      currentNode = this.greedyClosest(queryVector, currentNode, l);
    }

    // Search at layer 0
    const candidates = this.searchLayer(queryVector, [currentNode], ef, 0);

    return candidates.slice(0, k);
  }

  /**
   * Remove a point from the index
   */
  remove(id: PointId): boolean {
    const node = this.nodes.get(id);
    if (!node) {
      return false;
    }

    // Remove connections to this node from all neighbors
    for (const [level, neighbors] of node.neighbors) {
      for (const neighborId of neighbors) {
        const neighbor = this.nodes.get(neighborId);
        if (neighbor && neighbor.neighbors.has(level)) {
          neighbor.neighbors.get(level)!.delete(id);
        }
      }
    }

    this.nodes.delete(id);

    // Update entry point if necessary
    if (this.entryPoint === id) {
      if (this.nodes.size === 0) {
        this.entryPoint = null;
        this.maxLevel = 0;
      } else {
        // Find new entry point (node with highest level)
        let maxLevel = 0;
        let newEntry: PointId | null = null;
        for (const [nodeId, n] of this.nodes) {
          if (n.layer >= maxLevel) {
            maxLevel = n.layer;
            newEntry = nodeId;
          }
        }
        this.entryPoint = newEntry;
        this.maxLevel = maxLevel;
      }
    }

    return true;
  }

  /**
   * Serialize the index to a JSON-compatible object
   */
  serialize(): HNSWState {
    const nodes = Array.from(this.nodes.values()).map((node) => ({
      id: node.id,
      vector: node.vector,
      layer: node.layer,
      neighbors: Array.from(node.neighbors.entries()).map(([level, ids]) => [
        level,
        Array.from(ids),
      ]) as Array<[number, PointId[]]>,
    }));

    return {
      config: this.config,
      entryPoint: this.entryPoint,
      maxLevel: this.maxLevel,
      nodes,
    };
  }

  /**
   * Deserialize an index from a JSON-compatible object
   */
  static deserialize(state: HNSWState): HNSWIndex {
    const index = new HNSWIndex(state.config);
    index.entryPoint = state.entryPoint;
    index.maxLevel = state.maxLevel;

    for (const nodeData of state.nodes) {
      const neighbors = new Map<number, Set<PointId>>();
      for (const [level, ids] of nodeData.neighbors) {
        neighbors.set(level, new Set(ids));
      }
      index.nodes.set(nodeData.id, {
        id: nodeData.id,
        vector: nodeData.vector,
        layer: nodeData.layer,
        neighbors,
      });
    }

    return index;
  }

  /**
   * Get a point by ID
   */
  getPoint(id: PointId): { vector: number[] } | null {
    const node = this.nodes.get(id);
    return node ? { vector: node.vector } : null;
  }

  /**
   * Check if a point exists
   */
  has(id: PointId): boolean {
    return this.nodes.has(id);
  }

  // --- Private methods ---

  private randomLevel(): number {
    const r = Math.random();
    return Math.floor(-Math.log(r) * this.config.mL);
  }

  private distance(a: number[], b: number[]): number {
    if (this.config.metric === "cosine") {
      return 1 - this.cosineSimilarity(a, b);
    }
    return this.euclideanDistance(a, b);
  }

  private similarity(a: number[], b: number[]): number {
    if (this.config.metric === "cosine") {
      return this.cosineSimilarity(a, b);
    }
    // For euclidean, convert distance to similarity
    return 1 / (1 + this.euclideanDistance(a, b));
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private euclideanDistance(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  private greedyClosest(
    queryVector: number[],
    startNode: PointId,
    level: number
  ): PointId {
    let current = startNode;
    let currentDist = this.distance(
      queryVector,
      this.nodes.get(current)!.vector
    );

    while (true) {
      let closest = current;
      let closestDist = currentDist;

      const neighbors = this.nodes.get(current)?.neighbors.get(level);
      if (!neighbors) break;

      for (const neighborId of neighbors) {
        const neighbor = this.nodes.get(neighborId);
        if (!neighbor) continue;

        const dist = this.distance(queryVector, neighbor.vector);
        if (dist < closestDist) {
          closest = neighborId;
          closestDist = dist;
        }
      }

      if (closest === current) break;
      current = closest;
      currentDist = closestDist;
    }

    return current;
  }

  private searchLayer(
    queryVector: number[],
    entryPoints: PointId[],
    ef: number,
    level: number
  ): SearchResult[] {
    const visited = new Set<PointId>(entryPoints);
    const candidates: SearchResult[] = [];
    const results: SearchResult[] = [];

    for (const ep of entryPoints) {
      const node = this.nodes.get(ep);
      if (!node) continue;
      const score = this.similarity(queryVector, node.vector);
      candidates.push({ id: ep, score });
      results.push({ id: ep, score });
    }

    // Sort candidates by score descending (higher is better)
    candidates.sort((a, b) => b.score - a.score);

    while (candidates.length > 0) {
      const current = candidates.pop()!;

      // Get worst result score
      results.sort((a, b) => b.score - a.score);
      const worstResult = results.length >= ef ? results[ef - 1] : null;

      if (worstResult && current.score < worstResult.score) {
        break;
      }

      const currentNode = this.nodes.get(current.id);
      if (!currentNode) continue;

      const neighbors = currentNode.neighbors.get(level);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighbor = this.nodes.get(neighborId);
        if (!neighbor) continue;

        const score = this.similarity(queryVector, neighbor.vector);

        if (results.length < ef || score > results[results.length - 1].score) {
          candidates.push({ id: neighborId, score });
          results.push({ id: neighborId, score });
          results.sort((a, b) => b.score - a.score);
          if (results.length > ef) {
            results.pop();
          }
        }
      }

      // Re-sort candidates
      candidates.sort((a, b) => b.score - a.score);
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  private selectNeighbors(
    queryVector: number[],
    candidates: SearchResult[],
    maxConnections: number
  ): PointId[] {
    // Simple selection: take top candidates by score
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, maxConnections).map((c) => c.id);
  }

  private pruneConnections(
    node: HNSWNode,
    level: number,
    maxConnections: number
  ): void {
    const neighbors = node.neighbors.get(level);
    if (!neighbors || neighbors.size <= maxConnections) return;

    // Score all neighbors and keep the best ones
    const scored: SearchResult[] = [];
    for (const neighborId of neighbors) {
      const neighbor = this.nodes.get(neighborId);
      if (!neighbor) continue;
      const score = this.similarity(node.vector, neighbor.vector);
      scored.push({ id: neighborId, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const keep = new Set(scored.slice(0, maxConnections).map((s) => s.id));

    // Remove pruned connections
    for (const neighborId of Array.from(neighbors)) {
      if (!keep.has(neighborId)) {
        neighbors.delete(neighborId);
        // Also remove back-connection
        const neighbor = this.nodes.get(neighborId);
        if (neighbor && neighbor.neighbors.has(level)) {
          neighbor.neighbors.get(level)!.delete(node.id);
        }
      }
    }
  }
}

