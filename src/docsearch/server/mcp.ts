import { existsSync, readFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import chokidar from 'chokidar';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { closeDatabase, configureDatabase, getDatabase } from '../ingest/database.js';
import { performSearch } from '../ingest/search.js';
import { rerankResults } from '../ingest/reranker.js';
import { registerIngestTools } from './tools/ingest-tools.js';
import { FormatterFactory } from '../cli/adapters/output/formatter-factory.js';
import { CONFIG } from '../shared/config.js';
import { ingestFiles, removeIndexedFile } from '../ingest/sources/files.js';
import { ingestUrls, ensureUrlsFile } from '../ingest/sources/urls.js';
import { Indexer } from '../ingest/indexer.js';
import {
  installDocsearchShutdown,
  startDocsearchLifecycle,
} from '../shared/lifecycle.js';
import { setIndexingIdle, setIndexingRunning } from '../shared/indexing-state.js';
import { removeInstanceFile, type Logger } from '@modelcontextprotocol/mcp-lifecycle';

import type { OutputFormat } from '../cli/domain/ports.js';
import type { SearchResult as AdapterSearchResult } from '../ingest/adapters/index.js';
import type { SearchParams, SearchMode } from '../ingest/search.js';
import type { SourceType } from '../shared/types.js';

interface SearchResult extends AdapterSearchResult {
  readonly reason: 'keyword' | 'vector';
}

interface SearchToolInput {
  readonly query: string;
  readonly topK?: number | undefined;
  readonly source?: SourceType | undefined;
  readonly repo?: string | undefined;
  readonly pathPrefix?: string | undefined;
  readonly mode?: SearchMode | undefined;
  readonly latest?: boolean | undefined;
  readonly rerank?: boolean | undefined;
  readonly output?: OutputFormat | undefined;
  readonly includeImages?: boolean | undefined;
  readonly imagesOnly?: boolean | undefined;
}

function readNearestPackageJson(metaUrl: string): { version: string } {
  let dir = dirname(fileURLToPath(metaUrl));
  for (let i = 0; i < 5; i += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, 'utf8')) as { version: string };
    }
    dir = dirname(dir);
  }
  return { version: '0.0.0' };
}

const packageJson = readNearestPackageJson(import.meta.url);

export const server = new McpServer({ name: 'docsearch-mcp', version: packageJson.version });

// Register ingestion tools
registerIngestTools(server);

server.registerResource(
  'docchunk',
  new ResourceTemplate('docchunk://{id}', { list: undefined }),
  {
    title: 'Document Chunk',
    description: 'Retrieve an indexed chunk by id',
    mimeType: 'text/markdown',
  },
  async (_uri, { id }) => {
    const adapter = await getDatabase();
    const chunkContent = await adapter.getChunkContent(Number(id));

    if (!chunkContent) {
      return { contents: [{ uri: `docchunk://${id}`, text: 'Not found' }] };
    }

    const title = chunkContent.title || chunkContent.path || chunkContent.uri;
    const location = chunkContent.path ? `• ${chunkContent.path}` : '';
    const lines = chunkContent.start_line
      ? `(lines ${chunkContent.start_line}-${chunkContent.end_line})`
      : '';

    // Extract source URL for Confluence documents
    // URI format: confluence://{pageId}
    let sourceUrl = '';
    if (chunkContent.source === 'confluence' && CONFIG.CONFLUENCE_BASE_URL) {
      const uriMatch = chunkContent.uri.match(/^confluence:\/\/(.+)$/);
      if (uriMatch) {
        const pageId = uriMatch[1];
        sourceUrl = ` • ${CONFIG.CONFLUENCE_BASE_URL.replace(/\/$/, '')}/pages/viewpage.action?pageId=${pageId}`;
      }
    }

    const header = `# ${title}\n\n> ${chunkContent.source} • ${chunkContent.repo || ''} ${location} ${lines}${sourceUrl}\n\n`;

    return { contents: [{ uri: `docchunk://${id}`, text: header + chunkContent.content }] };
  },
);

