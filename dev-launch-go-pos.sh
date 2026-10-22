#!/usr/bin/env bash
set -euo pipefail

curl -s "http://localhost:8787/api/launch" \
    -H "Content-Type: application/json" \
    -d '{"projectId": "go-pos", "turnstileToken": "local-dev-token"}' \
    | jq .
