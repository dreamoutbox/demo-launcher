import { ActionLogRecord, ActionStatus, ActionType, Env } from './types';

export interface CreateActionLogParams {
	action: ActionType;
	projectId: string | null;
	ipAddress: string | null;
	country: string | null;
	userAgent: string | null;
	status: ActionStatus;
	details?: string | null;
	createdAt?: number;
}

export interface GetActionLogsOptions {
	limit?: number;
	offset?: number;
	projectId?: string;
}

export interface GetActionLogsResponse {
	logs: ActionLogRecord[];
	total: number;
	limit: number;
	offset: number;
}

/**
 * Extracts client metadata (IP address, country code, and user-agent) from an incoming HTTP request.
 *
 * @param req - The incoming HTTP Request object
 * @returns An object containing ipAddress, country, and userAgent
 *
 * @example
 * ```ts
 * const { ipAddress, country, userAgent } = extractClientInfo(req);
 * ```
 */
export function extractClientInfo(req: Request): {
	ipAddress: string | null;
	country: string | null;
	userAgent: string | null;
} {
	const ipAddress =
		req.headers.get('CF-Connecting-IP') ||
		req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
		req.headers.get('x-real-ip') ||
		null;
	const country = req.headers.get('CF-IPCountry') || null;
	const userAgent = req.headers.get('User-Agent') || null;

	return { ipAddress, country, userAgent };
}

/**
 * Checks whether the incoming request supplies a valid admin key matching the configured ADMIN_KEY.
 * Inspects Authorization header (Bearer token or raw key), 'x-admin-key' header, and URL query params ('admin_key' or 'key').
 *
 * @param req - The incoming HTTP Request object
 * @param env - Cloudflare Worker environment containing ADMIN_KEY
 * @returns True if authorized, false otherwise
 *
 * @example
 * ```ts
 * if (!isAdminAuthorized(req, env)) {
 *     return Response.json({ error: 'Unauthorized' }, { status: 401 });
 * }
 * ```
 */
export function isAdminAuthorized(req: Request, env: Env): boolean {
	const configuredKey = env.ADMIN_KEY;
	if (!configuredKey || configuredKey.trim() === '') {
		return false;
	}

	const authHeader = req.headers.get('Authorization');
	if (authHeader) {
		const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
		if (bearerMatch && bearerMatch[1].trim() === configuredKey) {
			return true;
		}
		if (authHeader.trim() === configuredKey) {
			return true;
		}
	}

	const customHeader = req.headers.get('x-admin-key');
	if (customHeader && customHeader.trim() === configuredKey) {
		return true;
	}

	const url = new URL(req.url);
	const queryKey = url.searchParams.get('admin_key') || url.searchParams.get('key');
	if (queryKey && queryKey.trim() === configuredKey) {
		return true;
	}

	return false;
}

/**
 * Inserts a new audit log record into the D1 `action_logs` table.
 *
 * @param env - Cloudflare Worker environment containing D1 database mydb
 * @param entry - The audit record data to insert
 * @returns Resolves when the record is saved to the database
 *
 * @example
 * ```ts
 * await recordActionLog(env, {
 *     action: ActionType.LAUNCH_DEMO,
 *     projectId: 'shop-demo',
 *     ipAddress: '198.51.100.1',
 *     country: 'US',
 *     userAgent: 'Mozilla/5.0...',
 *     status: ActionStatus.QUEUED,
 *     details: 'Queued to launch'
 * });
 * ```
 */
export async function recordActionLog(env: Env, entry: CreateActionLogParams): Promise<void> {
	try {
		const timestamp = entry.createdAt ?? Date.now();
		await env.mydb
			.prepare(
				`INSERT INTO action_logs (action, project_id, ip_address, country, user_agent, status, details, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
			)
			.bind(
				entry.action,
				entry.projectId,
				entry.ipAddress,
				entry.country,
				entry.userAgent,
				entry.status,
				entry.details ?? null,
				timestamp,
			)
			.run();
	} catch (err) {
		console.error('[ACTION-LOG] Failed to record action log:', err);
	}
}

/**
 * Retrieves paginated audit action logs from the D1 database, optionally filtered by project ID.
 *
 * @param env - Cloudflare Worker environment containing D1 database mydb
 * @param options - Pagination and filter criteria (limit, offset, projectId)
 * @returns An object containing the logs list, total matching record count, limit, and offset
 *
 * @example
 * ```ts
 * const result = await getActionLogs(env, { limit: 50, offset: 0, projectId: 'shop-demo' });
 * console.log(`Fetched ${result.logs.length} of ${result.total}`);
 * ```
 */
export async function getActionLogs(
	env: Env,
	options: GetActionLogsOptions = {},
): Promise<GetActionLogsResponse> {
	const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
	const offset = Math.max(0, options.offset ?? 0);
	const projectId = options.projectId;

	if (projectId) {
		const countResult = await env.mydb
			.prepare('SELECT COUNT(*) as total FROM action_logs WHERE project_id = ?1')
			.bind(projectId)
			.first<{ total: number }>();

		const { results } = await env.mydb
			.prepare(
				`SELECT id, action, project_id, ip_address, country, user_agent, status, details, created_at
                 FROM action_logs
                 WHERE project_id = ?1
                 ORDER BY created_at DESC
                 LIMIT ?2 OFFSET ?3`,
			)
			.bind(projectId, limit, offset)
			.all<ActionLogRecord>();

		return {
			logs: results,
			total: countResult?.total ?? 0,
			limit,
			offset,
		};
	}

	const countResult = await env.mydb
		.prepare('SELECT COUNT(*) as total FROM action_logs')
		.first<{ total: number }>();

	const { results } = await env.mydb
		.prepare(
			`SELECT id, action, project_id, ip_address, country, user_agent, status, details, created_at
             FROM action_logs
             ORDER BY created_at DESC
             LIMIT ?1 OFFSET ?2`,
		)
		.bind(limit, offset)
		.all<ActionLogRecord>();

	return {
		logs: results,
		total: countResult?.total ?? 0,
		limit,
		offset,
	};
}
