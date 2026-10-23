#!/usr/bin/env bash
# List all droplets in the DigitalOcean account (Admin Key protected).
# Usage: ./dev-get-droplets.sh   (ADMIN_KEY env overrides the default dev key)
set -euo pipefail

curl -s "http://localhost:8787/api/admin/droplets" \
    -H "x-admin-key: ${ADMIN_KEY:-demo-admin-key}" \
    | jq .
