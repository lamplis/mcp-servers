import type { DocumentInput, ChunkInput } from '../../shared/types.js';

export interface ChunkToEmbed {
  readonly id: number;
  readonly content: string;
}

export interface SearchResult {
  readonly chunk_id: number;
  readonly score: number;
  readonly document_id: number;
  readonly source: string;
  readonly uri: string;
  readonly repo: string | null;
  readonly path: string | null;
  readonly title: string | null;
  readonly start_line: number | null;
  readonly end_line: number | null;
  readonly snippet: string;
  readonly mtime: number | null;
  readonly extra_json: string | null;
}

export interface ChunkContent {
  readonly id: number;
  readonly content: string;
  readonly document_id: number;
  readonly source: string;
  readonly uri: string;
  readonly repo: string | null;
  readonly path: string | null;
  readonly title: string | null;
  readonly start_line: number | null;
  readonly end_line: number | null;
}

export interface IndexStats {
  readonly documents: number;
  readonly chunks: number;
  readonly embeddedChunks: number;
}

export interface SourceBreakdownRow {
  readonly source: string;
  readonly documents: number;
  readonly chunks: number;
}

export interface RecentDocumentRow {
  readonly title: string | null;
  readonly source: string;
  readonly repo: string | null;
  readonly path: string | null;
  readonly mtime: number | null;
}

export interface DocumentRecord {
  readonly id: number;
  readonly source: string;
  readonly uri: string;
  readonly repo: string | null;
  readonly path: string | null;
  readonly title: string | null;
  readonly lang: string | null;
  readonly hash: string;
  readonly mtime: number | null;
  readonly version: string | null;
  readonly extra_json: string | null;
}

export interface ChunkRecord {
  readonly id: number;
  readonly document_id: number;
  readonly chunk_index: number;
  readonly content: string;
  readonly start_line: number | null;
  readonly end_line: number | null;
  readonly token_count: number | null;
  readonly path?: string | null;
}

export interface DatabaseAdapter {
  init(): Promise<void>;
  close(): Promise<void>;

  // Document operations
  getDocument(uri: string): Promise<{ id: number; hash: string } | null>;
  upsertDocument(doc: DocumentInput): Promise<number>;
  updateDocumentHash(documentId: number, hash: string): Promise<void>;

  // Chunk operations
  insertChunks(documentId: number, chunks: readonly ChunkInput[]): Promise<void>;
  insertChunk(documentId: number, chunk: ChunkInput, index: number): Promise<void>;
  updateChunk(chunkId: number, chunk: ChunkInput): Promise<void>;
  deleteChunk(chunkId: number): Promise<void>;
  deleteDocumentChunks(documentId: number): Promise<void>;
  getChunksToEmbed(limit?: number): Promise<ChunkToEmbed[]>;
  getChunkContent(chunkId: number): Promise<ChunkContent | null>;
  getDocumentChunks(
    documentId: number,
  ): Promise<Array<{ id: number; content: string; startLine: number; endLine: number }>>;
  getChunkCount(documentId: number): Promise<number>;
  hasChunks(documentId: number): Promise<boolean>;

  // Vector operations
  insertEmbeddings(chunks: Array<{ id: number; embedding: number[] }>): Promise<void>;
  deleteEmbedding(chunkId: number): Promise<void>;

  // Search operations
  keywordSearch(query: string, limit: number, filters: SearchFilters): Promise<SearchResult[]>;
  vectorSearch(embedding: number[], limit: number, filters: SearchFilters): Promise<SearchResult[]>;

  // Metadata operations
  setMeta(key: string, value: string): Promise<void>;
  getMeta(key: string): Promise<string | undefined>;

  // Cleanup operations
  cleanupDocumentChunks(documentId: number): Promise<void>;

  // Stats / inspection (no SQL)
  getIndexStats(): Promise<IndexStats>;
  getSourceBreakdown(): Promise<SourceBreakdownRow[]>;
  getRecentDocuments(limit: number): Promise<RecentDocumentRow[]>;
  getLastCrawlTime(startUrl: string): Promise<number | null>;
  findDocuments(filter?: {
    lang?: string;
    excludeLang?: string;
    id?: number;
    uri?: string;
    uriContains?: string;
    source?: string;
  }): Promise<DocumentRecord[]>;
  findChunks(filter?: {
    documentId?: number;
    lang?: string;
    contentContains?: string;
  }): Promise<ChunkRecord[]>;
}

export interface SearchFilters {
  readonly source?: string;
  readonly repo?: string;
  readonly pathPrefix?: string;
  readonly includeImages?: boolean;
  readonly imagesOnly?: boolean;
}
