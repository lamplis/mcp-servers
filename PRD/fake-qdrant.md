# Product Requirements Document: Fake Qdrant MCP Server

## Executive Summary

The Fake Qdrant MCP Server is a repository-local vector store for similarity search without Docker, WSL, SQLite, or an external Qdrant process. It runs through npm-managed Node.js (`node scripts/mcp-launch.mjs fake-qdrant`), persists each collection as `meta.json` + `points.jsonl`, and searches with brute-force cosine similarity in memory. Callers supply vectors on upsert, or `text` when an OpenAI-compatible embedding provider is configured. An optional loopback HTTP shim exposes a subset of Qdrant-style collection and point APIs.

## Product Overview

### Purpose
Give local development a Qdrant-like collection and query surface that works on locked-down Windows: no native database binaries, no runtime downloads, no admin installs.

### Target Users
- Developers building local retrieval without a separate vector database
- MCP clients that need a local vector store
- Teams on restricted Windows workstations (GitHub-only egress, Node 20, npm)

### Value Proposition
- JSONL persistence; leftover `*.db` files are ignored, not migrated
- npm-only execution (`node scripts/mcp-launch.mjs fake-qdrant`)
- MCP tools for collections, upsert, query, compact, and persist
- Optional HTTP shim on `127.0.0.1` (default port 6333)
- Storage is provider-agnostic: vectors arrive already computed

## Goals and Objectives

### Primary Goals
1. Run a local vector store with TypeScript and npm only.
2. Support create/list/get/delete collections, upsert/query/delete points.
3. Persist collections across restarts as JSONL, not SQLite.
4. Expose an optional Qdrant-compatible HTTP subset on loopback.
5. Stay usable when SQLite / sqlite-vec / Docker are unavailable.
6. Keep unit-test coverage for storage, HTTP, and config parsing.

### Success Metrics
- Collections can be created, queried, compacted, and persisted through MCP tools.
- HTTP clients can use `/healthz` and the supported collection/point routes when the shim is enabled.
- Data survives process restart via `{dataDir}/{collection}/meta.json` and `points.jsonl`.
- Startup does not load native DB extensions.
- Tests cover store, HTTP, and `loadConfig` without network.

## Features and Capabilities

### Core Features
1. **Collection Management** - Create, inspect, list, and delete collections with vector size and cosine distance.
2. **Point Upsert** - Insert or replace points `{ id, vector, payload? }`. Latest id wins.
3. **Point Delete** - Remove points by id or limited filters (HTTP).
4. **Similarity Query** - Brute-force cosine KNN with optional `limit` and `scoreThreshold`.
5. **JSONL Persistence** - One directory per collection; append on upsert; compact rewrites a unique snapshot.
6. **HTTP Shim** - Loopback Qdrant-like REST when `FAKE_QDRANT_ENABLED=1`.
7. **Maintenance** - `fake_qdrant_compact_collection` and `fake_qdrant_persist_indexes`.
8. **Optional embedding helper** - `provider.ts` calls a local or OpenAI-compatible HTTP embeddings API (`Authorization: Bearer` when a key is set). MCP `fake_qdrant_upsert_points` / `fake_qdrant_query_points` and HTTP `query: { text }` / `vector: { text }` use it. Missing provider is non-fatal at startup; text requests then return 400. `fake_qdrant_status` reports `{ mode, model, baseUrlHost, dim }`.
9. **Daily file logs** - JSONL logs under `{dataDir}/logs/YYYY-MM-DD.log`, kept for 3 local days, so RooCode/VS Code HTTP and MCP failures can be reproduced from disk.
10. **Single-writer robustness** - One in-process disk gate for all durable writes; per-collection mutation mutex; `{dataDir}/.write.lock` so a second process cannot rewrite the same JSONL. A new start with `MCP_TAKEOVER=1` verifies the holder (`instance.json` + `tasklist` + `/healthz` pid) and kills it; `MCP_TAKEOVER=0` exits immediately. HTTP `/healthz` returns `pid`/`instanceId`. Stdin close, transport close, SIGINT/SIGTERM, and uncaughtException all run one shutdown path that releases the lock and port. Launch via `node scripts/mcp-launch.mjs fake-qdrant`, never `npx tsx`.
11. **RooCode HTTP dialect** - Nested payload filters, payload index stubs, honest point counts, query `{ points }`, scroll/retrieve/count, keyword postings, JSONL tombstones, truncated `codeChunk` logs.

