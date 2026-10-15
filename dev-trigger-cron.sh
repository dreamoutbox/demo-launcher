#!/usr/bin/env bash
set -euo pipefail

curl -s "http://localhost:8787/cdn-cgi/handler/scheduled" | jq.
