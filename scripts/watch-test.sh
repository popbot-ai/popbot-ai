#!/usr/bin/env bash
# Run the watcher test harness under Electron's Node, so the native
# @parcel/watcher ABI matches the Electron-rebuilt module (the same one the app
# uses). Usage:  bash scripts/watch-test.sh <dir>
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
electron="$(cd "$here" && node -p "require('electron')" 2>/dev/null || true)"
if [[ -z "$electron" || ! -x "$electron" ]]; then
  echo "Electron binary not found (require('electron') from $here) — run 'npm install' first." >&2
  exit 1
fi
exec env ELECTRON_RUN_AS_NODE=1 "$electron" "$here/scripts/watch-test.mjs" "$@"
