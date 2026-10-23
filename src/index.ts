import projects from './projects.json';
import { getDigitalOceanService } from './digitalocean';
import { formatUptime, getMaxDemoTimeMs, isDevelopment } from './helper';
import { ActionStatus, ActionType, DemoStatus, Env, LaunchPhase, QueueMessage } from './types';
import { verifyTurnstileToken, TurnstileStatus } from './turnstile';
import { extractClientInfo, getActionLogs, isAdminAuthorized, recordActionLog } from './action-log';
import { evaluateLaunchSchedule } from './time-range';
export { ProjectLauncher } from './launcher';


/**
 * Deletes the droplet (if any) and resets the project's demo row to STOPPED.
 *
 * @param env - Worker environment
 * @param doService - DigitalOcean service used to delete the droplet
 * @param projectId - Project whose demo is stopped
 * @param dropletId - Droplet to delete, or null if none was created yet
 *
 * @example
 * await stopDemo(env, getDigitalOceanService(env, req.url), 'go-pos', 123);
 */
async function stopDemo(env: Env, doService: ReturnType<typeof getDigitalOceanService>, projectId: string, dropletId: number | null): Promise<void> {
	if (dropletId) {
		await doService.deleteDroplet(dropletId);
	} else {
		// An interrupted launch may have created a droplet before saving its id.
		const droplets = await doService.listDroplets();
		for (const droplet of droplets.filter((candidate) => candidate.tags.includes(projectId))) {
			await doService.deleteDroplet(droplet.id);
		}
	}

	await env.mydb
		.prepare(
			`UPDATE project_demos
             SET status = 'STOPPED', droplet_id = NULL, droplet_ip = NULL, tags = NULL, launched_at = NULL,
                 attempt_id = NULL
             WHERE project_id = ?1
			`,
		)
		.bind(projectId)
		.run();
}

/**
 * Reusable cleanup function for both Scheduled CRON and manual testing
 */
