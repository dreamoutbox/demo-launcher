import projects from './projects.json';
import { getDigitalOceanService, isDevelopment } from './digitalocean';
import { Env, QueueMessage } from './types';
export { ProjectLauncher } from './launcher';

const MAX_DEMO_TIME = 60 * 60 * 1000; // 1 hour in milliseconds

/**
 * Formats milliseconds into human-readable uptime (e.g., "1h 12m 5s" or "4s")
 */
function formatUptime(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
	parts.push(`${seconds}s`);
	return parts.join(' ');
}

/**
 * Reusable cleanup function for both Scheduled CRON and manual testing
 */
export async function cleanupExpiredDemos(
	env: Env,
	maxDemoTimeMs: number = MAX_DEMO_TIME,
	requestUrl?: string,
): Promise<{ cleanedUp: string[]; maxDemoTimeMs: number }> {
	console.log(`[CRON] Checking for expired demo droplets (maxDemoTime: ${maxDemoTimeMs}ms)...`);
	const doService = getDigitalOceanService(env, requestUrl);
	const expirationThreshold = Date.now() - maxDemoTimeMs;

	const { results } = await env.mydb
		.prepare(
			`SELECT project_id, droplet_id
             FROM project_demos
             WHERE status = 'RUNNING' AND launched_at <= ?1`,
		)
		.bind(expirationThreshold)
		.all<{ project_id: string; droplet_id: number | null }>();

	const cleanedUp: string[] = [];

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

			cleanedUp.push(row.project_id);
			console.log(`[CRON] Cleaned up expired demo "${row.project_id}" (Droplet ID: ${row.droplet_id})`);
		} catch (err) {
			console.error(`[CRON] Failed to clean up demo "${row.project_id}":`, err);
		}
	}

	return { cleanedUp, maxDemoTimeMs };
}

export default {
	async fetch(req, env, ctx): Promise<Response> {
		const url = new URL(req.url);
		const { pathname, searchParams } = url;

		if (pathname === '/api/beverages') {
			const { results } = await env.mydb.prepare('SELECT * FROM Customers WHERE CompanyName = ?').bind('Bs Beverages').run();
			return Response.json(results);
		}

		// GET /api/projects -> List available projects and their current live demo status + uptime
		if (pathname === '/api/projects' && req.method === 'GET') {
			const now = Date.now();
			const { results } = await env.mydb.prepare('SELECT * FROM project_demos').all<{
				project_id: string;
				status: string;
				droplet_id: number | null;
				droplet_ip: string | null;
				launched_at: number | null;
			}>();

			const statusesWithUptime = results.map((row) => {
				const isRunning = row.status === 'RUNNING' && row.launched_at !== null;
				const uptimeMs = isRunning ? Math.max(0, now - row.launched_at!) : null;

				return {
					...row,
					uptime_ms: uptimeMs,
					uptime_seconds: uptimeMs !== null ? Math.floor(uptimeMs / 1000) : null,
					uptime_human: uptimeMs !== null ? formatUptime(uptimeMs) : null,
				};
			});

			return Response.json({
				projects,
				statuses: statusesWithUptime,
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
			await env.DEMO_LAUNCHER_QUEUE.send({ projectId: project.id });

			return Response.json(
				{
					message: `Launch request queued for ${project.name}`,
					projectId: project.id,
				},
				{ status: 202 },
			);
		}

		// GET or POST /api/cron-cleanup -> Manually trigger cleanup with custom max demo time (Dev only)
		if (pathname === '/api/cron-cleanup') {
			if (!isDevelopment(env, req.url)) {
				return Response.json({ error: 'Manual cron trigger is only allowed in development' }, { status: 403 });
			}

			// Accept ?maxDemoTimeSeconds=2 or ?maxDemoTimeMs=2000
			const secondsParam = searchParams.get('maxDemoTimeSeconds');
			const msParam = searchParams.get('maxDemoTimeMs');

			let customMaxTimeMs = MAX_DEMO_TIME;
			if (secondsParam !== null && !Number.isNaN(Number(secondsParam))) {
				customMaxTimeMs = Number(secondsParam) * 1000;
			} else if (msParam !== null && !Number.isNaN(Number(msParam))) {
				customMaxTimeMs = Number(msParam);
			}

			const result = await cleanupExpiredDemos(env, customMaxTimeMs, req.url);
			return Response.json({
				message: 'Manual cron cleanup executed',
				...result,
			});
		}

		return new Response('Use GET /api/projects, POST /api/launch, or GET /api/cron-cleanup?maxDemoTimeSeconds=2');
	},

	async queue(batch, env): Promise<void> {
		for (const message of batch.messages) {
			const { projectId } = message.body;

			// Route to a per-project Durable Object to serialize and coordinate launches
			const stub = env.LAUNCHER.get(env.LAUNCHER.idFromName(projectId));

			try {
				await stub.launch(projectId);
				message.ack();
			} catch (err) {
				console.error(`[QUEUE] launch failed for "${projectId}":`, err);
				message.retry();
			}
		}
	},

	async scheduled(controller, env, ctx) {
		await cleanupExpiredDemos(env, MAX_DEMO_TIME);
	},
} satisfies ExportedHandler<Env, QueueMessage>;
