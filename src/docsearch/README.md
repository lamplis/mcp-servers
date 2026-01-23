# docsearch-mcp (Local Fork)

100% local document search MCP server using SQLite + sqlite-vec. No Docker, no external databases, no cloud services required. Fully offline after initial model download.

## Features

- **Offline-First**: Uses local transformer models for embeddings - no API keys required
- **Hybrid Search**: Combines full-text search (FTS5) with vector similarity for optimal results
- **Multi-Source Indexing**: Local files, web pages (URLs), and Confluence (optional)
- **Automatic Indexing**: Server auto-indexes on startup
- **Simple Setup**: Just drop files in a folder and add URLs to a text file
- **100% Local Storage**: SQLite database with sqlite-vec extension
- **PDF Support**: Extract and search text from PDF documents
- **Image Support**: Optional AI-powered image description and search

## Quick Start

### 1. Download the embedding model (one-time, requires network)

The first time you run the server, it will automatically download the embedding model (~23MB) to the cache directory. After this initial download, the server works completely offline.

```bash
# Model is cached in ./model-cache by default
# To use a custom location:
$env:LOCAL_MODEL_CACHE_DIR = "C:/path/to/model-cache"
```

### 2. Add your documents

The server uses a simple folder structure:

```
./data/
  ├── docs/           # Drop your files here
  │   ├── readme.md
  │   ├── api-docs.pdf
  │   └── code/
  │       └── example.ts
  ├── urls.md         # List URLs to fetch and index
  └── index.db        # SQLite database (auto-created)
```

**For local files**: Simply drop them in `./data/docs/`

**For web pages**: Add URLs to `./data/urls.md` (one per line):

```markdown
# Documentation URLs (lines starting with # are ignored)
# Each URL is crawled recursively (same-domain links, up to 100 pages)
https://www.typescriptlang.org/docs/handbook/
https://docs.example.com/getting-started

# Single pages work too - they just won't have many links to follow
https://github.com/user/repo/blob/main/README.md
```

### Recursive Crawling

When you add a URL, the server automatically:
- **Crawls recursively**: Follows links within the same domain
- **Avoids loops**: Tracks visited URLs to prevent infinite loops
- **Respects limits**: Stops at 100 pages per starting URL
- **Filters smartly**: Skips non-HTML files, login pages, assets, etc.
- **Rate limits**: Waits 200ms between requests to be polite
- **Caches results**: Only re-crawls after 30 days (configurable via `DOCSEARCH_CRAWL_LIFETIME_DAYS`)

This means adding a single documentation root URL like `https://docs.example.com/` will index the entire documentation site (up to 100 pages).

To force a re-crawl before the lifetime expires:
```
Tool: doc-ingest
Input: { "source": "url", "force": true }
```

### 3. Run the server

```bash
# Using npx
npx mcp-server-docsearch

# Or if installed globally
mcp-server-docsearch
```

The server will:
1. Create the data directories if they don't exist
2. Index all files in `./data/docs/`
3. Crawl and index all URLs from `./data/urls.md` (recursively, up to 100 pages each)
4. Generate embeddings for search
5. Start file watchers for auto-reindexing
6. Start the MCP server

### Auto-Reindexing

The server watches for changes:
- **`urls.md` changes**: Re-crawls URLs when you edit the file
- **`docs/` changes**: Re-indexes files when you add, modify, or delete documents

Changes are debounced (waits 2 seconds after last change before reindexing).

## MCP Configuration

### VS Code / Cursor

