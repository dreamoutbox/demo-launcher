#!/usr/bin/env bash
set -euo pipefail

curl -s "http://localhost:8787/api/launch" \
    -H "Content-Type: application/json" \
    -d '{"projectId": "demo-launcher-simple-project", "turnstileToken": "local-dev-token"}' \
    | jq .
