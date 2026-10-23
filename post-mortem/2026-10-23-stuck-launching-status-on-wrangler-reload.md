# Postmortem: Stuck `LAUNCHING` status on wrangler dev reload

**Date:** 2026-10-23
**Severity:** Low
**Status:** Resolved

## Summary

A project launch could remain permanently in `LAUNCHING` when `wrangler dev` reloaded during an in-flight launch. After the reload, every new launch request was skipped as "already launching", and the queue message was acknowledged, so no retry ever ran.

## Impact

- Affected local development launches; the same architecture could also be interrupted by production deploys or Durable Object restarts.
- The project required manual database intervention or the force-stop endpoint before it could launch again.
- A droplet created before the crash could be left untracked and billable because its id was saved only after IP polling completed.

## Root Cause

The entire launch state machine ran inside one request:

1. Set status to `LAUNCHING`.
2. Call `createDroplet()`, which POSTed to DigitalOcean and then polled up to ~30 seconds for a public IP.
3. Save `droplet_id` and `droplet_ip`.
4. Run a health check for up to 5 minutes.
5. Set status to `RUNNING`.

A `wrangler dev` reload killed the process during one of those awaits. The `catch` and `finally` blocks never ran, so the row stayed `LAUNCHING`. The next launch used `WHERE status IN ('STOPPED', 'FAILED')`, matched zero rows, and `launch()` returned successfully, causing the queue consumer to ack the message. There was no recovery path for a `LAUNCHING` row.

## Detection

Observed directly in local development: the UI stayed on `LAUNCHING` after a reload and repeated launch clicks did nothing. The issue was recorded in `TODO.md` and confirmed during code review.

## Resolution

- Split launch into two queue phases:
  - `CREATE` creates the droplet and persists its id immediately.
  - `POLL_HEALTH` resolves the public IP, re-enqueues itself while the IP is unavailable, then runs the health check.
- Made `CREATE` resumable: an existing `LAUNCHING` row reuses its `attempt_id` instead of being skipped.
- Tagged droplets with `launch-<attemptId>`, so a redelivered `CREATE` can find a droplet created before the crash and adopt it instead of creating a duplicate.
- Added `attempt_id` to `project_demos` for retry correlation and stale-poll protection.
- Rely on Cloudflare Queues redelivery for recovery; no Durable Object alarm or lease watchdog.
- Added admin-stop fallback that deletes an orphaned droplet by project tag when `droplet_id` is missing.
- Added regression tests for resuming a `LAUNCHING` row and adopting an existing tagged droplet.

## Lessons Learned / Action Items

- [x] Persist the droplet id immediately after creation, before any polling.
- [x] Make launch resumable for `LAUNCHING` rows instead of silently skipping them.
- [x] Move long-running IP and health checks out of the create path.
- [x] Tag droplets with an attempt id so interrupted creates can be reconciled.
- [x] Add tests for redelivered `CREATE` messages adopting an existing droplet.
- [x] Add orphan cleanup through the admin stop endpoint.
- [ ] Document that recovery depends on queue redelivery or the next launch click if a local queue message is lost.
- [ ] Consider a low-frequency stale-`LAUNCHING` indicator or sweep as a backstop for lost messages.