export async function cleanupExpiredDemos(
	env: Env,
	maxDemoTimeMs: number = getMaxDemoTimeMs(env),
	requestUrl?: string,
): Promise<{ cleanedUp: string[]; maxDemoTimeMs: number }> {
	console.log(`[CRON] Checking for expired demo droplets (maxDemoTime: ${maxDemoTimeMs}ms)...`);
	const doService = getDigitalOceanService(env, requestUrl);
	const now = Date.now();
	const expirationThreshold = now - maxDemoTimeMs;

	const { results } = await env.mydb
		.prepare(
			`SELECT project_id, droplet_id
             FROM project_demos
             WHERE status = 'RUNNING' AND launched_at <= ?1
			`,
		)
		.bind(expirationThreshold)
		.all<{ project_id: string; droplet_id: number | null }>();

	const cleanedUp: string[] = [];

	for (const row of results) {
		try {
			await stopDemo(env, doService, row.project_id, row.droplet_id);

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
			const { results } = await env.mydb.prepare('SELECT * FROM Customers WHERE CompanyName = ?')
				.bind('Bs Beverages')
				.run();
			return Response.json(results);
		}

		// GET /api/projects -> List available projects and their current live demo status + uptime
		if (pathname === '/api/projects' && req.method === 'GET') {
			const now = Date.now();
			const { results } = await env.mydb.prepare('SELECT * FROM project_demos').all<{
				project_id: string;
				status: DemoStatus;
				droplet_id: number | null;
				droplet_ip: string | null;
				tags: string | null;
				launched_at: number | null;
			}>();

			const statusesWithUptime = results.map((row) => {
				const isRunning = row.status === DemoStatus.RUNNING && row.launched_at !== null;
				const uptimeMs = isRunning ? Math.max(0, now - row.launched_at!) : null;

				const appPort = projects.find((p) => p.id === row.project_id)?.appPort ?? null;

				return {
					...row,
					app_port: appPort,
					uptime_ms: uptimeMs,
					uptime_seconds: uptimeMs !== null ? Math.floor(uptimeMs / 1000) : null,
					uptime_human: uptimeMs !== null ? formatUptime(uptimeMs) : null,
				};
			});

			return Response.json({
				projects,
				statuses: statusesWithUptime,
				maxDemoTimeSeconds: getMaxDemoTimeMs(env) / 1000,
				turnstileSiteKey: env.TURNSTILE_SITE_KEY || '1x00000000000000000000AA',
			});
		}

		// POST /api/launch -> Triggered when user clicks a project launch button
		if (pathname === '/api/launch' && req.method === 'POST') {
			const clientInfo = extractClientInfo(req);
			const body = (await req.json().catch(() => null)) as {
				projectId?: string;
				turnstileToken?: string;
				'cf-turnstile-response'?: string;
			} | null;

			// Check if launch is permitted within the configured time range schedule
			const scheduleEval = evaluateLaunchSchedule(env.LAUNCH_ALLOW_TIME_RANGE, new Date(), env.LAUNCH_TIMEZONE);
			if (!scheduleEval.allowed) {
				const errorMsg = 'Launch requests are outside the allowed time schedule';

				await recordActionLog(env, {
					action: ActionType.LAUNCH_DEMO,
					projectId: body?.projectId ?? null,
					ipAddress: clientInfo.ipAddress,
					country: clientInfo.country,
					userAgent: clientInfo.userAgent,
					status: ActionStatus.REJECTED,
					details: JSON.stringify({
						error: errorMsg,
						allowedRanges: env.LAUNCH_ALLOW_TIME_RANGE,
					}),
				});

				return Response.json(
					{
						error: errorMsg,
						allowedRanges: env.LAUNCH_ALLOW_TIME_RANGE,
					},
					{ status: 403 },
				);
			}

			const token = body?.turnstileToken || body?.['cf-turnstile-response'];
			const clientIp = clientInfo.ipAddress ?? undefined;
			const verification = await verifyTurnstileToken(token, env, clientIp);

			if (!verification.success) {
				const isMissing = verification.status === TurnstileStatus.MISSING_TOKEN;
				const errorMsg = isMissing ? 'Turnstile token is required' : 'Turnstile verification failed';

				await recordActionLog(env, {
					action: ActionType.LAUNCH_DEMO,
					projectId: body?.projectId ?? null,
					ipAddress: clientInfo.ipAddress,
					country: clientInfo.country,
					userAgent: clientInfo.userAgent,
					status: ActionStatus.REJECTED,
					details: JSON.stringify({
						error: errorMsg,
						turnstileStatus: verification.status,
						errorCodes: verification.errorCodes,
					}),
				});

				return Response.json(
					{
						error: errorMsg,
						status: verification.status,
						errorCodes: verification.errorCodes,
					},
					{ status: isMissing ? 400 : 403 },
				);
			}

			const projectId = body?.projectId;
			const project = projects.find((p) => p.id === projectId);
			if (!project) {
				await recordActionLog(env, {
					action: ActionType.LAUNCH_DEMO,
					projectId: projectId ?? null,
					ipAddress: clientInfo.ipAddress,
					country: clientInfo.country,
					userAgent: clientInfo.userAgent,
					status: ActionStatus.REJECTED,
					details: JSON.stringify({ error: 'Invalid or unknown projectId' }),
				});

				return Response.json({ error: 'Invalid or unknown projectId' }, { status: 400 });
			}

			// Enqueue launch job
			await env.DEMO_LAUNCHER_QUEUE.send({ projectId: project.id, phase: LaunchPhase.CREATE });

			await recordActionLog(env, {
				action: ActionType.LAUNCH_DEMO,
				projectId: project.id,
				ipAddress: clientInfo.ipAddress,
				country: clientInfo.country,
				userAgent: clientInfo.userAgent,
				status: ActionStatus.QUEUED,
				details: JSON.stringify({ message: `Launch request queued for ${project.name}` }),
			});

			return Response.json(
				{
					message: `Launch request queued for ${project.name}`,
					projectId: project.id,
				},
				{ status: 202 },
			);
		}

		// POST /api/admin/stop {projectId} -> Force stop: delete droplet and reset state (Admin Key protected)
		if (pathname === '/api/admin/stop' && req.method === 'POST') {
			if (!isAdminAuthorized(req, env)) {
				return Response.json({ error: 'Unauthorized: invalid or missing admin key' }, { status: 401 });
			}

			const clientInfo = extractClientInfo(req);
			const body = (await req.json().catch(() => null)) as { projectId?: string } | null;
			const projectId = body?.projectId;

			if (!projectId || !projects.some((p) => p.id === projectId)) {
				return Response.json({ error: 'Invalid or unknown projectId' }, { status: 400 });
			}

			const row = await env.mydb
				.prepare('SELECT droplet_id FROM project_demos WHERE project_id = ?1')
				.bind(projectId)
				.first<{ droplet_id: number | null }>();

			try {
				await stopDemo(env, getDigitalOceanService(env, req.url), projectId, row?.droplet_id ?? null);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				await recordActionLog(env, {
					action: ActionType.STOP_DEMO,
					projectId,
					ipAddress: clientInfo.ipAddress,
					country: clientInfo.country,
					userAgent: clientInfo.userAgent,
					status: ActionStatus.FAILED,
					details: JSON.stringify({ error: message }),
				});
				return Response.json({ error: `Force stop failed: ${message}` }, { status: 500 });
			}

			await recordActionLog(env, {
				action: ActionType.STOP_DEMO,
				projectId,
				ipAddress: clientInfo.ipAddress,
				country: clientInfo.country,
				userAgent: clientInfo.userAgent,
				status: ActionStatus.SUCCESS,
				details: JSON.stringify({ dropletId: row?.droplet_id ?? null }),
			});

			return Response.json({ message: `Force stopped ${projectId}`, projectId, dropletId: row?.droplet_id ?? null });
		}

		// GET /api/admin/droplets -> List all droplets in the DigitalOcean account (Admin Key protected)
		if (pathname === '/api/admin/droplets' && req.method === 'GET') {
			if (!isAdminAuthorized(req, env)) {
				return Response.json({ error: 'Unauthorized: invalid or missing admin key' }, { status: 401 });
			}

			try {
				const droplets = await getDigitalOceanService(env, req.url).listDroplets();
				return Response.json({ droplets, count: droplets.length });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return Response.json({ error: `Failed to list droplets: ${message}` }, { status: 500 });
			}
		}

		// GET /api/admin/action-logs or /api/action-logs -> Retrieve audit logs (Admin Key protected)
		if ((pathname === '/api/admin/action-logs' || pathname === '/api/action-logs') && req.method === 'GET') {
			if (!isAdminAuthorized(req, env)) {
				return Response.json(
					{ error: 'Unauthorized: invalid or missing admin key' },
					{ status: 401 },
				);
			}

			const limitParam = searchParams.get('limit');
			const offsetParam = searchParams.get('offset');
			const projectId = searchParams.get('projectId') || undefined;

			const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10) || 50), 500) : 50;
			const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10) || 0) : 0;

			const result = await getActionLogs(env, { limit, offset, projectId });
			return Response.json(result);
		}

		// GET or POST /api/cron-cleanup -> Manually trigger cleanup with custom max demo time (Dev only)
		if (pathname === '/api/cron-cleanup') {
			if (!isDevelopment(env, req.url)) {
				return Response.json({ error: 'Manual cron trigger is only allowed in development' }, { status: 403 });
			}

			// Accept ?maxDemoTimeSeconds=2 or ?maxDemoTimeMs=2000
			const secondsParam = searchParams.get('maxDemoTimeSeconds');
			const msParam = searchParams.get('maxDemoTimeMs');

			let customMaxTimeMs = getMaxDemoTimeMs(env);
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

		// Friendly redirects for admin pages to their HTML files
		if (pathname === '/admin/login' || pathname === '/admin/login/') {
			return Response.redirect(`${url.origin}/admin/login.html`, 301);
		}
		if (pathname === '/admin/action_log' || pathname === '/admin/action_log/') {
			return Response.redirect(`${url.origin}/admin/action_log.html`, 301);
		}
		if (pathname === '/admin/demo_list' || pathname === '/admin/demo_list/') {
			return Response.redirect(`${url.origin}/admin/demo_list.html`, 301);
		}

		// Serve static assets if ASSETS binding is available
		if (env.ASSETS) {
			const assetRes = await env.ASSETS.fetch(req);
			if (assetRes.status !== 404) {
				return assetRes;
			}
		}

		return new Response('Use GET /api/projects, POST /api/launch, GET /api/admin/action-logs, or GET /api/cron-cleanup?maxDemoTimeSeconds=2');
	},

	async queue(batch, env, ctx): Promise<void> {
		for (const message of batch.messages) {
			const { projectId, phase, attemptId } = message.body;
			const stub = env.LAUNCHER.get(env.LAUNCHER.idFromName(projectId));

			try {
				if (phase === LaunchPhase.POLL_HEALTH) {
					if (!attemptId) {
						console.error(`[QUEUE] poll message for "${projectId}" is missing attemptId. Dropping.`);
						message.ack();
						continue;
					}
					await stub.pollAndHealth(projectId, attemptId);
				} else {
					// Legacy messages have no phase and are treated as CREATE.
					await stub.launch(projectId);
				}
				message.ack();
			} catch (err) {
				console.error(`[QUEUE] ${phase ?? LaunchPhase.CREATE} failed for "${projectId}":`, err);
				message.retry();
			}
		}
	},

	async scheduled(controller, env, ctx) {
		await cleanupExpiredDemos(env);
	},
} satisfies ExportedHandler<Env, QueueMessage>;