server.registerTool(
  'doc-search',
  {
    title: 'Search indexed docs',
    description:
      'Hybrid semantic+keyword search across local files, URLs, and Confluence. Set latest=true to prioritize recent docs.',
    inputSchema: {
      query: z.string(),
      topK: z.number().int().min(1).max(50).optional(),
      source: z.enum(['file', 'confluence', 'url']).optional(),
      repo: z.string().optional(),
      pathPrefix: z.string().optional(),
      mode: z.enum(['auto', 'vector', 'keyword']).optional(),
      latest: z.boolean().optional(),
      rerank: z.boolean().optional(),
      output: z.enum(['text', 'json', 'yaml']).optional(),
      includeImages: z.boolean().optional(),
      imagesOnly: z.boolean().optional(),
    },
  },
  async (input: SearchToolInput) => {
    const adapter = await getDatabase();
    let searchResults = await performSearch(adapter, input as SearchParams);
    if (input.rerank) {
      searchResults = await rerankResults(input.query, searchResults);
    }

    // Convert adapter results to our SearchResult format
    const results: SearchResult[] = searchResults.map((r) => ({
      ...r,
      reason: 'vector' as const, // performSearch handles both modes internally
    }));

    const items = results.slice(0, input.topK ?? 15);

    // Handle output formatting if requested
    if (input.output) {
      // Convert to CLI-compatible format for formatting
      const cliResults = items.map((r) => ({
        ...r,
        id: r.chunk_id,
        title: r.title || r.path || r.uri,
        content: r.snippet || '',
        source: r.source as SourceType,
      }));

      // Create minimal configuration for text formatter
      const config = {
        confluence: {
          baseUrl: CONFIG.CONFLUENCE_BASE_URL,
          email: CONFIG.CONFLUENCE_EMAIL,
          apiToken: CONFIG.CONFLUENCE_API_TOKEN,
          spaces: CONFIG.CONFLUENCE_SPACES,
        },
        embeddings: {
          provider: CONFIG.EMBEDDINGS_PROVIDER,
          local: {
            model: CONFIG.LOCAL_EMBED_MODEL,
            dimension: CONFIG.LOCAL_EMBED_DIM,
            cacheDir: CONFIG.LOCAL_MODEL_CACHE_DIR,
          },
          openai: {
            apiKey: CONFIG.OPENAI_API_KEY,
            baseUrl: CONFIG.OPENAI_BASE_URL,
            model: CONFIG.OPENAI_EMBED_MODEL,
            dimension: CONFIG.OPENAI_EMBED_DIM,
          },
          tei: {
            endpoint: CONFIG.TEI_ENDPOINT,
          },
        },
        files: {
          roots: CONFIG.FILE_ROOTS,
          includeGlobs: CONFIG.FILE_INCLUDE_GLOBS,
          excludeGlobs: CONFIG.FILE_EXCLUDE_GLOBS,
        },
        database: {
          path: CONFIG.DB_PATH,
        },
      };

      const formatter = FormatterFactory.createFormatter(input.output, config);
      const formattedOutput = formatter.format(cliResults);

      return {
        content: [{ type: 'text' as const, text: formattedOutput }],
      };
    }

    // Build text output
    const lines: string[] = [`Found ${items.length} results for "${input.query}"\n`];

    for (const r of items) {
      const name = r.title || r.path || r.uri;
      const repoInfo = r.repo ? ` • ${r.repo}` : '';
      const pathInfo = r.path ? ` • ${r.path}` : '';

      // Extract source URL for Confluence documents
      let sourceUrl = '';
      if (r.source === 'confluence' && r.extra_json && CONFIG.CONFLUENCE_BASE_URL) {
        try {
          const extraData = JSON.parse(r.extra_json);
          if (extraData.webui) {
            sourceUrl = ` • ${CONFIG.CONFLUENCE_BASE_URL.replace(/\/$/, '')}${extraData.webui}`;
          }
        } catch (_error) {
          // Ignore JSON parsing errors
        }
      }

      // For URL sources, include the original URL
      let urlInfo = '';
      if (r.source === 'url' && r.uri) {
        urlInfo = `\n   URL: ${r.uri}`;
      }

      const location = `${r.source}${repoInfo}${pathInfo}${sourceUrl}`;

      const snippet = String(r.snippet || '')
        .replace(/\s+/g, ' ')
        .slice(0, 300);
      const ellipsis = snippet.length >= 300 ? '…' : '';

      lines.push(`## ${name}`);
      lines.push(`   [${location}] chunk:${r.chunk_id}${urlInfo}`);
      lines.push(`   ${snippet}${ellipsis}`);
      lines.push('');
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    };
  },
);

let mcpLogger: Logger | undefined;
const watchers: Array<{ close(): Promise<void> | void }> = [];

function logInfo(message: string, fields?: Record<string, unknown>): void {
  if (mcpLogger) {
    mcpLogger.info('docsearch', { message, ...fields });
    return;
  }
  console.error(message);
}

function logError(message: string, fields?: Record<string, unknown>): void {
  if (mcpLogger) {
    mcpLogger.error('docsearch', { message, ...fields });
    return;
  }
  console.error(message);
}

/**
 * Run initial indexing of files and URLs
 */
