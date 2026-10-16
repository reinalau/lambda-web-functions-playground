#!/usr/bin/env bash
# Seed a product with a large stock so a load test does not run out.
# Usage: ./seed-stock.sh [productId] [available] [table]
set -euo pipefail

PRODUCT_ID="${1:-load-test}"
AVAILABLE="${2:-1000000}"
TABLE="${3:-inventory}"

aws dynamodb put-item --table-name "$TABLE" --item "{
  \"productId\":   {\"S\": \"$PRODUCT_ID\"},
  \"productName\": {\"S\": \"Load test product\"},
  \"available\":   {\"N\": \"$AVAILABLE\"}
}"

echo "Seeded $PRODUCT_ID with $AVAILABLE units in table $TABLE."
