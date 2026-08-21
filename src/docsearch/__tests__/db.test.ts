import { existsSync } from 'fs';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { testDbPath } from './setup.js';
import { JsonAdapter } from '../src/ingest/adapters/json.js';

describe('JSON index', () => {
  let adapter: JsonAdapter;

  beforeEach(async () => {
    adapter = new JsonAdapter({ path: testDbPath, embeddingDim: 1536 });
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe('init', () => {
    it('should create index directory', () => {
      expect(existsSync(testDbPath)).toBe(true);
    });

    it('should persist documents and chunks to JSON files', async () => {
      const id = await adapter.upsertDocument({
        source: 'file',
        uri: 'test://doc1',
        hash: 'hash123',
        extra_json: null,
      });
      await adapter.insertChunks(id, [{ content: 'searchable test content' }]);

      expect(existsSync(`${testDbPath}/documents.json`)).toBe(true);
      expect(existsSync(`${testDbPath}/chunks.json`)).toBe(true);

      const docs = await adapter.findDocuments();
      expect(docs).toHaveLength(1);
      expect(docs[0]?.uri).toBe('test://doc1');

      const chunks = await adapter.findChunks({ documentId: id });
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.content).toBe('searchable test content');
    });

    it('should use custom path when provided', async () => {
      const custom = new JsonAdapter({ path: './test/custom-index', embeddingDim: 512 });
      await custom.init();
      try {
        expect(existsSync('./test/custom-index')).toBe(true);
      } finally {
        await custom.close();
      }
    });
  });

  describe('search', () => {
    it('should match keyword tokens after insert', async () => {
      const id = await adapter.upsertDocument({
        source: 'file',
        uri: 'test://doc1',
        hash: 'hash123',
        extra_json: null,
      });
      await adapter.insertChunks(id, [{ content: 'searchable test content' }]);

      const results = await adapter.keywordSearch('searchable', 10, {});
      expect(results).toHaveLength(1);
      expect(results[0]?.snippet).toContain('searchable');
    });
  });

  describe('integrity', () => {
    it('should reject chunks for missing documents', async () => {
      await expect(
        adapter.insertChunks(999999, [{ content: 'invalid doc reference' }]),
      ).rejects.toThrow();
    });
  });
});
