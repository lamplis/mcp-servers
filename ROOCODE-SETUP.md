# RooCode / Cursor MCP User Guide

This guide covers the local MCP set in this repo: JSON-only storage, `npx` + Python launchers, no Docker, no SQLite, no admin installs.

Validated on this workstation (Node 22 / Node 20-compatible, Windows 11, no admin): all seven configured servers start over stdio, list tools, and answer a smoke `tools/call`. Fake Qdrant also serves `GET http://127.0.0.1:16333/healthz` during validation; production uses `:6333`. Local embeddings also serves `GET http://127.0.0.1:13100/healthz` during validation; production uses `:3100`.

## Prerequisites

- **Node.js 20+** and **npx**
- **Python 3** (only for `scripts/setup_roo.py`)
- **RooCode** and/or **Cursor** in VS Code
- No Docker, WSL, SQLite binaries, or extra system installs

Launchers allowed here: **npx** and **python** only.

`@xenova/transformers` lists native `sharp` (libvips) for image tensors. This repo overrides it with [`vendor/sharp-stub`](vendor/sharp-stub) (pure JS, no `.node`, no postinstall download). Text embeddings and docsearch work. Transformers.js image pipelines do not. Keep `ENABLE_IMAGE_TO_TEXT=false`. Do not vendor the real `sharp` binary.

## Quick Start

From this repo:

```powershell
cd C:\DEVHOME\GITHUB\mcp-servers
npm install
python scripts/setup_roo.py
python scripts/setup_roo.py --check
node scripts/validate_mcps.mjs
```

`.roo/mcp.json` and `.cursor/mcp.json` are **generated** (absolute paths) and not committed. After clone, run `python scripts/setup_roo.py`. That also creates:

- `data/fake-qdrant/`
- `data/docsearch/docs/`
- `model-cache/`

The Cursor playbook under `.cursor/rules/` is local (`.cursor/` is gitignored). Source of truth: `docs/mcp-servers-rules.md`.

Reload VS Code / RooCode / Cursor so the MCP servers start.

### Copy into another project

```powershell
mkdir <YOUR_PROJECT>\.roo
copy mcp-servers\mcp-config-template.json <YOUR_PROJECT>\.roo\mcp.json
```

Replace placeholders:

| Placeholder | Replace With | Example |
|-------------|--------------|---------|
| `<MCP_SERVERS_PATH>` | Full path to this repo | `C:\\DEVHOME\\GITHUB\\mcp-servers` |
| `<ALLOWED_PATH>` | Directory for filesystem access | `C:\\DEVHOME` |
| `<PROJECT_PATH>` | Your project's root path | `C:\\DEVHOME\\GITHUB\\MyProject` |

Copy the AI usage **playbook** (routing + recipes, not a tool catalog):

```powershell
mkdir <YOUR_PROJECT>\.roo\rules
copy mcp-servers\docs\mcp-servers-rules.md <YOUR_PROJECT>\.roo\rules\mcp-servers.md
```

## Validate that MCP servers work

Environment check (Node, npx, Python, writable data dirs, leftover `.db` files):

```powershell
python scripts/setup_roo.py --check
```

Stdio handshake + smoke tool call for every configured server:

```powershell
node scripts/validate_mcps.mjs
```

Or: `npm run validate:mcp`

That script starts each server with `npx tsx`, waits until it logs ready on stderr, then:

1. `initialize`
2. `tools/list`
3. A cheap `tools/call` (`read_graph`, `list_allowed_directories`, `echo`, `fake_qdrant_list_collections`, `health`, `doc-ingest-status`)
4. HTTP `GET /healthz` for fake-qdrant (`:16333` during the check) and local-embeddings (`:13100` during the check)

### Validated servers (default Roo / Cursor set)

| Config name | Entry | Smoke check |
|-------------|-------|-------------|
| `central-memory` | `src/memory/index.ts` | `read_graph` (9 tools) |
| `central-filesystem` | `src/filesystem/index.ts` | `list_allowed_directories` (14 tools) |
| `central-sequentialthinking` | `src/sequentialthinking/index.ts` | `tools/list` (`sequentialthinking`) |
| `central-everything` | `src/everything/index.ts stdio` | `echo` (12 tools) |
| `central-fake-qdrant` | `src/fake-qdrant/index.ts` | list collections + HTTP `/healthz` |
| `central-local-embeddings` | `src/local-embeddings/index.ts` | `health` + HTTP `/healthz` |
| `central-docsearch` | `src/docsearch/index.ts` | `doc-ingest-status` (3 tools) |

Not in the default Roo set (need extra runtimes such as `uv`): `src/fetch`, `src/git`, `src/time`.

## Storage model (no database binaries)

| Server | Persistence |
|--------|-------------|
| memory | JSON / JSONL knowledge graph (`memory.json` in the repo by default) |
| fake-qdrant | `meta.json` + `points.jsonl` per collection under `FAKE_QDRANT_DATA_DIR` |
| docsearch | JSON files under `{DOCSEARCH_DATA_DIR}/index/` |
| local-embeddings | on-disk model cache; embeddings themselves are not persisted |

