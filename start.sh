#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# start.sh — Bitcoin Toolkit launcher
#
# Starts both dashboards plus the landing page that links them, then waits.
# Ctrl-C stops all three.
#
# This script lives OUTSIDE both repositories and changes nothing inside them,
# so each project's own ./web.sh and ./grade.sh behave exactly as before.
#
#   Landing page   http://127.0.0.1:8080
#   Chain Lens     http://127.0.0.1:3222
#   Coin Smith     http://127.0.0.1:3333
###############################################################################

ROOT="$(cd "$(dirname "$0")" && pwd)"

HOME_PORT="${HOME_PORT:-8080}"
LENS_PORT="${LENS_PORT:-3222}"
SMITH_PORT="${SMITH_PORT:-3333}"

pids=()

cleanup() {
  echo ""
  echo "Stopping..."
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Fails fast with a clear message rather than a confusing bind error later.
port_busy() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

for port in "$HOME_PORT" "$LENS_PORT" "$SMITH_PORT"; do
  if port_busy "$port"; then
    echo "Error: port $port is already in use. Free it, or set HOME_PORT / LENS_PORT / SMITH_PORT." >&2
    exit 1
  fi
done

echo "Starting Chain Lens on ${LENS_PORT}..."
(cd "$ROOT/chain-lens" && PORT="$LENS_PORT" ./web.sh >/dev/null 2>&1) &
pids+=($!)

echo "Starting Coin Smith on ${SMITH_PORT}..."
(cd "$ROOT/coin-smith" && PORT="$SMITH_PORT" ./web.sh >/dev/null 2>&1) &
pids+=($!)

echo "Starting landing page on ${HOME_PORT}..."
(cd "$ROOT/home" && node "$ROOT/home/serve.js" "$HOME_PORT" >/dev/null 2>&1) &
pids+=($!)

sleep 2

echo ""
echo "  Landing page   http://127.0.0.1:$HOME_PORT"
echo "  Chain Lens     http://127.0.0.1:$LENS_PORT"
echo "  Coin Smith     http://127.0.0.1:$SMITH_PORT"
echo ""
echo "Press Ctrl-C to stop all three."

wait
