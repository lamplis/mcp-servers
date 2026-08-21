# Product Requirements Document: Local Embeddings MCP Server

## Executive Summary

The Local Embeddings MCP Server generates text embeddings on CPU with Transformers.js. The default model is `Xenova/all-MiniLM-L6-v2` (384 dimensions). Weights live under `MODEL_CACHE_DIR` / `MODEL_ASSETS_DIR` (`model-cache/`, gitignored). Prefetch once while the cache can be populated, then run offline (`allowRemoteModels=false`). Docsearch embeds **in-process** with the same stack; this server is for custom vectors, health/prefetch, and an optional OpenAI-compatible HTTP sidecar.

## Product Overview

### Purpose
Provide local embeddings on locked-down Windows without Docker, WSL, admin installs, or a public embedding API.

### Target Users
- Developers building local semantic search
- MCP clients that need `embeddings` / `prefetch_model` / `health`
- Workflows that upsert into fake-qdrant with matching 384-d cosine collections

### Value Proposition
- No API key for the default local path
- Offline after the model is in `model-cache/`
- MCP tools plus optional `GET /healthz` and `POST /v1/embeddings`
- LRU cache and concurrency limits for workstation CPUs
- npm-only (`npx tsx src/local-embeddings/index.ts`)

## Goals and Objectives

### Primary Goals
1. Generate embeddings through MCP with Node.js and npm only.
2. Default to MiniLM 384-d; allow other Xenova sentence-transformer ids when cached.
3. Prefetch into a gitignored cache; then refuse remote model fetch.
4. Expose health and optional HTTP sidecar on loopback.
5. Stay compatible with fake-qdrant (caller supplies vectors) and docsearch (in-process local provider).
6. Keep unit tests for embedder, cache, and semaphore behavior.

### Success Metrics
- `embeddings` returns vectors for a string or batch
- `prefetch_model` populates the cache when files can be obtained
- After cache is filled, operation works with remote fetch disabled
- HTTP sidecar starts only when `EMBEDDINGS_HTTP_PORT` is set; EADDRINUSE does not kill stdio
- Tests run without native SQLite

## Features and Capabilities

### Core Features
1. **Embedding generation** - Single text or batch (default max 64)
2. **Prefetch** - `prefetch_model` to download/load into `model-cache/`
3. **Health** - Model id, loaded flag, cache dir, cache stats, runtime
4. **Pooling / normalize** - `mean` or `cls`; normalize default true (cosine)
5. **LRU cache** - Repeated inputs skip recomputation
6. **Concurrency limit** - Semaphore (default 2)
7. **Optional HTTP** - OpenAI-compatible `POST /v1/embeddings` on loopback

### Architecture Summary
- Transformers.js pipeline, CPU only
- Assets from `MODEL_ASSETS_DIR` or `MODEL_CACHE_DIR`
- `env.allowRemoteModels = false` for normal embed after setup
- Docsearch does **not** need this process when `EMBEDDINGS_PROVIDER=local`

## Tools/API Reference

### `embeddings`
- **Input**: `input` (string or string[]), optional `model`, `normalize`, `pooling`
- **Output**: `model`, `data` (indexed vectors), `dimensions`, `normalized`

### `prefetch_model`
- **Input**: optional `model`
- **Output**: `model`, `cacheDir`, `status`
- **Use Case**: One-time cache fill (GitHub / internal files). If it fails offline, stop; do not pretend to embed.

### `health`
- **Input**: None
- **Output**: default model, `modelLoaded`, `cacheDir`, cache stats, concurrency, Node runtime

### HTTP sidecar (when `EMBEDDINGS_HTTP_PORT` is set)
- `GET /healthz` (and `/`)
- `POST /v1/embeddings`
- Bind: `EMBEDDINGS_HTTP_HOST` (default `127.0.0.1`)

## Use Cases and User Stories

### Use Case 1: Custom vectors for fake-qdrant
**As a** developer  
**I want to** embed pasted logs or notes  
**So that** I can upsert into a 384-d cosine collection

**Scenario**: `health` → `embeddings` (normalize true) → `fake_qdrant_upsert_points`.

### Use Case 2: Offline after prefetch
**As a** developer on a locked-down PC  
**I want to** prefetch once  
**So that** later sessions need no model download

**Scenario**: `prefetch_model` while cache is writable; later `embeddings` uses disk only.

### Use Case 3: HTTP for other local tools
**As a** local script  
**I want to** `POST /v1/embeddings`  
**So that** tools that speak OpenAI embeddings work without the public API

**Scenario**: Port 3100 sidecar; docsearch may instead use in-process local embeddings.

## Technical Requirements

### Implementation Details
- **Language**: TypeScript
- **Runtime**: Node.js via `npx tsx`
- **Library**: `@xenova/transformers` 2.x
- **Default model**: `Xenova/all-MiniLM-L6-v2`, 384-d
- **Protocol**: MCP stdio; optional HTTP

### Dependencies
- `@modelcontextprotocol/sdk`
- `@xenova/transformers`
- `zod`
- Internal npm registry; no SQLite

### Configuration
- `MODEL_ID` - default model
- `MODEL_CACHE_DIR` / `MODEL_ASSETS_DIR` - cache (gitignored `model-cache/`)
- `EMBED_CACHE_SIZE` - LRU capacity (default 1000)
- `EMBED_CONCURRENCY` - max parallel jobs (default 2)
- `MAX_CHARS` / `MAX_BATCH` - input limits
- `EMBEDDINGS_HTTP_PORT` / `EMBEDDINGS_HTTP_HOST` - sidecar

### Constraints
- CPU only; no DirectML/NPU requirement
- Model files are **not** required in git
- This server does not persist a vector index
- Chunking/ingest belongs to docsearch or the caller
- HTTP is optional; MCP is the primary contract

### Security Considerations
- Inputs may be sensitive local text
- HTTP binds loopback by default
- Trusted workstation use only

### Testing Requirements
- Dimension lookup for known models
- LRU and semaphore behavior
- Missing-cache errors are explicit
- No native SQLite in the test path

## Configuration and Deployment

### Build
```powershell
npm run build --workspace src/local-embeddings
```

### Local launch
```powershell
npx tsx src/local-embeddings/index.ts
```

### Model preparation
```text
Call prefetch_model once, or copy weights into model-cache/.
Git does not ship ONNX files.
```

### Repository integration
- Roo/Cursor: `central-local-embeddings`
- Docsearch: `EMBEDDINGS_PROVIDER=local` (in-process), same MiniLM cache
- Fake-qdrant: upsert vectors produced here; do not re-embed the docsearch corpus “for completeness”

## Success Criteria

### Functional
- Single and batch embeddings work
- Prefetch then offline embed works when cache is populated
- Health reports model and cache
- Sidecar can fail on EADDRINUSE without killing stdio

### Quality
- Oversize batch/chars rejected
- Missing model returns a clear error
- Concurrency and cache stay bounded
- Unit tests cover embedder helpers

## Out of Scope

- Shipping ONNX in git
- GPU/NPU acceleration
- Persistent vector storage (use fake-qdrant)
- Document ingest (use docsearch)
- Public OpenAI as the default path

## Future Considerations

- Additional cached models and dimension discovery
- Stronger HTTP OpenAI compatibility
- Cache/warmup diagnostics
