#!/usr/bin/env bash
# Package each service into a valid .zip for the Lambda Web Function CodeUri.
# Run from the project root (bff-orders-inventory/):  bash sam/package.sh
#
# The deployment package must contain package.json, node_modules/ and dist/ at
# its root. On Windows, git bash has no `zip` and `tar -a .zip` does NOT produce
# a real zip, so we use PowerShell's Compress-Archive, which writes a valid zip.
set -euo pipefail

zip_service() {
  local svc="$1"
  echo "Packaging $svc ..."
  ( cd "$svc" && npm ci --omit=dev )
  rm -f "$svc-app.zip"
  powershell -NoProfile -Command \
    "Compress-Archive -Path '$svc/package.json','$svc/node_modules','$svc/dist' -DestinationPath '$svc-app.zip' -Force"
  echo "Created $svc-app.zip"
}

zip_service inventory
zip_service orders

echo "Done. Now upload the two zips and run sam deploy (see README)."
