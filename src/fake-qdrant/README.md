# Fake Qdrant MCP Server

A local, lightweight Qdrant-compatible vector database server for the Model Context Protocol (MCP). This server provides vector similarity search capabilities without requiring an external Qdrant instance, making it ideal for development, testing, and offline environments.

## Overview

Fake Qdrant implements a subset of the Qdrant vector database API, offering:

- **MCP Tools Interface** - Direct integration with MCP-compatible clients (VS Code, RooCode, Claude Desktop)
- **HTTP API Shim** - Qdrant-compatible REST API on port 6333 (optional)
- **SQLite Vector Search** - Efficient KNN search using sqlite-vec extension
- **Persistent Storage** - Data persisted to SQLite databases with WAL mode
- **Zero External Services** - Node.js implementation, no Docker or external services required

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Client Applications                       │
│         (VS Code, RooCode, Claude Desktop, curl)            │
└─────────────────┬───────────────────────┬───────────────────┘
                  │                       │
                  ▼                       ▼
┌─────────────────────────┐   ┌─────────────────────────────┐
│   MCP Tools Interface   │   │   HTTP API Shim (optional)  │
│   fake_qdrant_* tools   │   │   Qdrant-compatible REST    │
└─────────────┬───────────┘   └─────────────┬───────────────┘
              │                             │
              └──────────────┬──────────────┘
                             ▼
              ┌─────────────────────────────┐
              │          Store              │
              │   Collection Management     │
              └──────────────┬──────────────┘
                             │
                             ▼
              ┌─────────────────────────────┐
              │     SQLite + sqlite-vec     │
              │   vec0 Virtual Tables       │
              │   (KNN Vector Search)       │
              └─────────────────────────────┘
```

## MCP Tools

The server exposes the following MCP tools:

| Tool | Description |
|------|-------------|
| `fake_qdrant_list_collections` | List all locally stored collections |
| `fake_qdrant_get_collection` | Get details of a specific collection |
| `fake_qdrant_create_collection` | Create a new collection with vector configuration |
| `fake_qdrant_delete_collection` | Remove a collection and its data |
| `fake_qdrant_upsert_points` | Insert or update vector points in a collection |
| `fake_qdrant_query_points` | Run vector similarity search (KNN) |
| `fake_qdrant_compact_collection` | Run SQLite VACUUM to optimize database |
| `fake_qdrant_persist_indexes` | Flush WAL checkpoint to ensure data durability |

### Tool Details

#### fake_qdrant_create_collection

```json
{
  "name": "my-vectors",
  "size": 384,
  "distance": "Cosine"
}
```

- `name` - Collection identifier
- `size` - Vector dimension (must match your embedding model output)
- `distance` - Distance metric (currently only `Cosine` is supported)

#### fake_qdrant_upsert_points

```json
{
  "collection": "my-vectors",
  "points": [
    {
      "id": "doc-001",
      "vector": [0.1, 0.2, ...],
      "payload": { "title": "Document 1", "path": "/docs/file.md" }
    }
  ]
}
```

#### fake_qdrant_query_points

```json
{
  "collection": "my-vectors",
  "vector": [0.1, 0.2, ...],
  "limit": 10,
  "scoreThreshold": 0.7
}
```

## HTTP API (Optional)

When enabled, the server exposes a Qdrant-compatible HTTP API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Health check |
| `GET` | `/healthz` | Health check |
| `GET` | `/collections` | List all collections |
| `PUT` | `/collections/{name}` | Create a collection |
| `GET` | `/collections/{name}` | Get collection info |
| `DELETE` | `/collections/{name}` | Delete a collection |
| `PUT` | `/collections/{name}/points` | Upsert points |
| `POST` | `/collections/{name}/points/query` | Query/search points |
| `POST` | `/collections/{name}/points/delete` | Delete points by ID or filter |
| `POST` | `/collections/{name}/compact` | Compact collection (custom endpoint) |

## Installation and Setup

### Prerequisites

- Node.js 20 or later
- npm (with access to your organization's internal registry if applicable)

### VS Code / RooCode Setup

#### Method 1: Workspace Configuration (Recommended)

Create or edit `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "fake-qdrant": {
      "command": "npx",
      "args": ["tsx", "src/fake-qdrant/index.ts"],
      "env": {
        "FAKE_QDRANT_ENABLED": "1",
        "FAKE_QDRANT_HTTP_PORT": "6333"
      }
    }
  }
}
```

#### Method 2: User Configuration

1. Open Command Palette (`Ctrl+Shift+P`)
2. Run `MCP: Open User Configuration`
3. Add the server configuration as shown above

#### Method 3: Using Built Distribution

If you have built the project:

```json
{
  "servers": {
    "fake-qdrant": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "FAKE_QDRANT_ENABLED": "1"
      }
    }
  }
}
```

### RooCode-Specific Setup

RooCode uses the same MCP configuration format. Add to your RooCode MCP settings:

```json
{
  "mcpServers": {
    "fake-qdrant": {
      "command": "npx",
      "args": ["tsx", "src/fake-qdrant/index.ts"],
      "env": {
        "FAKE_QDRANT_ENABLED": "1",
        "FAKE_QDRANT_HTTP_PORT": "6333",
        "FAKE_QDRANT_DATA_DIR": "./data/qdrant"
      }
    }
  }
}
```

### Cursor IDE Setup

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "central-fake-qdrant": {
      "command": "npx",
      "args": ["tsx", "src/fake-qdrant/index.ts"],
      "env": {
        "FAKE_QDRANT_ENABLED": "1",
        "FAKE_QDRANT_HTTP_PORT": "6333"
      }
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FAKE_QDRANT_ENABLED` | `0` | Set to `1` to enable the HTTP API shim |
| `FAKE_QDRANT_HTTP_PORT` | `6333` | HTTP server port |
| `FAKE_QDRANT_HTTP_HOST` | `127.0.0.1` | HTTP server bind address |
| `FAKE_QDRANT_DATA_DIR` | `./data` | Directory for persistent storage |

