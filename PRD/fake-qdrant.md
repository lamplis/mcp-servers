# Product Requirements Document: Fake Qdrant MCP Server

## Executive Summary

The Fake Qdrant MCP Server provides a repository-local vector database for similarity-search workflows without Docker, WSL, or an external Qdrant deployment. It runs 100% inside the repository's npm/Node execution model, persists data in SQLite, and relies on repository-bundled SQLite vector binaries so the target environment never has to download native artifacts at runtime. The product supports MCP-native collection management, an optional loopback HTTP compatibility layer, and a configurable embedding-provider contract that can switch cleanly between repository-local embeddings and an external OpenAI-compatible endpoint restricted to the `bge-large-en-v1.5-ITG` model.

## Product Overview

### Purpose
The Fake Qdrant server gives local development workflows a simple way to persist vectors, payloads, and collection metadata behind Qdrant-like semantics. Its purpose is not to fully reimplement Qdrant, but to provide enough compatibility for local retrieval experiments, MCP-native automation, repository-specific semantic tooling, and tightly controlled embedding workflows in restricted Windows environments.

### Target Users
- Developers building local retrieval and similarity-search features
- MCP client authors who need a local vector store without external infrastructure
- Teams working in restricted Windows environments without Docker, WSL, or runtime binary downloads
- Developers who want to search embedded code, notes, or future chat-history datasets locally

### Value Proposition
- Local vector storage with no separate database service to install
- npm-only execution inside the repository's standard Node.js workflow
- Repository-bundled SQLite vector binaries for environments that cannot download native artifacts
- MCP-native vector workflows for agents and tools
- Optional loopback HTTP compatibility for clients that already expect a Qdrant-style endpoint
- Clean provider switching between local embeddings and an approved external embedding API

## Goals and Objectives

### Primary Goals
1. Provide a local vector database that runs within the repository using TypeScript, Node.js, and npm-managed startup flows only.
2. Support core vector operations needed for local semantic retrieval: create collections, upsert vectors, delete points, and query by similarity.
3. Persist collection data locally so vectors survive restarts and can be reused across sessions.
4. Bundle all SQLite vector artifacts required by the target platform inside the repository so no runtime download is required.
5. Support a simple configuration switch between repository-local embeddings and an external OpenAI-compatible embedding endpoint using only `bge-large-en-v1.5-ITG`.
6. Integrate cleanly with the repository's local embeddings and central MCP orchestration patterns.
7. Require unit-test coverage for all changed and newly introduced behavior.

### Success Metrics
- Developers can create, inspect, query, compact, and persist collections entirely through MCP tools.
- Local HTTP clients can use a subset of Qdrant collection and point endpoints when the shim is enabled.
- Collection data remains available across process restarts through on-disk SQLite files.
- The server starts on a locked-down Windows workstation with no runtime downloads of binaries, databases, or helper services.
- Changing the embedding provider between local and external modes is a configuration change rather than a code fork.
- Unit tests cover storage initialization, collection operations, provider selection, config validation, and major failure cases.

## Features and Capabilities

### Core Features
1. **Collection Management** - Create, inspect, list, and delete vector collections with explicit dimension metadata.
2. **Point Upsert** - Insert or replace vector points with optional JSON payloads.
3. **Point Delete** - Remove vectors by ID and support the minimal deletion patterns required by local workflows.
4. **Similarity Querying** - Perform cosine-similarity search over stored vectors with configurable top-K and score thresholds.
5. **Persistent Storage** - Store each collection in its own SQLite database file with WAL enabled.
6. **Bundled Native Vector Runtime** - Load SQLite vector support from repository-bundled binaries or extension artifacts only.
7. **Embedding Provider Switching** - Support a consistent provider contract so related indexing flows can switch between local embeddings and an approved external API.
8. **HTTP Compatibility Layer** - Expose a local Qdrant-like HTTP interface when enabled through configuration.
9. **Maintenance Operations** - Compact collections and checkpoint indexes to keep local storage healthy.
10. **Central MCP Integration** - Run directly over stdio or behind the `central-mcp` HTTP router.

### Architecture Summary
- Storage is implemented with SQLite plus a repository-bundled SQLite vector extension compatible with the target platform.
- Each collection is stored as a separate `.db` file in the configured data directory.
- Vector payloads are stored as JSON strings alongside vector rows.
- The product supports cosine distance only in the current implementation.
- The HTTP shim binds to loopback by default and is intended for local development use only.
- Embeddings may be supplied directly as vectors or obtained through a provider abstraction used by helper indexing flows.
- The product must not require Docker, WSL, external database services, or runtime downloads.

