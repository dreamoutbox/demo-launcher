#!/usr/bin/env bash
set -euo pipefail

curl -s -H "x-admin-key: demo-admin-key" "http://localhost:8787/api/cron-cleanup?maxDemoTimeSeconds=2" | jq .
