# Product Requirements Document: Fake Qdrant MCP Server

## Executive Summary

The Fake Qdrant MCP Server is a repository-local vector store for similarity search without Docker, WSL, SQLite, or an external Qdrant process. It runs through npm-managed Node.js (`npx tsx`), persists each collection as `meta.json` + `points.jsonl`, and searches with brute-force cosine similarity in memory. Callers supply vectors on upsert (typically from local-embeddings or docsearch). An optional loopback HTTP shim exposes a subset of Qdrant-style collection and point APIs.

## Product Overview

### Purpose
Give local development a Qdrant-like collection and query surface that works on locked-down Windows: no native database binaries, no runtime downloads, no admin installs.

### Target Users
- Developers building local retrieval without a separate vector database
- MCP clients that need a local vector store
- Teams on restricted Windows workstations (GitHub-only egress, Node 20, npm)

### Value Proposition
- JSONL persistence; leftover `*.db` files are ignored, not migrated
- npm-only execution (`npx tsx src/fake-qdrant/index.ts`)
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
8. **Optional embedding helper** - `provider.ts` can call a local or OpenAI-compatible HTTP embeddings API. MCP upsert still takes raw vectors; the helper is not the storage engine.

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
- **Input**: `collection`, `points` (`{ id, vector, payload? }[]`)
- **Output**: Number of upserted points
- **Note**: Vectors are caller-supplied.

#### `fake_qdrant_query_points`
- **Input**: `collection`, `vector`, optional `limit`, optional `scoreThreshold`
- **Output**: Matching ids, scores, payloads

#### `fake_qdrant_compact_collection`
- **Input**: `name`
- **Output**: Count of unique points (latest id wins)
- **Use Case**: Rewrite a unique JSONL snapshot after many upserts

#### `fake_qdrant_persist_indexes`
- **Input**: None
- **Output**: Success flag
- **Use Case**: Flush dirty collections to compact JSONL files

### HTTP Shim Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` or `/healthz` | Liveness |
| `GET` | `/collections` | List collections |
| `GET` | `/collections/{name}` | Collection metadata |
| `PUT` | `/collections/{name}` | Create collection |
| `DELETE` | `/collections/{name}` | Delete collection |
| `PUT` | `/collections/{name}/points` | Upsert points |
| `POST` | `/collections/{name}/points/query` | Vector search |
| `POST` | `/collections/{name}/points/delete` | Delete by id or limited filter |
| `POST` | `/collections/{name}/compact` | Rewrite unique JSONL snapshot |

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
**I want to** run the store via `npx tsx`  
**So that** setup stays inside this repo

**Scenario**: Roo/Cursor launches `central-fake-qdrant` from `mcp.json` with `FAKE_QDRANT_DATA_DIR` under `data/fake-qdrant`.

## Technical Requirements

### Implementation Details
- **Language**: TypeScript
- **Runtime**: Node.js via `npx tsx` (no extra binaries)
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
- `FAKE_QDRANT_DATA_DIR` - JSONL collection root (default `./data/fake-qdrant`)
- Optional helper only (not used by MCP upsert): `FAKE_QDRANT_EMBEDDING_PROVIDER`, `FAKE_QDRANT_EMBEDDING_BASE_URL`, `FAKE_QDRANT_EMBEDDING_MODEL`, `FAKE_QDRANT_LOCAL_EMBEDDINGS_TARGET`

Startup reads these through `loadConfig()` and passes `dataDir` / HTTP bind into the store and shim.

### Constraints
- Partial Qdrant compatibility; local development only
- Cosine only
- No native DB binaries
- No built-in ingest/chunking
- No auth or multi-tenant isolation
- Leftover `*.db` files cannot be converted; re-upsert instead

### Security Considerations
- Default HTTP bind is loopback
- No network authentication
- Payloads are stored on local disk
- Intended for trusted workstation use

### Testing Requirements
- Config parsing (`loadConfig`) for HTTP, data dir, and optional embedding-provider helper
- Collection create, upsert, query, compact, persist
- HTTP shim for the supported route subset
- Tests run from npm-installed dependencies with no native SQLite

## Configuration and Deployment

### Build
```powershell
npm run build --workspace src/fake-qdrant
```

### Local launch
```powershell
npx tsx src/fake-qdrant/index.ts
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
- Production observability

## Future Considerations

- Richer query filters
- Import/export of collection directories
- Optional first-class embed-then-upsert tool (still not required for storage)
