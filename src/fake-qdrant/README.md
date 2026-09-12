# Fake Qdrant MCP Server

A local, lightweight Qdrant-compatible vector database server for the Model Context Protocol (MCP). This server provides vector similarity search capabilities without requiring an external Qdrant instance, making it ideal for development, testing, and offline environments.

## Overview

Fake Qdrant implements a subset of the Qdrant vector database API, offering:

- **MCP Tools Interface** - Direct integration with MCP-compatible clients (VS Code, RooCode, Claude Desktop)
- **HTTP API Shim** - Qdrant-compatible REST API on port 6333 (optional)
- **JSONL Vector Search** - Brute-force cosine similarity in pure JavaScript (no database binaries)
- **Optional embedding provider** - OpenAI-compatible HTTP (`OPENAI_EMBED_*` / `FAKE_QDRANT_EMBEDDING_*`) so MCP/HTTP can pass `text` instead of a raw vector. Roo `codebase_search` still embeds client-side and sends `query: number[]`.
- **Persistent Storage** - Data persisted as `meta.json` + `points.jsonl` per collection
- **Single-writer disk I/O** - Concurrent HTTP and MCP requests share one in-process writer; `{dataDir}/.write.lock` stops a second process from rewriting the same JSONL files
- **Daily file logs** - JSONL logs under `{dataDir}/logs/YYYY-MM-DD.log`, kept for 3 days
- **Zero extra binaries** - Node.js only; no Docker, SQLite, or Qdrant process. Optional HTTP embedder is configured via env, not required to store vectors.

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
              │ collection mutex → DiskGate │
              └──────────────┬──────────────┘
                             │
                             ▼
              ┌─────────────────────────────┐
              │ JSONL + in-memory maps      │
              │ cosine KNN; process lockdir │
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
| `fake_qdrant_delete_points` | Delete points by id and/or Qdrant payload filter |
| `fake_qdrant_collection_stats` | Point counts, JSONL lines, indexes, posting lists |
| `fake_qdrant_compact_collection` | Rewrite unique JSONL snapshot (latest id wins) |
| `fake_qdrant_persist_indexes` | Flush dirty collections to compact JSONL files |

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
      "vector": [0.1, 0.2, "..."],
      "payload": { "title": "Document 1", "path": "/docs/file.md" }
    },
    {
      "id": "doc-002",
      "text": "optional: embed this instead of passing a vector",
      "payload": { "title": "Document 2" }
    }
  ]
}
```

Each point needs exactly one of `vector` or `text`. Text is batch-embedded when an OpenAI-compatible provider is configured.

#### fake_qdrant_query_points

```json
{
  "collection": "my-vectors",
  "vector": [0.1, 0.2, "..."],
  "limit": 10,
  "scoreThreshold": 0.7
}
```

Pass exactly one of `vector` or `text`. `fake_qdrant_status` includes `embedding: { mode, model, baseUrlHost, dim }` when a provider started successfully.

## HTTP API (Optional)

When enabled, the server exposes a Qdrant-compatible HTTP API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Health check |
| `GET` | `/healthz` | Health check |
| `GET` | `/metrics` | Collection stats and lock busy flag |
| `GET` | `/collections` | List all collections (real point counts) |
| `PUT` | `/collections/{name}` | Create collection (idempotent if size matches; 409 if `FAKE_QDRANT_STRICT_CREATE=1`) |
| `GET` | `/collections/{name}` | Get collection info (Qdrant-shaped + extra local fields) |
| `GET` | `/collections/{name}/exists` | `{ result: { exists } }` |
| `DELETE` | `/collections/{name}` | Delete a collection |
| `PUT` | `/collections/{name}/index` | Record a payload keyword field |
| `PUT` | `/collections/{name}/points` | Upsert points |
| `POST` | `/collections/{name}/points` | Retrieve points by id |
| `POST` | `/collections/{name}/points/query` | Query API (`result.points`; default `limit` 10, `with_payload` false) |
| `POST` | `/collections/{name}/points/search` | Legacy Search API (`result` is a flat scored array) |
| `POST` | `/collections/{name}/points/query/batch` | `{ searches }` → `result: [{ points }]` |
| `POST` | `/collections/{name}/points/search/batch` | `{ searches }` → `result: ScoredPoint[][]` |
| `POST` | `/collections/{name}/points/payload` | Set (merge) payload |
| `PUT` | `/collections/{name}/points/payload` | Overwrite payload |
| `POST` | `/collections/{name}/points/payload/delete` | Delete payload keys |
| `POST` | `/collections/{name}/points/payload/clear` | Clear payload |
| `POST` | `/collections/{name}/points/scroll` | Page through points |
| `POST` | `/collections/{name}/points/count` | Count points (optional filter) |
| `POST` | `/collections/{name}/points/delete` | Delete points by ID or filter |
| `POST` | `/collections/{name}/compact` | Compact collection (custom endpoint) |

Query bodies accept canonical Qdrant shapes (`query: number[]`, `{ nearest }`, nearest-by-id, omitted query = list by id) plus the Roo dialect (`vector`, `query.vector`, `query.nearest.vector`). Inference documents `query: { text, model? }` and `query: { nearest: { text, model? } }` are embedded when a provider is configured. Tuning fields `params`, `indexed_only`, `timeout`, `consistency`, and `wait` are ignored. `prefetch`, `using`, `lookup_from`, `shard_key`, and `fusion`/`recommend`/`discover`/`sample`/`formula` return **400** `Unsupported query: <field>`.

### Supported filters

- Groups: `must`, `should`, `must_not`, `min_should`
- `match.value` / `match.any` / `match.except` (array-element + type-strict)
- `range`, `datetime_range`, `has_id`, `is_empty`, `is_null`

Anything else (`match.text`, geo, `values_count`, `nested`, `has_vector`, `slice`) returns **400** `Unsupported filter: <condition>`.

### Not implemented

- Distance metrics other than Cosine
- Named / sparse vectors
- Prefetch, fusion, recommend, discover, sample, formula
- Scroll offset as a point id (numeric index only)
- Snapshots and collection aliases

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
        "FAKE_QDRANT_DATA_DIR": "./data/fake-qdrant"
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
| `FAKE_QDRANT_DATA_DIR` | `./data/fake-qdrant` | Directory for JSONL collections (`meta.json` + `points.jsonl`) |
| `FAKE_QDRANT_LOG_DIR` | `{dataDir}/logs` | Directory for daily JSONL debug logs |
| `FAKE_QDRANT_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `FAKE_QDRANT_LOG_RETENTION_DAYS` | `3` | Keep this many local calendar days of log files |
| `FAKE_QDRANT_STRICT_CREATE` | `0` | Set to `1` so `PUT /collections/{name}` returns 409 when the collection already exists |
| `FAKE_QDRANT_EMBEDDING_PROVIDER` | inferred | `local` or `external`. Unset + a base URL infers `external`; otherwise `local`. |
| `FAKE_QDRANT_EMBEDDING_BASE_URL` | `OPENAI_EMBED_BASE_URL` | OpenAI-compatible base (no trailing `/embeddings`). Bare host gets `/v1` then `/embeddings`. |
| `FAKE_QDRANT_EMBEDDING_MODEL` | `OPENAI_EMBED_MODEL` | Model name sent in `{ input, model }` |
| `FAKE_QDRANT_EMBEDDING_API_KEY` | `OPENAI_EMBED_API_KEY` | Bearer token; never logged |
| `FAKE_QDRANT_EMBEDDING_DIM` | `OPENAI_EMBED_DIM` | Expected vector width; mismatch throws |
| `FAKE_QDRANT_EMBEDDING_TIMEOUT_MS` | `30000` | HTTP timeout for embedding calls |
| `FAKE_QDRANT_LOCAL_EMBEDDINGS_TARGET` | `http://127.0.0.1:3100` | Local-mode base URL |

