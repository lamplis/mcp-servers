import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { Store } from '../store.js';
import { startQdrantHttpServer, QdrantHttpServerHandle } from '../qdrant-http.js';
import { resolveDataDir } from '../store.js';
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

  describe('Health Check', () => {
    it('should return ok status on root endpoint', async () => {
      const response = await httpRequest('GET', '/');
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ status: 'ok' });
    });

    it('should return ok status on /healthz endpoint', async () => {
      const response = await httpRequest('GET', '/healthz');
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ status: 'ok' });
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
      expect(Array.isArray(response.data.result)).toBe(true);
      expect(response.data.result.length).toBeGreaterThan(0);
      expect(response.data.result[0]).toHaveProperty('id');
      expect(response.data.result[0]).toHaveProperty('score');
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
      expect(Array.isArray(response.data.result)).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/query', {
        vector: [1, 0, 0],
        limit: 1,
      });
      expect(response.status).toBe(200);
      expect(response.data.result.length).toBeLessThanOrEqual(1);
    });

    it('should respect score_threshold parameter', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/query', {
        vector: [1, 0, 0],
        limit: 10,
        score_threshold: 0.9,
      });
      expect(response.status).toBe(200);
      if (response.data.result.length > 0) {
        expect(response.data.result[0].score).toBeGreaterThanOrEqual(0.9);
      }
    });

    it('should reject query without vector', async () => {
      const response = await httpRequest('POST', '/collections/test-collection/points/query', {
        limit: 10,
      });
      expect(response.status).toBe(400);
      expect(response.data).toMatchObject({
        status: {
          error: 'missing query vector',
        },
      });
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
      expect(response.data.result).toEqual([]);
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
      const remainingIds = queryResponse.data.result.map((r: { id: unknown }) => r.id);
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
      const remainingIds = queryResponse.data.result.map((r: { id: unknown }) => r.id);
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