### Architecture Summary
- In-memory `Map` per collection; cosine computed in JavaScript.
- On disk: `{FAKE_QDRANT_DATA_DIR}/{name}/meta.json` and `points.jsonl`.
- Cosine only.
- HTTP binds to loopback by default.
- Leftover `{name}.db` SQLite files are logged and ignored.
- No Docker, WSL, SQLite, or sqlite-vec.

## Tools/API Reference

### MCP Tools

#### `fake_qdrant_list_collections`
- **Input**: None
- **Output**: Collection names, vector sizes, distance

#### `fake_qdrant_get_collection`
- **Input**: `name` (string)
- **Output**: Collection definition or `null`

#### `fake_qdrant_create_collection`
- **Input**: `name`, `size` (positive integer), `distance` (optional; cosine only)
- **Output**: Created collection metadata

#### `fake_qdrant_delete_collection`
- **Input**: `name`
- **Output**: Success flag

#### `fake_qdrant_upsert_points`
- **Input**: `collection`, `points` (`{ id, vector?, text?, payload? }[]`)
- **Output**: Number of upserted points
- **Note**: Each point needs exactly one of `vector` or `text`. Text is batch-embedded when a provider is configured.

#### `fake_qdrant_query_points`
- **Input**: `collection`, exactly one of `vector` or `text`, optional `limit`, optional `scoreThreshold`
- **Output**: Matching ids, scores, payloads

#### `fake_qdrant_compact_collection`
- **Input**: `name`
- **Output**: Count of unique points (latest id wins)
- **Use Case**: Rewrite a unique JSONL snapshot after many upserts

#### `fake_qdrant_persist_indexes`
- **Input**: None
- **Output**: Success flag
- **Use Case**: Flush dirty collections to compact JSONL files

#### `fake_qdrant_delete_points`
- **Input**: `collection`, optional `ids`, optional Qdrant `filter`
- **Output**: Deleted count

#### `fake_qdrant_collection_stats`
- **Input**: optional `name`
- **Output**: Points, JSONL lines, indexes, posting-list sizes

### HTTP Shim Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` or `/healthz` | Liveness |
| `GET` | `/metrics` | Stats + lock busy |
| `GET` | `/collections` | List collections with point counts |
| `PUT` | `/collections/{name}` | Create or no-op if same size (409 on mismatch; 409 if `FAKE_QDRANT_STRICT_CREATE=1`) |
| `GET` | `/collections/{name}` | Collection metadata (Qdrant-shaped + extras) |
| `GET` | `/collections/{name}/exists` | `{ exists }` |
| `DELETE` | `/collections/{name}` | Delete collection |
| `PUT` | `/collections/{name}/index` | Payload keyword field name |
| `PUT` | `/collections/{name}/points` | Upsert points |
| `POST` | `/collections/{name}/points` | Retrieve by ids |
| `POST` | `/collections/{name}/points/query` | Query API (`result.points`; default limit 10) |
| `POST` | `/collections/{name}/points/search` | Legacy search (`result` is a scored array) |
| `POST` | `/collections/{name}/points/query/batch` | Batch query |
| `POST` | `/collections/{name}/points/search/batch` | Batch search |
| `POST` | `/collections/{name}/points/payload` | Set payload (merge) |
| `PUT` | `/collections/{name}/points/payload` | Overwrite payload |
| `POST` | `/collections/{name}/points/payload/delete` | Delete payload keys |
| `POST` | `/collections/{name}/points/payload/clear` | Clear payload |
| `POST` | `/collections/{name}/points/scroll` | Page points |
| `POST` | `/collections/{name}/points/count` | Count points |
| `POST` | `/collections/{name}/points/delete` | Delete by id or nested filter |
| `POST` | `/collections/{name}/compact` | Rewrite unique JSONL snapshot |

