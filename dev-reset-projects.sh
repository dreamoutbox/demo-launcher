#!/usr/bin/env bash
# Reset projects table in D1 database without deleting demo droplets or records.
# Usage: ./dev-reset-projects.sh [--direct] [--url="http://localhost:8787"] [--x-admin-key="demo-admin-key"]
#   Default: calls POST /api/admin/projects/reset on target server.
#   --direct: executes DELETE directly via wrangler d1 execute (local).
set -euo pipefail

MODE="api"
BASE_URL="${URL:-http://localhost:8787}"
X_ADMIN_KEY="${ADMIN_KEY:-demo-admin-key}"

for arg in "$@"; do
    case "${arg}" in
        --direct)
            MODE="--direct"
            ;;
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
        *)
            echo "Error: Unknown option '${arg}'" >&2
            echo "Usage: $0 [--direct] [--url=\"...\"] [--x-admin-key=\"...\"]" >&2
            exit 1
            ;;
    esac
done

if [ "${MODE}" = "--direct" ]; then
    echo "Directly resetting projects table on local D1..."
    npx wrangler d1 execute mydb --local --yes --command="DELETE FROM projects;"
    echo "Projects table reset completed."
    exit 0
fi

BASE_URL="${BASE_URL%/}"
TARGET_URL="${BASE_URL}/api/admin/projects/reset"

echo "Target URL: ${TARGET_URL}"
echo "Calling admin reset API (/api/admin/projects/reset)..."
curl -s -X POST "${TARGET_URL}" \
    -H "x-admin-key: ${X_ADMIN_KEY}" \
    | jq .
