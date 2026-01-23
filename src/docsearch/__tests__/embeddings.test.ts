import { fetch } from 'undici';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('undici', () => ({
  fetch: vi.fn(),
}));

// Mock @xenova/transformers - use vi.hoisted for proper hoisting
const { mockPipeline, mockEnv } = vi.hoisted(() => ({
  mockPipeline: vi.fn(),
  mockEnv: {
    cacheDir: '',
    allowLocalModels: true,
    useBrowserCache: false,
    allowRemoteModels: false,
  },
}));

vi.mock('@xenova/transformers', () => ({
  pipeline: mockPipeline,
  env: mockEnv,
}));

const mockFetch = vi.mocked(fetch);

// Helper function to create mock Response objects
const createMockResponse = (init: {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  json?: () => Promise<any>;
  text?: () => Promise<string>;
}): any => {
  const headers = new Map(Object.entries(init.headers || {}));
  return {
    ok: init.ok,
    status: init.status,
    statusText: init.statusText || 'OK',
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) || null,
      has: (name: string) => headers.has(name.toLowerCase()),
      keys: () => headers.keys(),
      values: () => headers.values(),
      entries: () => headers.entries(),
      [Symbol.iterator]: () => headers.entries(),
      forEach: (callback: any) => headers.forEach(callback),
    },
    json: init.json || vi.fn(),
    text: init.text || vi.fn(),
    blob: vi.fn(),
    arrayBuffer: vi.fn(),
    formData: vi.fn(),
    bytes: vi.fn(),
    clone: vi.fn(),
    body: null,
    bodyUsed: false,
    redirected: false,
    type: 'basic',
    url: 'https://api.openai.com/v1/embeddings',
  };
};

