# Product Requirements Document: Local Embeddings MCP Server

## Executive Summary

The Local Embeddings MCP Server provides repository-local text embeddings using npm-managed Node.js execution and repository-bundled model assets so semantic workflows can run without downloading any external resources. It exposes a focused MCP tool set for generating embeddings, validating packaged assets, and reporting runtime health. The product serves as the local embedding mode for semantic systems in this repository, including `docsearch`, `fake-qdrant`, and future workflows over internal notes, documents, or chat-history datasets.

## Product Overview

### Purpose
The Local Embeddings server supplies embedding generation as a reusable local capability that fits restricted Windows development environments. It is designed to let repository tools generate vectors from text with no runtime model download, no external API dependency, and no bootstrap step outside the repository.

### Target Users
- Developers building local semantic search and retrieval features
- Teams operating in locked-down Windows environments without external model downloads
- MCP clients that need a local embeddings tool surface
- Developers who want to index repository content, notes, or future chat-history exports locally

### Value Proposition
- No external embedding API is required for the local mode
- No runtime download or prefetch step is required because model assets ship inside the repository
- Simple MCP interface for generating vectors from one text or many texts
- npm-only execution inside the repository's standard Node.js workflow
- Reusable building block for `docsearch`, `fake-qdrant`, and future indexing pipelines
- Local caching and batching controls to reduce repeated work

## Goals and Objectives

### Primary Goals
1. Provide a local embeddings service that runs directly from the repository through npm-managed Node.js commands only.
2. Support fully local embedding generation with all required model assets bundled inside the repository.
3. Offer a stable MCP tool surface for embedding generation, packaged-asset validation, and health inspection.
4. Make local semantic workflows viable on Windows workstations without Docker, WSL, or runtime downloads.
5. Integrate cleanly with repository consumers such as `docsearch` and [fake-qdrant.md](./fake-qdrant.md).
6. Require unit-test coverage for all changed and newly introduced behavior.

### Success Metrics
- Developers can generate embeddings for single texts or batches through MCP.
- A fresh clone with repository assets present can start the service without downloading model files.
- Local consumers can inspect model, asset, and runtime state through diagnostic tools.
- Repository tools can reuse the same local embedding layer instead of duplicating embedding logic.
- Unit tests cover packaged-asset validation, startup behavior, embedding generation, and downstream compatibility assumptions.

## Features and Capabilities

### Core Features
1. **Embedding Generation** - Produce vectors for single or batched text inputs through MCP.
2. **Packaged Asset Validation** - Verify that the repository contains every required model and runtime artifact before serving requests.
3. **Offline-Only Runtime** - Run with remote fetching disabled at all times.
4. **Pooling And Normalization Controls** - Support `mean` or `cls` pooling and optional vector normalization.
5. **In-Memory Embedding Cache** - Reuse recently computed embeddings to avoid duplicate work.
6. **Concurrency Control** - Limit concurrent embedding jobs to keep local execution predictable.
7. **Runtime Health Inspection** - Report model, asset, cache, and runtime state for diagnostics.
8. **Provider Interchangeability Support** - Expose model ID and output-dimension metadata so downstream systems such as fake-qdrant can switch between local and external embedding providers safely.

### Architecture Summary
- Embeddings are generated with a Node.js inference runtime such as Transformers.js configured to load assets from repository-local paths only.
- Model weights, tokenizer files, config files, and any runtime helper assets required by the chosen local model are bundled in the repository.
- Computed embeddings are cached in an in-memory LRU cache keyed by text and embedding options.
- Remote fetch is disabled for all normal and diagnostic paths.
- The service exposes model metadata and output dimensions so downstream components can validate collection sizing.

## Tools/API Reference

### Tools

#### `embeddings`
- **Description**: Generates embeddings for a text input or batch of text inputs.
- **Input**:
  - `input` (string or string array)
  - `model` (optional string, must resolve to a repository-bundled local model)
  - `normalize` (optional boolean)
  - `pooling` (optional enum: `mean` or `cls`)
- **Output**:
  - `model`
  - `data` as indexed embedding vectors
  - `dimensions`
  - `normalized`
- **Use Case**: Generate vectors for code chunks, document chunks, or future transcript chunks before indexing them elsewhere

#### `verify_assets`
- **Description**: Validates that the configured local model and its required runtime assets exist in the repository and are loadable.
- **Input**:
  - `model` (optional string)
  - `warmup` (optional boolean)
- **Output**:
  - `model`
  - `assetsDir`
  - `status`
  - `dimensions` when available
