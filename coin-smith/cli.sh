#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# cli.sh — Coin Smith: PSBT transaction builder CLI
#
# Usage:
#   ./cli.sh <fixture.json>
#
# Workflow:
#   1. Read the fixture JSON (UTXOs, payments, change template, fee rate)
#   2. Select coins (inputs) to fund the payments
#   3. Compute fee, change, and construct outputs
#   4. Build an unsigned PSBT (BIP-174)
#   5. Write JSON report to out/<fixture_name>.json
#   6. Exit 0 on success, 1 on error
#
# On error, writes { "ok": false, "error": { "code": "...", "message": "..." } }
# to the output file and exits 1.
###############################################################################

if [[ $# -lt 1 ]]; then
  printf '{"ok":false,"error":{"code":"INVALID_ARGS","message":"Usage: cli.sh <fixture.json>"}}\n'
  exit 1
fi

mkdir -p out
node cli.js "$1"