describe('Embeddings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('OpenAIEmbedder', () => {
    beforeEach(() => {
      vi.doMock('../shared/config.js', () => ({
        CONFIG: {
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'https://api.openai.com/v1',
          OPENAI_EMBED_MODEL: 'text-embedding-3-small',
          OPENAI_EMBED_DIM: 1536,
          TEI_ENDPOINT: 'http://localhost:8080',
          EMBEDDINGS_PROVIDER: 'openai',
        },
      }));
    });

    it('should initialize with correct configuration', async () => {
      const { OpenAIEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new OpenAIEmbedder();
      expect(embedder.dim).toBe(1536);
    });

    it('should throw error if API key is missing', async () => {
      vi.doMock('../shared/config.js', () => ({
        CONFIG: {
          OPENAI_API_KEY: '',
          OPENAI_BASE_URL: 'https://api.openai.com/v1',
          OPENAI_EMBED_MODEL: 'text-embedding-3-small',
          OPENAI_EMBED_DIM: 1536,
          TEI_ENDPOINT: 'http://localhost:8080',
          EMBEDDINGS_PROVIDER: 'openai',
        },
      }));

      const { OpenAIEmbedder } = await import('../ingest/embeddings.js');
      expect(() => new OpenAIEmbedder()).toThrow('OPENAI_API_KEY missing');
    });

    it('should return empty array for empty input', async () => {
      const { OpenAIEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new OpenAIEmbedder();
      const result = await embedder.embed([]);
      expect(result).toEqual([]);
    });

    it('should make correct API call and return embeddings', async () => {
      const { OpenAIEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new OpenAIEmbedder();

      const mockResponse = createMockResponse({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
        }),
      });
      mockFetch.mockResolvedValue(mockResponse);

      const result = await embedder.embed(['text1', 'text2']);

      expect(mockFetch).toHaveBeenCalledWith('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-key',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: ['text1', 'text2'],
        }),
      });

      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(Float32Array);
      expect(Array.from(result[0]!)).toEqual(
        expect.arrayContaining([
          expect.closeTo(0.1, 5),
          expect.closeTo(0.2, 5),
          expect.closeTo(0.3, 5),
        ]),
      );
      expect(Array.from(result[1]!)).toEqual(
        expect.arrayContaining([
          expect.closeTo(0.4, 5),
          expect.closeTo(0.5, 5),
          expect.closeTo(0.6, 5),
        ]),
      );
    });

    it('should handle API errors', async () => {
      const { OpenAIEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new OpenAIEmbedder();

      const mockResponse = createMockResponse({
        ok: false,
        status: 401,
        text: vi.fn().mockResolvedValue('Unauthorized'),
      });
      mockFetch.mockResolvedValue(mockResponse);

      await expect(embedder.embed(['text'])).rejects.toThrow(
        'Embeddings API error 401: Unauthorized',
      );
    });

    it('should handle rate limiting with retry-after header', async () => {
      vi.useFakeTimers();

      const { OpenAIEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new OpenAIEmbedder();

      // Mock console.log to verify output
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First call returns rate limit
          return createMockResponse({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            headers: {
              'retry-after': '2',
              'x-ratelimit-remaining-requests': '0',
              'x-ratelimit-remaining-tokens': '1000',
            },
            text: vi.fn().mockResolvedValue('Rate limit exceeded'),
          });
        } else {
          // Second call succeeds
          return createMockResponse({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({
              data: [{ embedding: [0.1, 0.2, 0.3] }],
            }),
          });
        }
      });

      const embedPromise = embedder.embed(['test text']);

      // Fast forward through the retry delay
      await vi.advanceTimersByTimeAsync(2000);

      const result = await embedPromise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Rate limit exceeded (attempt 1/5)'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Remaining requests: 0'));
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Waiting 2s before retrying...'),
      );

      consoleSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should handle rate limiting with exponential backoff when no retry-after header', async () => {
      vi.useFakeTimers();

      const { OpenAIEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new OpenAIEmbedder();

      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return createMockResponse({
            ok: false,
            status: 429,
            text: vi.fn().mockResolvedValue('Rate limit exceeded'),
          });
        } else {
          return createMockResponse({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({
              data: [{ embedding: [0.1, 0.2, 0.3] }],
            }),
          });
        }
      });

      const embedPromise = embedder.embed(['test text']);

      // Fast forward through the retry delay (1s for first attempt)
      await vi.advanceTimersByTimeAsync(1000);

      const result = await embedPromise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Rate limit exceeded (attempt 1/5)'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Waiting 1s before retrying...'),
      );

      consoleSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should fail after max retries on persistent rate limiting', async () => {
      const { OpenAIEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new OpenAIEmbedder();

      // Mock the sleep method to be synchronous
      const sleepSpy = vi.spyOn(embedder as any, 'sleep').mockResolvedValue(undefined);

      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const mockResponse = createMockResponse({
        ok: false,
        status: 429,
        text: vi.fn().mockResolvedValue('Rate limit exceeded'),
      });
      mockFetch.mockResolvedValue(mockResponse);

      await expect(embedder.embed(['test text'])).rejects.toThrow('Rate limit exceeded');
      expect(mockFetch).toHaveBeenCalledTimes(5); // maxRetries = 5
      expect(sleepSpy).toHaveBeenCalledTimes(4); // 4 sleep calls between 5 attempts

      consoleSpy.mockRestore();
      sleepSpy.mockRestore();
    });

    it('should handle network errors with retry', async () => {
      vi.useFakeTimers();

      const { OpenAIEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new OpenAIEmbedder();

      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network error');
        } else {
          return createMockResponse({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({
              data: [{ embedding: [0.1, 0.2, 0.3] }],
            }),
          });
        }
      });

      const embedPromise = embedder.embed(['test text']);

      // Fast forward through the retry delay (1s for first attempt)
      await vi.advanceTimersByTimeAsync(1000);

      const result = await embedPromise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Network error (attempt 1/5): Network error'),
      );

      consoleSpy.mockRestore();
      vi.useRealTimers();
    });
  });

  describe('TEIEmbedder', () => {
    beforeEach(() => {
      vi.doMock('../shared/config.js', () => ({
        CONFIG: {
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'https://api.openai.com/v1',
          OPENAI_EMBED_MODEL: 'text-embedding-3-small',
          OPENAI_EMBED_DIM: 1536,
          TEI_ENDPOINT: 'http://localhost:8080',
          EMBEDDINGS_PROVIDER: 'tei',
        },
      }));
    });

    it('should initialize with correct configuration', async () => {
      const { TEIEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new TEIEmbedder();
      expect(embedder.dim).toBe(1536);
    });

    it('should throw error if endpoint is missing', async () => {
      vi.doMock('../shared/config.js', () => ({
        CONFIG: {
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'https://api.openai.com/v1',
          OPENAI_EMBED_MODEL: 'text-embedding-3-small',
          OPENAI_EMBED_DIM: 1536,
          TEI_ENDPOINT: '',
          EMBEDDINGS_PROVIDER: 'tei',
        },
      }));

      const { TEIEmbedder } = await import('../ingest/embeddings.js');
      expect(() => new TEIEmbedder()).toThrow('TEI_ENDPOINT missing');
    });

    it('should return empty array for empty input', async () => {
      const { TEIEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new TEIEmbedder();
      const result = await embedder.embed([]);
      expect(result).toEqual([]);
    });

    it('should make correct API call and return embeddings', async () => {
      const { TEIEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new TEIEmbedder();

      const mockResponse = createMockResponse({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }],
        }),
      });
      mockFetch.mockResolvedValue(mockResponse);

      const result = await embedder.embed(['text1', 'text2']);

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8080', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: ['text1', 'text2'] }),
      });

      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(Float32Array);
      expect(Array.from(result[0]!)).toEqual(
        expect.arrayContaining([
          expect.closeTo(0.1, 5),
          expect.closeTo(0.2, 5),
          expect.closeTo(0.3, 5),
        ]),
      );
      expect(Array.from(result[1]!)).toEqual(
        expect.arrayContaining([
          expect.closeTo(0.4, 5),
          expect.closeTo(0.5, 5),
          expect.closeTo(0.6, 5),
        ]),
      );
    });

    it('should handle API errors', async () => {
      const { TEIEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new TEIEmbedder();

      const mockResponse = createMockResponse({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue('Internal Server Error'),
      });
      mockFetch.mockResolvedValue(mockResponse);

      await expect(embedder.embed(['text'])).rejects.toThrow(
        'TEI error 500: Internal Server Error',
      );
    });

    it('should strip trailing slash from endpoint', async () => {
      vi.doMock('../shared/config.js', () => ({
        CONFIG: {
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'https://api.openai.com/v1',
          OPENAI_EMBED_MODEL: 'text-embedding-3-small',
          OPENAI_EMBED_DIM: 1536,
          TEI_ENDPOINT: 'http://localhost:8080/',
          EMBEDDINGS_PROVIDER: 'tei',
        },
      }));

      const { TEIEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new TEIEmbedder();
      expect((embedder as any).endpoint).toBe('http://localhost:8080');
    });
  });

  describe('LocalEmbedder', () => {
    beforeEach(() => {
      vi.doMock('../shared/config.js', () => ({
        CONFIG: {
          OPENAI_API_KEY: '',
          OPENAI_BASE_URL: 'https://api.openai.com/v1',
          OPENAI_EMBED_MODEL: 'text-embedding-3-small',
          OPENAI_EMBED_DIM: 1536,
          TEI_ENDPOINT: '',
          EMBEDDINGS_PROVIDER: 'local',
          LOCAL_EMBED_MODEL: 'Xenova/all-MiniLM-L6-v2',
          LOCAL_EMBED_DIM: 384,
          LOCAL_MODEL_CACHE_DIR: './model-cache',
        },
      }));
      mockPipeline.mockReset();
    });

    it('should initialize with correct configuration', async () => {
      const { LocalEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new LocalEmbedder();
      expect(embedder.dim).toBe(384);
    });

    it('should return empty array for empty input', async () => {
      const { LocalEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new LocalEmbedder();
      const result = await embedder.embed([]);
      expect(result).toEqual([]);
    });

    it('should call pipeline and return embeddings as Float32Array', async () => {
      // Create mock embeddings
      const mockEmbedding1 = new Float32Array(384).fill(0.1);
      const mockEmbedding2 = new Float32Array(384).fill(0.2);

      const mockModel = vi.fn().mockResolvedValue({
        data: Float32Array.from([...mockEmbedding1, ...mockEmbedding2]),
        dims: [2, 384],
      });
      mockPipeline.mockResolvedValue(mockModel);

      const { LocalEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new LocalEmbedder();
      const result = await embedder.embed(['text1', 'text2']);

      expect(mockPipeline).toHaveBeenCalledWith('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      expect(mockModel).toHaveBeenCalledWith(['text1', 'text2'], {
        pooling: 'mean',
        normalize: true,
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(Float32Array);
      expect(result[1]).toBeInstanceOf(Float32Array);
    });

    it('should handle array output format', async () => {
      const mockModel = vi.fn().mockResolvedValue([
        new Float32Array([0.1, 0.2, 0.3]),
        new Float32Array([0.4, 0.5, 0.6]),
      ]);
      mockPipeline.mockResolvedValue(mockModel);

      const { LocalEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new LocalEmbedder();
      const result = await embedder.embed(['text1', 'text2']);

      expect(result).toHaveLength(2);
      // Use closeTo for Float32Array precision tolerance
      const arr0 = Array.from(result[0]!);
      const arr1 = Array.from(result[1]!);
      expect(arr0[0]).toBeCloseTo(0.1, 5);
      expect(arr0[1]).toBeCloseTo(0.2, 5);
      expect(arr0[2]).toBeCloseTo(0.3, 5);
      expect(arr1[0]).toBeCloseTo(0.4, 5);
      expect(arr1[1]).toBeCloseTo(0.5, 5);
      expect(arr1[2]).toBeCloseTo(0.6, 5);
    });

    it('should throw descriptive error when model not found', async () => {
      mockPipeline.mockRejectedValue(new Error('local model not found'));

      const { LocalEmbedder } = await import('../ingest/embeddings.js');
      const embedder = new LocalEmbedder();

      await expect(embedder.embed(['text'])).rejects.toThrow(
        'Model "Xenova/all-MiniLM-L6-v2" not found in cache directory',
      );
    });
  });

  describe('getEmbedder', () => {
    it('should return LocalEmbedder by default', async () => {
      vi.doMock('../shared/config.js', () => ({
        CONFIG: {
          OPENAI_API_KEY: '',
          OPENAI_BASE_URL: 'https://api.openai.com/v1',
          OPENAI_EMBED_MODEL: 'text-embedding-3-small',
          OPENAI_EMBED_DIM: 1536,
          TEI_ENDPOINT: '',
          EMBEDDINGS_PROVIDER: 'local',
          LOCAL_EMBED_MODEL: 'Xenova/all-MiniLM-L6-v2',
          LOCAL_EMBED_DIM: 384,
          LOCAL_MODEL_CACHE_DIR: './model-cache',
        },
      }));

      const { getEmbedder, LocalEmbedder } = await import('../ingest/embeddings.js');
      const embedder = getEmbedder();
      expect(embedder).toBeInstanceOf(LocalEmbedder);
    });

    it('should return OpenAIEmbedder when configured', async () => {
      vi.doMock('../shared/config.js', () => ({
        CONFIG: {
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'https://api.openai.com/v1',
          OPENAI_EMBED_MODEL: 'text-embedding-3-small',
          OPENAI_EMBED_DIM: 1536,
          TEI_ENDPOINT: 'http://localhost:8080',
          EMBEDDINGS_PROVIDER: 'openai',
          LOCAL_EMBED_MODEL: 'Xenova/all-MiniLM-L6-v2',
          LOCAL_EMBED_DIM: 384,
          LOCAL_MODEL_CACHE_DIR: './model-cache',
        },
      }));

      const { getEmbedder, OpenAIEmbedder } = await import('../ingest/embeddings.js');
      const embedder = getEmbedder();
      expect(embedder).toBeInstanceOf(OpenAIEmbedder);
    });

    it('should return TEIEmbedder when configured', async () => {
      vi.doMock('../shared/config.js', () => ({
        CONFIG: {
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'https://api.openai.com/v1',
          OPENAI_EMBED_MODEL: 'text-embedding-3-small',
          OPENAI_EMBED_DIM: 1536,
          TEI_ENDPOINT: 'http://localhost:8080',
          EMBEDDINGS_PROVIDER: 'tei',
          LOCAL_EMBED_MODEL: 'Xenova/all-MiniLM-L6-v2',
          LOCAL_EMBED_DIM: 384,
          LOCAL_MODEL_CACHE_DIR: './model-cache',
        },
      }));

      const { getEmbedder, TEIEmbedder } = await import('../ingest/embeddings.js');
      const embedder = getEmbedder();
      expect(embedder).toBeInstanceOf(TEIEmbedder);
    });

    it('should throw error when openai provider configured without API key', async () => {
      vi.doMock('../shared/config.js', () => ({
        CONFIG: {
          OPENAI_API_KEY: '',
          OPENAI_BASE_URL: 'https://api.openai.com/v1',
          OPENAI_EMBED_MODEL: 'text-embedding-3-small',
          OPENAI_EMBED_DIM: 1536,
          TEI_ENDPOINT: '',
          EMBEDDINGS_PROVIDER: 'openai',
          LOCAL_EMBED_MODEL: 'Xenova/all-MiniLM-L6-v2',
          LOCAL_EMBED_DIM: 384,
          LOCAL_MODEL_CACHE_DIR: './model-cache',
        },
      }));

      const { getEmbedder } = await import('../ingest/embeddings.js');
      expect(() => getEmbedder()).toThrow('OPENAI_API_KEY required when EMBEDDINGS_PROVIDER is "openai"');
    });
  });
});
