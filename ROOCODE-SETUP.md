# RooCode / Cursor MCP User Guide

This guide covers the local MCP set in this repo: JSON-only storage, `node scripts/mcp-launch.mjs`, no Docker, no SQLite, no admin installs.

Validated on this workstation (Node 22 / Node 20-compatible, Windows 11, no admin): all seven configured servers start over stdio, list tools, and answer a smoke `tools/call`. Fake Qdrant also serves `GET http://127.0.0.1:16333/healthz` during validation; production uses `:6333`. Local embeddings also serves `GET http://127.0.0.1:13100/healthz` during validation; production uses `:3100`.

## Prerequisites

- **Node.js 20+**
- **Python 3** (only for `scripts/setup_roo.py`)
- **RooCode** and/or **Cursor** in VS Code
- Optional intranet embedder: `OPENAI_EMBED_*` in `.env` (see `.env.example`)
- No Docker, WSL, SQLite binaries, or extra system installs

Launch every MCP with **`node scripts/mcp-launch.mjs <role>`** (never `npx`). `python scripts/setup_roo.py` only writes configs.

`@xenova/transformers` lists native `sharp` (libvips) for image tensors. This repo overrides it with [`vendor/sharp-stub`](vendor/sharp-stub) (pure JS, no `.node`, no postinstall download). Text embeddings and docsearch work. Transformers.js image pipelines do not. Keep `ENABLE_IMAGE_TO_TEXT=false`. Do not vendor the real `sharp` binary.

## Quick Start

From this repo:

```powershell
cd C:\DEVHOME\GITHUB\mcp-servers
npm install
# Optional: copy .env.example → .env and fill OPENAI_EMBED_* (intranet bge-m3 / 1024)
python scripts/setup_roo.py
python scripts/setup_roo.py --check
node scripts/validate_mcps.mjs
```

`setup_roo.py` infers `--embeddings external` when `OPENAI_EMBED_BASE_URL` (or `FAKE_QDRANT_EMBEDDING_BASE_URL`) is in the process env or a repo-root `.env`. Otherwise it stays `local`. Pass `--embeddings local|external` to override. `--check` prints the profile with the API key masked and does not rewrite `mcp.json`.

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

That script starts each server with `node scripts/mcp-launch.mjs` (never `npx`), waits until it logs ready on stderr, then:

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

Docsearch embeds **in-process**. With `EMBEDDINGS_PROVIDER=local` it uses MiniLM from `model-cache/` (no `:3100` sidecar). With `EMBEDDINGS_PROVIDER=openai` it posts to `OPENAI_EMBED_BASE_URL/embeddings` (same block as fake-qdrant). The `:3100` sidecar is only for custom vectors and the **local** Roo Codebase Indexing profile.

## Available Servers

| Server | Purpose |
|--------|---------|
| `central-memory` | Knowledge graph for persistent storage |
| `central-filesystem` | File operations outside the workspace |
| `central-docsearch` | Documentation search (JSON index; local MiniLM or OpenAI-compatible) |
| `central-sequentialthinking` | Complex reasoning and problem-solving |
| `central-fake-qdrant` | Local vector store (JSONL, HTTP `:6333`, optional `text` embed) |
| `central-local-embeddings` | Local MiniLM embeddings + optional HTTP `:3100` |
| `central-everything` | Demo/test server |

## Local Embeddings (MCP sidecar)

- No API key. Transformers.js on CPU (`Xenova/all-MiniLM-L6-v2`, 384 dimensions).
- Offline after the first model download into `MODEL_CACHE_DIR` / `MODEL_ASSETS_DIR`.
- Tools: `embeddings`, `prefetch_model`, `health`.
- Use this for ad-hoc 384-d vectors, or skip it when fake-qdrant’s **external** provider is configured and you upsert with `text`.

Prefetch once while you still have access to the model files (GitHub / internal cache):

```
Use prefetch_model
Use embeddings with input "Hello world"
```

## RooCode codebase indexing (recommended: intranet embedder)

This is the profile that makes **`codebase_search`** work against fake-qdrant. Roo embeds **client-side** in Codebase Indexing settings (not in `mcp.json`). Fake-qdrant must accept Roo’s real query body (`query: number[]`, `params`, `with_payload.include`, `must_not` metadata) — that is already implemented on the HTTP shim at `:6333`.

