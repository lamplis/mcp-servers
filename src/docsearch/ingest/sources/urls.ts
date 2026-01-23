import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import TurndownService from 'turndown';

import { CONFIG } from '../../shared/config.js';
import { addChunkHeader, chunkDoc } from '../chunker.js';
import { sha256 } from '../hash.js';
import { Indexer } from '../indexer.js';

import type { DatabaseAdapter } from '../adapters/index.js';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

/** Maximum pages to crawl per starting URL */
const MAX_PAGES_PER_SITE = 100;

/** Delay between requests in ms (be polite to servers) */
const REQUEST_DELAY_MS = 200;

/** Default crawl lifetime in days (how long before re-crawling) */
const DEFAULT_CRAWL_LIFETIME_DAYS = 30;

/** Get crawl lifetime in milliseconds from env or default */
function getCrawlLifetimeMs(): number {
  const days = parseInt(process.env['DOCSEARCH_CRAWL_LIFETIME_DAYS'] || '', 10);
  const lifetimeDays = isNaN(days) || days <= 0 ? DEFAULT_CRAWL_LIFETIME_DAYS : days;
  return lifetimeDays * 24 * 60 * 60 * 1000;
}

/** File extensions to skip */
const SKIP_EXTENSIONS = new Set([
  '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.mp3', '.mp4', '.wav', '.avi', '.mov',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dmg', '.pkg', '.deb', '.rpm',
  '.css', '.js', '.json', '.xml', '.rss', '.atom',
]);

/** Path patterns to skip (non-documentation pages) */
const SKIP_PATH_PATTERNS = [
  /\/login\b/i,
  /\/logout\b/i,
  /\/signup\b/i,
  /\/register\b/i,
  /\/signin\b/i,
  /\/auth\b/i,
  /\/oauth\b/i,
  /\/api\/(?!docs)/i,  // skip /api/ but not /api/docs
  /\/search\b/i,
  /\/download\b/i,
  /\/cdn\//i,
  /\/static\//i,
  /\/assets\//i,
  /\/_next\//i,
  /\/node_modules\//i,
];

/**
 * Remove unwanted HTML elements before conversion
 */
function cleanHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
}

/**
 * Parse urls.md file - one URL per line, skip empty lines and comments
 */
function parseUrlsFile(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.startsWith('http'));
}

/**
 * Extract title from HTML
 */
function extractTitle(html: string, url: string): string {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    return titleMatch[1].trim();
  }
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    return pathParts[pathParts.length - 1] || urlObj.hostname;
  } catch {
    return url;
  }
}

/**
 * Extract main content from HTML and convert to markdown
 */
function extractContent(html: string): string {
  const cleanedHtml = cleanHtml(html);

  const mainPatterns = [
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<body[^>]*>([\s\S]*?)<\/body>/i,
  ];

  let contentHtml: string = cleanedHtml;
  for (const pattern of mainPatterns) {
    const match = cleanedHtml.match(pattern);
    if (match && match[1]) {
      contentHtml = match[1];
      break;
    }
  }

  const markdown = turndown.turndown(contentHtml);

  return markdown
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
    .trim();
}

/**
 * Normalize URL for deduplication
 * - Remove fragment (#...)
 * - Remove trailing slash
 * - Sort query params (optional, for consistency)
 */
function normalizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    // Remove fragment
    urlObj.hash = '';
    // Normalize path (remove trailing slash except for root)
    if (urlObj.pathname.length > 1 && urlObj.pathname.endsWith('/')) {
      urlObj.pathname = urlObj.pathname.slice(0, -1);
    }
    return urlObj.toString();
  } catch {
    return url;
  }
}

/**
 * Check if URL should be skipped based on extension or path patterns
 */
function shouldSkipUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();

    // Check file extension
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot !== -1) {
      const ext = pathname.slice(lastDot);
      if (SKIP_EXTENSIONS.has(ext)) {
        return true;
      }
    }

    // Check path patterns
    for (const pattern of SKIP_PATH_PATTERNS) {
      if (pattern.test(pathname)) {
        return true;
      }
    }

    return false;
  } catch {
    return true;
  }
}

/**
 * Extract all links from HTML and resolve them to absolute URLs
 */
