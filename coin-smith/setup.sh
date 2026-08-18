#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# setup.sh — Install dependencies for Coin Smith (PSBT transaction builder)
#
# Add your install commands below (e.g., npm install, pip install, cargo build).
# This script is run once before grading to set up the environment.
###############################################################################

# Install the Node.js dependencies specified in package.json
npm install

echo "Setup complete"
