# PLAN: Store projects.json in D1 Database and Add Admin Droplets & Import Pages

Covers `TODO.md` items (L46-L60):
- Copy `projects.template.json` -> `projects.json` at repo root (delete `src/projects.json`).
- Gitignore `projects.json`.
- Store `projects.json` records in D1 (`projects` table) with every JSON field preserved (including secrets); sanitize public `GET /api/projects` output.
- Extract a reusable server-side project validation and import function used by both the admin import API/page and the CLI import shell script.
- Add a reset projects table script that clears `projects` (and optionally non-running demo rows if desired, or leaves `project_demos` intact) without deleting created droplets or active droplet records, so admins can still view and destroy droplets created before the reset.
- Add a new Admin Created Droplets page (`/admin/droplets`) that fetches live droplets from the DigitalOcean API (`GET /api/admin/droplets`) and provides a button to destroy individual droplets (`DELETE /api/admin/droplets/:id` or `POST /api/admin/droplets/destroy`).
- Add a new Admin Import Projects page (`/admin/import_projects`) with a textarea to paste `projects.json`, server-side validation, success feedback, and a live table of imported projects.

Build/test: `pnpm test` (Vitest), `pnpm types` if `wrangler.jsonc` bindings change.

## Current State

- Projects are statically imported via `import projects from './projects.json'` in `src/index.ts`, `src/launcher.ts`, `src/digitalocean.ts`, and `test/index.spec.ts`.
- `schema.sql` defines `project_demos` and `action_logs`. There is no `projects` table yet.
- `GET /api/admin/droplets` already exists in `src/index.ts` and calls `doService.listDroplets()`, returning `{ droplets, count }`. However, there is no admin endpoint to destroy an arbitrary droplet by `dropletId` directly (only `/api/admin/stop` by `projectId`), and no admin UI page for viewing/destroying droplets.
- `public/admin/navbar.js` renders links for `Demo List` and `Action Logs`.

## Phases

### Phase 1: Project Template, Gitignore, and D1 Schema [STATUS: DONE]
- Goal: Move `src/projects.json` to root `projects.template.json`, gitignore `projects.json`, and add the `projects` table to D1 schema and migrations.
- Tasks:
  - [x] Create `projects.template.json` in the repo root (copied from current `src/projects.json` with clean sample projects) and copy it to `projects.json` locally; add `/projects.json` to `.gitignore` (and keep `src/projects.json` removed once Phase 2 switches imports).
  - [x] Add `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);` to `schema.sql`.
  - [x] Add migration file `migrations-manual/0003_create_projects_table.sql` and update `dev-migrate.sh` and `dev-reset-local.sh` to include the `projects` table.
- Done when: `./dev-migrate.sh --local` succeeds and creates the `projects` table; `projects.json` is ignored by `git status`.

### Phase 2: Project Repository, Validation, Import & Reset Functions, and Runtime DB Lookup [STATUS: DONE]
- Goal: Replace static `src/projects.json` imports across the Worker with D1 queries and a reusable validation/import module.
- Tasks:
  - [x] Create `src/projects-db.ts` (or functions in `src/helper.ts`) with:
    - `ProjectConfig` type definition (`id`, `name`, `repoUrl`, `branch`, `healthcheckPort`, `healthcheckPath`, `appPort`, `size`, `firewallPorts`, plus `[key: string]: unknown` for extra/secret fields).
    - `validateProjectsJson(input: unknown): { valid: true; projects: ProjectConfig[] } | { valid: false; error: string }` — validates non-empty array (or array of project objects), unique non-empty `id`, required `name` and valid `repoUrl`, optional `branch` (`isValidGitBranch`), `appPort`/`healthcheckPort`/`firewallPorts` (`isValidPortOrRange` / `parsePortList`), and `size`.
    - `importProjectsToDb(env: Env, rawJsonOrArray: unknown): Promise<ProjectConfig[]>` — validates input and upserts (`INSERT OR REPLACE INTO projects (id, data, updated_at)`) all records in a D1 batch, storing the full JSON object in `data`.
    - `resetProjectsTable(env: Env): Promise<{ deletedCount: number }>` — executes `DELETE FROM projects` without deleting `project_demos` droplet records or DigitalOcean droplets.
    - `getProjectsFromDb(env: Env): Promise<ProjectConfig[]>` and `getProjectByIdFromDb(env: Env, projectId: string): Promise<ProjectConfig | null>`.
    - `sanitizeProjectForPublic(project: ProjectConfig)` — returns only public display/launch fields (`id`, `name`, `repoUrl`, `branch`, `healthcheckPort`, `healthcheckPath`, `appPort`, `size`, `firewallPorts`), stripping any secret fields for `GET /api/projects`.
  - [x] Update `src/index.ts`, `src/launcher.ts`, and `src/digitalocean.ts` to read projects from D1 instead of `src/projects.json`:
    - `GET /api/projects`: fetch projects from `getProjectsFromDb(env)`, sanitize for public response.
    - `POST /api/launch`: look up project via `getProjectByIdFromDb(env, projectId)`.
    - `POST /api/admin/stop`: allow stopping any `projectId` present in `projects` OR `project_demos` (so demos from before a project reset can still be stopped).
    - `ProjectLauncher.launch` & `pollAndHealth`: fetch project from D1 and pass project list (or firewall ports) to `getDigitalOceanService`.
  - [x] Delete `src/projects.json` and update `test/index.spec.ts` `beforeEach` to create the `projects` table and seed test projects via `importProjectsToDb`.
- Done when: `src/projects.json` is deleted, all Worker code reads projects from D1, and `pnpm test` passes.