- **Use Case**: Confirm that a workstation can run local embeddings with packaged assets only

#### `health`
- **Description**: Reports current runtime, model, and asset information.
- **Input**: None
- **Output**:
  - default model ID
  - whether the model is already loaded
  - assets directory and validation state
  - output dimensions when known
  - concurrency limit
  - Node.js runtime metadata
- **Use Case**: Confirm that the local embedding service is ready for indexing or search workflows

## Use Cases and User Stories

### Use Case 1: Local Semantic Search For Repository Content
**As a** developer  
**I want to** generate embeddings locally  
**So that** I can build semantic search features without external services

**Scenario**: A local indexing workflow sends text chunks to the `embeddings` tool and stores the resulting vectors in a downstream index.

### Use Case 2: Zero-Download Startup
**As a** developer in a restricted environment  
**I want to** run the service from the repository without downloading model files  
**So that** I can work in environments where runtime internet access is not available or approved

**Scenario**: The developer runs the server through npm, `verify_assets` confirms the bundled model files are present, and embeddings work immediately with no prefetch step.

### Use Case 3: Local Embedding Mode For Fake Qdrant
**As a** developer using a local vector store  
**I want to** generate vectors that can be inserted into fake-qdrant  
**So that** I can assemble a fully local semantic retrieval stack

**Scenario**: An integration script embeds local text chunks, creates a matching collection in fake-qdrant, and upserts the vectors with payload metadata.

### Use Case 4: Provider Switching Support
**As a** maintainer of semantic tooling  
**I want to** expose stable metadata about the local model and output dimensions  
**So that** downstream systems can switch cleanly between local embeddings and an approved external embedding API

**Scenario**: Fake-qdrant reads local embedding metadata from this server in local mode and uses the same collection-validation logic it uses for the external provider path.

### Use Case 5: Future Chat-History Indexing
**As a** developer with many prior technical conversations  
**I want to** embed transcript and chat-history chunks locally  
**So that** I can search earlier decisions and implementation context without sending them to external APIs

**Scenario**: Current project-local agent transcripts, and future exported chat histories, are chunked by an upstream pipeline and passed to the `embeddings` tool before storage in a local vector index.

## Technical Requirements

### Implementation Details
- **Language**: TypeScript
- **Runtime**: Node.js launched through npm-managed commands only
- **Embedding Runtime**: npm-installed inference library configured for local-file loading only
- **Protocol Surface**: MCP over stdio
- **Model Source**: Repository-bundled assets only
- **Remote Fetch Policy**: Disabled in all runtime paths

### Dependencies
- Node.js runtime compatible with the repository toolchain
- Local repository dependencies installed from the approved internal registry
- `@modelcontextprotocol/sdk`
- An npm-compatible local inference runtime such as `@xenova/transformers`
- Repository-bundled model assets and any required helper runtime assets
- Companion consumers such as `docsearch` and [fake-qdrant.md](./fake-qdrant.md)

### Model Packaging Requirements
- All files required to run the supported local embedding model must be present in the repository.
- Required files include model weights, tokenizer assets, configuration files, and any runtime helper assets used by the inference library.
- The service must resolve model assets from a repository-local directory rather than a download cache.
- The packaging approach must work on the target Windows environment without admin rights, Docker, or WSL.
- Asset validation must fail clearly when required files are missing, incomplete, or incompatible.

### Runtime Behavior
- Normal embedding requests use `input`, not provider-specific request shapes.
- The server accepts a single string or an array of strings.
- Requests larger than the configured batch or character limits are rejected.
- Embedding requests run under a semaphore-based concurrency limit.
- Results may be returned from the in-memory LRU cache when the same text and options are requested again.
- Runtime logic must never attempt to download model artifacts or call remote model registries.
- Health and verification responses must expose enough metadata for downstream dimension checks.

### Configuration
- `MODEL_ID` - Default repository-bundled local model identifier
- `MODEL_ASSETS_DIR` - Repository-local directory containing the bundled model assets
- `EMBED_CACHE_SIZE` - In-memory LRU cache capacity
- `EMBED_CONCURRENCY` - Maximum concurrent embedding jobs
- `MAX_CHARS` - Maximum input size per text item
- `MAX_BATCH` - Maximum number of texts per embedding call

