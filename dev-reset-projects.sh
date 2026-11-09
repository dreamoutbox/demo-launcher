#!/usr/bin/env bash
# Reset projects table in D1 database without deleting demo droplets or records.
# Usage: ./dev-reset-projects.sh [--direct]
#   Default: calls POST /api/admin/projects/reset on local dev server.
#   --direct: executes DELETE directly via wrangler d1 execute (local).
set -euo pipefail

MODE="${1:-api}"

if [ "${MODE}" = "--direct" ]; then
    echo "Directly resetting projects table on local D1..."
    npx wrangler d1 execute mydb --local --yes --command="DELETE FROM projects;"
    echo "Projects table reset completed."
    exit 0
fi

echo "Calling admin reset API (/api/admin/projects/reset)..."
curl -s -X POST "http://localhost:8787/api/admin/projects/reset" \
    -H "x-admin-key: ${ADMIN_KEY:-demo-admin-key}" \
    | jq .