function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();

  // Match href attributes in anchor tags
  const linkRegex = /<a[^>]+href=["']([^"'#][^"']*)["']/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    if (!href) continue;

    try {
      // Resolve relative URLs
      const absoluteUrl = new URL(href, baseUrl).toString();
      const normalized = normalizeUrl(absoluteUrl);

      // Skip if already seen
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      // Skip if should be filtered
      if (shouldSkipUrl(normalized)) continue;

      links.push(normalized);
    } catch {
      // Invalid URL, skip
    }
  }

  return links;
}

/**
 * Check if two URLs are on the same domain
 */
function isSameDomain(url: string, baseUrl: string): boolean {
  try {
    const urlHost = new URL(url).hostname.toLowerCase();
    const baseHost = new URL(baseUrl).hostname.toLowerCase();
    return urlHost === baseHost;
  } catch {
    return false;
  }
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Page content with raw HTML for link extraction */
interface CrawledPage {
  url: string;
  title: string;
  content: string;
  html: string;
}

/**
 * Fetch a web page and return both content and raw HTML
 */
async function fetchPage(url: string): Promise<CrawledPage | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; docsearch-mcp/1.0)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      console.warn(`[crawl] Failed to fetch ${url}: ${response.status}`);
      return null;
    }

    // Check content type
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      console.warn(`[crawl] Skipping non-HTML content at ${url}`);
      return null;
    }

    const html = await response.text();
    const title = extractTitle(html, url);
    const content = extractContent(html);

    if (!content || content.length < 50) {
      console.warn(`[crawl] No meaningful content at ${url}`);
      return null;
    }

    return { url, title, content, html };
  } catch (error) {
    console.warn(`[crawl] Error fetching ${url}:`, error);
    return null;
  }
}

/**
 * Crawl a site recursively using BFS
 * - Stays on the same domain
 * - Avoids loops (tracks visited URLs)
 * - Stops at MAX_PAGES_PER_SITE
 * - Adds delay between requests
 */
async function crawlSite(startUrl: string): Promise<CrawledPage[]> {
  const normalizedStart = normalizeUrl(startUrl);
  const visited = new Set<string>();
  const queue: string[] = [normalizedStart];
  const results: CrawledPage[] = [];

  console.info(`[crawl] Starting recursive crawl from ${startUrl}`);
  console.info(`[crawl] Max pages: ${MAX_PAGES_PER_SITE}, delay: ${REQUEST_DELAY_MS}ms`);

  while (queue.length > 0 && results.length < MAX_PAGES_PER_SITE) {
    const url = queue.shift()!;

    // Skip if already visited
    if (visited.has(url)) continue;
    visited.add(url);

    // Rate limiting
    if (results.length > 0) {
      await sleep(REQUEST_DELAY_MS);
    }

    console.info(`[crawl] (${results.length + 1}/${MAX_PAGES_PER_SITE}) Fetching: ${url}`);

    const page = await fetchPage(url);
    if (!page) continue;

    results.push(page);

    // Extract links and add same-domain ones to queue
    const links = extractLinks(page.html, url);
    for (const link of links) {
      if (!visited.has(link) && isSameDomain(link, startUrl)) {
        queue.push(link);
      }
    }

    console.info(`[crawl] Found ${links.filter((l) => isSameDomain(l, startUrl)).length} same-domain links`);
  }

  console.info(`[crawl] Finished crawling ${startUrl}: ${results.length} pages`);
  return results;
}

/**
 * Check when a starting URL was last crawled
 * Returns the most recent mtime of documents crawled from this URL, or null if never crawled
 */
