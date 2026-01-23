# Local Embeddings MCP Server

A Model Context Protocol (MCP) server that provides fully local, offline-capable text embeddings using [Transformers.js](https://huggingface.co/docs/transformers.js). This server enables AI assistants to generate semantic embeddings without requiring external API calls or network connectivity after initial model download.

## Features

- **Fully Offline Operation**: Run embeddings locally without network access after one-time model prefetch
- **Multiple Model Support**: Use any compatible Hugging Face sentence-transformer model
- **Batch Processing**: Embed multiple texts in a single request (up to 64 by default)
- **In-Memory Caching**: LRU cache reduces redundant computation for repeated inputs
- **Concurrency Control**: Configurable parallel execution limits to manage resource usage
- **Configurable Pooling**: Support for mean pooling and CLS token extraction
- **L2 Normalization**: Optional vector normalization for cosine similarity search

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     MCP Client (Cursor, etc.)               │
└─────────────────────────┬───────────────────────────────────┘
                          │ stdio
┌─────────────────────────▼───────────────────────────────────┐
│                   Local Embeddings Server                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  MCP Tools  │  │  LRU Cache  │  │  Concurrency Limiter│  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                    │              │
│  ┌──────▼────────────────▼────────────────────▼──────────┐  │
│  │                    Embedder Module                    │  │
│  │         (Transformers.js + Model Management)          │  │
│  └───────────────────────┬───────────────────────────────┘  │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                  Local Model Cache (Disk)                   │
│              (MODEL_CACHE_DIR / ./model-cache)              │
└─────────────────────────────────────────────────────────────┘
```

## Installation

### Prerequisites

- Node.js 20 or later
- npm

### Install Dependencies

From the monorepo root:

```powershell
npm install
```

Or install only this package:

```powershell
npm install --workspace src/local-embeddings
```

### Build

```powershell
npm run build --workspace src/local-embeddings
```

## Quick Start

### 1. Configure Your MCP Client

Add to your MCP configuration (e.g., `.roo/mcp.json` for RooCode, or Cursor settings):

```json
{
  "mcpServers": {
    "local-embeddings": {
      "command": "npx",
      "args": ["tsx", "src/local-embeddings/index.ts"],
      "cwd": "C:\\DEVHOME\\GITHUB\\mcp-servers",
      "env": {
        "MODEL_CACHE_DIR": "C:\\path\\to\\model-cache",
        "MODEL_ID": "Xenova/all-MiniLM-L6-v2"
      },
      "disabled": false,
      "alwaysAllow": []
    }
  }
}
```

### 2. Prefetch the Model (One-Time Setup)

Before using offline, call the `prefetch_model` tool to download model files:

```json
{ "model": "Xenova/all-MiniLM-L6-v2" }
```

### 3. Generate Embeddings

```json
{
  "input": ["Hello world", "How are you?"],
  "normalize": true,
  "pooling": "mean"
}
```

## API Reference

### Tool: `embeddings`

Generate embedding vectors for one or more text inputs.

#### Input Schema

| Parameter   | Type                   | Required | Default                    | Description                              |
|-------------|------------------------|----------|----------------------------|------------------------------------------|
| `input`     | `string \| string[]`   | Yes      | -                          | Text(s) to embed                         |
| `model`     | `string`               | No       | `MODEL_ID` env var         | Hugging Face model identifier            |
| `normalize` | `boolean`              | No       | `true`                     | Apply L2 normalization to output vectors |
| `pooling`   | `"mean" \| "cls"`      | No       | `"mean"`                   | Pooling strategy for token embeddings    |

#### Output Schema

```typescript
{
  model: string;           // Model used for embedding
  data: Array<{
    index: number;         // Position in input array
    embedding: number[];   // Embedding vector
  }>;
  dimensions: number;      // Vector dimensionality (e.g., 384)
  normalized: boolean;     // Whether vectors are L2-normalized
}
```

#### Example

**Request:**
```json
{
  "input": ["The quick brown fox", "jumps over the lazy dog"],
  "normalize": true,
  "pooling": "mean"
}
```

**Response:**
```json
{
  "model": "Xenova/all-MiniLM-L6-v2",
  "data": [
    { "index": 0, "embedding": [0.0234, -0.0891, 0.0412, ...] },
    { "index": 1, "embedding": [-0.0123, 0.0567, -0.0234, ...] }
  ],
  "dimensions": 384,
  "normalized": true
}
```

### Tool: `prefetch_model`

Download and cache model files for offline use. Must be called with network access before running offline.

#### Input Schema

| Parameter | Type     | Required | Default            | Description                   |
|-----------|----------|----------|--------------------|-------------------------------|
| `model`   | `string` | No       | `MODEL_ID` env var | Hugging Face model identifier |

#### Output Schema

```typescript
{
  model: string;    // Model identifier
  cacheDir: string; // Absolute path to cache directory
  status: "ok";     // Operation status
}
```

### Tool: `health`

Report server status, model state, and runtime information.

#### Output Schema

```typescript
{
  model: string;          // Default model identifier
  modelLoaded: boolean;   // Whether default model is loaded in memory
  cacheDir: string;       // Absolute path to model cache
  cacheEntries: number;   // Current LRU cache entries
  cacheCapacity: number;  // Maximum LRU cache capacity
  concurrency: number;    // Max parallel embedding operations
  runtime: {
    node: string;         // Node.js version
    platform: string;     // Operating system
    arch: string;         // CPU architecture
  };
}
```

## Configuration

### Environment Variables

| Variable            | Default                    | Description                                      |
|---------------------|----------------------------|--------------------------------------------------|
| `MODEL_ID`          | `Xenova/all-MiniLM-L6-v2`  | Default embedding model                          |
| `MODEL_CACHE_DIR`   | `./model-cache`            | Directory for cached model files                 |
| `EMBED_CACHE_SIZE`  | `1000`                     | Maximum entries in the LRU embedding cache       |
| `EMBED_CONCURRENCY` | `2`                        | Maximum concurrent embedding operations          |
| `MAX_CHARS`         | `20000`                    | Maximum characters per input text                |
| `MAX_BATCH`         | `64`                       | Maximum texts per batch request                  |

### Recommended Models

| Model                              | Dimensions | Use Case                        |
|------------------------------------|------------|---------------------------------|
| `Xenova/all-MiniLM-L6-v2`          | 384        | General purpose, fast           |
| `Xenova/all-MiniLM-L12-v2`         | 384        | Higher quality, slower          |
| `Xenova/paraphrase-MiniLM-L6-v2`   | 384        | Paraphrase detection            |
| `Xenova/multi-qa-MiniLM-L6-cos-v1` | 384        | Question-answering              |
| `Xenova/all-mpnet-base-v2`         | 768        | Highest quality, largest        |

## Offline Workflow

This server is designed for environments with restricted or no network access:

```
┌─────────────────────────────────────────────────────────────┐
│  PHASE 1: Setup (requires network)                          │
│                                                             │
│  1. Start server with network access                        │
│  2. Call prefetch_model tool                                │
│  3. Model files downloaded to MODEL_CACHE_DIR               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  PHASE 2: Operation (fully offline)                         │
│                                                             │
│  1. Server loads model from local cache                     │
│  2. No network requests made                                │
│  3. All embedding operations run locally                    │
└─────────────────────────────────────────────────────────────┘
```

**Important:** If the model is not cached and `allowRemoteModels` is disabled (default for `embeddings` tool), the server returns an error instructing you to run `prefetch_model`.

## Performance Considerations

### Memory Usage

- Model weights are loaded once per process and kept in memory
- LRU cache stores embedding vectors (not input text) to minimize memory
- Cache keys use SHA-256 hashes of inputs

### Throughput

- First request incurs model loading time (~2-10 seconds depending on model size)
- Subsequent requests are fast (~10-100ms per text depending on length)
- Batch requests are more efficient than individual requests
- Cached embeddings return instantly

### Concurrency

- `EMBED_CONCURRENCY` limits parallel model invocations
- Prevents memory exhaustion on large batch requests
- Default of 2 balances throughput and memory usage

## Troubleshooting

### "Cannot find package '@xenova/transformers'"

Run `npm install` from the monorepo root or `npm install --workspace src/local-embeddings`.

### "Model files not found in cache"

The model hasn't been downloaded yet. Call `prefetch_model` with network access.

### Out of Memory Errors

- Reduce `EMBED_CONCURRENCY` to 1
- Reduce `EMBED_CACHE_SIZE`
- Use a smaller model (e.g., `all-MiniLM-L6-v2` instead of `all-mpnet-base-v2`)

### Slow First Request

This is expected. The model must be loaded into memory on first use. Subsequent requests will be fast.

## Development

### Project Structure

```
src/local-embeddings/
├── index.ts        # Entry point (stdio transport)
├── server.ts       # MCP server and tool registration
├── embedder.ts     # Model loading and embedding logic
├── lru.ts          # LRU cache implementation
├── semaphore.ts    # Concurrency limiter
├── package.json
├── tsconfig.json
└── README.md
```

### Running in Development

```powershell
npx tsx src/local-embeddings/index.ts
```

### Building

```powershell
npm run build --workspace src/local-embeddings
```

### Running Tests

```powershell
npm test --workspace src/local-embeddings
```

## License

MIT

## Related

- [Model Context Protocol](https://modelcontextprotocol.io)
- [Transformers.js](https://huggingface.co/docs/transformers.js)
- [Hugging Face Sentence Transformers](https://huggingface.co/sentence-transformers)