**Query shapes:** `query` as a number array, `{ nearest }`, nearest-by-id, omitted (list by id, `score: 0`), or inference `{ text, model? }` / `{ nearest: { text } }` (embedded when a provider is configured). Roo dialect `vector` / `query.vector` / `query.nearest.vector` still works. `params`, `indexed_only`, `timeout`, `consistency`, and `wait` are ignored. Default HTTP `limit` is 10; MCP `fake_qdrant_query_points` still defaults to 20. `score_threshold` has no implicit 0. `with_payload` defaults to false (boolean, include list, or `{include|exclude}`). Hits are `{ id, version, score, payload?, vector? }`. Upsert accepts numeric `vector` or `{ text, model? }`. Missing provider → 400; embedding HTTP failure → 502.

**Filters:** `must` / `should` / `must_not` / `min_should`, `match.value|any|except` (array-element, type-strict), `range`, `datetime_range`, `has_id`, `is_empty`, `is_null`. Unsupported conditions return 400.

**Not implemented:** metrics other than Cosine, named/sparse vectors, prefetch/fusion, recommend/discover, scroll-by-id offset, snapshots, aliases.

## Use Cases and User Stories

### Use Case 1: Local semantic retrieval
**As a** developer  
**I want to** store and query embeddings locally  
**So that** I do not need a separate vector database

**Scenario**: Local-embeddings (or docsearch) produces 384-d vectors; the assistant upserts them into a cosine collection and queries later.

### Use Case 2: Qdrant-compatible local HTTP
**As a** developer with a Qdrant-oriented client  
**I want to** point it at loopback  
**So that** I can test without real Qdrant

**Scenario**: `FAKE_QDRANT_ENABLED=1` starts the shim; the client uses `/collections` and `/points/query`.

### Use Case 3: Locked-down Windows
**As a** team member without admin/Docker/SQLite  
**I want to** run the store via `node scripts/mcp-launch.mjs fake-qdrant`  
**So that** setup stays inside this repo

**Scenario**: Roo/Cursor launches `central-fake-qdrant` from `mcp.json` with `FAKE_QDRANT_DATA_DIR` under `data/fake-qdrant`.

## Technical Requirements

### Implementation Details
- **Language**: TypeScript
- **Runtime**: Node.js via `scripts/mcp-launch.mjs` (local `tsx` or `dist/`, never `npx`)
- **Storage**: JSONL + in-memory maps
- **Search**: Brute-force cosine
- **Protocol**: MCP stdio; optional HTTP shim
- **Distance**: Cosine only

### Dependencies
- Node.js from the workstation toolchain
- npm packages from the internal registry
- `@modelcontextprotocol/sdk`
- `zod`
- No `better-sqlite3`, sqlite-vec, or native vec DLLs

### Data Model
- One directory per collection
- `meta.json`: `{ size, distance }`
- `points.jsonl`: one JSON object per upsert; compact keeps unique ids
- Point ids: string or number
- Payloads: arbitrary JSON

