# RooCode MCP Servers Setup Guide

This guide explains how to integrate the MCP servers collection with [RooCode](https://roocode.com).

## Prerequisites

- **Node.js 20+** installed
- **npm** available
- **OpenAI API key** (for docsearch embeddings)
- **RooCode** extension installed in VS Code

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/modelcontextprotocol/servers.git mcp-servers
cd mcp-servers
npm install
```

### 2. Configure MCP Servers

Copy the template configuration to your project:

```bash
# Create .roo directory in your project
mkdir -p <YOUR_PROJECT>\.roo

# Copy the template
copy mcp-servers\mcp-config-roocode.json <YOUR_PROJECT>\.roo\mcp.json
```

### 3. Edit the Configuration

Open `<YOUR_PROJECT>\.roo\mcp.json` and replace the placeholders:

| Placeholder | Replace With | Example |
|-------------|--------------|---------|
| `<MCP_SERVERS_PATH>` | Full path to mcp-servers folder | `C:\\DEVHOME\\GITHUB\\mcp-servers` |
| `<ALLOWED_PATH>` | Directory for filesystem access | `C:\\DEVHOME` |
| `<YOUR_OPENAI_API_KEY>` | Your OpenAI API key | `sk-proj-...` |
| `<YOUR_PROJECT_PATH>` | Your project's root path | `C:\\DEVHOME\\GITHUB\\MyProject` |

**Example after replacement:**

```json
{
  "mcpServers": {
    "central-memory": {
      "command": "npx",
      "args": ["tsx", "src/memory/index.ts"],
      "cwd": "C:\\DEVHOME\\GITHUB\\mcp-servers",
      "disabled": false
    },
    "central-docsearch": {
      "command": "npx",
      "args": ["tsx", "src/docsearch/index.ts"],
      "cwd": "C:\\DEVHOME\\GITHUB\\mcp-servers",
      "env": {
        "OPENAI_API_KEY": "sk-proj-your-key-here",
        "DOCSEARCH_DATA_DIR": "C:\\DEVHOME\\GITHUB\\MyProject\\.roo\\docsearch-data"
      }
    }
  }
}
```

### 4. Copy the Rule File (Optional but Recommended)

Copy the AI instructions rule file to your project:

```bash
mkdir -p <YOUR_PROJECT>\.roo\rules
copy mcp-servers\.roo\rules\mcp-servers.md <YOUR_PROJECT>\.roo\rules\
```

This file teaches the AI how to use the MCP servers effectively.

### 5. Set Up Docsearch Data (Optional)

If using docsearch, create the data directories:

```bash
mkdir -p <YOUR_PROJECT>\.roo\docsearch-data\docs
```

Add URLs to index in `<YOUR_PROJECT>\.roo\docsearch-data\urls.md`:

```markdown
# Documentation URLs to index
https://www.typescriptlang.org/docs/handbook/
https://docs.example.com/api/
```

### 6. Restart RooCode

Restart VS Code or reload the window to activate the MCP servers.

## Available Servers

| Server | Purpose |
|--------|---------|
| `central-memory` | Knowledge graph for persistent storage |
| `central-filesystem` | File operations outside workspace |
| `central-docsearch` | Documentation search (requires OpenAI key) |
| `central-sequentialthinking` | Complex reasoning and problem-solving |
| `central-fake-qdrant` | Local vector database |
| `central-everything` | Demo/test server (disabled by default) |

## Docsearch Features

The docsearch server provides:

- **Recursive crawling**: Add a documentation URL and it crawls up to 100 pages
- **Hybrid search**: Combines semantic and keyword search
- **Auto-indexing**: Watches for changes to `urls.md` and `docs/` folder
- **Caching**: Only re-crawls after 30 days (configurable)

### Adding Documentation

**Local files:** Drop files into `.roo/docsearch-data/docs/`

**Web pages:** Add URLs to `.roo/docsearch-data/urls.md` (one per line)

### Using Docsearch

Ask the AI to search your indexed docs:

```
Search my docs for "TypeScript generics"
```

Or use the tool directly:

```
Use doc-search with query "API authentication"
```

## Troubleshooting

### Server not starting

1. Check Node.js version: `node --version` (should be 20+)
2. Verify paths in mcp.json use double backslashes on Windows
3. Check RooCode output panel for errors

### Docsearch not finding results

1. Verify OPENAI_API_KEY is set correctly
2. Check that URLs were indexed: use `doc-ingest-status` tool
3. Try `doc-ingest` with `force: true` to re-index

### Memory server not persisting

The memory server stores data in `memory.json` in the mcp-servers directory.
Ensure the directory is writable.

## Environment Variables

| Variable | Server | Description |
|----------|--------|-------------|
| `OPENAI_API_KEY` | docsearch | Required for embeddings |
| `DOCSEARCH_DATA_DIR` | docsearch | Data directory location |
| `DOCSEARCH_CRAWL_LIFETIME_DAYS` | docsearch | Days before re-crawl (default: 30) |
| `FAKE_QDRANT_ENABLED` | fake-qdrant | Enable the server |
| `FAKE_QDRANT_HTTP_PORT` | fake-qdrant | HTTP API port (default: 6333) |

## File Structure

After setup, your project should have:

```
your-project/
├── .roo/
│   ├── mcp.json              # MCP server configuration
│   ├── rules/
│   │   └── mcp-servers.md    # AI instructions (optional)
│   └── docsearch-data/       # Docsearch data (if using)
│       ├── docs/             # Local files to index
│       ├── urls.md           # URLs to crawl
│       └── index.db          # SQLite database (auto-created)
└── ...
```

## Links

- [RooCode Custom Instructions](https://docs.roocode.com/features/custom-instructions)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