Each `FAKE_QDRANT_EMBEDDING_*` falls back to the matching `OPENAI_EMBED_*` so one env block can feed fake-qdrant and docsearch. Direct intranet access is assumed (`node:http` / `node:https`, no PAC). If the host later requires the corporate proxy, an explicit proxy would have to be added.

HTTP `PUT /points` also accepts Qdrant inference vectors `{ "text": "...", "model"? }`. Missing provider → **400**. Embedding HTTP failure → **502** `{ status: { error: "embedding: ..." } }`.

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

### Where to find logs after a RooCode / VS Code error

MCP stdio output is not retained by the IDE. Open the daily file log instead:

```powershell
Get-Content ".\data\fake-qdrant\logs\$(Get-Date -Format yyyy-MM-dd).log" -Tail 80
```

Each line is one JSON object (`event`, `level`, `fields`). HTTP requests from RooCode's Qdrant client show up as `http.request` (vectors are redacted). MCP tool calls show up as `mcp.tool`. Warn and error lines are also mirrored to stderr. Files older than 3 local days are deleted on startup and at midnight rollover.

### HTTP 503 / `store.busy`

**Symptom:** Collection or point requests return 503 `service busy`, or logs show `store.busy`.

A verified takeover should replace the lock holder on the next start (`MCP_TAKEOVER=1`). Inspect and kill a leftover instance without stopping every `node.exe`:

```powershell
node scripts/mcp-ps.mjs doctor
node scripts/mcp-ps.mjs list
node scripts/mcp-ps.mjs kill fake-qdrant
```

