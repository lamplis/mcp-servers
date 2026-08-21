#!/usr/bin/env python3
"""Prepare this repo so RooCode / Cursor can launch every MCP with npx + Python only.

Usage:
  python scripts/setup_roo.py
  python scripts/setup_roo.py --check
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_FAKE_QDRANT = REPO_ROOT / "data" / "fake-qdrant"
DATA_DOCSEARCH = REPO_ROOT / "data" / "docsearch"
DATA_DOCSEARCH_DOCS = DATA_DOCSEARCH / "docs"
MODEL_CACHE = REPO_ROOT / "model-cache"
DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2"


def repo_path_for_json() -> str:
    return str(REPO_ROOT)


def filesystem_root() -> str:
    candidate = Path("C:/DEVHOME")
    if candidate.exists():
        return str(candidate)
    return str(REPO_ROOT.parent)


def build_mcp_config(*, include_cwd: bool, filesystem_dir: str) -> dict:
    cwd = repo_path_for_json()
    servers = {
        "central-memory": {
            "$comment": "Knowledge graph memory server (JSONL, no database)",
            "command": "npx",
            "args": ["tsx", "src/memory/index.ts"],
            "disabled": False,
            "alwaysAllow": [],
        },
        "central-filesystem": {
            "$comment": "Filesystem server",
            "command": "npx",
            "args": ["tsx", "src/filesystem/index.ts", filesystem_dir],
            "disabled": False,
            "alwaysAllow": [],
        },
        "central-everything": {
            "$comment": "MCP demo/test server",
            "command": "npx",
            "args": ["tsx", "src/everything/index.ts", "stdio"],
            "disabled": False,
            "alwaysAllow": ["get-env"],
        },
        "central-sequentialthinking": {
            "$comment": "Sequential thinking/reasoning server",
            "command": "npx",
            "args": ["tsx", "src/sequentialthinking/index.ts"],
            "disabled": False,
            "alwaysAllow": [],
        },
        "central-fake-qdrant": {
            "$comment": "Local Qdrant-compatible vector store (JSONL, HTTP :6333)",
            "command": "npx",
            "args": ["tsx", "src/fake-qdrant/index.ts"],
            "env": {
                "FAKE_QDRANT_ENABLED": "1",
                "FAKE_QDRANT_HTTP_PORT": "6333",
                "FAKE_QDRANT_DATA_DIR": str(DATA_FAKE_QDRANT),
            },
            "disabled": False,
            "alwaysAllow": [
                "fake_qdrant_list_collections",
                "fake_qdrant_get_collection",
                "fake_qdrant_create_collection",
                "fake_qdrant_delete_collection",
                "fake_qdrant_upsert_points",
                "fake_qdrant_query_points",
                "fake_qdrant_compact_collection",
                "fake_qdrant_persist_indexes",
            ],
        },
        "central-local-embeddings": {
            "$comment": "Local Transformers.js embeddings (optional HTTP :3100)",
            "command": "npx",
            "args": ["tsx", "src/local-embeddings/index.ts"],
            "env": {
                "MODEL_ID": DEFAULT_MODEL,
                "MODEL_CACHE_DIR": str(MODEL_CACHE),
                "MODEL_ASSETS_DIR": str(MODEL_CACHE),
                "EMBEDDINGS_HTTP_PORT": "3100",
                "EMBEDDINGS_HTTP_HOST": "127.0.0.1",
            },
            "disabled": False,
            "alwaysAllow": ["embeddings", "prefetch_model", "health"],
        },
        "central-docsearch": {
            "$comment": "Document search with in-process local embeddings (JSON index)",
            "command": "npx",
            "args": ["tsx", "src/docsearch/index.ts"],
            "env": {
                "EMBEDDINGS_PROVIDER": "local",
                "DOCSEARCH_DATA_DIR": str(DATA_DOCSEARCH),
                "LOCAL_EMBED_MODEL": DEFAULT_MODEL,
                "LOCAL_MODEL_CACHE_DIR": str(MODEL_CACHE),
            },
            "disabled": False,
            "alwaysAllow": ["doc-search", "doc-ingest", "doc-ingest-status"],
        },
    }
    if include_cwd:
        for server in servers.values():
            server["cwd"] = cwd
    return {"mcpServers": servers}


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {path}")


def ensure_dirs() -> None:
    for directory in (DATA_FAKE_QDRANT, DATA_DOCSEARCH_DOCS, MODEL_CACHE):
        directory.mkdir(parents=True, exist_ok=True)
        print(f"Ensured {directory}")
    urls = DATA_DOCSEARCH / "urls.md"
    if not urls.exists():
        urls.write_text(
            "# Documentation URLs to index (one per line, # comments ignored)\n",
            encoding="utf-8",
        )
        print(f"Wrote {urls}")


def which(name: str) -> str | None:
    return shutil.which(name)


def run_version(cmd: list[str]) -> str:
    try:
        completed = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
        output = (completed.stdout or completed.stderr or "").strip().splitlines()
        return output[0] if output else f"exit {completed.returncode}"
    except (OSError, subprocess.TimeoutExpired) as error:
        return f"failed: {error}"


def leftover_db_files() -> list[Path]:
    hits: list[Path] = []
    for pattern in ("**/*.db", "**/*.db-wal", "**/*.db-shm", "**/vec0.dll"):
        hits.extend(REPO_ROOT.glob(pattern))
    return [
        path
        for path in hits
        if "node_modules" not in path.parts and "coverage" not in path.parts
    ]


def check_environment() -> int:
    ok = True
    node = which("node")
    npx = which("npx")
    python = which("python") or which("python3")
    print(f"node: {node or 'MISSING'}")
    if node:
        print(f"  {run_version(['node', '--version'])}")
    else:
        ok = False
    print(f"npx: {npx or 'MISSING'}")
    if not npx:
        ok = False
    print(f"python: {python or 'MISSING'}")
    if python:
        print(f"  {run_version([python, '--version'])}")
    else:
        ok = False

    for directory in (DATA_FAKE_QDRANT, DATA_DOCSEARCH_DOCS, MODEL_CACHE, REPO_ROOT):
        writable = os.access(directory if directory.exists() else directory.parent, os.W_OK)
        print(f"writable {directory}: {writable}")
        if not writable:
            ok = False

    leftovers = leftover_db_files()
    if leftovers:
        print("Leftover database files (ignored by the JSON runtime; safe to delete):")
        for path in leftovers:
            print(f"  {path}")
    else:
        print("No leftover .db / vec0.dll files found.")

    if not ok:
        print("Check failed.")
        return 1
    print("Check passed. Next: node scripts/validate_mcps.mjs then reload RooCode / Cursor.")
    return 0


def write_configs() -> None:
    filesystem_dir = filesystem_root()
    roo_payload = build_mcp_config(include_cwd=True, filesystem_dir=filesystem_dir)
    cursor_payload = build_mcp_config(include_cwd=False, filesystem_dir=filesystem_dir)
    cursor_payload["mcpServers"]["mcp-docs"] = {
        "$comment": "External HTTP MCP docs (optional; may be blocked by firewall)",
        "type": "http",
        "url": "https://modelcontextprotocol.io/mcp",
    }
    write_json(REPO_ROOT / ".roo" / "mcp.json", roo_payload)
    write_json(REPO_ROOT / ".cursor" / "mcp.json", cursor_payload)


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare local MCP servers for RooCode.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify Node/npx/Python and data dirs without rewriting configs",
    )
    args = parser.parse_args()

    ensure_dirs()
    if args.check:
        return check_environment()

    write_configs()
    print()
    print("Setup complete.")
    print("  1. From the repo root, run: python scripts/setup_roo.py --check")
    print("  2. Run: node scripts/validate_mcps.mjs")
    print("  3. Reload VS Code / RooCode / Cursor so npx tsx MCP servers start.")
    print("  4. No Docker, SQLite, or extra binaries are required.")
    print(f"  Data: {DATA_FAKE_QDRANT}")
    print(f"        {DATA_DOCSEARCH}")
    print(f"        {MODEL_CACHE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
