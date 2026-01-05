#!/usr/bin/env sh

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
pwsh -NoLogo -NoProfile -File "$SCRIPT_DIR/start-central-mcp.ps1" "$@"