## Tools/API Reference

### MCP Tools

#### `fake_qdrant_list_collections`
- **Description**: Returns all locally stored collections.
- **Input**: None
- **Output**: Collection names, vector sizes, and distance metric
- **Use Case**: Inspect current vector-store state before ingesting or querying data

#### `fake_qdrant_get_collection`
- **Description**: Returns metadata for a specific collection.
- **Input**: `name` (string)
- **Output**: Collection definition or `null`
- **Use Case**: Validate that a collection exists and confirm its dimension

#### `fake_qdrant_create_collection`
- **Description**: Creates or overwrites a collection with a defined vector size.
- **Input**:
  - `name` (string)
  - `size` (positive integer)
  - `distance` (optional string, currently cosine only)
- **Output**: Created collection metadata
- **Use Case**: Prepare a collection before loading embeddings

#### `fake_qdrant_delete_collection`
- **Description**: Deletes a collection and its local files.
- **Input**: `name` (string)
- **Output**: Success flag
- **Use Case**: Reset local test data or remove obsolete datasets

#### `fake_qdrant_upsert_points`
- **Description**: Inserts or replaces vector points in a collection.
- **Input**:
  - `collection` (string)
  - `points` (array of `{ id, vector, payload? }`)
- **Output**: Number of upserted points
- **Use Case**: Load embedded chunks, documents, or conversation segments

#### `fake_qdrant_query_points`
- **Description**: Runs cosine-similarity search over a collection.
- **Input**:
  - `collection` (string)
  - `vector` (number array)
  - `limit` (optional integer)
  - `scoreThreshold` (optional number)
- **Output**: Matching point IDs, scores, and payloads
- **Use Case**: Retrieve semantically similar code, notes, or transcript chunks

#### `fake_qdrant_compact_collection`
- **Description**: Runs collection compaction to reclaim space and optimize storage.
- **Input**: `name` (string)
- **Output**: Count of unique points remaining
- **Use Case**: Periodic maintenance for local development datasets

#### `fake_qdrant_persist_indexes`
- **Description**: Checkpoints open SQLite WAL files to disk.
- **Input**: None
- **Output**: Success flag
- **Use Case**: Ensure durability before shutdown or scripted handoff

### HTTP Shim Endpoints

#### `GET /healthz`
- **Description**: Returns a basic service health response
- **Use Case**: Local liveness check

#### `GET /collections`
- **Description**: Lists collections in a Qdrant-like response shape
- **Use Case**: Client compatibility and collection discovery

#### `GET /collections/{name}`
- **Description**: Returns collection metadata
- **Use Case**: Inspect collection configuration

#### `PUT /collections/{name}`
- **Description**: Creates or recreates a collection
- **Use Case**: Provision collections from Qdrant-style clients

#### `DELETE /collections/{name}`
- **Description**: Deletes a collection
- **Use Case**: Cleanup for local test workflows

#### `PUT /collections/{name}/points`
- **Description**: Upserts points
- **Use Case**: Load vectors into the store from local or external embedding providers

#### `POST /collections/{name}/points/query`
- **Description**: Executes vector similarity search
- **Use Case**: Query a collection from clients that expect Qdrant semantics

#### `POST /collections/{name}/points/delete`
- **Description**: Deletes points by IDs or limited filter forms
- **Use Case**: Remove stale points during local re-indexing

#### `POST /collections/{name}/compact`
- **Description**: Non-standard maintenance endpoint for local compaction
- **Use Case**: Keep local datasets lean during iterative development

## Use Cases and User Stories

### Use Case 1: Local Semantic Retrieval For Code And Notes
**As a** developer  
**I want to** store and query embeddings locally  
**So that** I can build retrieval features without a separate vector database service

**Scenario**: A repository-local embedding workflow generates vectors for repository content and stores them in a fake-qdrant collection for semantic lookup.

### Use Case 2: External API Embedding Mode
**As a** developer working behind an approved gateway  
**I want to** use an OpenAI-compatible embedding endpoint with a fixed allowed model  
**So that** I can reuse the same fake-qdrant workflows without changing storage behavior

**Scenario**: A configuration switch moves the upstream embedding source from local embeddings to an OpenAI-compatible base URL while forcing the model to `bge-large-en-v1.5-ITG`.