Also check `data/fake-qdrant/logs/launcher.log` if the server never starts (red in Roo).

### Port 6333 Already in Use

**Symptom:** Bind fails with `EADDRINUSE`.

The new process probes `/healthz`. If the holder is our sidecar, it is killed and the port is rebound. If not:

```powershell
node scripts/mcp-ps.mjs doctor
node scripts/mcp-ps.mjs kill fake-qdrant
```

`/healthz` now includes `pid`, `instanceId`, and `dataDir`.

### Empty / flagged payloads (Roo indexer)

`fake_qdrant_collection_stats` reports `emptyPayloadPoints` (whitespace-only `codeChunk`) and `flaggedPayloadPoints` (default patterns `Error converting`, `Traceback`). Those come from the Roo codebase indexer / an external docx converter, not from this server. Set `FAKE_QDRANT_DROP_EMPTY_CHUNKS=1` to skip empty chunks at upsert. Collection names like `ws-<hash>` are workspace hashes from Roo; leftover collections from other folders stay on disk until deleted.

Filter-delete dedup (`http.delete_dedup`, `deleted: 0`) is a 60s TTL to ignore duplicate Roo deletes; it is logged at debug.

Large ~1.4 MB PUT batches are the client's batch size; this server accepts up to 25 MiB. Split batches in Roo if requests are slow (`http.slow_request`).

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
   node scripts/mcp-ps.mjs doctor
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
   node scripts/mcp-launch.mjs fake-qdrant
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

3. **JSONL is written on every upsert:**
   Data is appended to `points.jsonl`. Use `fake_qdrant_compact_collection` or `fake_qdrant_persist_indexes` to rewrite a unique snapshot.

### Vector Dimension Mismatch

**Symptom:** Error "Vector must contain N finite numbers for collection X"

**Solutions:**

1. **Verify embedding model output dimension:**
   - Local sidecar `Xenova/all-MiniLM-L6-v2` (`http://127.0.0.1:3100/v1`): **384** — use this for RooCode codebase indexing
   - OpenAI `text-embedding-3-small` / `text-embedding-ada-002`: 1536 (only if a real OpenAI-compatible API is reachable)
   - OpenAI `text-embedding-3-large`: 3072 (avoid here; doubles JSONL/RAM/brute-force CPU)

   Fake Qdrant does not care about the model name. Collection `size` must match the vector length. Do not mix 384 and 1536 in one collection.

2. **Match collection size to your model:**
   ```json
   {
     "name": "my-collection",
     "size": 384,
     "distance": "Cosine"
   }
   ```

3. **Check for truncated vectors:**
   Ensure your embedding pipeline returns complete vectors.

### Database Recovery

**Symptom:** Query returns unexpected results or errors.

**Solutions:**

1. **Compact the collection (rewrite unique JSONL):**
   ```bash
   curl -X POST "http://localhost:6333/collections/my-collection/compact"
   ```

2. **Inspect collection files:**
   ```powershell
   Get-ChildItem ".\data\my-collection"
   # Expect meta.json and points.jsonl
   ```

3. **Full reset (last resort):**
   ```powershell
   # Backup data first!
   Remove-Item -Recurse ".\data\my-collection"
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

## Storage format

JSONL is the native format (one directory per collection):

```
data/fake-qdrant/{collection}/
  meta.json
  points.jsonl
data/fake-qdrant/logs/
  YYYY-MM-DD.log
```

Leftover `{name}.db` SQLite files cannot be converted on locked-down workstations (database binaries are blocked). Re-upsert points instead:

```powershell
npx tsx src/fake-qdrant/migrate.ts
```

## Development

### Building from Source

```powershell
cd src/fake-qdrant
npm install
npm run build
```

### Running Tests

From the repo root, smoke-test this server together with the rest of the Roo set:

```powershell
node scripts/validate_mcps.mjs
```

Package tests:

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
├── store.ts           # JSONL + in-memory cosine store
├── qdrant-http.ts     # HTTP API shim
├── __tests__/
│   └── qdrant-http.test.ts  # Integration tests
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Limitations

- **Distance Metrics:** Only Cosine similarity is currently supported
- **Filters:** Nested must/should/must_not/min_should plus match/range/datetime_range/has_id/is_empty/is_null. Unsupported conditions return 400.
- **Scroll/Pagination:** `POST .../points/scroll` with numeric limit/offset (not point-id offset)
- **Sharding:** Single-node only, no distributed support
- **Not implemented:** named/sparse vectors, prefetch/fusion, recommend/discover, snapshots, aliases
- **Concurrency:** Overlapping requests in one process share files safely (one disk writer). A second process on the same data dir fails instead of corrupting JSONL. This is not multi-tenant isolation or authentication.

## License

MIT License - see the LICENSE file in the project repository.
