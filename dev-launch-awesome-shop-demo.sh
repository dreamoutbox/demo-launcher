#!/usr/bin/env bash
set -euo pipefail

curl -s "http://localhost:8787/api/launch" \
    -H "Content-Type: application/json" \
    -d '{"projectId": "awesome-shop-demo", "turnstileToken": "local-dev-token"}' \
    | jq .
    