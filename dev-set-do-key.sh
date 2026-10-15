#!/usr/bin/env bash
set -euo pipefail

npx wrangler secret put DO_API_KEY --env production
