# Demo Launcher

Demo Launcher is a Cloudflare Worker application for showcasing projects by starting temporary DigitalOcean droplets on demand. The Worker serves a small web interface, queues launch requests with Cloudflare Queues, stores demo status in D1, and creates or deletes droplets through the DigitalOcean API.

Each demo is stopped after one hour. A scheduled Worker runs every five minutes, so cleanup can happen up to about five minutes after that limit.

## Requirements

- Node.js and pnpm
- A Cloudflare account with Workers, Queues, and D1 enabled
- Wrangler authenticated to that account (`npx wrangler login`)
- A DigitalOcean account and API token for deployed demos
- `jq` if using the included local test scripts

## Configure Projects

Edit [`src/projects.json`](src/projects.json) and replace the example GitHub URLs with the repositories you want to showcase. The repositories must be publicly cloneable by a new droplet. At startup, the droplet clones the repository and runs `demo-launcher-entrypoint.sh` from its root if present; otherwise, it serves a basic placeholder page with Nginx.

## Set Up Cloudflare

Install dependencies and create the remote queue and D1 database, then apply the schema:

```sh
pnpm install
bash ./dev-setup.sh
```

`dev-setup.sh` creates the `demo-launcher-queue` queue and the `mydb` D1 database, applies [`schema.sql`](schema.sql), and verifies the `project_demos` table. It does not create the dead-letter queue referenced by the Worker configuration. Create that queue once as well:

```sh
npx wrangler queues create my-queue-dlq
```

The script prints the new D1 database ID. Update the `database_id` for `mydb` in [`wrangler.jsonc`](wrangler.jsonc) to that ID before deploying. The checked-in ID may belong to a different Cloudflare account.

## Deploy

For real DigitalOcean provisioning, set `ENVIRONMENT` to `production` in the top-level `vars` section of `wrangler.jsonc` (uncomment or add the section):

```jsonc
"vars": {
	"ENVIRONMENT": "production"
}
```

Deploy the Worker and static assets:

```sh
bash ./dev-deploy.sh
```

After the first deployment, add the DigitalOcean API token as a Worker secret:

```sh
npx wrangler secret put DO_API_KEY
```

This default configuration deploys to Wrangler's default environment. The included `dev-set-do-key.sh` targets a separate Wrangler environment named `production`, which is not configured in `wrangler.jsonc`.

The production service currently creates Ubuntu 24.04 droplets in DigitalOcean region `sgp1` using size `s-1vcpu-1gb`. Adjust these values in [`src/digitalocean.prod.ts`](src/digitalocean.prod.ts) if needed. DigitalOcean account limits and billing apply.

## Run Locally

Local Wrangler development uses a mock DigitalOcean service unless `ENVIRONMENT` is set to `production`:

```sh
npx wrangler d1 execute mydb --local --file=./schema.sql
pnpm dev
```

Open `http://localhost:8787`. Local launch requests use mock droplets and do not require a DigitalOcean token. The included `dev-manually-test.sh` runs a local end-to-end check; it requires `jq` and initializes the local D1 database itself.

## Use the App

Open the deployed Worker URL to browse the configured projects and request a demo. The Worker also exposes:

- `GET /api/projects` returns projects and current demo statuses.
- `POST /api/launch` accepts JSON such as `{"projectId":"awesome-shop-demo"}` and queues a launch request.
- `GET /api/cron-cleanup` manually runs cleanup only in development. An optional `maxDemoTimeSeconds` query parameter sets the expiration threshold for testing.

The launch endpoint responds with `202 Accepted`; provisioning continues asynchronously in the queue. The UI polls project status until the droplet IP is available. Demos are publicly reachable at their droplet IP, so only add repositories suitable for public demonstration.
