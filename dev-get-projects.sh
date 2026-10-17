#!/usr/bin/env bash
set -euo pipefail

curl -s "http://localhost:8787/api/projects" \
    -H "Content-Type: application/json" | jq .