# MCP operating playbook

**Setup:** Copy this file to `<project>/.roo/rules/mcp-servers.md` (RooCode) or `.cursor/rules/mcp-servers.mdc` (Cursor, `alwaysApply: true`). These are operating rules, not a tool catalog.

These servers are the **default tools** for knowledge, memory, cross-project files, local vectors, and hard reasoning. Follow the routing table and recipes.

This workstation is locked down: no Docker, no WSL, no SQLite binaries, no public npm/PyPI/web docs. GitHub is the only external exit. **Local MCP knowledge beats guessing and beats unreachable websites.**

---

## 1. Route first, then act

Pick **one primary MCP** before using shell, guessing APIs, or asking the user for facts they already stored.

| User intent | First call | Next |
|-------------|------------|------|
| How does X work, API, config, tutorial, “what does the doc say” | `doc-search` | Read `docchunk://{id}` for the best hits. If empty → ingest recipe. |
| “What did we decide”, prior incident, workstation constraint, where a path lives | `search_nodes` | `open_nodes` or `add_observations`. Do **not** `read_graph` every turn. |
| Path **outside** the current workspace, typically under `C:\DEVHOME` | `list_allowed_directories` | Then `search_files` / `read_text_file` / `directory_tree`. |
| Path **inside** the current workspace | IDE file tools | Use filesystem MCP only when the IDE cannot reach the path. |
| Architecture tradeoff, nasty bug, 3+ plausible designs, conflicting constraints | `sequentialthinking` (several calls) | Then execute with other MCPs. Thinking is not the deliverable. |
| Similarity over **your** notes, error logs, snippets, ad-hoc corpus (not already in docsearch) | `health` → `embeddings` | `fake_qdrant_*` recipe below. |
| MCP process env / cwd / missing var | `get-env` on `central-everything` | Do not use other everything tools for real work. |

**Parallelize independent calls** (status + search, search_nodes + doc-search).

---

## 2. Session rituals

**Start of a non-trivial task** (multi-file, debug, design, “continue yesterday”):

1. `search_nodes` with the project or topic (`MCP_Servers`, `Workstation`, ticket id, service name).
2. If the task is documentary, **also** `doc-search` in the same turn. Do not wait until you are stuck.
3. Reuse stored paths, decisions, and constraints instead of re-discovering them.

**When you learn a durable fact** (decision, constraint, allowed path, “user prefers X”, outage lesson):

- `search_nodes` first. If the entity exists → `add_observations`. Else `create_entities` then `create_relations`.
- One atomic fact per observation. Active-voice relations (`uses`, `constrained_by`, `located_at`, `decided_for`, `depends_on`).
- Never store secrets, tokens, or passwords.

**Do not** dump `read_graph` unless the graph is small and the user asked for a full map.

---

## 3. Recipes (copy this behavior)

### A. Documentation (docsearch)

Call shape:

```
doc-search { "query": "tsx mcp.json cwd Windows", "topK": 8, "mode": "auto" }
```

- Prefer **concrete tokens** from the user’s wording (file names, env vars, error strings).
- Versions: write `TypeScript 5 9`, not `5.9` (dots hurt keyword overlap).
- Newest / changelog / “current”: `"latest": true`.
- Exact identifier or error string: `"mode": "keyword"`. Conceptual question: `"mode": "vector"` or `auto`.
- Filter with `source` (`file` | `url` | `confluence`) and `pathPrefix` when you know the tree.
- After hits: open `docchunk://{id}` for the top 1–3. Cite path/URI in the answer.
- Empty or weak hits: broaden query → `mode: "keyword"` on a distinctive token → `doc-ingest-status`. If the index is empty, tell the user to drop files in `data/docsearch/docs/` or URLs in `data/docsearch/urls.md`, then `doc-ingest` `{ "source": "all", "force": true }`. **Do not invent APIs.**
- Leftover `index.db*` is dead. JSON index is `{DOCSEARCH_DATA_DIR}/index/`.

Docsearch already embeds in-process. **Do not** re-embed the same docs through local-embeddings unless you are building a *separate* custom collection.

### B. Memory graph

Stable names, stable types:

| entityType | Examples |
|------------|----------|
| `Project` | `MCP_Servers` |
| `Constraint` | `Workstation_No_Admin` |
| `Decision` | `JSONL_Not_SQLite` |
| `Path` | `Docsearch_Data_Dir` |
| `Service` | `Fake_Qdrant`, `Local_Embeddings` |
| `Person` | user-facing names only if useful |
| `Incident` | a named outage or bug |

