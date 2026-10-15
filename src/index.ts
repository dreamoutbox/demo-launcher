import projects from './projects.json';
import { DigitalOceanMockService } from './digitalocean.mock';
import { DigitalOceanProdService } from './digitalocean.prod';
import { Env, IDigitalOceanService, QueueMessage } from './types';

const MAX_DEMO_TIME = 60 * 60 * 1000; // 1 hour in milliseconds

// In-memory mutex lock to serialize access within the same Worker isolate
class Mutex {
	private queue: Promise<void> = Promise.resolve();

	async lock(): Promise<() => void> {
		let unlockNext!: () => void;
		const nextLock = new Promise<void>((resolve) => {
			unlockNext = resolve;
		});
		const willWait = this.queue;
		this.queue = this.queue.then(() => nextLock);
		await willWait;
		return unlockNext;
	}
}

const workerMutex = new Mutex();

/**
 * Factory that detects local `npx wrangler dev` vs production deployment
 */
function getDigitalOceanService(env: Env, requestUrl?: string): IDigitalOceanService {
	const isLocalHost = requestUrl ? ['localhost', '127.0.0.1'].includes(new URL(requestUrl).hostname) : false;
	const isDev = env.ENVIRONMENT !== 'production' || isLocalHost;

	if (isDev) {
		return new DigitalOceanMockService(env.DO_API_KEY);
	}
	return new DigitalOceanProdService(env.DO_API_KEY);
}

export default {
	async fetch(req, env, ctx): Promise<Response> {
		const { pathname } = new URL(req.url);

		if (pathname === '/api/beverages') {
			// If you did not use `DB` as your binding name, change it here
			const { results } = await env.mydb.prepare('SELECT * FROM Customers WHERE CompanyName = ?').bind('Bs Beverages').run();
			return Response.json(results);
		}

		// GET /api/projects -> List available projects and their current live demo status
		if (pathname === '/api/projects' && req.method === 'GET') {
			const { results } = await env.mydb.prepare('SELECT * FROM project_demos').all();
			return Response.json({
				projects,
				statuses: results,
			});
		}

		// POST /api/launch -> Triggered when user clicks a project launch button
		if (pathname === '/api/launch' && req.method === 'POST') {
			const body = (await req.json().catch(() => null)) as { projectId?: string } | null;
			const projectId = body?.projectId;

			const project = projects.find((p) => p.id === projectId);
			if (!project) {
				return Response.json({ error: 'Invalid or unknown projectId' }, { status: 400 });
			}

			// Enqueue launch job
			await env.MY_QUEUE.send({ projectId: project.id });

			return Response.json(
				{
					message: `Launch request queued for ${project.name}`,
					projectId: project.id,
				},
				{ status: 202 },
			);
		}

		return new Response('Use GET /api/projects or POST /api/launch to manage demos.');
	},

	async queue(batch, env): Promise<void> {
		const doService = getDigitalOceanService(env);

		for (let message of batch.messages) {
			const { projectId } = message.body;
			const project = projects.find((p) => p.id === projectId);

			if (!project) {
				console.error(`[QUEUE] Project "${projectId}" not found in src/projects.json. Skipping.`);
				message.ack();
				continue;
			}

			// Acquire isolate mutex lock to prevent concurrent processing in the same Worker
			const unlock = await workerMutex.lock();

			try {
				const now = Date.now();

				// Atomic check-and-set in D1 to prevent race conditions across distributed isolates:
				// Only transitions to 'LAUNCHING' if row doesn't exist OR is currently 'STOPPED'/'FAILED'.
				const lockResult = await env.mydb
					.prepare(
						`INSERT INTO project_demos (project_id, status, launched_at)
                         VALUES (?1, 'LAUNCHING', ?2)
                         ON CONFLICT(project_id) DO UPDATE
                         SET status = 'LAUNCHING', launched_at = ?2
                         WHERE project_demos.status IN ('STOPPED', 'FAILED')`,
					)
					.bind(project.id, now)
					.run();

				if (lockResult.meta.changes === 0) {
					console.log(`[QUEUE] Project "${project.id}" is already LAUNCHING or RUNNING. Skipping.`);
					message.ack();
					continue;
				}

				console.log(`[QUEUE] Launching DigitalOcean droplet for "${project.id}"...`);
				const droplet = await doService.createDroplet(project.id, project.repoUrl);

				// Store droplet ID, IP, and timestamp for cleanup later
				await env.mydb
					.prepare(
						`UPDATE project_demos
                         SET status = 'RUNNING', droplet_id = ?1, droplet_ip = ?2, launched_at = ?3
                         WHERE project_id = ?4`,
					)
					.bind(droplet.id, droplet.ip, Date.now(), project.id)
					.run();

				console.log(`[QUEUE] Project "${project.id}" is RUNNING at IP ${droplet.ip} (Droplet ID: ${droplet.id})`);
				message.ack();
			} catch (err) {
				console.error(`[QUEUE] Failed to launch project "${project.id}":`, err);
				// Mark as FAILED so a future click can retry
				await env.mydb.prepare(`UPDATE project_demos SET status = 'FAILED' WHERE project_id = ?1`).bind(project.id).run();
				message.retry();
			} finally {
				unlock();
			}
		}
	},

	async scheduled(controller, env, ctx) {
		console.log('[CRON] Checking for expired demo droplets...');
		const doService = getDigitalOceanService(env);
		const expirationThreshold = Date.now() - MAX_DEMO_TIME;

		// Find all running demos that have exceeded MAX_DEMO_TIME (1 hour)
		const { results } = await env.mydb
			.prepare(
				`SELECT project_id, droplet_id
                 FROM project_demos
                 WHERE status = 'RUNNING' AND launched_at <= ?1`,
			)
			.bind(expirationThreshold)
			.all<{ project_id: string; droplet_id: number | null }>();

		for (const row of results) {
			try {
				if (row.droplet_id) {
					await doService.deleteDroplet(row.droplet_id);
				}

				await env.mydb
					.prepare(
						`UPDATE project_demos
                         SET status = 'STOPPED', droplet_id = NULL, droplet_ip = NULL, launched_at = NULL
                         WHERE project_id = ?1`,
					)
					.bind(row.project_id)
					.run();

				console.log(`[CRON] Cleaned up expired demo "${row.project_id}" (Droplet ID: ${row.droplet_id})`);
			} catch (err) {
				console.error(`[CRON] Failed to clean up demo "${row.project_id}":`, err);
			}
		}
	},
} satisfies ExportedHandler<Env, QueueMessage>;