Add to `.vscode/mcp.json` or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "docsearch": {
      "command": "node",
      "args": ["path/to/mcp-servers/src/docsearch/dist/index.js"],
      "env": {
        "DOCSEARCH_DATA_DIR": "./data",
        "LOCAL_MODEL_CACHE_DIR": "./model-cache"
      }
    }
  }
}
```

### Using npx

```json
{
  "mcpServers": {
    "docsearch": {
      "command": "npx",
      "args": ["mcp-server-docsearch"],
      "env": {
        "DOCSEARCH_DATA_DIR": "./data"
      }
    }
  }
}
```

### Using OpenAI (optional)

If you prefer to use OpenAI embeddings instead of local models:

```json
{
  "mcpServers": {
    "docsearch": {
      "command": "npx",
      "args": ["mcp-server-docsearch"],
      "env": {
        "EMBEDDINGS_PROVIDER": "openai",
        "OPENAI_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

## Environment Variables

### Core Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DOCSEARCH_DATA_DIR` | No | `./data` | Base data directory |
| `DOCSEARCH_CRAWL_LIFETIME_DAYS` | No | `30` | Days before re-crawling URLs |
| `EMBEDDINGS_PROVIDER` | No | `local` | Provider: `local`, `openai`, or `tei` |

### Local Embeddings (Default)

| Variable | Default | Description |
|----------|---------|-------------|
| `LOCAL_EMBED_MODEL` | `Xenova/all-MiniLM-L6-v2` | Local transformer model |
| `LOCAL_EMBED_DIM` | `384` | Embedding dimension |
| `LOCAL_MODEL_CACHE_DIR` | `./model-cache` | Model cache directory |

### OpenAI Embeddings (Optional)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | When using OpenAI | - | OpenAI API key |
| `OPENAI_EMBED_MODEL` | No | `text-embedding-3-small` | Embedding model |
| `OPENAI_EMBED_DIM` | No | `1536` | Embedding dimension |

### Optional: Confluence Integration

| Variable | Description |
|----------|-------------|
| `CONFLUENCE_BASE_URL` | Your Confluence URL |
| `CONFLUENCE_EMAIL` | Your email |
| `CONFLUENCE_API_TOKEN` | API token |
| `CONFLUENCE_SPACES` | Comma-separated space keys |

### Optional: Image Processing

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_IMAGE_TO_TEXT` | `false` | Enable image description |
| `IMAGE_TO_TEXT_MODEL` | `gpt-4o-mini` | Vision model for images |

## MCP Tools

### doc-search

Search your indexed documents with hybrid semantic + keyword search.

**Parameters:**
- `query` (string, required): Search query
- `topK` (number, optional): Number of results (default: 8, max: 50)
- `source` (string, optional): Filter by source (`file`, `url`, `confluence`)
- `mode` (string, optional): Search mode (`auto`, `vector`, `keyword`)

### doc-ingest

Manually trigger document ingestion. URLs are cached and only re-crawled after the lifetime expires (default 30 days).

**Parameters:**
- `source` (string, required): Source to ingest (`file`, `url`, `confluence`, `all`)
- `force` (boolean, optional): Force re-crawl URLs even if within lifetime (default: false)

### doc-ingest-status

Get information about the current document index.

**Parameters:**
- `detailed` (boolean, optional): Include detailed statistics

## CLI Usage

The package also includes a CLI for manual operations:

```bash
# Index documents
docsearch ingest files
docsearch ingest urls
docsearch ingest confluence
docsearch ingest all

# Search
docsearch search "your query"
docsearch search "typescript interface" --top-k 5 --output json

# Start MCP server
docsearch start
```

## Supported File Types

- **Code**: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`, `.java`, `.cs`, `.cpp`, `.c`, `.rb`, `.php`, `.kt`, `.swift`
- **Documents**: `.md`, `.mdx`, `.txt`, `.rst`, `.adoc`, `.yaml`, `.yml`, `.json`
- **PDFs**: `.pdf` (text extraction)
- **Images**: `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp` (with optional AI description)

## How It Works

1. **Indexing**: Documents are split into chunks and stored in SQLite
2. **Embeddings**: Each chunk gets a vector embedding for semantic search
   - Default: Local transformer model (`Xenova/all-MiniLM-L6-v2`) - no API required
   - Optional: OpenAI embeddings (requires API key)
3. **FTS5**: Full-text search index for keyword matching
4. **Hybrid Search**: Combines vector similarity with keyword matching for best results

## Switching Embedding Providers

**Important**: Different embedding models produce different dimension vectors. If you switch providers, you must re-index your documents:

1. Delete the existing database: `rm ./data/index.db`
2. Set the new provider: `$env:EMBEDDINGS_PROVIDER = "openai"` (or `"local"`)
3. Run the server to re-index

| Provider | Model | Dimensions |
|----------|-------|------------|
| `local` (default) | Xenova/all-MiniLM-L6-v2 | 384 |
| `openai` | text-embedding-3-small | 1536 |

## Troubleshooting

### "Model not found in cache directory"

The embedding model needs to be downloaded on first use. Make sure you have network access for the initial download, then the server works offline.

### "No documents found"

- Check that files are in `./data/docs/`
- Check that `./data/urls.md` contains valid URLs
- Run `docsearch ingest all` to manually trigger indexing

### "sqlite-vec not loading"

The `sqlite-vec` extension requires native compilation. Ensure you have:
- Node.js 18+ 
- Build tools for your platform (usually included with Node.js)

## License

Apache License 2.0

## Credits

Based on [docsearch-mcp](https://github.com/PatrickKoss/docsearch-mcp) by Patrick Koss.