### Phase 3: Admin API Endpoints & CLI Shell Scripts (Import & Reset) [STATUS: TODO]
- Goal: Expose admin API routes for importing/listing/resetting projects and destroying droplets by ID, plus shell scripts for importing `projects.json` and resetting the `projects` table.
- Tasks:
  - [ ] Add `ActionType` enum members in `src/types.ts` (e.g., `IMPORT_PROJECTS = 'IMPORT_PROJECTS'`, `RESET_PROJECTS = 'RESET_PROJECTS'`, `DESTROY_DROPLET = 'DESTROY_DROPLET'`).
  - [ ] In `src/index.ts`, add Admin Key protected endpoints:
    - `GET /api/admin/projects` — returns full stored projects from D1 (unsanitized, for admin view).
    - `POST /api/admin/projects/import` — accepts raw JSON array or `{ projects: ... }`, runs `importProjectsToDb(env, body)`, logs action to `action_logs`, and returns `{ message, count, projects }` (or `400` with validation error details).
    - `POST /api/admin/projects/reset` — runs `resetProjectsTable(env)`, logs action, and returns `{ message, deletedCount }`.
    - `POST /api/admin/droplets/destroy` (or `DELETE /api/admin/droplets/:id`) — accepts `{ dropletId: number }`, calls `doService.deleteDroplet(dropletId)`, resets any matching `project_demos` row where `droplet_id = ?1` to `STOPPED`, logs action, and returns `{ message, dropletId }`.
  - [ ] Create `./dev-import-projects.sh` — reads `./projects.json` (or file path arg) and POSTs to `/api/admin/projects/import` (or supports `--local`/`--remote` via API / D1).
  - [ ] Create `./dev-reset-projects.sh` — clears the `projects` table via `/api/admin/projects/reset` (or `wrangler d1 execute mydb --command="DELETE FROM projects;"`) while preserving `project_demos` and created droplets.
  - [ ] Write unit/integration tests in `test/index.spec.ts` covering: valid/invalid project import, secret field preservation in DB vs public sanitization in `GET /api/projects`, resetting projects table while keeping `project_demos` droplet records intact, and destroying a droplet by ID via `/api/admin/droplets/destroy`.
- Done when: `pnpm test` passes and `./dev-import-projects.sh` / `./dev-reset-projects.sh` work against local dev.

### Phase 4: Admin Page for Viewing & Destroying Created Droplets [STATUS: TODO]
- Goal: Add `/admin/droplets` (`public/admin/droplets.html` + `public/admin/droplets.js`) to list all droplets from the DigitalOcean API and destroy any droplet.
- Tasks:
  - [ ] Create `public/admin/droplets.html` and `public/admin/droplets.js` using `public/main.css` and `<admin-nav></admin-nav>`:
    - Fetches `GET /api/admin/droplets` with `x-admin-key`.
    - Displays table columns: Droplet ID, Status, Public IP, Tags (rendered as `.code-pill`), Linked Project (matched from tags or `project_demos`), and Action (`Destroy` button).
    - Clicking `Destroy` confirms with the admin, calls `POST /api/admin/droplets/destroy` with `{ dropletId }`, shows status feedback, and refreshes the table.
  - [ ] Add friendly redirect `/admin/droplets` -> `/admin/droplets.html` in `src/index.ts`.
  - [ ] Update `public/admin/navbar.js` to include the `Droplets` link.
- Done when: Navigating to `/admin/droplets` lists droplets from `GET /api/admin/droplets` and destroys a droplet on click; `pnpm test` passes.

### Phase 5: Admin Page for Importing `projects.json` to DB [STATUS: TODO]
- Goal: Add `/admin/import_projects` (`public/admin/import_projects.html` + `public/admin/import_projects.js`) to paste and import `projects.json` with validation and view/reset current DB projects.
- Tasks:
  - [ ] Create `public/admin/import_projects.html` and `public/admin/import_projects.js` using `public/main.css` and `<admin-nav></admin-nav>`:
    - Textarea for pasting `projects.json` content, `Import Projects` submit button, and `Reset Projects Table` button.
    - Displays server-side validation error message in red or success message in green upon import.
    - Displays a table of currently stored projects fetched from `GET /api/admin/projects` (ID, Name, Repo URL, Branch, App Port, Healthcheck, Size, Firewall Ports, Raw JSON / extra fields), reloading automatically after import or reset.
  - [ ] Add friendly redirect `/admin/import_projects` -> `/admin/import_projects.html` in `src/index.ts`.
  - [ ] Update `public/admin/navbar.js` to include the `Import Projects` link.
  - [ ] Update `TODO.md` (tick L49-L60) and `README.md` with instructions for `projects.template.json` -> `projects.json` and the new scripts/admin pages.
- Done when: Pasting valid JSON into `/admin/import_projects` saves to D1, shows success message, and reloads the projects table; invalid JSON/fields show server validation errors; `pnpm test` passes.

## Unknowns, Risks, Assumptions

- **Storage format**: The `projects` table stores `id TEXT PRIMARY KEY`, `data TEXT NOT NULL` (full serialized JSON object including any custom/secret fields), and `updated_at INTEGER NOT NULL`.
- **Public sanitization**: `GET /api/projects` strips unknown/secret properties and returns only public fields needed by the frontend (`id`, `name`, `repoUrl`, `branch`, `healthcheckPort`, `healthcheckPath`, `appPort`, `size`, `firewallPorts`), while `GET /api/admin/projects` and internal launch logic have access to the full stored JSON object.
- **Reset behavior**: Resetting the `projects` table (`DELETE FROM projects`) does not touch `project_demos` or DigitalOcean droplets. `POST /api/admin/stop` and `POST /api/admin/droplets/destroy` work even if the project was removed from `projects`, allowing admins to clean up droplets created prior to the reset.