Leftover SQLite files (`*.db`, `*.db-wal`, `*.db-shm`, `vec0.dll`) cannot be opened on this workstation. They are ignored. Delete them and re-ingest / re-upsert:

```powershell
# After deleting old index.db files:
# In RooCode / Cursor, call doc-ingest with { "source": "all", "force": true }
```

`python scripts/setup_roo.py --check` lists leftover database files.

## HTTP sidecars (optional)

These bind to loopback only. Stdio MCP still works if the port is already in use.

| Service | Env | Production URL |
|---------|-----|----------------|
| Fake Qdrant REST shim | `FAKE_QDRANT_ENABLED=1`, `FAKE_QDRANT_HTTP_PORT=6333` | `http://127.0.0.1:6333/healthz` |
| OpenAI-compatible embeddings | `EMBEDDINGS_HTTP_PORT=3100` | `http://127.0.0.1:3100/healthz` |

Docsearch uses **in-process** local embeddings (`EMBEDDINGS_PROVIDER=local`). It does not need the embeddings HTTP sidecar.

## Available Servers

| Server | Purpose |
|--------|---------|
| `central-memory` | Knowledge graph for persistent storage |
| `central-filesystem` | File operations outside the workspace |
| `central-docsearch` | Documentation search (local embeddings, JSON index) |
| `central-sequentialthinking` | Complex reasoning and problem-solving |
| `central-fake-qdrant` | Local vector store (JSONL, brute-force cosine) |
| `central-local-embeddings` | Local/offline text embeddings (no API key) |
| `central-everything` | Demo/test server |

## Local Embeddings

- No API key. Transformers.js on CPU (`Xenova/all-MiniLM-L6-v2`, 384 dimensions).
- Offline after the first model download into `MODEL_CACHE_DIR` / `MODEL_ASSETS_DIR`.
- Tools: `embeddings`, `prefetch_model`, `health`.

Prefetch once while you still have access to the model files (GitHub / internal cache):

```
Use prefetch_model
Use embeddings with input "Hello world"
```

## RooCode codebase indexing (OpenAI-compatible local embedder)

Point RooCode at the **local-embeddings HTTP sidecar**, not at `api.openai.com`. `central-local-embeddings` must be running with `EMBEDDINGS_HTTP_PORT=3100` (already in `.roo/mcp.json` after `python scripts/setup_roo.py`). Confirm with `GET http://127.0.0.1:3100/healthz`.

Fill RooCode's OpenAI-compatible provider as:

| Field | Value |
|-------|--------|
| Base URL | `http://127.0.0.1:3100/v1` |
| API key | `local` (the sidecar does not validate it; it must be non-empty if RooCode requires a key) |
| Model | `Xenova/all-MiniLM-L6-v2` |
| Dimensions | `384` |

Qdrant (fake-qdrant on `http://127.0.0.1:6333`): create the index collection at **384 / Cosine**. Do not use 1536 or 3072 with this embedder.

If RooCode still lists cloud OpenAI models, do **not** pick them on this workstation:

| Model | Dim | Notes |
|-------|-----|--------|
| text-embedding-3-small | 1536 | Only if a real OpenAI-compatible API is reachable. Worst fit vs local MiniLM. |
| text-embedding-ada-002 | 1536 | Same width as 3-small; older. |
| text-embedding-3-large | 3072 | Avoid. Doubles JSONL/RAM/brute-force CPU in fake-qdrant. |

If the Base URL field must be a host with no `/v1` suffix, use `http://127.0.0.1:3100` (the sidecar also accepts `POST /embeddings`).

## Docsearch

- Hybrid search: keyword token overlap + cosine over local embeddings.
- Watches `urls.md` and `docs/` under `DOCSEARCH_DATA_DIR`.
- Index directory: `{DOCSEARCH_DATA_DIR}/index/` (JSON, not SQLite).

Add files under `data/docsearch/docs/` and URLs in `data/docsearch/urls.md`, then:

```
Use doc-ingest-status
Use doc-search with query "API authentication"
Use doc-ingest with source "all" and force true
```

## Troubleshooting

### Server not starting

1. `node --version` should be 20+.
2. Paths in `mcp.json` use double backslashes on Windows.
3. `cwd` must be this repo (so `npx tsx src/...` resolves).
4. Check the RooCode / Cursor MCP output panel.
5. Re-run `node scripts/validate_mcps.mjs`.

### Browser `/healthz` shows "not found"

Those JSON bodies mean the HTTP sidecars **are** running. A 404 on `/healthz` was usually a browser `HEAD` or a trailing slash (`/healthz/`), which older shims treated as unknown routes.

- Embeddings 404 looks like `{ "error": { "message": "not found", "type": "invalid_request_error" } }`
- Fake Qdrant 404 looks like `{ "status": { "error": "not found" } }`

Reload the window so MCP restarts, then open:

- `http://127.0.0.1:3100/healthz`
- `http://127.0.0.1:6333/healthz`

