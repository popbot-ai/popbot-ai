#!/bin/bash
# Runs popbot-host on the container's config, bound to every interface
# so the published port reaches it. Extra arguments go to the daemon
# (`--repo id=/repos/x`, `--slots x=4`, `--name`, `--token`). Set
# POPBOT_HOST_TOKEN to choose the token instead of taking the random one
# printed at the first start.
set -euo pipefail
CONFIG=/data/config.json
ARGS=(--config "$CONFIG" --bind 0.0.0.0 --port 7677 --workspaces /data/workspaces)
if [ -n "${POPBOT_HOST_TOKEN:-}" ]; then ARGS+=(--token "$POPBOT_HOST_TOKEN"); fi
if [ -n "${POPBOT_HOST_NAME:-}" ]; then ARGS+=(--name "$POPBOT_HOST_NAME"); fi
# Repositories mounted under /repos are trusted whoever owns them.
git config --global --add safe.directory '*' 2>/dev/null || true
exec node /app/popbot-host.cjs "${ARGS[@]}" "$@"