### Constraints
- No runtime download or prefetch flow is allowed.
- The service must start and run using npm-managed Node.js commands only.
- The service does not provide its own persistent vector store.
- Transcript parsing, chunking, and ingestion orchestration are not part of this server.
- The primary supported interface is MCP; any HTTP compatibility wrappers are secondary and should not be treated as the core product contract.
- This service defines the repository's local embedding mode, while external API embedding remains a separate provider path owned by downstream consumers such as fake-qdrant.

### Security Considerations
- Text submitted for embedding may contain sensitive local content and remains subject to the workstation's local data-handling rules.
- Model artifacts are stored inside the repository and should be treated as required runtime assets.
- The server is designed for trusted local development use, not exposed multi-user hosting.
- Avoiding runtime downloads reduces unapproved data egress and startup variability.

### Testing Requirements
- Unit tests must validate bundled-model discovery and asset-path resolution.
- Unit tests must validate startup behavior with packaged assets present and clear failures when assets are missing or malformed.
- Unit tests must cover embedding generation for single inputs and batches using repository-bundled assets only.
- Unit tests must cover input validation, pooling and normalization options, cache behavior, and concurrency guards.
- Unit tests must cover `verify_assets` and `health` responses, including model metadata and output dimensions.
- Unit tests must validate compatibility assumptions used by downstream consumers such as fake-qdrant.
- Unit tests must run entirely from repository assets and npm-installed dependencies with no network downloads.

## Configuration and Deployment

### Build Process
```bash
npm run build
```
- Compiles TypeScript sources into the repository `dist/` output.

### Local Launch
```bash
npm exec -- tsx src/local-embeddings/index.ts
```
- Starts the MCP server over stdio through npm.
- Startup must resolve the configured model from repository-local assets only.

### Model Preparation
```text
No prefetch step is required or supported. The repository must already contain the full local model package.
```
- `verify_assets` can be used to validate the packaged model and optionally warm it into memory.

### Repository Integration
- The repository config template includes `central-local-embeddings` as a ready-to-wire MCP server.
- `docsearch` can use this service as its local embedding provider.
- `fake-qdrant` can use this service as its `local` embedding mode while switching to an approved external API through its own provider configuration.
- Any auxiliary HTTP wrapper remains secondary to the MCP contract and must not introduce runtime downloads.

### Deployment Expectations
- Intended for local workstation usage
- No Docker or WSL dependency
- No runtime model downloads
- Compatible with restricted Windows development setups when the repository includes the required model assets
- Best used as a component within broader local semantic pipelines

## Success Criteria

### Functional Requirements
- ✅ The server generates embeddings for single text inputs and batches.
- ✅ The server starts from repository assets without downloading external resources.
- ✅ `verify_assets` confirms that required model files are present and loadable.
- ✅ Health information reports model, asset, and runtime status.
- ✅ Pooling and normalization options are available to callers.
- ✅ The server can act as the vector source for local semantic consumers in this repository.

### Quality Requirements
- ✅ Invalid oversized inputs are rejected with clear errors.
- ✅ Startup fails clearly when required packaged assets are missing or invalid.
- ✅ The server defaults are appropriate for local workstation usage.
- ✅ Repeated requests can benefit from caching.
- ✅ Concurrency is bounded to avoid uncontrolled local resource usage.
- ✅ Unit tests exist for every changed behavior area described in this PRD.

### Performance Requirements
- Cached embedding requests should avoid recomputing identical inputs.
- Batched requests should be supported within configured limits.
- Repository-bundled models should load predictably from local disk.
- The service should remain responsive for typical local semantic-search workloads.

## Out of Scope

### Explicitly Excluded
- Runtime model downloads or prefetch commands
- External hosted embedding APIs as the primary product path
- Persistent vector storage
- Document or transcript chunking pipelines
- Full OpenAI API emulation as a core contract
- Production-grade multi-tenant service hosting
- GPU-specific tuning or platform-specific acceleration guarantees

### Limitations
- Effective output dimension depends on the selected bundled local model.
- Large-scale indexing throughput is bounded by local CPU, memory, and configured concurrency.
- The product is intended as a local repository service rather than a standalone hosted platform.
- Repository size will increase because required model assets are checked in or otherwise shipped inside the repository.

## Future Considerations

Potential future enhancements could include:
- Better first-class integration helpers for fake-qdrant and transcript-ingestion workflows
- More explicit support for additional repository-bundled local models and dimension discovery
- A hardened OpenAI-compatible HTTP surface aligned with the MCP output contract
- More operational diagnostics around cache usage, warmup status, and embedding latency
- Dedicated helpers for chunking and embedding conversation histories from multiple export formats