## Usage Examples

### Creating a Collection and Upserting Vectors

Using MCP tools (via AI assistant):

```
Create a collection named "documents" with 384-dimensional vectors.
Then upsert these document embeddings...
```

Using HTTP API (curl):

```bash
# Create collection
curl -X PUT "http://localhost:6333/collections/documents" \
  -H "Content-Type: application/json" \
  -d '{"vectors": {"size": 384, "distance": "Cosine"}}'

# Upsert points
curl -X PUT "http://localhost:6333/collections/documents/points" \
  -H "Content-Type: application/json" \
  -d '{
    "points": [
      {"id": 1, "vector": [0.1, 0.2, ...], "payload": {"title": "Doc 1"}}
    ]
  }'

# Query similar vectors
curl -X POST "http://localhost:6333/collections/documents/points/query" \
  -H "Content-Type: application/json" \
  -d '{"vector": [0.1, 0.2, ...], "limit": 5}'
```

### Querying Similar Documents

```bash
curl -X POST "http://localhost:6333/collections/documents/points/query" \
  -H "Content-Type: application/json" \
  -d '{
    "vector": [0.15, 0.25, ...],
    "limit": 10,
    "score_threshold": 0.7
  }'
```

### Deleting Points by Filter

```bash
curl -X POST "http://localhost:6333/collections/documents/points/delete" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": {
      "must": [{"key": "path", "match": {"value": "/docs/old.md"}}]
    }
  }'
```

## Troubleshooting

### Port 6333 Already in Use

**Symptom:** Server fails to start with `EADDRINUSE` error.

**Solutions:**

1. **Find and stop the conflicting process:**
   ```powershell
   # PowerShell (Windows)
   Get-NetTCPConnection -LocalPort 6333 -State Listen | 
     Select-Object -ExpandProperty OwningProcess | 
     ForEach-Object { Stop-Process -Id $_ -Force }
   ```

2. **Use a different port:**
   ```json
   {
     "env": {
       "FAKE_QDRANT_HTTP_PORT": "6334"
     }
   }
   ```

3. **Disable HTTP shim** (use MCP tools only):
   ```json
   {
     "env": {
       "FAKE_QDRANT_ENABLED": "0"
     }
   }
   ```

### MCP Server Not Connecting

**Symptom:** Tools don't appear in VS Code/RooCode.

**Solutions:**

1. **Verify configuration path:**
   - VS Code: `.vscode/mcp.json` or user settings
   - RooCode: Check RooCode MCP settings location
   - Cursor: `.cursor/mcp.json`

2. **Check Node.js availability:**
   ```powershell
   node --version  # Should be v20+
   npx tsx --version
   ```

3. **Verify workspace path:**
   Ensure the `args` path is correct relative to your workspace root.