### Use Case 3: Provider Switching With Minimal Friction
**As a** maintainer of semantic tooling  
**I want to** switch between local and external embedding providers through configuration  
**So that** I can adapt to workstation or environment constraints without rewriting indexing code

**Scenario**: The same ingestion workflow reads provider mode and endpoint configuration, then stores vectors in fake-qdrant without changing collection-management or query code.

### Use Case 4: Qdrant-Compatible Local Development
**As a** developer with an existing Qdrant-oriented client  
**I want to** point that client at a local compatibility endpoint  
**So that** I can test integration logic without running real Qdrant

**Scenario**: A local tool issues collection and point requests against the HTTP shim on loopback and receives Qdrant-like responses.

### Use Case 5: Centralized Local Stack
**As a** team member in a restricted environment  
**I want to** run the vector store inside the repository's local orchestration flow  
**So that** I can avoid unsupported infrastructure and keep setup simple

**Scenario**: `central-mcp` exposes the fake-qdrant MCP server and, when enabled, starts the loopback HTTP shim for local consumers.

## Technical Requirements

### Implementation Details
- **Language**: TypeScript
- **Runtime**: Node.js launched through npm-managed commands only
- **Storage Engine**: SQLite via `better-sqlite3`
- **Vector Extension**: SQLite vector support loaded from repository-bundled artifacts
- **Protocol Surface**: MCP over stdio and optional local HTTP shim
- **Distance Metric**: Cosine only in the current implementation
- **Provider Modes**: `local` and `external`
- **Allowed External Model**: `bge-large-en-v1.5-ITG` only

### Dependencies
- Node.js runtime compatible with the repository toolchain
- Local repository dependencies installed from the approved internal registry
- `@modelcontextprotocol/sdk`
- `better-sqlite3`
- SQLite vector binaries or extension artifacts committed to the repository for supported targets
- Optional companion service from [local-embeddings.md](./local-embeddings.md) for local embedding mode
- An OpenAI-compatible base URL for external embedding mode

### Embedding Provider Contract
- `local` mode uses the repository's local embeddings server or adapter layer.
- `external` mode sends embedding requests to an OpenAI-compatible base URL.
- In `external` mode, requests must be rejected if the configured model is anything other than `bge-large-en-v1.5-ITG`.
- Switching between `local` and `external` modes must be driven by configuration rather than code changes.
- Provider responses must expose enough metadata for collection dimension validation and troubleshooting.
- The fake-qdrant storage layer remains provider-agnostic once vectors have been produced.

### Data Model
- Each collection is represented by a separate SQLite database file.
- Collection metadata stores vector dimension and distance metric.
- Vectors are stored in a `vec0` virtual table.
- Payloads are stored in a separate table as JSON text.
- Point identifiers may be strings or numbers.
- Collection dimension must be validated against the dimension returned by the selected embedding provider when helper indexing flows are used.

### Configuration
- `FAKE_QDRANT_ENABLED` - Enables the HTTP shim when set to `1`
- `FAKE_QDRANT_HTTP_HOST` - Loopback host for the HTTP shim
- `FAKE_QDRANT_HTTP_PORT` - Port for the HTTP shim
- `FAKE_QDRANT_DATA_DIR` - Directory for per-collection SQLite files
- `FAKE_QDRANT_SQLITE_VEC_DIR` - Repository-relative directory containing bundled SQLite vector artifacts
- `FAKE_QDRANT_EMBEDDING_PROVIDER` - `local` or `external`
- `FAKE_QDRANT_EMBEDDING_BASE_URL` - OpenAI-compatible base URL used only in `external` mode
- `FAKE_QDRANT_EMBEDDING_MODEL` - Must resolve to `bge-large-en-v1.5-ITG` in `external` mode
- `FAKE_QDRANT_LOCAL_EMBEDDINGS_TARGET` - Target local embeddings server or adapter identifier used in `local` mode

### Constraints
- Compatibility is intentionally partial and focused on local development use cases.
- The current implementation supports cosine distance only.
- No runtime download of SQLite vector binaries or helper native dependencies is allowed.
- The product must start and run using npm-managed Node.js commands only.
- The product does not require a separate external vector database service.
- The storage layer does not implement arbitrary hosted-model support; external embeddings are limited to `bge-large-en-v1.5-ITG` through an OpenAI-compatible API.
- Transcript or document ingestion pipelines are not built into this server.
- No authentication or multi-tenant isolation is provided.

