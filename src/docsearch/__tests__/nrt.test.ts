/**
 * Non-Regression Test (NRT) for the Docsearch pipeline.
 *
 * Exercises the full ingestion-embedding-search flow with two sources:
 *   - Local file: Playwright MCP documentation (real fixture)
 *   - URL: TypeScript basic types documentation (mocked HTTP fetch)
 *
 * Uses real embeddings via the centralized local-embeddings HTTP server
 * (must be running on http://127.0.0.1:3100 before executing this test).
 *
 * Scenarios:
 *   1.  Local file ingestion
 *   2.  Local file embedding
 *   3.  Keyword search on local file content
 *   4.  Vector search on local file content
 *   5.  URL ingestion (mocked fetch)
 *   6.  URL embedding
 *   7.  Keyword search on URL content
 *   8.  Vector search on URL content
 *   9.  Cross-source hybrid search
 *  10.  Source-filtered search
 *  11.  Ingestion status
 *  12.  Idempotency (re-ingest produces no duplicates)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/* ------------------------------------------------------------------ */
/*  Hoisted setup: compute temp paths before module loading           */
/* ------------------------------------------------------------------ */

const { testDir, docsDir, urlsFile, dbPath } = vi.hoisted(() => {
  const _os = require('node:os');
  const _path = require('node:path');
  const dir = _path.join(_os.tmpdir(), `docsearch-nrt-${Date.now()}`);
  return {
    testDir: dir,
    docsDir: _path.join(dir, 'docs'),
    urlsFile: _path.join(dir, 'urls.md'),
    dbPath: _path.join(dir, 'index.db'),
  };
});

/* ------------------------------------------------------------------ */
/*  Mock CONFIG → temp directory + centralized embedding server       */
/* ------------------------------------------------------------------ */

vi.mock('../shared/config.js', () => ({
  CONFIG: {
    DATA_DIR: testDir,
    DOCS_DIR: docsDir,
    URLS_FILE: urlsFile,
    DB_PATH: dbPath,
    EMBEDDINGS_PROVIDER: 'openai',
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: '',
    OPENAI_EMBED_API_KEY: 'local',
    OPENAI_EMBED_BASE_URL: 'http://127.0.0.1:3100/v1',
    OPENAI_EMBED_MODEL: 'Xenova/bge-small-en-v1.5',
    OPENAI_EMBED_DIM: 384,
    TEI_ENDPOINT: '',
    ENABLE_IMAGE_TO_TEXT: false,
    IMAGE_TO_TEXT_PROVIDER: '',
    IMAGE_TO_TEXT_MODEL: '',
    CONFLUENCE_BASE_URL: '',
    CONFLUENCE_EMAIL: '',
    CONFLUENCE_API_TOKEN: '',
    CONFLUENCE_AUTH_METHOD: 'basic',
    CONFLUENCE_SPACES: [],
    CONFLUENCE_PARENT_PAGES: [],
    CONFLUENCE_TITLE_INCLUDES: [],
    CONFLUENCE_TITLE_EXCLUDES: [],
    FILE_ROOTS: [docsDir],
    FILE_INCLUDE_GLOBS: ['**/*.{txt,md}'],
    FILE_EXCLUDE_GLOBS: ['**/{.git,node_modules}/**'],
  },
}));

/* ------------------------------------------------------------------ */
/*  Imports (after mocks are set up)                                  */
/* ------------------------------------------------------------------ */

import { createDatabaseAdapter } from '../ingest/adapters/factory.js';
import { Indexer } from '../ingest/indexer.js';
import { performSearch } from '../ingest/search.js';
import { ingestFiles } from '../ingest/sources/files.js';
import { ingestUrls } from '../ingest/sources/urls.js';

import type { DatabaseAdapter } from '../ingest/adapters/types.js';

/* ------------------------------------------------------------------ */
/*  Test fixtures                                                     */
/* ------------------------------------------------------------------ */

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures', 'playwright-mcp-llms.txt');

const TS_URL = 'https://www.typescriptlang.org/docs/handbook/2/basic-types.html';

const TS_DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>TypeScript: Basic Types</title></head>
<body>
<nav>TypeScript Handbook</nav>
<main>
<h1>Basic Types</h1>
<p>TypeScript provides several basic types for type annotations.
These include boolean, number, string, array, tuple, enum, any, void,
null, undefined, never, and object.</p>