Expect `"status":"ok"`. `GET /v1` and `GET /v1/models` on `:3100` are also valid. Do not test the RooCode base URL `http://127.0.0.1:3100/v1` as a health page on an old process.

### Port already in use (`EADDRINUSE` on 6333 or 3100)

Stdio still works. Fake Qdrant will try to free its HTTP port. Local embeddings logs a warning and keeps stdio up if `:3100` is taken.

### Docsearch not finding results

1. Call `doc-ingest-status`.
2. Confirm files/URLs exist under `DOCSEARCH_DATA_DIR`.
3. Call `doc-ingest` with `force: true`.
4. Delete leftover `index.db*` first; they are not migrated.

### Memory not persisting

The memory server writes `memory.json` in this repo (or `MEMORY_FILE_PATH` if set). The directory must be writable.

### Native sharp / libvips install fails

Expected. Root `package.json` maps `sharp` to `vendor/sharp-stub`. After `npm install`, `npm ls sharp` should show `vendor/sharp-stub`, not a GitHub/libvips download. Do not copy a real `sharp-*.node` into the repo. Image-to-text stays off (`ENABLE_IMAGE_TO_TEXT=false`).

### Local embeddings model not found

1. Call `prefetch_model` while the model cache can be populated.
2. Confirm `MODEL_CACHE_DIR` is writable.
3. Confirm files exist under `model-cache/`.

## Environment Variables

| Variable | Server | Description |
|----------|--------|-------------|
| `EMBEDDINGS_PROVIDER` | docsearch | `local` (default), `openai`, or `tei` |
| `DOCSEARCH_DATA_DIR` | docsearch | Data directory (`docs/`, `urls.md`, `index/`) |
| `LOCAL_MODEL_CACHE_DIR` | docsearch | Transformers.js model cache |
| `LOCAL_EMBED_MODEL` | docsearch | Default `Xenova/all-MiniLM-L6-v2` |
| `LOCAL_EMBED_DIM` | docsearch | Default `384` |
| `DB_PATH` | docsearch | JSON index directory (default `{DOCSEARCH_DATA_DIR}/index`) |
| `DOCSEARCH_CRAWL_LIFETIME_DAYS` | docsearch | Days before re-crawl (default: 30) |
| `MEMORY_FILE_PATH` | memory | Knowledge graph file (default `memory.json` in cwd) |
| `FAKE_QDRANT_ENABLED` | fake-qdrant | Set `1` to enable the HTTP shim |
| `FAKE_QDRANT_HTTP_HOST` | fake-qdrant | HTTP bind host (default `127.0.0.1`) |
| `FAKE_QDRANT_HTTP_PORT` | fake-qdrant | HTTP API port (default: 6333) |
| `FAKE_QDRANT_DATA_DIR` | fake-qdrant | JSONL collection directory |
| `MODEL_ID` | local-embeddings | Default model (`Xenova/all-MiniLM-L6-v2`) |
| `MODEL_CACHE_DIR` | local-embeddings | Model cache directory |
| `MODEL_ASSETS_DIR` | local-embeddings | Alternate model assets directory |
| `EMBEDDINGS_HTTP_PORT` | local-embeddings | If set, start OpenAI-compatible HTTP on that port |
| `EMBEDDINGS_HTTP_HOST` | local-embeddings | HTTP bind host (default: `127.0.0.1`) |
| `EMBED_CACHE_SIZE` | local-embeddings | LRU cache entries (default: 1000) |
| `EMBED_CONCURRENCY` | local-embeddings | Max parallel jobs (default: 2) |

## File Structure

After setup, this repo looks like:

```
mcp-servers/
├── .roo/mcp.json                 # RooCode MCP config (absolute cwd)
├── .cursor/mcp.json              # Cursor MCP config
├── scripts/setup_roo.py          # Writes configs + --check
├── scripts/validate_mcps.mjs     # Stdio + HTTP smoke test
├── data/fake-qdrant/             # JSONL collections
├── data/docsearch/
│   ├── docs/                     # Local files to index
│   ├── urls.md                   # URLs to crawl
│   └── index/                    # JSON index (auto-created)
├── model-cache/                  # Transformers.js weights
├── vendor/sharp-stub/            # Pure-JS sharp stand-in (no libvips)
└── src/
    ├── memory/
    ├── filesystem/
    ├── everything/
    ├── sequentialthinking/
    ├── fake-qdrant/
    ├── local-embeddings/
    └── docsearch/
```

## Links

- Per-server docs: [src/docsearch/README.md](src/docsearch/README.md), [src/fake-qdrant/README.md](src/fake-qdrant/README.md), [src/local-embeddings/README.md](src/local-embeddings/README.md)
- AI usage playbook: [docs/mcp-servers-rules.md](docs/mcp-servers-rules.md) (copied to `.roo/rules/mcp-servers.md`)
- [RooCode Custom Instructions](https://docs.roocode.com/features/custom-instructions)
- [Model Context Protocol](https://modelcontextprotocol.io/)
