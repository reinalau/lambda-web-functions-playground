#!/usr/bin/env bash
# Package the weather agent into a valid .zip for the Lambda Web Function CodeUri.
# Run from the project root (agent-weather-sse/):  bash sam/package.sh
#
# The deployment package must contain package.json, node_modules/ and dist/ at
# its root. On Windows, git bash has no `zip` and `tar -a .zip` does NOT produce
# a real zip, so we use PowerShell's Compress-Archive, which writes a valid zip.
set -euo pipefail

echo "Installing production dependencies ..."
npm ci --omit=dev

echo "Packaging app.zip ..."
rm -f app.zip
powershell -NoProfile -Command \
  "Compress-Archive -Path 'package.json','node_modules','dist' -DestinationPath 'app.zip' -Force"

echo "Created app.zip. Now upload it and run sam deploy (see README)."