4. **Check Output panel:**
   - VS Code: View → Output → Select "MCP" from dropdown
   - Look for startup errors or connection issues

5. **Restart the MCP server:**
   - Command Palette (`Ctrl+Shift+P`) → `MCP: Restart Server`

### Tools Not Appearing in VS Code/RooCode

**Symptom:** MCP server connects but tools are not visible.

**Solutions:**

1. **Reload window:**
   - Command Palette → `Developer: Reload Window`

2. **Check server logs:**
   ```powershell
   # Run manually to see output
   npx tsx src/fake-qdrant/index.ts
   ```

3. **Verify MCP SDK version:**
   Check that `@modelcontextprotocol/sdk` is properly installed.

### Data Persistence Issues

**Symptom:** Data lost after restart.

**Solutions:**

1. **Check data directory permissions:**
   ```powershell
   # Verify directory exists and is writable
   Test-Path -Path ".\data"
   ```

2. **Set explicit data directory:**
   ```json
   {
     "env": {
       "FAKE_QDRANT_DATA_DIR": "C:\\Users\\YourName\\qdrant-data"
     }
   }
   ```

3. **SQLite uses WAL mode:**
   Data is automatically persisted. Use `fake_qdrant_persist_indexes` to force a WAL checkpoint.

### Vector Dimension Mismatch

**Symptom:** Error "Vector must contain N finite numbers for collection X"

**Solutions:**

1. **Verify embedding model output dimension:**
   - OpenAI `text-embedding-3-small`: 1536 dimensions
   - OpenAI `text-embedding-ada-002`: 1536 dimensions
   - Sentence Transformers `all-MiniLM-L6-v2`: 384 dimensions

2. **Match collection size to your model:**
   ```json
   {
     "name": "my-collection",
     "size": 1536,
     "distance": "Cosine"
   }
   ```

3. **Check for truncated vectors:**
   Ensure your embedding pipeline returns complete vectors.

### Database Recovery

**Symptom:** Query returns unexpected results or errors.

**Solutions:**

1. **Compact the collection (runs VACUUM):**
   ```bash
   curl -X POST "http://localhost:6333/collections/my-collection/compact"
   ```

2. **Check for WAL files:**
   ```powershell
   # SQLite WAL files should be automatically merged
   # If stuck, delete WAL files (data loss possible if uncommitted)
   Remove-Item ".\data\my-collection.db-wal"
   Remove-Item ".\data\my-collection.db-shm"
   ```

3. **Full reset (last resort):**
   ```powershell
   # Backup data first!
   Remove-Item ".\data\my-collection.db"
   ```

### HTTP API Returns 404

**Symptom:** All HTTP requests return "not found".

**Solutions:**

1. **Verify HTTP shim is enabled:**
   ```json
   {
     "env": {
       "FAKE_QDRANT_ENABLED": "1"
     }
   }
   ```

2. **Check the port:**
   ```bash
   curl http://localhost:6333/healthz
   ```

3. **Verify endpoint format:**
   - Collection names are URL-encoded
   - Points endpoint uses `PUT` for upsert, `POST` for query

## Migration from JSONL Format

If you have existing data from the previous JSONL + HNSW implementation, you can migrate it to the new SQLite format:

```powershell
cd src/fake-qdrant
npm run migrate
# Or specify a custom data directory:
npx tsx migrate.ts "C:\path\to\data"
```

The migration utility will:
1. Find all old-style collections (directories with `meta.json` and `points.jsonl`)
2. Create new SQLite databases for each collection
3. Import all points into the new format
4. Print instructions for removing old data directories

## Development

### Building from Source

```powershell
cd src/fake-qdrant
npm install
npm run build
```

### Running Tests

```powershell
cd src/fake-qdrant
npm test              # Run tests once
npm run test:watch    # Run tests in watch mode
```

### Project Structure

```
src/fake-qdrant/
├── index.ts           # Entry point (stdio transport)
├── server.ts          # MCP server and tool registration
├── store.ts           # SQLite + sqlite-vec storage layer
├── qdrant-http.ts     # HTTP API shim
├── __tests__/
│   └── qdrant-http.test.ts  # Integration tests
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Limitations

- **Distance Metrics:** Only Cosine similarity is currently supported
- **Filters:** Basic filter support for delete operations (must/should conditions)
- **Scroll/Pagination:** Not implemented for large result sets
- **Sharding:** Single-node only, no distributed support

## License

MIT License - see the LICENSE file in the project repository.