async function getLastCrawlTime(adapter: DatabaseAdapter, startUrl: string): Promise<number | null> {
  try {
    // Find documents that were crawled from this starting URL
    const results = await adapter.rawQuery(
      `SELECT MAX(mtime) as last_crawl FROM documents WHERE extra_json LIKE ?`,
      [`%"crawledFrom":"${startUrl}"%`]
    );
    
    if (results && results.length > 0) {
      const row = results[0] as { last_crawl: number | null };
      return row.last_crawl;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format duration in human-readable format
 */
function formatDuration(ms: number): string {
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  return `${hours}h`;
}

/**
 * Ensure urls.md file exists with template content
 */
export async function ensureUrlsFile(): Promise<void> {
  const urlsFile = CONFIG.URLS_FILE;
  if (!existsSync(urlsFile)) {
    const template = `# URLs to Index
# Add one URL per line. Lines starting with # are ignored.
# Each URL will be crawled recursively (same-domain links, up to 100 pages).
# URLs are re-crawled after ${DEFAULT_CRAWL_LIFETIME_DAYS} days (configurable via DOCSEARCH_CRAWL_LIFETIME_DAYS).

# Example:
# https://docs.example.com/getting-started
# https://www.typescriptlang.org/docs/handbook/
`;
    await writeFile(urlsFile, template, 'utf-8');
    console.info(`Created ${urlsFile} template`);
  }
}

/**
 * Ingest URLs from urls.md file with recursive crawling
 * @param adapter Database adapter
 * @param force If true, ignore lifetime and force re-crawl
 */
export async function ingestUrls(adapter: DatabaseAdapter, force = false): Promise<void> {
  const urlsFile = CONFIG.URLS_FILE;
  const indexer = new Indexer(adapter);
  const crawlLifetimeMs = getCrawlLifetimeMs();
  const crawlLifetimeDays = Math.round(crawlLifetimeMs / (24 * 60 * 60 * 1000));

  await ensureUrlsFile();

  try {
    const content = await readFile(urlsFile, 'utf-8');
    const startUrls = parseUrlsFile(content);

    if (startUrls.length === 0) {
      console.info('No URLs to index (urls.md is empty or contains only comments)');
      return;
    }

    console.info(`Found ${startUrls.length} starting URLs to crawl`);
    console.info(`[crawl] Crawl lifetime: ${crawlLifetimeDays} days${force ? ' (FORCE mode - ignoring lifetime)' : ''}`);

    for (const startUrl of startUrls) {
      try {
        // Check if we should skip this URL based on lifetime
        if (!force) {
          const lastCrawl = await getLastCrawlTime(adapter, startUrl);
          if (lastCrawl !== null) {
            const age = Date.now() - lastCrawl;
            if (age < crawlLifetimeMs) {
              const remaining = crawlLifetimeMs - age;
              console.info(`[crawl] Skipping ${startUrl} - crawled ${formatDuration(age)} ago, next crawl in ${formatDuration(remaining)}`);
              continue;
            }
            console.info(`[crawl] Re-crawling ${startUrl} - last crawl was ${formatDuration(age)} ago (lifetime: ${crawlLifetimeDays}d)`);
          } else {
            console.info(`[crawl] First time crawling ${startUrl}`);
          }
        }

        // Crawl the site recursively
        const pages = await crawlSite(startUrl);

        console.info(`[index] Indexing ${pages.length} pages from ${startUrl}`);

        for (const page of pages) {
          try {
            const hash = sha256(page.content);

            // Check if already indexed with same hash
            const existing = await adapter.getDocument(page.url);
            if (existing?.hash === hash) {
              console.info(`[index] Skipping ${page.url} (unchanged)`);
              continue;
            }

            // Index the page
            const docId = await indexer.upsertDocument({
              source: 'url',
              uri: page.url,
              repo: null,
              path: null,
              title: page.title,
              lang: 'html',
              hash,
              mtime: Date.now(),
              version: null,
              extraJson: JSON.stringify({
                fetchedAt: new Date().toISOString(),
                crawledFrom: startUrl,
              }),
            });

            // Insert chunks if needed
            const hasChunks = await adapter.hasChunks(docId);
            if (!hasChunks) {
              const header = buildChunkHeader({
                title: page.title || page.url,
                source: 'url',
                uri: page.url,
              });
              const chunks = addChunkHeader(chunkDoc(page.content), header);
              await indexer.insertChunks(docId, chunks);
              console.info(`[index] Indexed ${page.url}: ${chunks.length} chunks`);
            }
          } catch (error) {
            console.error(`[index] Error indexing ${page.url}:`, error);
          }
        }
      } catch (error) {
        console.error(`[crawl] Error crawling ${startUrl}:`, error);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Error reading urls.md:', error);
    }
  }
}

function buildChunkHeader(metadata: { title: string; source: string; uri: string }): string {
  return `# ${metadata.title}\n> source=${metadata.source} uri=${metadata.uri}`;
}