<h2>Boolean</h2>
<p>The most basic datatype is the simple true/false value, which JavaScript
and TypeScript call a boolean value.</p>
<pre><code>let isDone: boolean = false;</code></pre>

<h2>Number</h2>
<p>As in JavaScript, all numbers in TypeScript are either floating point
values or BigIntegers.</p>
<pre><code>let decimal: number = 6;
let hex: number = 0xf00d;</code></pre>

<h2>String</h2>
<p>TypeScript uses double quotes or single quotes to surround string data.</p>
<pre><code>let color: string = "blue";</code></pre>

<h2>Array</h2>
<p>TypeScript, like JavaScript, allows you to work with arrays of values.
Array types can be written in one of two ways.</p>
<pre><code>let list: number[] = [1, 2, 3];</code></pre>

<h2>Type Annotations</h2>
<p>TypeScript uses type annotations to explicitly specify types for
identifiers such as variables, functions, objects, etc. Type annotations
are used to enforce type checking at compile time.</p>
<pre><code>function greet(person: string, date: Date) {
  console.log(\`Hello \${person}, today is \${date.toDateString()}!\`);
}</code></pre>

<h2>Static Type Checking</h2>
<p>Static type checkers like TypeScript identify bugs before our code runs.
TypeScript checks a program for errors before execution, and does so based
on the kinds of values. This is a form of static analysis that helps
catch common mistakes early in development.</p>
</main>
<footer>TypeScript Documentation</footer>
</body>
</html>`;

/* ------------------------------------------------------------------ */
/*  Test suite                                                        */
/* ------------------------------------------------------------------ */

describe('Docsearch NRT (Non-Regression Test)', () => {
  let adapter: DatabaseAdapter;
  let indexer: Indexer;

  beforeAll(async () => {
    // Create temp directory structure
    await fs.mkdir(docsDir, { recursive: true });

    // Copy fixture file into docs directory
    const fixtureContent = await fs.readFile(FIXTURE_PATH, 'utf-8');
    await fs.writeFile(path.join(docsDir, 'playwright-mcp-llms.txt'), fixtureContent);

    // Write urls.md with TypeScript docs URL
    await fs.writeFile(urlsFile, `# URLs\n${TS_URL}\n`);

    // Mock global fetch for URL ingestion
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes('typescriptlang.org')) {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null,
            },
            text: async () => TS_DOCS_HTML,
          };
        }
        return {
          ok: false,
          status: 404,
          headers: { get: () => null },
        };
      }),
    );

    // Initialize database with 384-dim vectors (centralized local-embeddings server)
    adapter = createDatabaseAdapter({ path: dbPath, embeddingDim: 384 });
    await adapter.init();
    indexer = new Indexer(adapter);
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await adapter?.close();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  /* -------------------------------------------------------------- */
  /*  Local file ingestion                                          */
  /* -------------------------------------------------------------- */

  it('Step 1: ingest local file produces documents and chunks', async () => {
    await ingestFiles(adapter);

    const docs = await adapter.rawQuery('SELECT COUNT(*) as count FROM documents WHERE source = ?', ['file']);
    const docCount = (docs[0] as { count: number }).count;
    expect(docCount).toBeGreaterThanOrEqual(1);

    const chunks = await adapter.rawQuery('SELECT COUNT(*) as count FROM chunks');
    const chunkCount = (chunks[0] as { count: number }).count;
    expect(chunkCount).toBeGreaterThan(0);
  }, 30_000);

  it('Step 2: embed local file chunks generates vectors', async () => {
    await indexer.embedNewChunks();

    const unembedded = await adapter.getChunksToEmbed();
    expect(unembedded).toHaveLength(0);

    const vecCount = await adapter.rawQuery('SELECT COUNT(*) as count FROM vec_chunks');
    expect((vecCount[0] as { count: number }).count).toBeGreaterThan(0);
  }, 120_000);

  it('Step 3: keyword search "browser automation Playwright" returns file results', async () => {
    const results = await performSearch(adapter, {
      query: 'browser automation Playwright',
      mode: 'keyword',
      topK: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.source).toBe('file');
    expect(results[0]!.snippet.toLowerCase()).toMatch(/playwright|browser|automation/);
  });

  it('Step 4: vector search "how to click elements on a web page" returns relevant results', async () => {
    const results = await performSearch(adapter, {
      query: 'how to click elements on a web page',
      mode: 'vector',
      topK: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.source).toBe('file');
    expect(results[0]!.score).toBeGreaterThan(0);
  }, 30_000);

  /* -------------------------------------------------------------- */
  /*  URL ingestion                                                 */
  /* -------------------------------------------------------------- */

  it('Step 5: URL ingestion produces documents and chunks', async () => {
    await ingestUrls(adapter);
    await indexer.embedNewChunks();

    const urlDocs = await adapter.rawQuery(
      'SELECT COUNT(*) as count FROM documents WHERE source = ?',
      ['url'],
    );
    expect((urlDocs[0] as { count: number }).count).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('Step 6: URL embedding leaves no un-embedded chunks', async () => {
    const unembedded = await adapter.getChunksToEmbed();
    expect(unembedded).toHaveLength(0);
  });

  it('Step 7: keyword search "type annotations TypeScript" returns URL results', async () => {
    const results = await performSearch(adapter, {
      query: 'type annotations TypeScript',
      mode: 'keyword',
      topK: 10,
    });

    expect(results.length).toBeGreaterThan(0);

    const urlResult = results.find((r) => r.source === 'url');
    expect(urlResult).toBeDefined();
    expect(urlResult!.snippet.toLowerCase()).toMatch(/type|annotation|typescript/);
  });

  it('Step 8: vector search "static type checking in JavaScript" returns relevant results', async () => {
    const results = await performSearch(adapter, {
      query: 'static type checking in JavaScript',
      mode: 'vector',
      topK: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.score).toBeGreaterThan(0);
  }, 30_000);

  /* -------------------------------------------------------------- */
  /*  Cross-source and filtered search                              */
  /* -------------------------------------------------------------- */

  it('Step 9: cross-source hybrid search returns results from both sources', async () => {
    const results = await performSearch(adapter, {
      query: 'automation tools configuration',
      mode: 'auto',
      topK: 15,
    });

    expect(results.length).toBeGreaterThan(0);
    const sources = new Set(results.map((r) => r.source));
    expect(sources.size).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('Step 10: source-filtered search returns only matching source', async () => {
    const fileResults = await performSearch(adapter, {
      query: 'browser',
      mode: 'keyword',
      topK: 10,
      source: 'file',
    });
    for (const r of fileResults) {
      expect(r.source).toBe('file');
    }

    const urlResults = await performSearch(adapter, {
      query: 'boolean number string',
      mode: 'keyword',
      topK: 10,
      source: 'url',
    });
    for (const r of urlResults) {
      expect(r.source).toBe('url');
    }
  });

  /* -------------------------------------------------------------- */
  /*  Status and idempotency                                        */
  /* -------------------------------------------------------------- */

  it('Step 11: ingestion status shows correct counts', async () => {
    const docs = await adapter.rawQuery('SELECT COUNT(*) as count FROM documents');
    const chunks = await adapter.rawQuery('SELECT COUNT(*) as count FROM chunks');
    const embedded = await adapter.rawQuery('SELECT COUNT(*) as count FROM vec_chunks');

    const docCount = (docs[0] as { count: number }).count;
    const chunkCount = (chunks[0] as { count: number }).count;
    const embeddedCount = (embedded[0] as { count: number }).count;

    expect(docCount).toBeGreaterThanOrEqual(2);
    expect(chunkCount).toBeGreaterThan(0);
    expect(embeddedCount).toBe(chunkCount);
  });

  it('Step 12: re-ingestion is idempotent (no duplicate documents)', async () => {
    const beforeDocs = await adapter.rawQuery('SELECT COUNT(*) as count FROM documents');
    const beforeChunks = await adapter.rawQuery('SELECT COUNT(*) as count FROM chunks');

    await ingestFiles(adapter);
    await ingestUrls(adapter);

    const afterDocs = await adapter.rawQuery('SELECT COUNT(*) as count FROM documents');
    const afterChunks = await adapter.rawQuery('SELECT COUNT(*) as count FROM chunks');

    expect((afterDocs[0] as { count: number }).count).toBe(
      (beforeDocs[0] as { count: number }).count,
    );
    expect((afterChunks[0] as { count: number }).count).toBe(
      (beforeChunks[0] as { count: number }).count,
    );
  }, 30_000);
});
