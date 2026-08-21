import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  DatabaseAdapter,
  ChunkToEmbed,
  SearchResult,
  ChunkContent,
  SearchFilters,
  IndexStats,
  SourceBreakdownRow,
  RecentDocumentRow,
  DocumentRecord,
  ChunkRecord,
} from './types.js';
import type { DocumentInput, ChunkInput } from '../../shared/types.js';

export interface JsonAdapterConfig {
  readonly path: string;
  readonly embeddingDim: number;
}

interface StoredDocument {
  id: number;
  source: string;
  uri: string;
  repo: string | null;
  path: string | null;
  title: string | null;
  lang: string | null;
  hash: string;
  mtime: number | null;
  version: string | null;
  extra_json: string | null;
}

interface StoredChunk {
  id: number;
  document_id: number;
  chunk_index: number;
  content: string;
  start_line: number | null;
  end_line: number | null;
  token_count: number | null;
}

interface PersistedMeta {
  nextDocumentId: number;
  nextChunkId: number;
  embeddingDim: number;
  kv: Record<string, string>;
}

/**
 * File-backed document index (JSON, no database binaries).
 * `config.path` is a directory (historically named DB_PATH).
 */
export class JsonAdapter implements DatabaseAdapter {
  private documents = new Map<number, StoredDocument>();
  private documentsByUri = new Map<string, number>();
  private chunks = new Map<number, StoredChunk>();
  private embeddings = new Map<number, number[]>();
  private kv = new Map<string, string>();
  private nextDocumentId = 1;
  private nextChunkId = 1;
  private dirty = false;
  private persistChain: Promise<void> = Promise.resolve();
  private readonly dir: string;

  constructor(private readonly config: JsonAdapterConfig) {
    this.dir = config.path;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await this.load();
  }

  async close(): Promise<void> {
    if (this.dirty) {
      await this.persist();
    }
  }

  private metaFile(): string {
    return join(this.dir, 'meta.json');
  }
  private documentsFile(): string {
    return join(this.dir, 'documents.json');
  }
  private chunksFile(): string {
    return join(this.dir, 'chunks.json');
  }
  private embeddingsFile(): string {
    return join(this.dir, 'embeddings.json');
  }

