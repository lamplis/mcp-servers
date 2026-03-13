/**
 * Functional test: plain-text URL ingestion (llms.txt)
 *
 * Verifies the full pipeline for a text/plain URL:
 *   1.  URL ingestion (mocked fetch returning text/plain)
 *   2.  Embedding generation
 *   3.  Keyword search returns URL results
 *   4.  Vector search returns semantically relevant results
 *
 * Uses real embeddings via the centralized local-embeddings HTTP server
 * (must be running on http://127.0.0.1:3100 before executing this test).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/*  Hoisted setup: compute temp paths before module loading           */
/* ------------------------------------------------------------------ */

const { testDir, docsDir, urlsFile, dbPath } = vi.hoisted(() => {
  const _os = require('node:os');
  const _path = require('node:path');
  const dir = _path.join(_os.tmpdir(), `docsearch-func-url-${Date.now()}`);
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
import { ingestUrls } from '../ingest/sources/urls.js';

import type { DatabaseAdapter } from '../ingest/adapters/types.js';

/* ------------------------------------------------------------------ */
/*  Fixture: realistic TypeScript llms.txt content (text/plain)       */
/* ------------------------------------------------------------------ */

const CONTEXT7_URL =
  'https://context7.com/websites/typescriptlang/llms.txt?tokens=10000';

const TS_LLMS_TXT = `# TypeScript Documentation

> TypeScript is a strongly typed programming language that builds on JavaScript.

## Type Inference

TypeScript can infer types automatically without explicit type annotations.
The compiler analyzes the value assigned to a variable and determines its type.

\`\`\`typescript
let message = "hello"; // inferred as string
let count = 42;        // inferred as number
\`\`\`

When a variable is declared with an initializer, TypeScript uses the type of
the initializer as the type of the variable. This is called contextual typing.

## Generics

Generics allow you to write reusable components that work with a variety of
types rather than a single one. A generic function or class uses a type
parameter that acts as a placeholder.

\`\`\`typescript
function identity<T>(arg: T): T {
  return arg;
}

let output = identity<string>("hello");
\`\`\`

Generic constraints let you restrict the kinds of types that a type parameter
can accept by using the \`extends\` keyword.

\`\`\`typescript
interface Lengthwise {
  length: number;
}

function loggingIdentity<T extends Lengthwise>(arg: T): T {
  console.log(arg.length);
  return arg;
}
\`\`\`

## Conditional Types

Conditional types select one of two possible types based on a condition
expressed as a type relationship test:

\`\`\`typescript
type IsString<T> = T extends string ? "yes" : "no";

type A = IsString<string>;  // "yes"
type B = IsString<number>;  // "no"
\`\`\`

Conditional types become particularly powerful when combined with generics,
enabling type-level programming and advanced type transformations. The
\`infer\` keyword allows extracting types from within conditional type branches.

## Mapped Types

Mapped types allow you to create new types by transforming each property
in an existing type:

\`\`\`typescript
type Readonly<T> = {
  readonly [P in keyof T]: T[P];
};

type Partial<T> = {
  [P in keyof T]?: T[P];
};
\`\`\`

## Utility Types

TypeScript provides several built-in utility types to facilitate common
type transformations:

- \`Partial<T>\` makes all properties optional
- \`Required<T>\` makes all properties required
- \`Pick<T, K>\` constructs a type with a subset of properties
- \`Omit<T, K>\` constructs a type by removing properties
- \`Record<K, T>\` constructs a type with keys K and values T
- \`Exclude<T, U>\` excludes from T types assignable to U
- \`Extract<T, U>\` extracts from T types assignable to U
- \`ReturnType<T>\` obtains the return type of a function type

## Declaration Files

Declaration files (\`.d.ts\`) provide type information for JavaScript libraries
that don't include their own types. The DefinitelyTyped repository hosts
community-maintained declaration files for popular packages.

## TypeScript Compiler Options

The \`tsconfig.json\` file specifies the root files and compiler options.
Key options include \`strict\`, \`target\`, \`module\`, \`outDir\`,
\`rootDir\`, \`esModuleInterop\`, and \`skipLibCheck\`.
`;

/* ------------------------------------------------------------------ */
/*  Test suite                                                        */
/* ------------------------------------------------------------------ */

describe('Functional test: plain-text URL ingestion (llms.txt)', () => {
  let adapter: DatabaseAdapter;
  let indexer: Indexer;

  beforeAll(async () => {
    await fs.mkdir(docsDir, { recursive: true });

    await fs.writeFile(urlsFile, `# URLs\n${CONTEXT7_URL}\n`);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes('context7.com')) {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === 'content-type'
                  ? 'text/plain; charset=utf-8'
                  : null,
            },
            text: async () => TS_LLMS_TXT,
          };
        }
        return {
          ok: false,
          status: 404,
          headers: { get: () => null },
        };
      }),
    );

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
  /*  Ingestion + embedding                                         */
  /* -------------------------------------------------------------- */

  it('Step 1: ingest plain-text URL produces documents and chunks', async () => {
    await ingestUrls(adapter);

    const docs = await adapter.rawQuery(
      'SELECT COUNT(*) as count FROM documents WHERE source = ?',
      ['url'],
    );
    expect((docs[0] as { count: number }).count).toBeGreaterThanOrEqual(1);

    const chunks = await adapter.rawQuery('SELECT COUNT(*) as count FROM chunks');
    expect((chunks[0] as { count: number }).count).toBeGreaterThan(0);
  }, 30_000);

  it('Step 2: embedding leaves no un-embedded chunks', async () => {
    await indexer.embedNewChunks();

    const unembedded = await adapter.getChunksToEmbed();
    expect(unembedded).toHaveLength(0);

    const vecCount = await adapter.rawQuery('SELECT COUNT(*) as count FROM vec_chunks');
    expect((vecCount[0] as { count: number }).count).toBeGreaterThan(0);
  }, 120_000);

  /* -------------------------------------------------------------- */
  /*  Proof: keyword search                                         */
  /* -------------------------------------------------------------- */

  it('Step 3: keyword search "generics conditional types" returns URL results', async () => {
    const results = await performSearch(adapter, {
      query: 'generics conditional types',
      mode: 'keyword',
      topK: 10,
      source: 'url',
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.source).toBe('url');
    expect(results[0]!.snippet.toLowerCase()).toMatch(/generic|conditional|type/);
  });

  it('Step 4: keyword search "mapped utility types" returns URL results', async () => {
    const results = await performSearch(adapter, {
      query: 'mapped utility types Partial Required',
      mode: 'keyword',
      topK: 10,
      source: 'url',
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.source).toBe('url');
  });

  /* -------------------------------------------------------------- */
  /*  Proof: vector search                                          */
  /* -------------------------------------------------------------- */

  it('Step 5: vector search "how does TypeScript infer variable types" returns relevant results', async () => {
    const results = await performSearch(adapter, {
      query: 'how does TypeScript infer variable types automatically',
      mode: 'vector',
      topK: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.score).toBeGreaterThan(0);
    expect(results[0]!.source).toBe('url');
  }, 30_000);

  it('Step 6: vector search "reusable components with type parameters" returns relevant results', async () => {
    const results = await performSearch(adapter, {
      query: 'reusable components with type parameters in TypeScript',
      mode: 'vector',
      topK: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.score).toBeGreaterThan(0);
  }, 30_000);

  /* -------------------------------------------------------------- */
  /*  Idempotency                                                   */
  /* -------------------------------------------------------------- */

  it('Step 7: re-ingestion is idempotent (no duplicates)', async () => {
    const beforeDocs = await adapter.rawQuery('SELECT COUNT(*) as count FROM documents');
    const beforeChunks = await adapter.rawQuery('SELECT COUNT(*) as count FROM chunks');

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