| Field | Value |
|-------|--------|
| Base URL | `https://server.com/v1/openai` |
| API key | from your `.env` `OPENAI_EMBED_API_KEY` (never commit it) |
| Model | `bge-m3` |
| Dimensions | `1024` |
| Qdrant URL | `http://127.0.0.1:6333` |

`python scripts/setup_roo.py` writes the same `OPENAI_EMBED_*` block into `central-docsearch` (`EMBEDDINGS_PROVIDER=openai`) and `FAKE_QDRANT_EMBEDDING_*` into `central-fake-qdrant` when `OPENAI_EMBED_BASE_URL` is set (or pass `--embeddings external`). `--check` prints the profile with the key masked.

Roo recreates the Qdrant collection when `config.params.vectors.size` does not match (DELETE + PUT). After switching to 1024, let it re-index. Switching docsearch dimensions wipes the JSON index (`index.dim_mismatch`) — then run `doc-ingest { "source": "all", "force": true }`.

Confirm the API is reachable directly (no PAC; Node does not follow WPAD). On this host the embedder is a direct intranet call:

```powershell
Invoke-WebRequest -NoProxy -Method Post https://server.com/v1/openai/embeddings `
  -Headers @{ Authorization = "Bearer $env:OPENAI_EMBED_API_KEY"; "Content-Type" = "application/json" } `
  -Body '{"model":"bge-m3","input":["ping"]}'
```

Expect a 1024-d vector. Then `python scripts/setup_roo.py`, `node scripts/mcp-ps.mjs doctor`, restart MCP servers in Roo, and set Codebase Indexing to this table.

MCP/HTTP `text` on fake-qdrant is for **our** tools (`fake_qdrant_upsert_points` / `query: { text }`). Roo `codebase_search` never sends text; it sends a 1024-d vector.

## RooCode codebase indexing (fallback: local MiniLM sidecar)

Point RooCode at the **local-embeddings HTTP sidecar**, not at `api.openai.com`. `central-local-embeddings` must be running with `EMBEDDINGS_HTTP_PORT=3100`. Confirm with `GET http://127.0.0.1:3100/healthz`.

| Field | Value |
|-------|--------|
| Base URL | `http://127.0.0.1:3100/v1` |
| API key | `local` (the sidecar does not validate it; it must be non-empty if RooCode requires a key) |
| Model | `Xenova/all-MiniLM-L6-v2` |
| Dimensions | `384` |
| Qdrant URL | `http://127.0.0.1:6333` |

Create the index collection at **384 / Cosine**. Do not mix this collection with 1024-d `bge-m3` vectors.

If RooCode still lists cloud OpenAI models, do **not** pick them unless that API is actually reachable:

| Model | Dim | Notes |
|-------|-----|--------|
| text-embedding-3-small | 1536 | Only if a real OpenAI-compatible API is reachable. |
| text-embedding-ada-002 | 1536 | Same width as 3-small; older. |
| text-embedding-3-large | 3072 | Avoid. Doubles JSONL/RAM/brute-force CPU in fake-qdrant. |

If the Base URL field must be a host with no `/v1` suffix, use `http://127.0.0.1:3100` (the sidecar also accepts `POST /embeddings`).

## Docsearch

- Hybrid search: keyword token overlap + cosine over local or OpenAI-compatible embeddings.
- Watches `urls.md` and `docs/` under `DOCSEARCH_DATA_DIR`.
- Index directory: `{DOCSEARCH_DATA_DIR}/index/` (JSON, not SQLite).
- Changing `OPENAI_EMBED_DIM` / `LOCAL_EMBED_DIM` resets the index (`index.dim_mismatch`) so the next ingest re-embeds.

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
3. `cwd` must be this repo (so `scripts/mcp-launch.mjs` and `src/...` resolve).
4. Check the RooCode / Cursor MCP output panel.
5. Re-run `node scripts/validate_mcps.mjs`.

### Browser `/healthz` shows "not found"

Those JSON bodies mean the HTTP sidecars **are** running. A 404 on `/healthz` was usually a browser `HEAD` or a trailing slash (`/healthz/`), which older shims treated as unknown routes.

- Embeddings 404 looks like `{ "error": { "message": "not found", "type": "invalid_request_error" } }`
- Fake Qdrant 404 looks like `{ "status": { "error": "not found" } }`

Reload the window so MCP restarts, then open:

- `http://127.0.0.1:3100/healthz`
- `http://127.0.0.1:6333/healthz`

