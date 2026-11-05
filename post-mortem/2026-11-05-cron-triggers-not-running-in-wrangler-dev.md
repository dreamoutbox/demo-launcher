# Postmortem: Cron triggers do not run on a schedule in wrangler dev

**Date:** 2026-11-05
**Severity:** Low
**Status:** Resolved

## Summary

Demo droplet instances in local development were observed running past their configured maximum lifetime without being cleaned up by the scheduled cron task. In `wrangler dev`, Cloudflare does not automatically execute cron triggers on a timer.

## Impact

- Expired demo droplets in local development remain active unless manually cleared.
- Developers may assume automated cleanup is broken or failing to detect expired droplets.

## Root Cause

Cloudflare Workers cron triggers (`triggers.crons` in `wrangler.jsonc`) only run on an automated schedule when deployed to Cloudflare's edge network. The local development runtime (`workerd` via `wrangler dev`) does not run a background cron scheduler or trigger the `scheduled()` exported handler automatically.

## Detection

Observed directly during local development when a demo instance passed its 30-minute demo time without the scheduled cleanup running.

## Resolution

- Documented that cron triggers must be invoked manually in local development.
- Verified local trigger mechanisms:
  - CLI script: `./dev-trigger-cron.sh` (`GET http://localhost:8787/cdn-cgi/handler/scheduled`)
  - Admin endpoint: `curl -H "x-admin-key: <ADMIN_KEY>" http://localhost:8787/api/cron-cleanup` (or `./dev-trigger-cron-2-seconds.sh`)
  - Admin UI: **Trigger Cron Cleanup** button on `http://localhost:8787/admin/demo_list.html`

## Lessons Learned / Action Items

- [x] Document in `AGENTS.md` that cron triggers do not fire automatically in `wrangler dev`.
- [x] Use `./dev-trigger-cron.sh` or the Admin UI cleanup button when testing scheduled tasks locally.

