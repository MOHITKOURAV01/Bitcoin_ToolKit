#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# web.sh — Coin Smith: PSBT builder web UI and visualizer
#
# Starts the web server for the PSBT transaction builder.
#
# Behavior:
#   - Reads PORT env var (default: 3000)
#   - Prints the URL (e.g., http://127.0.0.1:3000) to stdout
#   - Keeps running until terminated (CTRL+C / SIGTERM)
#   - Must serve GET /api/health -> 200 { "ok": true }
#
# TODO: Replace the stub below with your web server start command.
###############################################################################

PORT="${PORT:-3000}"

# Start your web server here
export PORT
exec node server.js

