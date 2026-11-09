#!/usr/bin/env bash
# Import projects.json into D1 database via admin API.
# Usage: ./dev-import-projects.sh [path/to/projects.json] [--url="http://localhost:8787"] [--x-admin-key="demo-admin-key"]
set -euo pipefail

FILE_PATH="./projects.json"
BASE_URL="${URL:-http://localhost:8787}"
X_ADMIN_KEY="${ADMIN_KEY:-demo-admin-key}"

for arg in "$@"; do
    case "${arg}" in
        --url=*)
            VAL="${arg#*=}"
            if [ -n "${VAL}" ]; then
                BASE_URL="${VAL}"
            fi
            ;;
        --x-admin-key=*)
            VAL="${arg#*=}"
            if [ -n "${VAL}" ]; then
                X_ADMIN_KEY="${VAL}"
            fi
            ;;
        --*)
            echo "Error: Unknown option '${arg}'" >&2
            echo "Usage: $0 [path/to/projects.json] [--url=\"...\"] [--x-admin-key=\"...\"]" >&2
            exit 1
            ;;
        *)
            FILE_PATH="${arg}"
            ;;
    esac
done

BASE_URL="${BASE_URL%/}"
TARGET_URL="${BASE_URL}/api/admin/projects/import"

if [ ! -f "${FILE_PATH}" ]; then
    echo "Error: File '${FILE_PATH}' not found." >&2
    echo "Tip: Copy projects.template.json -> projects.json first." >&2
    exit 1
fi

echo "Target URL: ${TARGET_URL}"
echo "Importing projects from ${FILE_PATH}..."

curl -s "${TARGET_URL}" \
    -H "Content-Type: application/json" \
    -H "x-admin-key: ${X_ADMIN_KEY}" \
    --data-binary "@${FILE_PATH}" \
    | jq .
