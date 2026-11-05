import { connect } from 'cloudflare:sockets';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Polls http://<ip>:<port><path> until it returns a 2xx response or the timeout elapses.
 *
 * @param ip          Droplet public IP.
 * @param port        Port the app listens on (projects.json `healthcheckPort`).
 * @param path        Health endpoint path (projects.json `healthcheckPath`).
 * @param timeoutMs   Total time to keep retrying.
 * @param intervalMs  Delay between attempts.
 * @returns true if healthy before the timeout, false otherwise.
 *
 * @example
 * ```ts
 * const ok = await waitForHealthy('1.2.3.4', '80', '/healthz');
 * ```
 */
export async function waitForHealthyFetch(
	ip: string,
	port: string,
	path: string,
	timeoutMs = 5 * 60_000, // 5 minutes
	intervalMs = 5_000, // 5 seconds
): Promise<boolean> {
	const url = `http://${ip}:${port}${path.startsWith('/') ? path : `/${path}`}`;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, {
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) demo-launcher-healthcheck',
					'Accept': '*/*',
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (res.ok) return true;
			const bodySnippet = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
			console.log(`[DO] Health check ${url} returned status ${res.status} (${bodySnippet}); retrying...`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`[DO] Health check ${url} pending: ${msg}; retrying...`);
		}

		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}

	return false;
}

type SocketConnection = ReturnType<typeof connect>;

/**
 * Performs a TCP socket probe against a target IP and port to determine if the service is accepting connections.
 *
 * @param ip - Target droplet public IPv4 address
 * @param port - Application port string or number
 * @param _path - Unused in TCP probing, retained for signature compatibility with HTTP checks
 * @param timeoutMs - Maximum milliseconds to wait for TCP connection establishment (defaults to 4000ms)
 * @returns Object indicating whether the TCP port is reachable and healthy
 *
 * @example
 * ```ts
 * const result = await checkHealthSocket('168.144.254.91', '8080');
 * if (result.healthy) {
 *     // TCP port is accepting connections
 * }
 * ```
 */
export async function checkHealthSocket(
	ip: string,
	port: string | number,
	_path = '/',
	timeoutMs = 4_000,
): Promise<{ healthy: boolean; status?: number; error?: string }> {
	const portNum = typeof port === 'number' ? port : Number.parseInt(port, 10);
	if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) {
		return { healthy: false, error: `Invalid port: ${port}` };
	}

	let socket: SocketConnection | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		socket = connect({ hostname: ip, port: portNum });
		const openedPromise = socket.opened;
		openedPromise.catch(() => { });

		await Promise.race([
			openedPromise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`TCP probe timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);

		return { healthy: true, status: 200 };
	} catch (err) {
		return {
			healthy: false,
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		if (socket) {
			try {
				await socket.close();
			} catch {
				// Socket may already be closed or rejected during connection failure
			}
		}
	}
}