Expect `"status":"ok"` on `/`, `/health`, and `/healthz`. `GET /v1` and `GET /v1/models` on `:3100` are also valid.

### Port already in use (`EADDRINUSE` on 6333 or 3100)

A new fake-qdrant start verifies `/healthz` and takes over if the holder is ours (`MCP_TAKEOVER=1`). Never run `Get-Process node | Stop-Process -Force` — that kills every MCP and the IDE extension host.

```powershell
node scripts/mcp-ps.mjs doctor
node scripts/mcp-ps.mjs list
node scripts/mcp-ps.mjs kill fake-qdrant
```

If the server is **red** and never logged `lifecycle.start`, open `data/fake-qdrant/logs/launcher.log` first.

VS Code / Roo tasks (add locally; `.vscode/` is gitignored):

```json
{
  "version": "2.0.0",
  "tasks": [
    { "label": "MCP: list processes", "type": "shell", "command": "node scripts/mcp-ps.mjs list" },
    { "label": "MCP: kill fake-qdrant", "type": "shell", "command": "node scripts/mcp-ps.mjs kill fake-qdrant" },
    { "label": "MCP: kill docsearch", "type": "shell", "command": "node scripts/mcp-ps.mjs kill docsearch" }
  ]
}
```

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

### Roo `codebase_search` fails against fake-qdrant

Roo sends `{ query: number[], params, with_payload: { include: [...] }, filter.must_not type=metadata }`. It does **not** send text.

| Error | Cause | Fix |
|-------|--------|-----|
| `Unsupported query: params` | Stale `src/fake-qdrant/dist` still rejected `params` | `node node_modules/typescript/bin/tsc -p src/fake-qdrant`, then restart MCP (`node scripts/mcp-ps.mjs doctor`) |
| `missing query vector` | Old dist only read `body.vector` / `query.vector` | Same rebuild; current shim accepts raw `query: number[]` |
| Empty / wrong hits after switching embedder | Collection size ≠ Codebase Indexing dim | Let Roo DELETE+PUT the collection (1024 for `bge-m3`, 384 for MiniLM) and re-index |
| HTTP 400 `Embedding provider not configured` on `query: { text }` | Expected: Roo never uses that shape. MCP `text` needs `FAKE_QDRANT_EMBEDDING_BASE_URL` | Set `OPENAI_EMBED_*` and re-run `python scripts/setup_roo.py` |

Confirm `:6333` with `GET http://127.0.0.1:6333/healthz`. Collection size is in `GET /collections/{name}` → `config.params.vectors.size`.

## Environment Variables

| Variable | Server | Description |
|----------|--------|-------------|
| `EMBEDDINGS_PROVIDER` | docsearch | `local` (default), `openai`, or `tei` |
| `OPENAI_EMBED_BASE_URL` | docsearch + fake-qdrant | OpenAI-compatible base (no `/embeddings` suffix). Intranet: `https://server.com/v1/openai` |
| `OPENAI_EMBED_MODEL` | docsearch + fake-qdrant | e.g. `bge-m3` |
| `OPENAI_EMBED_DIM` | docsearch + fake-qdrant | e.g. `1024` |
| `OPENAI_EMBED_API_KEY` | docsearch + fake-qdrant | Bearer token; never commit |
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
| `FAKE_QDRANT_EMBEDDING_PROVIDER` | fake-qdrant | `local` or `external` (inferred from base URL if unset) |
| `FAKE_QDRANT_EMBEDDING_BASE_URL` | fake-qdrant | Falls back to `OPENAI_EMBED_BASE_URL` |
| `FAKE_QDRANT_EMBEDDING_MODEL` | fake-qdrant | Falls back to `OPENAI_EMBED_MODEL` |
| `FAKE_QDRANT_EMBEDDING_DIM` | fake-qdrant | Falls back to `OPENAI_EMBED_DIM` |
| `FAKE_QDRANT_EMBEDDING_API_KEY` | fake-qdrant | Falls back to `OPENAI_EMBED_API_KEY`; never logged |
| `FAKE_QDRANT_EMBEDDING_TIMEOUT_MS` | fake-qdrant | Embedding HTTP timeout (default `30000`) |
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
├── .env.example                  # Shared OPENAI_EMBED_* + fake-qdrant fallbacks
├── .roo/mcp.json                 # RooCode MCP config (absolute cwd, gitignored)
├── .cursor/mcp.json              # Cursor MCP config
├── scripts/setup_roo.py          # Writes configs + --embeddings + --check
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
