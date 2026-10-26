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
export async function waitForHealthy(
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
			const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
			if (res.ok) return true;
			console.log(`[DO] Health check ${url} returned status ${res.status}; retrying...`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`[DO] Health check ${url} pending: ${msg}; retrying...`);
		}

		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}

	return false;
}