```
search_nodes { "query": "JSONL SQLite" }
create_entities { "entities": [{ "name": "JSONL_Not_SQLite", "entityType": "Decision", "observations": ["Fake Qdrant and docsearch persist JSON/JSONL; leftover .db files are ignored"] }] }
create_relations { "relations": [{ "from": "MCP_Servers", "to": "JSONL_Not_SQLite", "relationType": "decided_for" }] }
```

### C. Cross-project files (filesystem)

Allowed root is usually `C:\DEVHOME` (confirm with `list_allowed_directories`).

- Discover: `search_files` or `directory_tree`, not `cmd /c dir`.
- Read: `read_text_file` (`head`/`tail` for large files). `read_file` is deprecated. Batch with `read_multiple_files`.
- Write/edit outside the workspace: `write_file` / `edit_file` / `create_directory` / `move_file`.
- **Inside this repo**, prefer IDE file tools so diffs stay in the editor.
- Never use filesystem MCP to exfiltrate secrets or to touch paths outside the allowed list.

### D. Hard reasoning (sequentialthinking)

Use when the cost of a wrong path is high. Skip for renames, single-file nits, and “add a log line”.

Call **multiple times** (typically 4–8). Required fields every call: `thought`, `thoughtNumber`, `totalThoughts`, `nextThoughtNeeded`.

- Start `totalThoughts` at 5; raise it if the problem expands.
- If evidence contradicts an earlier step: `isRevision: true`, `revisesThought: N`.
- Branch only when comparing real alternatives (`branchFromThought`, `branchId`).
- Set `nextThoughtNeeded: false` only when you have a single actionable answer.
- Immediately execute that answer with docsearch, filesystem, or code tools.

### E. Custom vectors (embeddings + fake-qdrant)

Use for **ad-hoc** corpora (pasted logs, a folder of notes that is not ingested into docsearch, clustering similar errors). Default model: `Xenova/all-MiniLM-L6-v2`, **384** dims, `normalize: true` (cosine).

```
health {}
fake_qdrant_list_collections {}
fake_qdrant_create_collection { "name": "error_logs", "size": 384, "distance": "Cosine" }
embeddings { "input": ["chunk 1", "chunk 2"], "normalize": true }
fake_qdrant_upsert_points { "collection": "error_logs", "points": [{ "id": "1", "vector": [...], "payload": { "text": "chunk 1", "source": "build.log" } }] }
fake_qdrant_query_points { "collection": "error_logs", "vector": [...], "limit": 8 }
fake_qdrant_persist_indexes {}
```

- Chunk to keep each input under ~20k characters. Batch up to 64 texts.
- If `health` says the model is missing: `prefetch_model`. If that fails (offline / no cache), stop and say so; do not pretend to embed.
- Collection `size` **must** match the embedding dimension. Do not mix models in one collection.
- After large upserts: `fake_qdrant_persist_indexes`. If scores look duplicated/stale: `fake_qdrant_compact_collection`.
- Do **not** curl `:3100` or `:6333` while these MCP tools work. HTTP is a sidecar for other apps, not the assistant’s first path.
- Do **not** `fake_qdrant_delete_collection` unless the user asked.

### F. Demo server (everything)

Allowed for diagnosis: `get-env`.

Do **not** use `echo`, image, gzip, long-running, elicitation, or sampling tools in ordinary development tasks.

---

## 4. NEVER

- Invent library APIs when `doc-search` was skipped or returned hits you ignored.
- Web-search public docs that cannot be reached here; use docsearch + memory + GitHub.
- Propose Docker, WSL, SQLite, Bun, pip, or admin installs as the fix.
- Store secrets in the knowledge graph or in fake-qdrant payloads.
- Re-embed the whole docsearch corpus into fake-qdrant “for completeness”.
- Call `sequentialthinking` once with `nextThoughtNeeded: false` as theatre.
- Use `read_graph` as a greeting, or `create_entities` with empty observations.
- Use shell (`Get-Content`, `type`, `dir`) for files the filesystem MCP can already see **outside** the workspace.

---

## 5. Failure handling

| Symptom | Action |
|---------|--------|
| MCP tool missing / timeout | Say which server failed. Suggest reload + `python scripts/setup_roo.py --check` and `node scripts/validate_mcps.mjs`. Continue with IDE tools only for the **current workspace**. |
| doc-search empty | Ingest recipe. Do not hallucinate. |
| embeddings model missing | `prefetch_model`; if offline, fail clearly. |
| filesystem path denied | `list_allowed_directories`; ask to widen the root in `mcp.json`. |
| fake-qdrant dimension error | Recreate collection at 384 or embed with the matching model. |
| leftover `*.db` | Ignore. JSON/JSONL only. Delete and re-ingest/re-upsert if the user wants a clean store. |
