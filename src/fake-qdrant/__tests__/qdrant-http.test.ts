import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { Store } from '../store.js';
import { startQdrantHttpServer, QdrantHttpServerHandle, summarizeHttpBody } from '../qdrant-http.js';
import { resolveDataDir } from '../store.js';
import { acquireProcessLock, lockDirForDataDir } from '../disk-gate.js';
import fs from 'fs/promises';
import path from 'path';

describe('Fake Qdrant HTTP API Integration Tests', () => {
  let server: QdrantHttpServerHandle | null = null;
  let store: Store | null = null;
  let testDataDir: string;
  let testPort: number;
  let baseUrl: string;

  beforeEach(async () => {
    // Create a unique test data directory
    testDataDir = path.join(resolveDataDir(), `test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    await fs.mkdir(testDataDir, { recursive: true });
    
    store = await Store.create({ dataDir: testDataDir });
    
    // Use dynamic port (0 = OS assigns a free port)
    testPort = 0;
    server = await startQdrantHttpServer({
      store,
      host: '127.0.0.1',
      port: testPort,
      logger: () => {}, // Suppress logs during tests
    });
    
    // Get the actual port assigned by the OS
    testPort = server.port;
    baseUrl = `http://127.0.0.1:${testPort}`;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    // Drop in-memory collections before removing files
    if (store) {
      await store.close();
    }
    if (testDataDir) {
      try {
        await fs.rm(testDataDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  function httpRequest(
    method: string,
    urlPath: string,
    body?: unknown
  ): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, baseUrl);
      const options: http.RequestOptions = {
        method,
        hostname: url.hostname,
        port: testPort,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            resolve({ status: res.statusCode || 500, data: parsed });
          } catch (error) {
            resolve({ status: res.statusCode || 500, data: data });
          }
        });
      });

      req.on('error', reject);

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  function queryHits(data: any): Array<{ id: unknown; score?: number; payload?: unknown }> {
    if (Array.isArray(data?.result?.points)) {
      return data.result.points;
    }
    if (Array.isArray(data?.result)) {
      return data.result;
    }
    return [];
  }

  describe('Health Check', () => {
    it('should return ok status on root endpoint', async () => {
      const response = await httpRequest('GET', '/');
      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({ status: 'ok' });
    });

    it('should return ok status on /health and /healthz', async () => {
      const health = await httpRequest('GET', '/health');
      expect(health.status).toBe(200);
      expect(health.data).toMatchObject({ status: 'ok' });
      const healthz = await httpRequest('GET', '/healthz');
      expect(healthz.status).toBe(200);
      expect(healthz.data).toMatchObject({ status: 'ok' });
      expect(Number.isInteger((healthz.data as { pid?: number }).pid)).toBe(true);
    });

    it('should accept HEAD and trailing slash on /healthz', async () => {
      const slash = await httpRequest('GET', '/healthz/');
      expect(slash.status).toBe(200);
      expect(slash.data).toMatchObject({ status: 'ok' });
      const head = await httpRequest('HEAD', '/healthz');
      expect(head.status).toBe(200);
    });

    it('should return ok on /readyz', async () => {
      const response = await httpRequest('GET', '/readyz');
      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({ status: 'ok' });
    });
  });

  describe('Collections', () => {
    it('should list empty collections', async () => {
      const response = await httpRequest('GET', '/collections');
      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        result: {
          collections: [],
        },
        status: 'ok',
      });
    });

    it('should create a collection', async () => {
      const response = await httpRequest('PUT', '/collections/test-collection', {
        vectors: {
          size: 128,
          distance: 'Cosine',
        },
      });
      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        result: true,
        status: 'ok',
      });
    });

    it('should create a collection with alternative vector format', async () => {
      const response = await httpRequest('PUT', '/collections/test-collection-2', {
        vector_size: 64,
        distance: 'Cosine',
      });
      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        result: true,
        status: 'ok',
      });
    });

    it('should reject collection creation without vector size', async () => {
      const response = await httpRequest('PUT', '/collections/invalid', {
        distance: 'Cosine',
      });
      expect(response.status).toBe(400);
      expect(response.data).toMatchObject({
        status: {
          error: 'missing vector size',
        },
      });
    });

    it('should list collections after creation', async () => {
      await httpRequest('PUT', '/collections/test-collection', {
        vectors: { size: 128, distance: 'Cosine' },
      });

      const response = await httpRequest('GET', '/collections');
      expect(response.status).toBe(200);
      expect(response.data.result.collections).toHaveLength(1);
      expect(response.data.result.collections[0]).toMatchObject({
        name: 'test-collection',
        status: 'green',
        config: {
          params: {
            vectors: {
              size: 128,
              distance: 'Cosine',
            },
          },
        },
      });
    });

    it('should get collection info', async () => {
      await httpRequest('PUT', '/collections/test-collection', {
        vectors: { size: 128, distance: 'Cosine' },
      });

      const response = await httpRequest('GET', '/collections/test-collection');
      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        result: {
          name: 'test-collection',
          vectors: {
            size: 128,
            distance: 'Cosine',
          },
          status: 'green',
        },
        status: 'ok',
      });
    });

    it('should return 404 for non-existent collection', async () => {
      const response = await httpRequest('GET', '/collections/non-existent');
      expect(response.status).toBe(404);
      expect(response.data).toMatchObject({
        status: {
          error: 'collection not found',
        },
      });
    });

    it('should delete a collection', async () => {
      await httpRequest('PUT', '/collections/test-collection', {
        vectors: { size: 128, distance: 'Cosine' },
      });

      const deleteResponse = await httpRequest('DELETE', '/collections/test-collection');
      expect(deleteResponse.status).toBe(200);
      expect(deleteResponse.data).toMatchObject({
        result: true,
        status: 'ok',
      });

      const getResponse = await httpRequest('GET', '/collections/test-collection');
      expect(getResponse.status).toBe(404);
    });
  });

  describe('Points - Upsert', () => {
    beforeEach(async () => {
      await httpRequest('PUT', '/collections/test-collection', {
        vectors: { size: 3, distance: 'Cosine' },
      });
    });

    it('should upsert points', async () => {
      const response = await httpRequest('PUT', '/collections/test-collection/points', {
        points: [
          {
            id: 1,
            vector: [0.1, 0.2, 0.3],
            payload: { key: 'value1' },
          },
          {
            id: 2,
            vector: [0.4, 0.5, 0.6],
            payload: { key: 'value2' },
          },
        ],
      });
      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        result: {
          operation_id: 0,
          status: 'completed',
        },
        status: 'ok',
      });
    });

    it('should reject upsert without points array', async () => {
      const response = await httpRequest('PUT', '/collections/test-collection/points', {
        invalid: 'data',
      });
      expect(response.status).toBe(400);
      expect(response.data).toMatchObject({
        status: {
          error: 'missing points[]',
        },
      });
    });

    it('should reject upsert with invalid vector dimension', async () => {
      const response = await httpRequest('PUT', '/collections/test-collection/points', {
        points: [
          {
            id: 1,
            vector: [0.1, 0.2], // Wrong dimension
          },
        ],
      });
      expect(response.status).toBe(400);
    });

    it('should reject upsert with missing id', async () => {
      const response = await httpRequest('PUT', '/collections/test-collection/points', {
        points: [
          {
            vector: [0.1, 0.2, 0.3],
          },
        ],
      });
      expect(response.status).toBe(400);
      expect(response.data).toMatchObject({
        status: {
          error: 'each point must include id and vector',
        },
      });
    });

    it('should reject upsert with non-finite vector values', async () => {
      const response = await httpRequest('PUT', '/collections/test-collection/points', {
        points: [
          {
            id: 1,
            vector: [0.1, Infinity, 0.3],
          },
        ],
      });
      expect(response.status).toBe(400);
      expect(response.data).toMatchObject({
        status: {
          error: 'vectors must contain finite numbers',
        },
      });
    });
  });

  describe('Points - Query', () => {
    beforeEach(async () => {
      await httpRequest('PUT', '/collections/test-collection', {
        vectors: { size: 3, distance: 'Cosine' },
      });
      await httpRequest('PUT', '/collections/test-collection/points', {
        points: [
          {
            id: 1,
            vector: [1, 0, 0],
            payload: { name: 'point1' },
          },
          {
            id: 2,
            vector: [0, 1, 0],
            payload: { name: 'point2' },
          },
          {
            id: 3,
            vector: [0, 0, 1],
            payload: { name: 'point3' },
          },
        ],
      });
    });

    it('should query points with vector', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/query', {
        vector: [1, 0, 0],
        limit: 2,
      });
      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        status: 'ok',
      });
      const hits = queryHits(response.data);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]).toHaveProperty('id');
      expect(hits[0]).toHaveProperty('score');
    });

    it('should query points with query.vector format', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/query', {
        query: {
          vector: [1, 0, 0],
        },
        limit: 2,
      });
      expect(response.status).toBe(200);
      expect(response.data.status).toBe('ok');
      expect(Array.isArray(queryHits(response.data))).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/query', {
        vector: [1, 0, 0],
        limit: 1,
      });
      expect(response.status).toBe(200);
      expect(queryHits(response.data).length).toBeLessThanOrEqual(1);
    });

    it('should respect score_threshold parameter', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/query', {
        vector: [1, 0, 0],
        limit: 10,
        score_threshold: 0.9,
      });
      expect(response.status).toBe(200);
      const hits = queryHits(response.data);
      if (hits.length > 0) {
        expect(hits[0].score).toBeGreaterThanOrEqual(0.9);
      }
    });

    it('should list points by id when query is omitted', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/query', {
        limit: 10,
      });
      expect(response.status).toBe(200);
      const hits = queryHits(response.data);
      expect(hits.map((hit) => hit.id)).toEqual([1, 2, 3]);
      expect(hits.every((hit) => hit.score === 0)).toBe(true);
    });

    it('should return empty results for empty collection', async () => {
      await httpRequest('PUT', '/collections/empty-collection', {
        vectors: { size: 3, distance: 'Cosine' },
      });
      const response = await httpRequest('POST', '/collections/empty-collection/points/query', {
        vector: [1, 0, 0],
        limit: 10,
      });
      expect(response.status).toBe(200);
      expect(queryHits(response.data)).toEqual([]);
    });
  });

  describe('Query API fidelity', () => {
    beforeEach(async () => {
      await httpRequest('PUT', '/collections/test-collection', {
        vectors: { size: 3, distance: 'Cosine' },
      });
      await httpRequest('PUT', '/collections/test-collection/points', {
        points: [
          { id: 1, vector: [1, 0, 0], payload: { name: 'point1', tag: 'a' } },
          { id: 2, vector: [0, 1, 0], payload: { name: 'point2', tag: 'b' } },
          { id: 3, vector: [0, 0, 1], payload: { name: 'point3', tag: 'c' } },
        ],
      });
    });

    it('accepts canonical query as a raw vector array', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/query', {
        query: [1, 0, 0],
        limit: 1,
      });
      expect(response.status).toBe(200);
      expect(queryHits(response.data)[0].id).toBe(1);
      expect(queryHits(response.data)[0]).toHaveProperty('version');
      expect(queryHits(response.data)[0].payload).toBeUndefined();
    });

    it('accepts query.nearest as a vector', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/query', {
        query: { nearest: [1, 0, 0] },
        limit: 1,
      });
      expect(response.status).toBe(200);
      expect(queryHits(response.data)[0].id).toBe(1);
    });

    it('queries nearest-by-id and excludes the origin point', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/query', {
        query: { nearest: 1 },
        limit: 10,
      });
      expect(response.status).toBe(200);
      const ids = queryHits(response.data).map((hit) => hit.id);
      expect(ids).not.toContain(1);
      expect(ids.length).toBeGreaterThan(0);
    });

    it('applies offset after scoring', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/query', {
        query: [1, 0, 0],
        limit: 10,
        offset: 1,
      });
      expect(response.status).toBe(200);
      const ids = queryHits(response.data).map((hit) => hit.id);
      expect(ids).not.toContain(1);
    });

    it('projects payload include lists and optional vectors', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/query', {
        query: [1, 0, 0],
        limit: 1,
        with_payload: ['name'],
        with_vector: true,
      });
      expect(response.status).toBe(200);
      const hit = queryHits(response.data)[0];
      expect(hit.payload).toEqual({ name: 'point1' });
      expect(hit.vector).toEqual([1, 0, 0]);
    });

    it('returns negative cosine scores when score_threshold is omitted', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/query', {
        query: [-1, 0, 0],
        limit: 10,
      });
      expect(response.status).toBe(200);
      const hits = queryHits(response.data);
      const opposite = hits.find((hit) => hit.id === 1);
      expect(opposite).toBeDefined();
      expect(opposite?.score).toBeLessThan(0);
    });

    it('returns a flat result from /points/search', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/search', {
        vector: [1, 0, 0],
        limit: 1,
      });
      expect(response.status).toBe(200);
      expect(Array.isArray(response.data.result)).toBe(true);
      expect(response.data.result[0].id).toBe(1);
    });

    it('runs query and search batch endpoints', async () => {
      const queryBatch = await httpRequest('POST', '/collections/test-collection/points/query/batch', {
        searches: [{ query: [1, 0, 0], limit: 1 }, { query: [0, 1, 0], limit: 1 }],
      });
      expect(queryBatch.status).toBe(200);
      expect(queryBatch.data.result).toHaveLength(2);
      expect(queryBatch.data.result[0].points[0].id).toBe(1);
      expect(queryBatch.data.result[1].points[0].id).toBe(2);

      const searchBatch = await httpRequest('POST', '/collections/test-collection/points/search/batch', {
        searches: [{ vector: [1, 0, 0], limit: 1 }],
      });
      expect(searchBatch.status).toBe(200);
      expect(searchBatch.data.result[0][0].id).toBe(1);
    });

    it('mutates payloads with set, overwrite, delete, and clear', async () => {
      const setRes = await httpRequest('POST', '/collections/test-collection/points/payload', {
        payload: { extra: true },
        points: [1],
      });
      expect(setRes.status).toBe(200);
      expect(setRes.data.result.status).toBe('completed');

      const retrieved = await httpRequest('POST', '/collections/test-collection/points', {
        ids: [1],
      });
      expect(retrieved.data.result.points[0].payload).toMatchObject({
        name: 'point1',
        extra: true,
      });

      const overwrite = await httpRequest('PUT', '/collections/test-collection/points/payload', {
        payload: { only: 'x' },
        points: [1],
      });
      expect(overwrite.status).toBe(200);
      const afterOverwrite = await httpRequest('POST', '/collections/test-collection/points', {
        ids: [1],
      });
      expect(retrieved.data.result.points[0].payload).toBeDefined();
      expect(afterOverwrite.data.result.points[0].payload).toEqual({ only: 'x' });

      const deleted = await httpRequest('POST', '/collections/test-collection/points/payload/delete', {
        keys: ['only'],
        points: [1],
      });
      expect(deleted.status).toBe(200);
      const afterDelete = await httpRequest('POST', '/collections/test-collection/points', {
        ids: [1],
      });
      expect(afterDelete.data.result.points[0].payload).toEqual({});

      const cleared = await httpRequest('POST', '/collections/test-collection/points/payload/clear', {
        points: [2],
      });
      expect(cleared.status).toBe(200);
      const afterClear = await httpRequest('POST', '/collections/test-collection/points', {
        ids: [2],
      });
      expect(afterClear.data.result.points[0].payload).toEqual({});
    });

    it('reports collection existence and Qdrant-shaped GET info', async () => {
      const exists = await httpRequest('GET', '/collections/test-collection/exists');
      expect(exists.status).toBe(200);
      expect(exists.data.result.exists).toBe(true);
      const missing = await httpRequest('GET', '/collections/nope/exists');
      expect(missing.data.result.exists).toBe(false);

      const info = await httpRequest('GET', '/collections/test-collection');
      expect(info.status).toBe(200);
      expect(info.data.result).toMatchObject({
        name: 'test-collection',
        status: 'green',
        optimizer_status: 'ok',
        points_count: 3,
        segments_count: 1,
        config: {
          params: {
            vectors: { size: 3, distance: 'Cosine' },
          },
        },
      });
      expect(info.data.result.pointsCount).toBe(3);
    });

    it('returns 400 for prefetch and unsupported filters', async () => {
      const prefetch = await httpRequest('POST', '/collections/test-collection/points/query', {
        query: [1, 0, 0],
        prefetch: [{ query: [1, 0, 0] }],
      });
      expect(prefetch.status).toBe(400);
      expect(prefetch.data.status.error).toMatch(/Unsupported query: prefetch/);

      const filter = await httpRequest('POST', '/collections/test-collection/points/query', {
        query: [1, 0, 0],
        filter: { must: [{ key: 'name', match: { text: 'point1' } }] },
      });
      expect(filter.status).toBe(400);
      expect(filter.data.status.error).toMatch(/Unsupported filter: match.text/);
    });
  });

  describe('Points - Delete', () => {
    beforeEach(async () => {
      await httpRequest('PUT', '/collections/test-collection', {
        vectors: { size: 3, distance: 'Cosine' },
      });
      await httpRequest('PUT', '/collections/test-collection/points', {
        points: [
          {
            id: 1,
            vector: [1, 0, 0],
            payload: { path: '/file1.txt' },
          },
          {
            id: 2,
            vector: [0, 1, 0],
            payload: { path: '/file2.txt' },
          },
          {
            id: 3,
            vector: [0, 0, 1],
            payload: { path: '/file3.txt' },
          },
        ],
      });
    });

    it('should delete points by IDs', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/delete', {
        points: [1, 2],
      });
      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        result: {
          operation_id: 0,
          status: 'completed',
        },
        status: 'ok',
      });

      // Verify points were deleted by querying
      const queryResponse = await httpRequest('POST', '/collections/test-collection/points/query', {
        vector: [1, 0, 0],
        limit: 10,
      });
      const remainingIds = queryHits(queryResponse.data).map((r) => r.id);
      expect(remainingIds).not.toContain(1);
      expect(remainingIds).not.toContain(2);
      expect(remainingIds).toContain(3);
    });

    it('should delete points by filter', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/delete', {
        filter: {
          must: [
            {
              key: 'path',
              match: {
                value: '/file1.txt',
              },
            },
          ],
        },
      });
      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        result: {
          operation_id: 0,
          status: 'completed',
        },
        status: 'ok',
      });

      // Verify point was deleted
      const queryResponse = await httpRequest('POST', '/collections/test-collection/points/query', {
        vector: [1, 0, 0],
        limit: 10,
      });
      const remainingIds = queryHits(queryResponse.data).map((r) => r.id);
      expect(remainingIds).not.toContain(1);
    });

    it('should reject delete without points or filter', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/delete', {});
      expect(response.status).toBe(400);
      expect(response.data).toMatchObject({
        status: {
          error: 'missing points[] or filter',
        },
      });
    });
  });

  describe('Collection Compact', () => {
    beforeEach(async () => {
      await httpRequest('PUT', '/collections/test-collection', {
        vectors: { size: 3, distance: 'Cosine' },
      });
    });

    it('should compact an empty collection', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/compact');
      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        result: {
          unique_points: 0,
        },
        status: 'ok',
      });
    });

    it('should compact a collection with points', async () => {
      await httpRequest('PUT', '/collections/test-collection/points', {
        points: [
          {
            id: 1,
            vector: [1, 0, 0],
            payload: { key: 'value' },
          },
        ],
      });

      const response = await httpRequest('POST', '/collections/test-collection/compact');
      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        result: {
          unique_points: 1,
        },
        status: 'ok',
      });
    });
  });

  describe('RooCode HTTP dialect', () => {
    it('keeps points when PUT collection is repeated with the same size', async () => {
      await httpRequest('PUT', '/collections/keep', {
        vectors: { size: 2, distance: 'Cosine' },
      });
      await httpRequest('PUT', '/collections/keep/points', {
        points: [{ id: 1, vector: [1, 0], payload: { keep: true } }],
      });
      const again = await httpRequest('PUT', '/collections/keep', {
        vectors: { size: 2, distance: 'Cosine' },
      });
      expect(again.status).toBe(200);
      const listed = await httpRequest('GET', '/collections');
      expect(listed.data.result.collections[0].points_count).toBe(1);
    });

    it('returns 409 when PUT collection size mismatches', async () => {
      await httpRequest('PUT', '/collections/sized', {
        vectors: { size: 2, distance: 'Cosine' },
      });
      const response = await httpRequest('PUT', '/collections/sized', {
        vectors: { size: 8, distance: 'Cosine' },
      });
      expect(response.status).toBe(409);
    });

    it('creates payload indexes and persists them in meta.json', async () => {
      await httpRequest('PUT', '/collections/idx', {
        vectors: { size: 2, distance: 'Cosine' },
      });
      const created = await httpRequest('PUT', '/collections/idx/index', {
        field_name: 'pathSegments.0',
        field_schema: 'keyword',
      });
      expect(created.status).toBe(200);
      const again = await httpRequest('PUT', '/collections/idx/index', {
        field_name: 'pathSegments.0',
        field_schema: 'keyword',
      });
      expect(again.status).toBe(200);
      const metaRaw = await fs.readFile(
        path.join(testDataDir, 'idx', 'meta.json'),
        'utf8'
      );
      const meta = JSON.parse(metaRaw);
      expect(meta.indexes).toEqual(['pathSegments.0']);
    });

    it('returns 404 for index on a missing collection', async () => {
      const response = await httpRequest('PUT', '/collections/nope/index', {
        field_name: 'type',
      });
      expect(response.status).toBe(404);
    });

    it('returns 400 when field_name is missing', async () => {
      await httpRequest('PUT', '/collections/idx2', {
        vectors: { size: 2, distance: 'Cosine' },
      });
      const response = await httpRequest('PUT', '/collections/idx2/index', {});
      expect(response.status).toBe(400);
    });

    it('deletes nested RooCode pathSegments filters', async () => {
      await httpRequest('PUT', '/collections/roo', {
        vectors: { size: 2, distance: 'Cosine' },
      });
      await httpRequest('PUT', '/collections/roo/index', {
        field_name: 'pathSegments.0',
      });
      await httpRequest('PUT', '/collections/roo/points', {
        points: [
          {
            id: 1,
            vector: [1, 0],
            payload: { pathSegments: ['config.py'] },
          },
          {
            id: 2,
            vector: [0, 1],
            payload: { pathSegments: ['keep.py'] },
          },
        ],
      });
      const del = await httpRequest('POST', '/collections/roo/points/delete', {
        filter: {
          should: [
            { must: [{ key: 'pathSegments.0', match: { value: 'config.py' } }] },
          ],
        },
      });
      expect(del.status).toBe(200);
      expect(del.data.result.deleted).toBe(1);
      const count = await httpRequest('POST', '/collections/roo/points/count', {});
      expect(count.data.result.count).toBe(1);
    });

    it('does not delete re-upserted points when the same filter is retried within 60s', async () => {
      await httpRequest('PUT', '/collections/dedup', {
        vectors: { size: 2, distance: 'Cosine' },
      });
      const filter = {
        must: [{ key: 'path', match: { value: '/dup.md' } }],
      };
      await httpRequest('PUT', '/collections/dedup/points', {
        points: [{ id: 1, vector: [1, 0], payload: { path: '/dup.md' } }],
      });
      const first = await httpRequest('POST', '/collections/dedup/points/delete', {
        filter,
      });
      expect(first.data.result.deleted).toBe(1);
      await httpRequest('PUT', '/collections/dedup/points', {
        points: [{ id: 2, vector: [1, 0], payload: { path: '/dup.md' } }],
      });
      const second = await httpRequest('POST', '/collections/dedup/points/delete', {
        filter,
      });
      expect(second.status).toBe(200);
      expect(second.data.result.dedup).toBe(true);
      const count = await httpRequest('POST', '/collections/dedup/points/count', {});
      expect(count.data.result.count).toBe(1);
    });

    it('scrolls, retrieves, counts, and filters queries', async () => {
      await httpRequest('PUT', '/collections/extra', {
        vectors: { size: 2, distance: 'Cosine' },
      });
      await httpRequest('PUT', '/collections/extra/points', {
        points: [
          { id: 1, vector: [1, 0], payload: { type: 'code' } },
          { id: 2, vector: [0, 1], payload: { type: 'md' } },
        ],
      });
      const scrolled = await httpRequest('POST', '/collections/extra/points/scroll', {
        limit: 1,
        offset: 0,
      });
      expect(scrolled.status).toBe(200);
      expect(scrolled.data.result.points).toHaveLength(1);
      const retrieved = await httpRequest('POST', '/collections/extra/points', {
        ids: [2],
      });
      expect(retrieved.data.result.points[0].id).toBe(2);
      const counted = await httpRequest('POST', '/collections/extra/points/count', {
        filter: { must: [{ key: 'type', match: { value: 'md' } }] },
      });
      expect(counted.data.result.count).toBe(1);
      const queried = await httpRequest('POST', '/collections/extra/points/query', {
        vector: [1, 0],
        filter: { must: [{ key: 'type', match: { value: 'code' } }] },
      });
      expect(queryHits(queried.data).map((hit) => hit.id)).toEqual([1]);
    });

    it('exposes metrics', async () => {
      const response = await httpRequest('GET', '/metrics');
      expect(response.status).toBe(200);
      expect(response.data.result).toHaveProperty('busy');
      expect(Array.isArray(response.data.result.collections)).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should return 404 for unknown endpoints', async () => {
      const response = await httpRequest('GET', '/unknown-endpoint');
      expect(response.status).toBe(404);
      expect(response.data).toMatchObject({
        status: {
          error: 'not found',
        },
      });
    });

    it('should handle OPTIONS requests', async () => {
      const response = await httpRequest('OPTIONS', '/collections');
      expect(response.status).toBe(200);
    });
  });

  describe('CORS Headers', () => {
    it('should include CORS headers in responses', async () => {
      return new Promise<void>((resolve, reject) => {
        const url = new URL('/healthz', baseUrl);
        const req = http.request(
          {
            method: 'GET',
            hostname: url.hostname,
            port: testPort,
            path: url.pathname,
          },
          (res) => {
            expect(res.headers['access-control-allow-origin']).toBe('*');
            expect(res.headers['access-control-allow-headers']).toBe('*');
            expect(res.headers['access-control-allow-methods']).toContain('GET');
            resolve();
          }
        );
        req.on('error', reject);
        req.end();
      });
    });
  });
});