async function ensureDataDirectories(logger?: Logger): Promise<void> {
  await mkdir(CONFIG.DATA_DIR, { recursive: true });
  await mkdir(CONFIG.DOCS_DIR, { recursive: true });
  await ensureUrlsFile();
  logger?.info('docsearch.paths', {
    dataDir: CONFIG.DATA_DIR,
    docsDir: CONFIG.DOCS_DIR,
    urlsFile: CONFIG.URLS_FILE,
    indexDir: CONFIG.DB_PATH,
  });
}

async function runInitialIndexing(): Promise<void> {
  logInfo('Running initial indexing...');
  setIndexingRunning();
  try {
    const adapter = await getDatabase();
    logInfo('Indexing files from docs directory...');
    await ingestFiles(adapter);
    logInfo('Indexing URLs from urls.md...');
    await ingestUrls(adapter);
    logInfo('Generating embeddings...');
    const indexer = new Indexer(adapter);
    await indexer.embedNewChunks();
    logInfo('Initial indexing complete');
    setIndexingIdle();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError('Error during initial indexing', { error: message });
    setIndexingIdle(message);
  }
}

/**
 * Debounce helper to avoid rapid re-indexing
 */
function debounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return ((...args: unknown[]) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  }) as T;
}

/**
 * Start file watching for auto-indexing
 */
function startFileWatching(): void {
  let isIndexing = false;

  // Debounced URL indexing (wait 2 seconds after last change)
  const indexUrls = debounce(async () => {
    if (isIndexing) {
      logInfo('[watch] Skipping URL indexing - already in progress');
      return;
    }
    isIndexing = true;
    setIndexingRunning();
    logInfo('[watch] urls.md changed - re-indexing URLs...');
    try {
      const adapter = await getDatabase();
      await ingestUrls(adapter);
      const indexer = new Indexer(adapter);
      await indexer.embedNewChunks();
      logInfo('[watch] URL indexing complete');
      setIndexingIdle();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError('[watch] URL indexing failed', { error: message });
      setIndexingIdle(message);
    } finally {
      isIndexing = false;
    }
  }, 2000);

  const indexFiles = debounce(async () => {
    if (isIndexing) {
      logInfo('[watch] Skipping file indexing - already in progress');
      return;
    }
    isIndexing = true;
    setIndexingRunning();
    logInfo('[watch] docs/ changed - re-indexing files...');
    try {
      const adapter = await getDatabase();
      await ingestFiles(adapter);
      const indexer = new Indexer(adapter);
      await indexer.embedNewChunks();
      logInfo('[watch] File indexing complete');
      setIndexingIdle();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError('[watch] File indexing failed', { error: message });
      setIndexingIdle(message);
    } finally {
      isIndexing = false;
    }
  }, 2000);

  // Watch urls.md for changes
  const urlsWatcher = chokidar.watch(CONFIG.URLS_FILE, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  urlsWatcher.on('change', () => {
    indexUrls();
  });

  urlsWatcher.on('error', (error) => {
    logError('[watch] urls.md watcher error', { error: String(error) });
  });

  // Watch docs directory for changes
  const docsWatcher = chokidar.watch(CONFIG.DOCS_DIR, {
    ignoreInitial: true,
    ignored: /(^|[/\\])\../, // ignore dotfiles
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  docsWatcher.on('all', (event, filePath) => {
    if (event === 'unlink') {
      logInfo(`[watch] ${event}: ${filePath}`);
      void (async () => {
        try {
          const adapter = await getDatabase();
          await removeIndexedFile(adapter, filePath);
        } catch (error) {
          logError('[watch] unlink remove failed', { error: String(error), path: filePath });
        }
      })();
      return;
    }
    if (event === 'add' || event === 'change') {
      logInfo(`[watch] ${event}: ${filePath}`);
      indexFiles();
    }
  });

  docsWatcher.on('error', (error) => {
    logError('[watch] docs/ watcher error', { error: String(error) });
  });

  watchers.push(urlsWatcher, docsWatcher);
  logInfo(`[watch] Watching ${CONFIG.URLS_FILE} for URL changes`);
  logInfo(`[watch] Watching ${CONFIG.DOCS_DIR} for file changes`);
}

export async function startServer() {
  const lifecycle = await startDocsearchLifecycle();
  mcpLogger = lifecycle.logger;
  configureDatabase({ diskGate: lifecycle.diskGate });

  await ensureDataDirectories(lifecycle.logger);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Docsearch MCP Server running on stdio; logs: ${lifecycle.logger.currentFilePath()}`);

  void runInitialIndexing();
  startFileWatching();

  installDocsearchShutdown(lifecycle, transport, async () => {
    for (const watcher of watchers) {
      await Promise.resolve(watcher.close()).catch(() => undefined);
    }
    await closeDatabase();
    await lifecycle.processLock.release();
    await removeInstanceFile(lifecycle.dataDir);
    await lifecycle.logger.flush();
    lifecycle.logger.close();
  });
}

// Auto-start if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
}
