#!/usr/bin/env bash
set -euo pipefail

# curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
curl -s "http://localhost:8787/cdn-cgi/handler/scheduled"