describe('Fake Qdrant HTTP API when the data dir is locked', () => {
  let server: QdrantHttpServerHandle | null = null;
  let store: Store | null = null;
  let testDataDir: string;
  let extraLock: { release(): Promise<void> } | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    if (store) {
      await store.close();
      store = null;
    }
    if (extraLock) {
      await extraLock.release();
      extraLock = undefined;
    }
    if (testDataDir) {
      await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('returns 503 when another live process holds the write lock', async () => {
    testDataDir = path.join(
      resolveDataDir(),
      `busy-${Date.now()}-${Math.random().toString(36).substring(7)}`
    );
    await fs.mkdir(testDataDir, { recursive: true });
    extraLock = await acquireProcessLock({
      lockDir: lockDirForDataDir(testDataDir),
      pid: 424242,
      isAlive: () => true,
      retries: 0,
    });
    store = await Store.create({
      dataDir: testDataDir,
      lockRetries: 0,
      lockRetryMs: 1,
    });
    expect(store.isBusy).toBe(true);
    server = await startQdrantHttpServer({
      store,
      host: '127.0.0.1',
      port: 0,
      logger: () => {},
    });
    const testPort = server.port;
    const list = await new Promise<{ status: number; data: unknown }>((resolve, reject) => {
      const req = http.request(
        {
          method: 'GET',
          hostname: '127.0.0.1',
          port: testPort,
          path: '/collections',
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode || 500,
              data: data ? JSON.parse(data) : {},
            });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(list.status).toBe(503);
    expect(list.data).toMatchObject({
      status: { error: 'service busy' },
    });

    const body = JSON.stringify({
      vectors: { size: 2, distance: 'Cosine' },
    });
    const created = await new Promise<{ status: number; data: unknown }>((resolve, reject) => {
      const req = http.request(
        {
          method: 'PUT',
          hostname: '127.0.0.1',
          port: testPort,
          path: '/collections/blocked',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            resolve({
              status: res.statusCode || 500,
              data: data ? JSON.parse(data) : {},
            });
          });
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    expect(created.status).toBe(503);
    expect(created.data).toMatchObject({
      status: { error: 'service busy' },
    });
  });
});

describe('strict collection create', () => {
  let server: QdrantHttpServerHandle | null = null;
  let store: Store | null = null;
  let testDataDir: string;

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    if (store) {
      await store.close();
    }
    if (testDataDir) {
      await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('returns 409 when FAKE_QDRANT_STRICT_CREATE is enabled', async () => {
    testDataDir = path.join(
      resolveDataDir(),
      `strict-${Date.now()}-${Math.random().toString(36).substring(7)}`
    );
    await fs.mkdir(testDataDir, { recursive: true });
    store = await Store.create({ dataDir: testDataDir });
    server = await startQdrantHttpServer({
      store,
      host: '127.0.0.1',
      port: 0,
      logger: () => {},
      strictCreate: true,
    });
    const port = server.port;
    const put = (name: string) =>
      new Promise<{ status: number; data: any }>((resolve, reject) => {
        const body = JSON.stringify({ vectors: { size: 2, distance: 'Cosine' } });
        const req = http.request(
          {
            method: 'PUT',
            hostname: '127.0.0.1',
            port,
            path: `/collections/${name}`,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk.toString();
            });
            res.on('end', () => {
              resolve({
                status: res.statusCode || 500,
                data: data ? JSON.parse(data) : {},
              });
            });
          }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    const first = await put('dup');
    expect(first.status).toBe(200);
    const second = await put('dup');
    expect(second.status).toBe(409);
    expect(second.data.status.error).toMatch(/already exists/);
  });
});

describe('summarizeHttpBody', () => {
  it('clips codeChunk strings to 200 characters', () => {
    const long = 'x'.repeat(500);
    const summarized = summarizeHttpBody({
      points: [{ payload: { codeChunk: long, path: '/a.ts' } }],
    }) as { points: Array<{ payload: { codeChunk: { preview: string; length: number } } }> };
    expect(summarized.points[0].payload.codeChunk.length).toBe(500);
    expect(summarized.points[0].payload.codeChunk.preview).toHaveLength(200);
  });
});
