#!/usr/bin/env bash
set -euo pipefail

curl -s "http://localhost:8787/api/cron-cleanup?maxDemoTimeSeconds=2" | jq .
