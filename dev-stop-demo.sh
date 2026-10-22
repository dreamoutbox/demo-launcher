#!/usr/bin/env bash
# Force stop a demo: delete its droplet and reset state.
# Usage: ./dev-stop-demo.sh <project-id>   (ADMIN_KEY env overrides the default dev key)
set -euo pipefail

if [ $# -ne 1 ]; then
    echo "Usage: $0 <project-id>" >&2
    exit 1
fi

curl -s "http://localhost:8787/api/admin/stop" \
    -H "Content-Type: application/json" \
    -H "x-admin-key: ${ADMIN_KEY:-demo-admin-key}" \
    -d "{\"projectId\": \"$1\"}" \
    | jq .