  private async load(): Promise<void> {
    const meta = await readJsonFile<PersistedMeta>(this.metaFile());
    if (meta) {
      this.nextDocumentId = meta.nextDocumentId ?? 1;
      this.nextChunkId = meta.nextChunkId ?? 1;
      this.kv = new Map(Object.entries(meta.kv ?? {}));
    }

    const docs = await readJsonFile<StoredDocument[]>(this.documentsFile());
    this.documents.clear();
    this.documentsByUri.clear();
    if (Array.isArray(docs)) {
      for (const doc of docs) {
        this.documents.set(doc.id, doc);
        this.documentsByUri.set(doc.uri, doc.id);
      }
    }

    const chunks = await readJsonFile<StoredChunk[]>(this.chunksFile());
    this.chunks.clear();
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) {
        this.chunks.set(chunk.id, chunk);
      }
    }

    const embeddings = await readJsonFile<Record<string, number[]>>(this.embeddingsFile());
    this.embeddings.clear();
    if (embeddings && typeof embeddings === 'object') {
      for (const [key, value] of Object.entries(embeddings)) {
        const id = Number(key);
        if (Number.isFinite(id) && Array.isArray(value)) {
          this.embeddings.set(id, value);
        }
      }
    }

    this.dirty = false;
  }

  private async persist(): Promise<void> {
    this.persistChain = this.persistChain.catch(() => undefined).then(async () => {
      await mkdir(this.dir, { recursive: true });
      const meta: PersistedMeta = {
        nextDocumentId: this.nextDocumentId,
        nextChunkId: this.nextChunkId,
        embeddingDim: this.config.embeddingDim,
        kv: Object.fromEntries(this.kv),
      };
      await writeJsonAtomic(this.metaFile(), meta);
      await writeJsonAtomic(this.documentsFile(), [...this.documents.values()]);
      await writeJsonAtomic(this.chunksFile(), [...this.chunks.values()]);
      await writeJsonAtomic(
        this.embeddingsFile(),
        Object.fromEntries([...this.embeddings.entries()].map(([id, vec]) => [String(id), vec])),
      );
      this.dirty = false;
    });
    await this.persistChain;
  }

  private markDirty(): void {
    this.dirty = true;
  }

  async getDocument(uri: string): Promise<{ id: number; hash: string } | null> {
    const id = this.documentsByUri.get(uri) ?? this.documentsByUri.get(normalizeUri(uri));
    if (id === undefined) {
      for (const [stored, storedId] of this.documentsByUri) {
        if (normalizeUri(stored) === normalizeUri(uri)) {
          const doc = this.documents.get(storedId);
          return doc ? { id: doc.id, hash: doc.hash } : null;
        }
      }
      return null;
    }
    const doc = this.documents.get(id);
    if (!doc) {
      return null;
    }
    return { id: doc.id, hash: doc.hash };
  }

  async upsertDocument(doc: DocumentInput): Promise<number> {
    if (!doc.uri || !doc.hash) {
      throw new Error(`Failed to upsert document: ${String(doc.uri)}`);
    }
    const existing = await this.getDocument(doc.uri as string);
    const isSame = existing && existing.hash === (doc.hash as string);
    const extraJson = extraJsonOf(doc);

    const stored: StoredDocument = {
      id: existing?.id ?? this.nextDocumentId,
      source: String(doc.source),
      uri: String(doc.uri),
      repo: (doc.repo as string | null | undefined) ?? null,
      path: (doc.path as string | null | undefined) ?? null,
      title: (doc.title as string | null | undefined) ?? null,
      lang: (doc.lang as string | null | undefined) ?? null,
      hash: String(doc.hash),
      mtime: (doc.mtime as number | null | undefined) ?? null,
      version: (doc.version as string | null | undefined) ?? null,
      extra_json: extraJson,
    };

    if (!existing) {
      this.nextDocumentId += 1;
    }

    this.documents.set(stored.id, stored);
    this.documentsByUri.set(stored.uri, stored.id);
    this.markDirty();

    if (!isSame && existing) {
      await this.cleanupDocumentChunks(stored.id);
    }

    await this.persist();
    return stored.id;
  }

  async insertChunks(documentId: number, chunks: readonly ChunkInput[]): Promise<void> {
    chunks.forEach((chunk, index) => {
      this.insertChunkSync(documentId, chunk, index);
    });
    this.markDirty();
    await this.persist();
  }

  async insertChunk(documentId: number, chunk: ChunkInput, index: number): Promise<void> {
    this.insertChunkSync(documentId, chunk, index);
    this.markDirty();
    await this.persist();
  }

  private insertChunkSync(documentId: number, chunk: ChunkInput, index: number): void {
    if (!this.documents.has(documentId)) {
      throw new Error(`Document not found: ${documentId}`);
    }
    const stored: StoredChunk = {
      id: this.nextChunkId,
      document_id: documentId,
      chunk_index: index,
      content: chunk.content,
      start_line: chunk.startLine ?? null,
      end_line: chunk.endLine ?? null,
      token_count: chunk.tokenCount ?? null,
    };
    this.nextChunkId += 1;
    this.chunks.set(stored.id, stored);
  }

  async updateChunk(chunkId: number, chunk: ChunkInput): Promise<void> {
    const existing = this.chunks.get(chunkId);
    if (!existing) {
      return;
    }
    this.chunks.set(chunkId, {
      ...existing,
      content: chunk.content,
      start_line: chunk.startLine ?? null,
      end_line: chunk.endLine ?? null,
      token_count: chunk.tokenCount ?? null,
    });
    this.embeddings.delete(chunkId);
    this.markDirty();
    await this.persist();
  }

  async deleteChunk(chunkId: number): Promise<void> {
    this.embeddings.delete(chunkId);
    this.chunks.delete(chunkId);
    this.markDirty();
    await this.persist();
  }

  async deleteDocumentChunks(documentId: number): Promise<void> {
    await this.cleanupDocumentChunks(documentId);
  }

  async updateDocumentHash(documentId: number, hash: string): Promise<void> {
    const doc = this.documents.get(documentId);
    if (!doc) {
      return;
    }
    this.documents.set(documentId, { ...doc, hash });
    this.markDirty();
    await this.persist();
  }

  async getChunksToEmbed(limit: number = 10000): Promise<ChunkToEmbed[]> {
    const result: ChunkToEmbed[] = [];
    for (const chunk of this.chunks.values()) {
      if (this.embeddings.has(chunk.id)) {
        continue;
      }
      result.push({ id: chunk.id, content: chunk.content });
      if (result.length >= limit) {
        break;
      }
    }
    return result;
  }

  async getChunkContent(chunkId: number): Promise<ChunkContent | null> {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) {
      return null;
    }
    const doc = this.documents.get(chunk.document_id);
    if (!doc) {
      return null;
    }
    return {
      id: chunk.id,
      content: chunk.content,
      document_id: chunk.document_id,
      source: doc.source,
      uri: doc.uri,
      repo: doc.repo,
      path: doc.path,
      title: doc.title,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
    };
  }

  async hasChunks(documentId: number): Promise<boolean> {
    return (await this.getChunkCount(documentId)) > 0;
  }

  async getDocumentChunks(
    documentId: number,
  ): Promise<Array<{ id: number; content: string; startLine: number; endLine: number }>> {
    const rows = [...this.chunks.values()]
      .filter((chunk) => chunk.document_id === documentId)
      .sort((a, b) => a.chunk_index - b.chunk_index);
    return rows.map((chunk) => ({
      id: chunk.id,
      content: chunk.content,
      startLine: chunk.start_line ?? 0,
      endLine: chunk.end_line ?? 0,
    }));
  }

  async getChunkCount(documentId: number): Promise<number> {
    let count = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.document_id === documentId) {
        count += 1;
      }
    }
    return count;
  }

  async deleteEmbedding(chunkId: number): Promise<void> {
    this.embeddings.delete(chunkId);
    this.markDirty();
    await this.persist();
  }

  async insertEmbeddings(chunks: Array<{ id: number; embedding: number[] }>): Promise<void> {
    for (const { id, embedding } of chunks) {
      this.embeddings.set(id, Array.from(embedding));
    }
    this.markDirty();
    await this.persist();
  }

  async keywordSearch(
    query: string,
    limit: number,
    filters: SearchFilters,
  ): Promise<SearchResult[]> {
    const tokens = tokenize(query);
    if (tokens.size === 0) {
      return [];
    }
    const scored: SearchResult[] = [];
    for (const chunk of this.chunks.values()) {
      const doc = this.documents.get(chunk.document_id);
      if (!doc || !matchesFilters(doc, filters)) {
        continue;
      }
      const contentTokens = tokenize(chunk.content);
      let overlap = 0;
      for (const token of tokens) {
        if (contentTokens.has(token)) {
          overlap += 1;
        }
      }
      if (overlap === 0) {
        continue;
      }
      scored.push(toSearchResult(chunk, doc, overlap));
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async vectorSearch(
    embedding: number[],
    limit: number,
    filters: SearchFilters,
  ): Promise<SearchResult[]> {
    const scored: SearchResult[] = [];
    for (const [chunkId, vector] of this.embeddings) {
      const chunk = this.chunks.get(chunkId);
      if (!chunk) {
        continue;
      }
      const doc = this.documents.get(chunk.document_id);
      if (!doc || !matchesFilters(doc, filters)) {
        continue;
      }
      scored.push(toSearchResult(chunk, doc, cosineSimilarity(embedding, vector)));
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
    this.markDirty();
    await this.persist();
  }

  async getMeta(key: string): Promise<string | undefined> {
    return this.kv.get(key);
  }

  async cleanupDocumentChunks(documentId: number): Promise<void> {
    for (const chunk of [...this.chunks.values()]) {
      if (chunk.document_id === documentId) {
        this.embeddings.delete(chunk.id);
        this.chunks.delete(chunk.id);
      }
    }
    this.markDirty();
    await this.persist();
  }

  async getIndexStats(): Promise<IndexStats> {
    return {
      documents: this.documents.size,
      chunks: this.chunks.size,
      embeddedChunks: this.embeddings.size,
    };
  }

  async getSourceBreakdown(): Promise<SourceBreakdownRow[]> {
    const bySource = new Map<string, { documents: number; chunks: number }>();
    for (const doc of this.documents.values()) {
      const entry = bySource.get(doc.source) ?? { documents: 0, chunks: 0 };
      entry.documents += 1;
      bySource.set(doc.source, entry);
    }
    for (const chunk of this.chunks.values()) {
      const doc = this.documents.get(chunk.document_id);
      if (!doc) {
        continue;
      }
      const entry = bySource.get(doc.source) ?? { documents: 0, chunks: 0 };
      entry.chunks += 1;
      bySource.set(doc.source, entry);
    }
    return [...bySource.entries()].map(([source, counts]) => ({
      source,
      documents: counts.documents,
      chunks: counts.chunks,
    }));
  }

  async getRecentDocuments(limit: number): Promise<RecentDocumentRow[]> {
    return [...this.documents.values()]
      .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
      .slice(0, limit)
      .map((doc) => ({
        title: doc.title,
        source: doc.source,
        repo: doc.repo,
        path: doc.path,
        mtime: doc.mtime,
      }));
  }

  async getLastCrawlTime(startUrl: string): Promise<number | null> {
    const needle = `"crawledFrom":"${startUrl}"`;
    let max: number | null = null;
    for (const doc of this.documents.values()) {
      if (!doc.extra_json || !doc.extra_json.includes(needle)) {
        continue;
      }
      if (doc.mtime != null && (max === null || doc.mtime > max)) {
        max = doc.mtime;
      }
    }
    return max;
  }

  async findDocuments(filter: {
    lang?: string;
    excludeLang?: string;
    id?: number;
    uri?: string;
    uriContains?: string;
    source?: string;
  } = {}): Promise<DocumentRecord[]> {
    const rows = [...this.documents.values()].filter((doc) => {
      if (filter.id !== undefined && doc.id !== filter.id) {
        return false;
      }
      if (filter.lang !== undefined && doc.lang !== filter.lang) {
        return false;
      }
      if (filter.excludeLang !== undefined && doc.lang === filter.excludeLang) {
        return false;
      }
      if (filter.uri !== undefined && doc.uri !== filter.uri) {
        return false;
      }
      if (filter.uriContains !== undefined && !doc.uri.includes(filter.uriContains)) {
        return false;
      }
      if (filter.source !== undefined && doc.source !== filter.source) {
        return false;
      }
      return true;
    });
    rows.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''));
    return rows;
  }

  async findChunks(
    filter: { documentId?: number; lang?: string; contentContains?: string } = {},
  ): Promise<ChunkRecord[]> {
    const rows: ChunkRecord[] = [];
    for (const chunk of this.chunks.values()) {
      const doc = this.documents.get(chunk.document_id);
      if (filter.documentId !== undefined && chunk.document_id !== filter.documentId) {
        continue;
      }
      if (filter.lang !== undefined && doc?.lang !== filter.lang) {
        continue;
      }
      if (filter.contentContains !== undefined && !chunk.content.includes(filter.contentContains)) {
        continue;
      }
      rows.push({
        ...chunk,
        path: doc?.path ?? null,
      });
    }
    rows.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''));
    return rows;
  }
}