### Configuration
- `FAKE_QDRANT_ENABLED` - `1` enables the HTTP shim
- `FAKE_QDRANT_HTTP_HOST` - bind host (default `127.0.0.1`)
- `FAKE_QDRANT_HTTP_PORT` - bind port (default `6333`)
- `FAKE_QDRANT_DATA_DIR` - JSONL collection root (default package-relative `data/fake-qdrant`)
- `MCP_TAKEOVER` - `1` (default) verified kill of our lock/port holder; `0` fail-fast
- `FAKE_QDRANT_DROP_EMPTY_CHUNKS` - `1` skips whitespace-only `codeChunk` points at upsert
- `FAKE_QDRANT_SLOW_MS` - warn `http.slow_request` above this duration (default `1000`)
- `FAKE_QDRANT_LOG_DIR` - daily JSONL debug logs (default `{resolvedDataDir}/logs`)
- `FAKE_QDRANT_LOG_LEVEL` - `debug` | `info` | `warn` | `error` (default `info`)
- `FAKE_QDRANT_LOG_RETENTION_DAYS` - keep this many local calendar days of log files (default `3`)
- `FAKE_QDRANT_STRICT_CREATE` - `1` makes `PUT /collections/{name}` return 409 when the name already exists (default stays idempotent for Roo)
- `FAKE_QDRANT_EMBEDDING_PROVIDER` - `local` or `external`. Unset with a base URL infers `external`; otherwise `local`.
- `FAKE_QDRANT_EMBEDDING_BASE_URL` / `_MODEL` / `_API_KEY` / `_DIM` / `_TIMEOUT_MS` - OpenAI-compatible client. Each falls back to `OPENAI_EMBED_*` so one env block can serve fake-qdrant and docsearch. Direct intranet access (`node:http`/`node:https`); no PAC. If a host later requires the corporate proxy, an explicit proxy would have to be added.
- `FAKE_QDRANT_LOCAL_EMBEDDINGS_TARGET` - local-mode base URL (default `http://127.0.0.1:3100`)
- HTTP query ignores Qdrant tuning knobs `params`, `indexed_only`, `timeout`, `consistency`, `wait`. `prefetch` / `using` / `lookup_from` / `shard_key` / fusion-family objects still 400.

Startup reads these through `loadConfig()` and passes `dataDir` / HTTP bind into the store and shim.

### Constraints
- Partial Qdrant compatibility; local development only
- Cosine only
- Named/sparse vectors, prefetch/fusion, recommend/discover, snapshots, and aliases are not implemented
- No native DB binaries
- No built-in ingest/chunking
- No auth or multi-tenant isolation
- Leftover `*.db` files cannot be converted; re-upsert instead
- Concurrent clients on one process share files safely. A second process on the same data dir is taken over when `MCP_TAKEOVER=1` and it is verified as ours; otherwise it exits. This is not multi-tenant isolation or authentication.

### Security Considerations
- Default HTTP bind is loopback
- No network authentication
- Payloads are stored on local disk
- Intended for trusted workstation use

### Testing Requirements
- Config parsing (`loadConfig`) for HTTP, data dir, log dir/level/retention, and optional embedding-provider helper
- Collection create, upsert, query, compact, persist
- HTTP shim for the supported route subset
- Daily file logger: local-date filename, midnight rollover, 3-day prune, vector redaction, no stdout
- Concurrent upserts/deletes keep valid JSONL and latest-id-wins; auto-compact threshold; process lock busy and stale-pid steal; HTTP 503 when the write lock is held
- Tests run from npm-installed dependencies with no native SQLite

## Configuration and Deployment

### Build
```powershell
npm run build --workspace src/fake-qdrant
```

### Local launch
```powershell
node scripts/mcp-launch.mjs fake-qdrant
```
- MCP on stdio
- HTTP shim when `FAKE_QDRANT_ENABLED=1`

### Roo / Cursor
- Template name: `central-fake-qdrant`
- Generate configs with `python scripts/setup_roo.py`

### Deployment expectations
- Local workstation only
- No Docker, WSL, or SQLite
- Pair with local-embeddings MCP for vector generation when needed

## Success Criteria

### Functional
- Collections can be created, listed, loaded, and deleted
- Points can be upserted and queried by cosine similarity
- Data persists as JSONL across restarts
- HTTP shim supports the documented subset
- Leftover SQLite files are ignored

### Quality
- Invalid sizes and malformed points are rejected
- Defaults are Windows-friendly
- Tools return text plus structured content where applicable
- Unit tests cover store, HTTP, and config

### Performance
- Suitable for local (not production-scale) collections
- Compact after large upsert batches
- Persist before shutdown when dirty

## Out of Scope

- Full Qdrant parity, clustering, replication
- Auth / multi-user tenancy
- Built-in embedding or document ingest
- Production APM, metrics, or remote log shipping
- Named/sparse vectors, prefetch/fusion, recommend/discover, snapshots, aliases

## Future Considerations

- Import/export of collection directories
- Optional first-class embed-then-upsert tool (still not required for storage)
