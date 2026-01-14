# docsearch-mcp (Local Fork)

100% local document search MCP server using SQLite + sqlite-vec. No Docker, no external databases, no cloud services required (except OpenAI API for embeddings).

## Features

- **Hybrid Search**: Combines full-text search (FTS5) with vector similarity for optimal results
- **Multi-Source Indexing**: Local files, web pages (URLs), and Confluence (optional)
- **Automatic Indexing**: Server auto-indexes on startup
- **Simple Setup**: Just drop files in a folder and add URLs to a text file
- **100% Local Storage**: SQLite database with sqlite-vec extension
- **PDF Support**: Extract and search text from PDF documents
- **Image Support**: Optional AI-powered image description and search

## Quick Start

### 1. Set your OpenAI API key

```bash
# Windows PowerShell
$env:OPENAI_API_KEY = "sk-your-key-here"

# Or create a .env file
echo OPENAI_API_KEY=sk-your-key-here > .env
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
        "OPENAI_API_KEY": "sk-your-key-here"
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
        "OPENAI_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | - | OpenAI API key for embeddings |
| `DOCSEARCH_DATA_DIR` | No | `./data` | Base data directory |
| `DOCSEARCH_CRAWL_LIFETIME_DAYS` | No | `30` | Days before re-crawling URLs |
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
2. **Embeddings**: Each chunk gets an OpenAI embedding for semantic search
3. **FTS5**: Full-text search index for keyword matching
4. **Hybrid Search**: Combines vector similarity with keyword matching for best results

## Troubleshooting

### "OPENAI_API_KEY not set"

Make sure you have set the environment variable or created a `.env` file.

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
