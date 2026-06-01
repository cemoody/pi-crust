#!/usr/bin/env bash
# Launch the isolated live pi-crust server.
#
# Isolation choices (see also: the "robust system" design notes):
#   - Dedicated checkout:  /home/coder/pi-crust-live-server (own .git, own node_modules)
#   - Dedicated config:    PI_CRUST_CONFIG_DIR=/home/coder/.pi-crust-live (no stray dev extensions)
#   - Dedicated runtime:   XDG_RUNTIME_DIR=/tmp/pi-crust-live-xdg  -> runtime dir /tmp/pi-crust-live-xdg/pi-crust
#   - SHARED with dev:     same port (8787) and same session transcripts (~/.pi/agent/sessions)
set -euo pipefail

cd "$(dirname "$0")"

export PI_CRUST_API_HOST="${PI_CRUST_API_HOST:-0.0.0.0}"
export PI_CRUST_API_PORT="${PI_CRUST_API_PORT:-8787}"
export PI_CRUST_CONFIG_DIR="${PI_CRUST_CONFIG_DIR:-/home/coder/.pi-crust-live}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR_OVERRIDE:-/tmp/pi-crust-live-xdg}"
# session transcripts: shared (the global default ~/.pi/agent/sessions)

mkdir -p "$XDG_RUNTIME_DIR"
mkdir -p "$PI_CRUST_CONFIG_DIR/extensions"
[ -f "$PI_CRUST_CONFIG_DIR/settings.json" ] || echo '{}' > "$PI_CRUST_CONFIG_DIR/settings.json"

echo "[run-live] host=$PI_CRUST_API_HOST port=$PI_CRUST_API_PORT"
echo "[run-live] config=$PI_CRUST_CONFIG_DIR runtime=$XDG_RUNTIME_DIR/pi-crust"
echo "[run-live] cwd=$(pwd) sha=$(git rev-parse --short HEAD)"

exec npm run dev:api:loop
