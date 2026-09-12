#!/usr/bin/env python3
"""Prepare this repo so RooCode / Cursor can launch every MCP with node + local tsx/dist.

Usage:
  python scripts/setup_roo.py
  python scripts/setup_roo.py --check
  python scripts/setup_roo.py --embeddings external
  python scripts/setup_roo.py --embeddings local
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
DEFAULT_EXTERNAL_MODEL = "bge-m3"
DEFAULT_EXTERNAL_DIM = "1024"
EMBED_ENV_KEYS = (
    "OPENAI_EMBED_BASE_URL",
    "OPENAI_EMBED_MODEL",
    "OPENAI_EMBED_DIM",
    "OPENAI_EMBED_API_KEY",
    "FAKE_QDRANT_EMBEDDING_BASE_URL",
    "FAKE_QDRANT_EMBEDDING_MODEL",
    "FAKE_QDRANT_EMBEDDING_DIM",
    "FAKE_QDRANT_EMBEDDING_API_KEY",
    "FAKE_QDRANT_EMBEDDING_PROVIDER",
)


def parse_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[7:].strip()
        if "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def merged_embed_env() -> dict[str, str]:
    file_env = parse_dotenv(REPO_ROOT / ".env")
    merged: dict[str, str] = {}
    for key in EMBED_ENV_KEYS:
        if os.environ.get(key):
            merged[key] = os.environ[key]
        elif file_env.get(key):
            merged[key] = file_env[key]
    return merged


def mask_secret(value: str | None) -> str:
    if not value:
        return "(unset)"
    if len(value) <= 6:
        return "****"
    return f"{value[:2]}...{value[-2:]}"


def resolve_embeddings_mode(cli: str | None) -> tuple[str, dict[str, str]]:
    env = merged_embed_env()
    base = env.get("OPENAI_EMBED_BASE_URL") or env.get("FAKE_QDRANT_EMBEDDING_BASE_URL")
    if cli:
        mode = cli
    elif base:
        mode = "external"
    else:
        mode = "local"
    return mode, env


def print_embeddings_profile(mode: str, env: dict[str, str]) -> None:
    base = env.get("OPENAI_EMBED_BASE_URL") or env.get("FAKE_QDRANT_EMBEDDING_BASE_URL") or "(unset)"
    model = (
        env.get("OPENAI_EMBED_MODEL")
        or env.get("FAKE_QDRANT_EMBEDDING_MODEL")
        or DEFAULT_EXTERNAL_MODEL
    )
    dim = env.get("OPENAI_EMBED_DIM") or env.get("FAKE_QDRANT_EMBEDDING_DIM") or DEFAULT_EXTERNAL_DIM
    key = env.get("OPENAI_EMBED_API_KEY") or env.get("FAKE_QDRANT_EMBEDDING_API_KEY")
    print(f"embeddings profile: {mode}")
    print(f"  OPENAI_EMBED_BASE_URL={base}")
    print(f"  OPENAI_EMBED_MODEL={model}")
    print(f"  OPENAI_EMBED_DIM={dim}")
    print(f"  OPENAI_EMBED_API_KEY={mask_secret(key)}")


def apply_embedding_env(servers: dict, mode: str, env: dict[str, str]) -> None:
    if mode != "external":
        return
    base = env.get("OPENAI_EMBED_BASE_URL") or env.get("FAKE_QDRANT_EMBEDDING_BASE_URL") or ""
    model = (
        env.get("OPENAI_EMBED_MODEL")
        or env.get("FAKE_QDRANT_EMBEDDING_MODEL")
        or DEFAULT_EXTERNAL_MODEL
    )
    dim = env.get("OPENAI_EMBED_DIM") or env.get("FAKE_QDRANT_EMBEDDING_DIM") or DEFAULT_EXTERNAL_DIM
    key = env.get("OPENAI_EMBED_API_KEY") or env.get("FAKE_QDRANT_EMBEDDING_API_KEY") or ""
    doc = servers["central-docsearch"]["env"]
    doc["EMBEDDINGS_PROVIDER"] = "openai"
    doc["OPENAI_EMBED_BASE_URL"] = base
    doc["OPENAI_EMBED_MODEL"] = model
    doc["OPENAI_EMBED_DIM"] = str(dim)
    doc["OPENAI_EMBED_API_KEY"] = key
    fq = servers["central-fake-qdrant"]["env"]
    fq["FAKE_QDRANT_EMBEDDING_PROVIDER"] = "external"
    fq["FAKE_QDRANT_EMBEDDING_BASE_URL"] = base
    fq["FAKE_QDRANT_EMBEDDING_MODEL"] = model
    fq["FAKE_QDRANT_EMBEDDING_DIM"] = str(dim)
    fq["FAKE_QDRANT_EMBEDDING_API_KEY"] = key


def repo_path_for_json() -> str:
    return str(REPO_ROOT)


def filesystem_root() -> str:
    candidate = Path("C:/DEVHOME")
    if candidate.exists():
        return str(candidate)
    return str(REPO_ROOT.parent)


def launch_args(role: str, extra: list[str] | None = None) -> list[str]:
    args = ["scripts/mcp-launch.mjs", role]
    if extra:
        args.extend(extra)
    return args


def build_mcp_config(
    *,
    include_cwd: bool,
    filesystem_dir: str,
    embeddings_mode: str = "local",
    embed_env: dict[str, str] | None = None,
) -> dict:
    cwd = repo_path_for_json()
    servers = {
        "central-memory": {
            "$comment": "Knowledge graph memory server (JSONL, no database)",
            "command": "node",
            "args": launch_args("memory"),
            "disabled": False,
            "alwaysAllow": [],
            "env": {
                "MCP_TAKEOVER": "1",
            },
        },
        "central-filesystem": {
            "$comment": "Filesystem server",
            "command": "node",
            "args": launch_args("filesystem", [filesystem_dir]),
            "disabled": False,
            "alwaysAllow": [],
        },
        "central-everything": {
            "$comment": "MCP demo/test server",
            "command": "node",
            "args": launch_args("everything", ["stdio"]),
            "disabled": False,
            "alwaysAllow": ["get-env"],
        },
        "central-sequentialthinking": {
            "$comment": "Sequential thinking/reasoning server",
            "command": "node",
            "args": launch_args("sequentialthinking"),
            "disabled": False,
            "alwaysAllow": [],
        },
        "central-fake-qdrant": {
            "$comment": "Local Qdrant-compatible vector store (JSONL, HTTP :6333)",
            "command": "node",
            "args": launch_args("fake-qdrant"),
            "env": {
                "FAKE_QDRANT_ENABLED": "1",
                "FAKE_QDRANT_HTTP_PORT": "6333",
                "FAKE_QDRANT_DATA_DIR": str(DATA_FAKE_QDRANT),
                "MCP_TAKEOVER": "1",
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
                "fake_qdrant_status",
            ],
        },
        "central-local-embeddings": {
            "$comment": "Local Transformers.js embeddings (optional HTTP :3100)",
            "command": "node",
            "args": launch_args("local-embeddings"),
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
            "command": "node",
            "args": launch_args("docsearch"),
            "env": {
                "EMBEDDINGS_PROVIDER": "local",
                "DOCSEARCH_DATA_DIR": str(DATA_DOCSEARCH),
                "LOCAL_EMBED_MODEL": DEFAULT_MODEL,
                "LOCAL_MODEL_CACHE_DIR": str(MODEL_CACHE),
                "MCP_TAKEOVER": "1",
            },
            "disabled": False,
            "alwaysAllow": ["doc-search", "doc-ingest", "doc-ingest-status"],
        },
    }
    apply_embedding_env(servers, embeddings_mode, embed_env or {})
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

    tsx = REPO_ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"
    lifecycle_dist = REPO_ROOT / "src" / "mcp-lifecycle" / "dist" / "index.js"
    print(f"tsx local: {tsx if tsx.exists() else 'MISSING (npm install tsx from internal registry)'}")
    print(f"mcp-lifecycle dist: {lifecycle_dist if lifecycle_dist.exists() else 'MISSING (npm run build -w src/mcp-lifecycle)'}")
    if not tsx.exists() and not (REPO_ROOT / "src" / "fake-qdrant" / "dist" / "index.js").exists():
        ok = False

    doctor = subprocess.run(
        ["node", str(REPO_ROOT / "scripts" / "mcp-ps.mjs"), "doctor"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    print(doctor.stdout or doctor.stderr or "mcp-ps doctor produced no output")
    if doctor.returncode != 0:
        print("mcp-ps doctor reported issues (stale locks/instance files).")

    if not ok:
        print("Check failed.")
        return 1
    print("Check passed. Next: node scripts/validate_mcps.mjs then reload RooCode / Cursor.")
    return 0


def write_configs(embeddings_mode: str, embed_env: dict[str, str]) -> None:
    filesystem_dir = filesystem_root()
    roo_payload = build_mcp_config(
        include_cwd=True,
        filesystem_dir=filesystem_dir,
        embeddings_mode=embeddings_mode,
        embed_env=embed_env,
    )
    cursor_payload = build_mcp_config(
        include_cwd=False,
        filesystem_dir=filesystem_dir,
        embeddings_mode=embeddings_mode,
        embed_env=embed_env,
    )
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
    parser.add_argument(
        "--embeddings",
        choices=["local", "external"],
        default=None,
        help="Embedding profile written into mcp.json (default: external when OPENAI_EMBED_BASE_URL is set)",
    )
    args = parser.parse_args()
    embeddings_mode, embed_env = resolve_embeddings_mode(args.embeddings)

    ensure_dirs()
    print_embeddings_profile(embeddings_mode, embed_env)
    if args.check:
        return check_environment()

    write_configs(embeddings_mode, embed_env)
    print()
    print("Setup complete.")
    print("  1. From the repo root, run: python scripts/setup_roo.py --check")
    print("  2. Run: node scripts/validate_mcps.mjs")
    print("  3. Reload VS Code / RooCode / Cursor so node scripts/mcp-launch.mjs MCP servers start.")
    print("  4. No Docker, SQLite, or extra binaries are required.")
    print(f"  Data: {DATA_FAKE_QDRANT}")
    print(f"        {DATA_DOCSEARCH}")
    print(f"        {MODEL_CACHE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
