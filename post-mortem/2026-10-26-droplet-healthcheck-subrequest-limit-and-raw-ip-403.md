# Postmortem: Droplet healthcheck subrequest limit and outbound raw IP 403

**Date:** 2026-10-26
**Severity:** Medium
**Status:** Resolved

## Summary

Droplet launches frequently failed or remained stuck in `LAUNCHING` due to two distinct Cloudflare Worker platform constraints during application health checks:
1. Worker queue invocations exceeded the 50 subrequest limit (`Too many subrequests by single Worker invocation`) while polling droplet HTTP endpoints in a loop.
2. Even after the droplet application was listening, outbound `fetch("http://<raw-ip>:<port>/...")` from the Worker returned `403 Forbidden` because Cloudflare edge proxy policies block outbound HTTP requests to raw public IP addresses.

Direct client-side browser polling was also prohibited by W3C Mixed Content rules (HTTPS origin to HTTP raw IP). The issue was resolved by removing the blocking healthcheck loop from the Worker queue consumer, updating the database status to `RUNNING` immediately upon IP assignment, and implementing a TCP socket health probe (`cloudflare:sockets`) queried on-demand by the frontend.

## Impact

- Project launches (such as `rust-playground-server` and `java-apartment-management-system`) failed or timed out during the healthcheck phase even when droplets had booted successfully.
- Queue messages exhausted their retry budgets due to uncaught subrequest quota exhaustion.
- Droplets remained active and billable on DigitalOcean while marked failed or stuck in the launcher database.

## Root Cause

Two separate constraints interacted to break the healthcheck mechanism:

1. **Subrequest Limit Quota:**
   In Cloudflare Workers, a single invocation allows a maximum of 50 subrequests. The `waitForHealthy` loop in the queue consumer polled `fetch()` every 5 seconds for up to 5 minutes, easily exceeding 50 HTTP calls before application startup completed (which typically takes 60–120 seconds for Ubuntu package installations, git clone, and Docker build).

2. **Edge Proxy SSRF Protection (HTTP 403 on Raw IPs):**
   Cloudflare Workers' standard `fetch()` API routes outbound HTTP requests through the Cloudflare edge proxy, which applies automated SSRF protection policies blocking requests directed at raw IPv4 addresses, responding with an HTTP `403 Forbidden` rather than forwarding the request to the origin server.

3. **Browser Mixed Content Policy:**
   When testing whether the client browser could query the droplet directly, browsers blocked requests from the HTTPS dashboard (`https://demo-launcher.workers.dev`) to `http://<droplet-ip>:<port>` under mixed-content restrictions.

## Detection

- Observed in `wrangler tail` and production logs:
  - `Error: Too many subrequests by single Worker invocation`
  - `[DO] Health check http://168.144.247.63:8080/login returned status 403; retrying...`
- Manual verification via local terminal (`curl http://152.42.212.39:3000/`) confirmed the droplet and web app were responding normally while Worker `fetch()` calls were blocked.

## Resolution

1. **Decouple Health Checking from Launch Lifecycle:**
   - Removed the blocking `waitForHealthy` loop from `ProjectLauncher.pollAndHealth` in `src/launcher.ts`.
   - As soon as DigitalOcean assigns a public IP to the droplet, the Worker immediately records `droplet_ip` and updates the status to `RUNNING` in D1.

2. **Implement TCP Socket Probing:**
   - Implemented `checkHealth(ip, port)` in `src/helper.ts` using `connect()` from `cloudflare:sockets`.
   - TCP sockets connect at Layer 4 (Transport layer) directly to the target IP and port without triggering Cloudflare's Layer 7 HTTP SSRF filter.
   - Sockets race against an abort timeout (`timeoutMs`) and close immediately upon connection establishment or failure.

3. **Frontend Polling Endpoint:**
   - Exposed `GET /api/health-check?ip=...&port=...` in `src/index.ts`.
   - Updated `public/main.js` to poll this endpoint every 3 seconds once the droplet has an IP, displaying `Starting up (booting app)...` until the TCP socket connects, and `Ready` once open.

4. **Testing:**
   - Added unit tests in `test/healthcheck.spec.ts` validating TCP connection success, socket timeout, connection refused handling, and port boundary checks.
   - Added API integration test in `test/index.spec.ts` covering parameter validation and probe responses.

## Lessons Learned / Action Items

- [x] Never poll external network endpoints in long-running loops within a single Worker invocation; respect the 50-subrequest ceiling.
- [x] Use `cloudflare:sockets` (Layer 4 TCP) rather than `fetch()` (Layer 7 HTTP) when probing raw IP addresses from Cloudflare Workers.
- [x] Transition droplets to `RUNNING` as soon as their public IP is assigned to avoid blocking queue consumers on variable container build times.
- [x] Let the browser drive UI-facing readiness polling through a dedicated, single-probe backend endpoint.
- [ ] Add rate limiting or Turnstile protection to `/api/health-check` if public traffic abuse becomes a concern.
- [ ] Provide optional entrypoint logging or status callbacks from the droplet startup script to report detailed bootstrap progress.
