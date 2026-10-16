#!/usr/bin/env bash
# Fire N concurrent POST /orders requests at the orders BFF.
# Each request reserves 1 unit of the seeded load-test product.
#
# Usage: ./run-load.sh <orders-domain> [total] [concurrency] [productId]
#   orders-domain : the endpoint domain, e.g. abcd1234.qh3.lambda-web.us-east-1.on.aws
#   total         : total number of requests to send   (default 200)
#   concurrency   : how many to run in parallel at once (default 50)
#   productId     : product to order                   (default load-test)
#
# Prints each request's HTTP status, then a summary count per status.
set -uo pipefail

DOMAIN="${1:?Usage: ./run-load.sh <orders-domain> [total] [concurrency] [productId]}"
TOTAL="${2:-200}"
CONCURRENCY="${3:-50}"
PRODUCT_ID="${4:-load-test}"

URL="https://$DOMAIN/orders"
BODY="{\"productId\":\"$PRODUCT_ID\",\"quantity\":1,\"customer\":\"load-test\"}"

# One request: print the HTTP status code and the total client-side time (s).
# time_total includes DNS + TLS on every call (curl opens a fresh connection),
# so treat it as an upper bound: "client-observed latency", not server time.
one_request() {
  curl --ssl-no-revoke -s -o /dev/null -w '%{http_code} %{time_total}\n' \
    -X POST "$URL" -H "Content-Type: application/json" -d "$BODY"
}
export -f one_request
export URL BODY

echo "Sending $TOTAL requests to $URL (concurrency $CONCURRENCY)..."

# Wall-clock timer around the whole run: the real elapsed time, to compare
# against the summed active-CPU time from CloudWatch.
start=$(date +%s)

# xargs -P runs up to CONCURRENCY requests in parallel. Summarize per-status
# counts and the summed client-observed latency across all requests.
seq "$TOTAL" | xargs -P "$CONCURRENCY" -I {} bash -c 'one_request' \
  | awk '{ c[$1]++; t += $2 }
         END { for (s in c) print "  status " s ": " c[s] " requests";
               printf "  summed client latency: %.1f s\n", t }'

elapsed=$(( $(date +%s) - start ))
echo "Done in ${elapsed}s wall-clock time."
