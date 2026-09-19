#!/usr/bin/env bash
# Cursor/Claude/Codex often spawn MCP without a login shell, so nvm's `node`
# is missing from PATH. This wrapper loads nvm (when present) and runs the
# MacroMe stdio server from the repo root.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh" >&2
fi
cd "$ROOT"
exec node "$ROOT/mcp-server.cjs"