function normalizeUri(uri: string): string {
  return uri.replace(/\\/g, '/');
}

function extraJsonOf(doc: DocumentInput): string | null {
  const rec = doc as DocumentInput & { extraJson?: string | null };
  if (rec.extraJson !== undefined) {
    return rec.extraJson;
  }
  return doc.extra_json ?? null;
}

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length > 0);
  return new Set(tokens);
}

function matchesFilters(doc: StoredDocument, filters: SearchFilters): boolean {
  if (filters.source && doc.source !== filters.source) {
    return false;
  }
  if (filters.repo && doc.repo !== filters.repo) {
    return false;
  }
  if (filters.pathPrefix && !(doc.path ?? '').startsWith(filters.pathPrefix)) {
    return false;
  }
  if (filters.imagesOnly) {
    return doc.lang === 'image';
  }
  if (filters.includeImages === false && doc.lang === 'image') {
    return false;
  }
  return true;
}

function toSearchResult(chunk: StoredChunk, doc: StoredDocument, score: number): SearchResult {
  return {
    chunk_id: chunk.id,
    score,
    document_id: doc.id,
    source: doc.source,
    uri: doc.uri,
    repo: doc.repo,
    path: doc.path,
    title: doc.title,
    start_line: chunk.start_line,
    end_line: chunk.end_line,
    snippet: chunk.content.slice(0, 400),
    mtime: doc.mtime,
    extra_json: doc.extra_json,
  };
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) {
    return 0;
  }
  return dot / denom;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tmp, body, 'utf8');
  try {
    await rename(tmp, filePath);
  } catch {
    await writeFile(filePath, body, 'utf8');
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}
