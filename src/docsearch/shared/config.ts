import { join } from 'node:path';
import dotenv from 'dotenv';

type EmbeddingsProvider = 'local' | 'openai' | 'tei';
type ConfluenceAuthMethod = 'basic' | 'bearer';

interface AppConfig {
  // Data directories (fixed structure)
  readonly DATA_DIR: string;
  readonly DOCS_DIR: string;
  readonly URLS_FILE: string;
  readonly DB_PATH: string;

  // Embeddings configuration
  readonly EMBEDDINGS_PROVIDER: EmbeddingsProvider;
  readonly OPENAI_API_KEY: string;
  readonly OPENAI_BASE_URL: string;
  readonly OPENAI_EMBED_MODEL: string;
  readonly OPENAI_EMBED_DIM: number;
  readonly TEI_ENDPOINT: string;

  // Local embeddings configuration
  readonly LOCAL_EMBED_MODEL: string;
  readonly LOCAL_EMBED_DIM: number;
  readonly LOCAL_MODEL_CACHE_DIR: string;

  // Image processing (optional)
  readonly ENABLE_IMAGE_TO_TEXT: boolean;
  readonly IMAGE_TO_TEXT_PROVIDER: string;
  readonly IMAGE_TO_TEXT_MODEL: string;

  // Confluence integration (optional)
  readonly CONFLUENCE_BASE_URL: string;
  readonly CONFLUENCE_EMAIL: string;
  readonly CONFLUENCE_API_TOKEN: string;
  readonly CONFLUENCE_AUTH_METHOD: ConfluenceAuthMethod;
  readonly CONFLUENCE_SPACES: readonly string[];
  readonly CONFLUENCE_PARENT_PAGES: readonly string[];
  readonly CONFLUENCE_TITLE_INCLUDES: readonly string[];
  readonly CONFLUENCE_TITLE_EXCLUDES: readonly string[];

  // Legacy config (for backward compatibility)
  readonly FILE_ROOTS: readonly string[];
  readonly FILE_INCLUDE_GLOBS: readonly string[];
  readonly FILE_EXCLUDE_GLOBS: readonly string[];
}

function splitCsv(v: string | undefined, def: string): readonly string[] {
  const raw = v && v.length ? v : def;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function validateEmbeddingsProvider(provider: string): EmbeddingsProvider {
  if (provider === 'local' || provider === 'openai' || provider === 'tei') {
    return provider;
  }
  return 'local';
}

function validateConfluenceAuthMethod(method: string): ConfluenceAuthMethod {
  if (method === 'basic' || method === 'bearer') {
    return method;
  }
  return 'basic';
}

let _config: AppConfig | null = null;

function initializeConfig(): AppConfig {
  if (_config === null) {
    // Load default .env file if it exists (for MCP server and other non-CLI usage)
    dotenv.config();

    // Fixed data directory structure
    const dataDir = process.env.DOCSEARCH_DATA_DIR || './data';
    const docsDir = join(dataDir, 'docs');
    const urlsFile = join(dataDir, 'urls.md');
    const dbPath = join(dataDir, 'index.db');

    _config = {
      // Fixed paths
      DATA_DIR: dataDir,
      DOCS_DIR: docsDir,
      URLS_FILE: urlsFile,
      DB_PATH: dbPath,

      // Embeddings
      EMBEDDINGS_PROVIDER: validateEmbeddingsProvider(process.env.EMBEDDINGS_PROVIDER || 'local'),
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || '',
      OPENAI_EMBED_MODEL: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
      OPENAI_EMBED_DIM: parseInt(process.env.OPENAI_EMBED_DIM || '1536', 10),
      TEI_ENDPOINT: process.env.TEI_ENDPOINT || '',

      // Local embeddings
      LOCAL_EMBED_MODEL: process.env.LOCAL_EMBED_MODEL || 'Xenova/all-MiniLM-L6-v2',
      LOCAL_EMBED_DIM: parseInt(process.env.LOCAL_EMBED_DIM || '384', 10),
      LOCAL_MODEL_CACHE_DIR: process.env.LOCAL_MODEL_CACHE_DIR || './model-cache',

      // Image processing
      ENABLE_IMAGE_TO_TEXT: process.env.ENABLE_IMAGE_TO_TEXT === 'true',
      IMAGE_TO_TEXT_PROVIDER: process.env.IMAGE_TO_TEXT_PROVIDER || 'openai',
      IMAGE_TO_TEXT_MODEL: process.env.IMAGE_TO_TEXT_MODEL || 'gpt-4o-mini',

      // Confluence (optional)
      CONFLUENCE_BASE_URL: process.env.CONFLUENCE_BASE_URL || '',
      CONFLUENCE_EMAIL: process.env.CONFLUENCE_EMAIL || '',
      CONFLUENCE_API_TOKEN: process.env.CONFLUENCE_API_TOKEN || '',
      CONFLUENCE_AUTH_METHOD: validateConfluenceAuthMethod(
        process.env.CONFLUENCE_AUTH_METHOD || 'basic',
      ),
      CONFLUENCE_SPACES: splitCsv(process.env.CONFLUENCE_SPACES, ''),
      CONFLUENCE_PARENT_PAGES: splitCsv(process.env.CONFLUENCE_PARENT_PAGES, ''),
      CONFLUENCE_TITLE_INCLUDES: splitCsv(process.env.CONFLUENCE_TITLE_INCLUDES, ''),
      CONFLUENCE_TITLE_EXCLUDES: splitCsv(process.env.CONFLUENCE_TITLE_EXCLUDES, ''),

      // Legacy file config (use DOCS_DIR instead, kept for backward compatibility)
      FILE_ROOTS: splitCsv(process.env.FILE_ROOTS, docsDir),
      FILE_INCLUDE_GLOBS: splitCsv(
        process.env.FILE_INCLUDE_GLOBS,
        '**/*.{go,ts,tsx,js,py,rs,java,md,mdx,txt,yaml,yml,json,pdf,png,jpg,jpeg,gif,svg,webp}',
      ),
      FILE_EXCLUDE_GLOBS: splitCsv(
        process.env.FILE_EXCLUDE_GLOBS,
        '**/{.git,node_modules,dist,build,target}/**',
      ),
    } as const;
  }
  return _config;
}

export const CONFIG = new Proxy({} as AppConfig, {
  get(target, prop: keyof AppConfig) {
    return initializeConfig()[prop];
  },
});
