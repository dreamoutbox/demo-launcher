# PLAN: Deploy branch, firewall ports, instance limit

Covers TODO items (L37-L42):
- git branch to deploy
- firewall allowed incoming ports. extend default firewall rules
- limit instances count

Build/test: `pnpm test` (vitest, `test/*.spec.ts`), `pnpm types` after `wrangler.jsonc` var changes. No manual edits to `src/types.ts` env typings.

## Current state

- `projects.json` already has `branch`, but `createDroplet(projectId, repoUrl, size, attemptId)` and `buildStartupScript(repoUrl)` ignore it (plain `git clone`).
- Firewall inbound defaults live in `DEFAULT_FIREWALL_INBOUND_RULES` (`src/digitalocean.prod.ts`): 22, 80, 443, 81, 8080, 3000, 9000, ICMP. `ensureFirewall()` re-pushes rules only when the rule **count** differs.
- No cap on concurrent demos. `/api/launch` enqueues unconditionally; `ProjectLauncher` is one Durable Object per project (`env.LAUNCHER.idFromName(projectId)` in `src/index.ts`), so no cross-project serialization exists.

## Phases

### Phase 1: Clone the configured branch [STATUS: DONE]
- Goal: droplets check out `project.branch` instead of the repo default.
- Tasks:
  - [x] Add optional `branch` param to `buildStartupScript` in `src/helper.ts`; use `git clone --branch <branch> --single-branch`; omit flag when unset. Validate/quote the branch value (allow `[A-Za-z0-9._/-]` only) to avoid shell injection.
  - [x] Thread `branch` through `IDigitalOceanService.createDroplet` (`src/types` interface lives in `src/digitalocean.ts`), prod and mock services, and the call in `src/launcher.ts`.
  - [x] Update existing `createDroplet` callers in tests; add tests: script contains branch flag, no flag when unset, invalid branch rejected.
- Done when: `pnpm test` passes; test asserts the user-data payload sent to the DO API contains the branch clone.

### Phase 2: Extend firewall inbound ports (global env + per-project) [STATUS: TODO]
- Goal: extra inbound ports configurable globally via env and per project via `projects.json`, with correct rule drift detection.
- Tasks:
  - [ ] Add optional `firewallPorts` (array of port/range strings, e.g. `["5432", "8000-8100"]`) to project entries in `src/projects.json`; add an example to one project.
  - [ ] Add optional env `DO_FIREWALL_EXTRA_INBOUND_PORTS` (comma list) in `wrangler.jsonc` vars (commented example) and `TEMPLATE.env`; run `pnpm types`.
  - [ ] Add helper in `src/helper.ts` to parse/validate port lists (reject non-numeric, out of 1-65535, reversed range) and build the final inbound rule list: defaults + env extras + the ports of every project in `projects.json` (union, deduped, TCP, `0.0.0.0/0` + `::/0`; cap total at DO's 50-rule limit).
  - [ ] Pass computed rules into `DigitalOceanProdService` config. Replace the count-only drift check in `ensureFirewall()` with a comparison of the sorted protocol/port set so changes of equal count are applied.
  - [ ] Tests: parser (valid, invalid, dedupe), union of defaults/env/project ports, PUT issued when ports differ, none when identical.
- Done when: `pnpm test` passes; adding a port in `projects.json` or the env shows up in the firewall create/update payload.

### Phase 3: Single global Durable Object [STATUS: TODO]
- Goal: replace per-project `ProjectLauncher` instances with one global instance, enabling cross-project serialization.
- Tasks:
  - [ ] Add a constant (e.g. `GLOBAL_LAUNCHER_NAME`) in `src/helper.ts`; use `env.LAUNCHER.idFromName(GLOBAL_LAUNCHER_NAME)` at the call site in `src/index.ts` (and any test/helper using `idFromName(projectId)`).
  - [ ] Keep the same class and binding (no wrangler migration needed): state is in D1 keyed by `project_id`, not in DO storage. Verify no DO storage is used.
  - [ ] Existing in-memory `Mutex` now serializes all launches/polls across projects. Confirm `pollAndHealth` does not hold the mutex during long waits (health checks) so one slow project does not block others; narrow the lock scope if it does.
  - [ ] Update class docstring ("one instance per project") and tests (concurrent launch of different projects, same project still creates one droplet).
- Done when: `pnpm test` passes; two different projects launched concurrently both succeed via the same DO instance.

### Phase 4: Limit concurrent instances [STATUS: TODO]
- Goal: cap simultaneous demo droplets via env.
- Tasks:
  - [ ] Add env `MAX_INSTANCES` (positive integer; unset = unlimited) in `wrangler.jsonc` vars, `TEMPLATE.env`; `pnpm types`.
  - [ ] Add helper `countActiveDemos(env)` in `src/helper.ts`: count `project_demos` rows with status `LAUNCHING` or `RUNNING`.
  - [ ] `POST /api/launch` (`src/index.ts`): if the project is not already active and count >= limit, log `ActionStatus.REJECTED` and return 429 with a clear message.
  - [ ] Re-check in `ProjectLauncher.launch` inside the global mutex, before claiming (count + claim is now atomic across projects, so the cap is strict); on exceed, mark the demo STOPPED/FAILED per existing conventions and ack.
  - [ ] Frontend (`public/main.js`): show the 429 message to the user.
  - [ ] Tests: under limit launches, at limit rejected with 429 + action log, relaunch of already-active project not blocked, unset env means unlimited.
- Done when: `pnpm test` passes; with `MAX_INSTANCES=1` a second distinct project launch returns 429.

### Phase 5: Docs and TODO cleanup [STATUS: TODO]
- Goal: document new settings and close the items.
- Tasks:
  - [ ] README: document `DO_FIREWALL_EXTRA_INBOUND_PORTS`, per-project `firewallPorts`, `MAX_INSTANCES`, and branch behavior.
  - [ ] Tick the three items in `TODO.md`.
- Done when: README lists the env vars; `pnpm test` still passes.

## Unknowns, risks, assumptions

- Decided: firewall ports are both global (env) and per-project (`firewallPorts`); since one shared firewall serves all droplets, per-project ports are opened for every demo (union), not isolated per project.
- Decided: one global Durable Object makes the instance cap strict. Trade-off: a single throughput bottleneck; fine at this scale as long as the lock is not held across slow waits (Phase 3 task).
- Assumption: "instances" = demos in `LAUNCHING` or `RUNNING`.
- Risk: DigitalOcean inbound rule limit (50); helper caps the total.
- Assumption: TODO items L43+ are out of scope.
