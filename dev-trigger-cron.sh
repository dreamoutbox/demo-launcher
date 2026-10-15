#!/usr/bin/env bash
set -euo pipefail

curl -s -w "\n" "http://localhost:8787/cdn-cgi/handler/scheduled"
