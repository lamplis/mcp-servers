# Product Requirements Document: Docsearch MCP Server

## Executive Summary

Docsearch is a local hybrid (keyword + vector) documentation search MCP. It indexes files, URLs, and optional Confluence into a JSON directory (`DOCSEARCH_DATA_DIR`), embeds with in-process Transformers.js (384-d MiniLM), and answers `doc-search` / `doc-ingest` over stdio. No SQLite, Docker, or HTTP sidecar.

## Lifecycle (aligned with fake-qdrant)

- Launch via `node scripts/mcp-launch.mjs docsearch` (never `npx tsx`).
- Process identity: `process.title = mcp-docsearch`, `{DATA_DIR}/instance.json`.
- Exclusive writer: `{DB_PATH}/.write.lock` with verified takeover (`MCP_TAKEOVER`).
- Daily logs: `{DATA_DIR}/logs/YYYY-MM-DD.log` (`DOCSEARCH_LOG_*`), `ts` with local offset. Failures before `main()` go to `launcher.log`.
- Connect MCP transport first, then background initial indexing and chokidar watchers.
- Shutdown on stdin close / SIGINT / SIGTERM / uncaughtException: close watchers, `closeDatabase()`, release lock, remove `instance.json`.
- `doc-ingest-status` reports `indexing` (`running`|`idle`), `lastRun`, `lastError`.
- Whitespace-only `chunkDoc` slices are dropped. Watcher `unlink` removes the document from the index.

## Out of scope

- Office `.docx` conversion (URL crawl skips those extensions).
- Re-embedding the corpus into fake-qdrant.