### Security Considerations
- Default HTTP binding is loopback (`127.0.0.1`) for local-only usage.
- No network authentication or authorization is included.
- Payload data is stored locally on disk and should be treated according to the sensitivity of the source material.
- External embedding mode sends text to the configured approved base URL and should therefore be opt-in and explicit.
- The server is intended for trusted local development environments, not open network exposure.

### Testing Requirements
- Unit tests must validate configuration parsing for both `local` and `external` provider modes.
- Unit tests must validate rejection of any external model other than `bge-large-en-v1.5-ITG`.
- Unit tests must cover loading of repository-bundled SQLite vector artifacts and failure handling when artifacts are missing or incompatible.
- Unit tests must cover collection creation, point upsert, point delete, similarity query, compaction, and persistence behavior.
- Unit tests must cover vector-dimension validation and provider-selection edge cases.
- Unit tests must cover optional HTTP shim request handling for the supported endpoint subset.
- Unit tests must run entirely from repository assets and npm-installed dependencies with no network downloads.

## Configuration and Deployment

### Build Process
```bash
npm run build
```
- Compiles TypeScript sources into the repository `dist/` output.

### Local Launch
```bash
npm exec -- tsx src/fake-qdrant/index.ts
```
- Starts the MCP server over stdio through npm.
- When `FAKE_QDRANT_ENABLED=1`, also starts the local HTTP shim.
- Startup must load the bundled SQLite vector artifacts from the repository before serving requests.

### Central MCP Integration
- The repository config template includes `central-fake-qdrant` as a ready-to-wire server.
- `central-mcp` can expose fake-qdrant through its router and optionally start the HTTP shim.
- The PowerShell startup path is compatible with local Windows development conventions in this repository.
- Provider mode must be configurable through the same repository-local orchestration flow used by other MCP servers.

### Deployment Expectations
- Intended for local workstation and development-tool usage
- No Docker or WSL dependency
- No requirement for an external vector database service
- No runtime binary or model downloads
- Best used alongside repository-local embeddings or the approved external embedding endpoint

## Success Criteria

### Functional Requirements
- ✅ Collections can be created, listed, loaded, and deleted locally.
- ✅ Vector points can be upserted and deleted with payload metadata.
- ✅ Cosine-similarity queries return scored matches with payloads.
- ✅ Collection data persists across restarts through SQLite files.
- ✅ The optional HTTP shim supports local collection and point workflows for compatible clients.
- ✅ The server can switch between local embeddings and the approved external embedding API through configuration alone.

### Quality Requirements
- ✅ Input validation rejects invalid vector sizes, malformed point data, and unsupported provider configuration.
- ✅ Startup fails clearly when bundled SQLite vector artifacts are missing or incompatible.
- ✅ Local storage defaults are simple and Windows-friendly.
- ✅ Tool responses expose both human-readable text and structured content where appropriate.
- ✅ The product can be orchestrated through repository-standard MCP configuration.
- ✅ Unit tests exist for every changed behavior area described in this PRD.

### Performance Requirements
- Collections should open quickly for local development datasets.
- Point upserts should be atomic within a transaction.
- Queries should remain responsive for typical local semantic-search workloads.
- WAL checkpointing and compaction should support long-lived local use without requiring manual database administration.
- Provider switching should not introduce measurable overhead beyond the embedding call itself.

## Out of Scope

### Explicitly Excluded
- Full Qdrant feature parity
- Distributed storage, clustering, or replication
- Authentication, authorization, and multi-user tenancy
- Arbitrary hosted embedding model support beyond `bge-large-en-v1.5-ITG`
- Built-in transcript parsing, chunking, or ingestion orchestration
- Production-grade observability and operational tooling

### Limitations
- Only cosine distance is supported.
- Filter deletion support is limited to basic local use cases.
- The HTTP surface is compatible with a subset of Qdrant semantics, not the entire API.
- The product is intended for local and development workflows rather than production deployments.
- External embedding mode depends on the configured approved base URL being reachable in that environment.

## Future Considerations

Potential future enhancements could include:
- Richer Qdrant API compatibility, including additional filter and retrieval patterns
- First-class ingestion helpers for transcript, chat-export, and document-chunk workflows
- Better observability, diagnostics, and maintenance reporting
- Bulk import/export utilities for moving local vector datasets between workstations
- Additional repository-bundled target binaries if more supported platforms are added
