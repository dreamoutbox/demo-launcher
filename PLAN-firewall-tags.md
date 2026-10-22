# PLAN: Droplet Firewall via Tags

Covers TODO items:
- create firewall if not exists; create tag for droplets to attach to
- D1 `project_demos` table: add `tags` field
- attach droplets to firewall by tagging them

## Decisions

| Topic | Decision |
|-------|----------|
| Where firewall is ensured | Worker runtime: `ensureFirewall()` in `DigitalOceanProdService`, cached per instance like `ensureSshKey` |
| Inbound rules | TCP 22, 80, 443 + ICMP, from `0.0.0.0/0` and `::/0` |
| Outbound rules | All TCP, UDP, ICMP to anywhere |
| Names | Default firewall `demo-launcher-fw`, tag `demo-launcher-fw`; override with `DO_FIREWALL_NAME` / `DO_FIREWALL_TAG` |
| `tags` column | `TEXT`, JSON array of the DO tags actually applied to the droplet, written when the launch succeeds |
| DB migration | Keep `schema.sql` for fresh installs + one-off `ALTER TABLE` migration file run from setup scripts |
| Mock | Echo the tags it was given, log the firewall step, no simulated firewall state |

## Assumptions

- DO attaches a firewall to every droplet carrying one of the firewall's `tags`, including droplets created later. So droplets need no per-droplet attach call. Tagging at create time is enough.
- A tag must exist before a firewall can reference it, so `ensureFirewall()` creates the tag first (`POST /v2/tags` is idempotent).
- The `DO_API_KEY` token can manage firewalls and tags (full Read/Write tokens can).
- One shared firewall serves all demo droplets. No per-project firewalls.

> Verify the first two against the current DO API docs (`/v2/firewalls`, `/v2/tags`) before implementing.

---

## Phase 1: Config and types

**Goal:** The new settings can flow from env into the DO service.

1. Add optional `DO_FIREWALL_NAME` and `DO_FIREWALL_TAG` to `Env` in `src/types.ts`.
2. Add `firewallName` and `firewallTag` to `DigitalOceanConfig` (`src/digitalocean.prod.ts`). Defaults are constants in one place.
3. Pass both fields through in `getDigitalOceanService` (`src/digitalocean.ts`).
4. Add `tags: string[]` to `DropletInfo` so callers know which tags were applied.
5. Document the new vars in `wrangler.jsonc` vars (commented example) and `README.md`.

**Verify:** `pnpm exec tsc --noEmit` passes (after the mock is updated in Phase 3).

## Phase 2: Ensure tag + firewall (prod service)

**Goal:** On first droplet creation, the tag and firewall exist, and the step is idempotent.

1. `ensureTag(name)`: `POST /v2/tags`. Treat 201 and the "already exists" response as success.
2. `ensureFirewall()`:
   - Return the cached firewall ID if present.
   - `GET /v2/firewalls` (paginate or `per_page=200`), match by `firewallName`.
   - If found but missing `firewallTag` in its `tags`, add it with `POST /v2/firewalls/{id}/tags`.
   - If not found, `ensureTag` then `POST /v2/firewalls` with the name, inbound/outbound rules from Decisions, and `tags: [firewallTag]`.
   - Handle a create race (two DO instances for different projects): on a conflict or 422, re-list and resolve by name. Same pattern as `ensureSshKey`.
   - Cache the resolved ID.
3. Inbound/outbound rule definitions sit in one constant or builder, not inline in the request.
4. Add JSDoc (what it does, args, example) to match existing style.

**Verify:** A manual run against the real API with `DO_USE_REAL_API=true`: the first launch creates the firewall, and a second launch reuses it (check `action_logs` / worker logs and the DO dashboard).

## Phase 3: Tag droplets at creation

**Goal:** Every new droplet carries the firewall tag, so DO attaches the firewall to it.

1. In `createDroplet` (prod): call `ensureFirewall()` before `POST /v2/droplets`.
2. Build tags once: `['demo-launcher', projectId, firewallTag]`, deduplicated. Use the same array for the payload and the returned `DropletInfo.tags`.
3. Decide failure policy: if `ensureFirewall()` fails, abort the launch (recommended; keeps droplets from going out unprotected). The existing catch in `launcher.ts` already marks the project `FAILED`.
4. Mock (`src/digitalocean.mock.ts`): build the same tag array, log "ensure firewall (mock)", return the tags.
5. Extract the tag-building logic into a shared helper (e.g. `buildDropletTags` in `src/helper.ts`) because both prod and mock use it.

**Verify:** In the dev/mock launch logs, the tags include the firewall tag. On a real launch, the droplet appears under the firewall's droplet list in the DO dashboard.

## Phase 4: D1 `tags` column

**Goal:** `project_demos.tags` exists on fresh and existing DBs and holds the applied tags.

1. `schema.sql`: add `tags TEXT` (comment: JSON array of DO tags) to `CREATE TABLE project_demos`.
2. New `migrations-manual/0001_project_demos_add_tags.sql` (or similar) with `ALTER TABLE project_demos ADD COLUMN tags TEXT;`.
3. SQLite `ADD COLUMN` is not idempotent. Re-runs and fresh installs (where `schema.sql` already added the column) would fail. Handle this in a dedicated script file, e.g. `dev-migrate.sh <--local|--remote>`:
   - Query `PRAGMA table_info(project_demos)`; apply the ALTER only if `tags` is absent.
   - Call it from `dev-setup-local.sh` and `dev-setup-remote.sh` right after `schema.sql` is applied.
4. `launcher.ts`: the success `UPDATE` also sets `tags = JSON.stringify(droplet.tags)`.
5. `index.ts` cron cleanup: reset `tags = NULL` with the other droplet fields.
6. Admin/listing query (`index.ts` ~L76): add `tags` to the row type. Whether to show it in the admin UI is out of scope unless requested.

**Verify:** Run `./dev-setup-local.sh` twice; neither run errors. `SELECT tags FROM project_demos` shows the JSON array after a mock launch and `NULL` after cron cleanup.

## Phase 5: Tests

**Goal:** Behaviour is locked in by vitest.

1. `test/index.spec.ts`: add `tags TEXT` to the manually created `project_demos` table.
2. Launch test: assert `tags` is a JSON array containing `demo-launcher`, the project ID, and the default firewall tag.
3. Cron cleanup test: assert `tags` is reset to `NULL`.
4. Unit tests for the prod `ensureFirewall` with a stubbed `fetch`:
   - Firewall exists: no create call, ID cached.
   - Firewall missing: tag created, firewall created with the expected rules and tag.
   - Firewall exists without the tag: tag added.
   - Create returns a conflict: re-list resolves the ID.
5. Env override test: `DO_FIREWALL_TAG` changes the applied tag.

**Verify:** `./dev-test-vitest.sh` is green.

## Phase 6: Docs and TODO

1. `README.md`: describe the firewall behaviour, default rules, the env overrides, and the migration script.
2. Tick the three TODO items in `TODO.md`.

---

## Risks / Open points

- **Existing droplets** created before this change have no firewall tag and stay unprotected until they are recycled by cron. They could be backfilled with `POST /v2/tags/{tag}/resources`, but that isn't planned unless you ask for it.
- **Port 22 open to the world**: acceptable for SSH-key-only droplets. Restricting the SSH source CIDR could be a later env option.
- **Rule drift**: if someone edits the firewall in the dashboard, `ensureFirewall()` won't reconcile the rules (it only matches by name and ensures the tag). This is intentional, to keep it simple.
- **Per-instance cache**: the firewall ID cache lives in the service instance. A new instance does one extra `GET /v2/firewalls`, which is negligible.
