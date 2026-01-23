import { readFileSync, existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';

import chokidar from 'chokidar';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getDatabase } from '../ingest/database.js';
import { performSearch } from '../ingest/search.js';
import { rerankResults } from '../ingest/reranker.js';
import { registerIngestTools } from './tools/ingest-tools.js';
import { FormatterFactory } from '../cli/adapters/output/formatter-factory.js';
import { CONFIG } from '../shared/config.js';
import { ingestFiles } from '../ingest/sources/files.js';
import { ingestUrls, ensureUrlsFile } from '../ingest/sources/urls.js';
import { Indexer } from '../ingest/indexer.js';

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

// Read version from package.json
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

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

/**
 * Ensure data directories exist and create template files
 */
async function ensureDataDirectories(): Promise<void> {
  // Create data directory
  await mkdir(CONFIG.DATA_DIR, { recursive: true });
  
  // Create docs directory
  await mkdir(CONFIG.DOCS_DIR, { recursive: true });
  
  // Create urls.md template if it doesn't exist
  await ensureUrlsFile();
  
  console.error(`Data directory: ${CONFIG.DATA_DIR}`);
  console.error(`Docs directory: ${CONFIG.DOCS_DIR}`);
  console.error(`URLs file: ${CONFIG.URLS_FILE}`);
  console.error(`Database: ${CONFIG.DB_PATH}`);
}

/**
 * Run initial indexing of files and URLs
 */
async function runInitialIndexing(): Promise<void> {
  console.error('Running initial indexing...');
  
  try {
    const adapter = await getDatabase();
    
    // Index files from docs directory
    console.error('Indexing files from docs directory...');
    await ingestFiles(adapter);
    
    // Index URLs from urls.md
    console.error('Indexing URLs from urls.md...');
    await ingestUrls(adapter);
    
    // Generate embeddings for new chunks
    console.error('Generating embeddings...');
    const indexer = new Indexer(adapter);
    await indexer.embedNewChunks();
    
    console.error('Initial indexing complete');
  } catch (error) {
    console.error('Error during initial indexing:', error);
    // Don't fail startup if indexing fails
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
      console.error('[watch] Skipping URL indexing - already in progress');
      return;
    }
    isIndexing = true;
    console.error('[watch] urls.md changed - re-indexing URLs...');
    try {
      const adapter = await getDatabase();
      await ingestUrls(adapter);
      const indexer = new Indexer(adapter);
      await indexer.embedNewChunks();
      console.error('[watch] URL indexing complete');
    } catch (error) {
      console.error('[watch] URL indexing failed:', error);
    } finally {
      isIndexing = false;
    }
  }, 2000);

  // Debounced file indexing (wait 2 seconds after last change)
  const indexFiles = debounce(async () => {
    if (isIndexing) {
      console.error('[watch] Skipping file indexing - already in progress');
      return;
    }
    isIndexing = true;
    console.error('[watch] docs/ changed - re-indexing files...');
    try {
      const adapter = await getDatabase();
      await ingestFiles(adapter);
      const indexer = new Indexer(adapter);
      await indexer.embedNewChunks();
      console.error('[watch] File indexing complete');
    } catch (error) {
      console.error('[watch] File indexing failed:', error);
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
    console.error('[watch] urls.md watcher error:', error);
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

  docsWatcher.on('all', (event, path) => {
    if (event === 'add' || event === 'change' || event === 'unlink') {
      console.error(`[watch] ${event}: ${path}`);
      indexFiles();
    }
  });

  docsWatcher.on('error', (error) => {
    console.error('[watch] docs/ watcher error:', error);
  });

  console.error(`[watch] Watching ${CONFIG.URLS_FILE} for URL changes`);
  console.error(`[watch] Watching ${CONFIG.DOCS_DIR} for file changes`);
}

export async function startServer() {
  // Ensure data directories exist
  await ensureDataDirectories();
  
  // Run initial indexing
  await runInitialIndexing();
  
  // Start file watching for auto-indexing
  startFileWatching();
  
  // Connect MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Auto-start if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
}
