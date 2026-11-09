#!/usr/bin/env bash
# Import projects.json into D1 database via admin API.
# Usage: ./dev-import-projects.sh [path/to/projects.json]
set -euo pipefail

FILE_PATH="${1:-./projects.json}"

if [ ! -f "${FILE_PATH}" ]; then
    echo "Error: File '${FILE_PATH}' not found." >&2
    echo "Tip: Copy projects.template.json -> projects.json first." >&2
    exit 1
fi

echo "Importing projects from ${FILE_PATH}..."

curl -s "http://localhost:8787/api/admin/projects/import" \
    -H "Content-Type: application/json" \
    -H "x-admin-key: ${ADMIN_KEY:-demo-admin-key}" \
    --data-binary "@${FILE_PATH}" \
    | jq .

