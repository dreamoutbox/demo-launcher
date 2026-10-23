# Postmortem: Queue retried a non-retryable droplet-limit error

**Date:** 2026-10-23
**Severity:** Low
**Status:** Resolved

## Summary

A DigitalOcean `createDroplet` request returned `422 Unprocessable Entity` with "creating this/these droplet(s) will exceed your droplet limit". The queue consumer treated every error as transient, retried the message three times, then moved it to the dead letter queue. The launch failed and the queue spent retries on a request that could never succeed.

## Impact

- One project launch (`rust-playground-server`) failed.
- Three unnecessary DigitalOcean create attempts.
- One message was moved to `my-queue-dlq`.
- No data loss or external user impact beyond the failed launch.

## Root Cause

`DigitalOceanProdService` threw a generic `Error` for HTTP failures, and `worker.queue` retried every thrown error unconditionally. A 422 droplet-limit response is a permanent 4xx condition, so retrying could not succeed.

## Detection

Reported from `wrangler dev` logs showing repeated 422 responses and the message moving to the DLQ after three failed attempts.

## Resolution

- Added `DigitalOceanApiError` with the HTTP status and a `retryable` classification: `408`, `429`, and `5xx` are retryable; other 4xx responses are terminal.
- `DigitalOceanProdService` now throws this error for API failures.
- `ProjectLauncher.launch` and `pollAndHealth` mark the project `FAILED` and return normally for non-retryable errors, causing the queue consumer to ack the message.
- Retryable errors still throw and are retried.
- Added a regression test asserting that a 422 is acked without retry.

## Lessons Learned / Action Items

- [x] Classify DigitalOcean API errors as retryable or terminal.
- [x] Add a regression test for the 422 ack/no-retry behavior.
- [x] Document the non-retryable behavior in the README.
- [ ] Add tests for retryable 429 and 5xx paths.
- [ ] Add an alert or dashboard for messages entering `my-queue-dlq`.
- [ ] Surface the failure reason, such as the droplet limit, in the project status/API.