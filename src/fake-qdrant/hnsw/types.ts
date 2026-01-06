/**
 * HNSW (Hierarchical Navigable Small World) Types
 * Pure TypeScript implementation for use without external dependencies.
 */

export type PointId = string | number;

export interface HNSWNode {
  id: PointId;
  vector: number[];
  layer: number;
  neighbors: Map<number, Set<PointId>>; // layer -> neighbor ids
}

export interface HNSWConfig {
  /** Maximum number of connections per node at layer 0 */
  M: number;
  /** Maximum number of connections per node at layers > 0 */
  Mmax0: number;
  /** Size of the dynamic candidate list during construction */
  efConstruction: number;
  /** Size of the dynamic candidate list during search */
  efSearch: number;
  /** Normalization factor for level generation */
  mL: number;
  /** Distance metric */
  metric: "cosine" | "euclidean";
}

export interface HNSWState {
  config: HNSWConfig;
  entryPoint: PointId | null;
  maxLevel: number;
  nodes: Array<{
    id: PointId;
    vector: number[];
    layer: number;
    neighbors: Array<[number, PointId[]]>; // [layer, neighborIds[]]
  }>;
}

export interface SearchResult {
  id: PointId;
  score: number;
}

export const DEFAULT_HNSW_CONFIG: HNSWConfig = {
  M: 16,
  Mmax0: 32,
  efConstruction: 200,
  efSearch: 50,
  mL: 1 / Math.log(16),
  metric: "cosine",
};

