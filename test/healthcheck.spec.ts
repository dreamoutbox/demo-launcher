import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForHealthy } from '../src/healthcheck';
import { checkHealth } from '../src/helper';
import { connect } from 'cloudflare:sockets';

vi.mock('cloudflare:sockets', () => ({
	connect: vi.fn(),
}));

describe('checkHealth TCP probing', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns healthy: false for invalid port numbers', async () => {
		const invalidResult = await checkHealth('1.2.3.4', 'invalid-port');
		expect(invalidResult.healthy).toBe(false);
		expect(invalidResult.error).toContain('Invalid port');

		const zeroResult = await checkHealth('1.2.3.4', 0);
		expect(zeroResult.healthy).toBe(false);
		expect(zeroResult.error).toContain('Invalid port');

		const overflowResult = await checkHealth('1.2.3.4', 70000);
		expect(overflowResult.healthy).toBe(false);
		expect(overflowResult.error).toContain('Invalid port');
	});

	it('returns healthy: true when TCP connection succeeds', async () => {
		const closeMock = vi.fn().mockResolvedValue(undefined);
		vi.mocked(connect).mockReturnValue({
			opened: Promise.resolve({ remoteAddress: '1.2.3.4' }),
			close: closeMock,
		} as any);

		const result = await checkHealth('1.2.3.4', '8080');

		expect(connect).toHaveBeenCalledWith({ hostname: '1.2.3.4', port: 8080 });
		expect(result).toEqual({ healthy: true, status: 200 });
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it('returns healthy: false with error when TCP connection fails', async () => {
		const closeMock = vi.fn().mockResolvedValue(undefined);
		vi.mocked(connect).mockReturnValue({
			opened: Promise.reject(new Error('Connection refused')),
			close: closeMock,
		} as any);

		const result = await checkHealth('1.2.3.4', 8080);

		expect(result.healthy).toBe(false);
		expect(result.error).toContain('Connection refused');
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it('returns healthy: false when TCP connection times out', async () => {
		const closeMock = vi.fn().mockResolvedValue(undefined);
		// Sockets opened promise never resolves
		const openedPromise = new Promise<{ remoteAddress: string }>(() => { });
		vi.mocked(connect).mockReturnValue({
			opened: openedPromise,
			close: closeMock,
		} as any);

		const checkPromise = checkHealth('1.2.3.4', '8080', '/', 2000);
		await vi.advanceTimersByTimeAsync(2001);

		const result = await checkPromise;
		expect(result.healthy).toBe(false);
		expect(result.error).toContain('TCP probe timed out after 2000ms');
		expect(closeMock).toHaveBeenCalledTimes(1);
	});
});

describe('waitForHealthy', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('returns true on first 2xx and builds the url from ip/port/path', async () => {
		const fetchMock = vi.fn(async (_url: string) => new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		expect(await waitForHealthy('1.2.3.4', '80', '/healthz')).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe('http://1.2.3.4:80/healthz');
	});

	it('adds a leading slash to the path when missing', async () => {
		const fetchMock = vi.fn(async (_url: string) => new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		await waitForHealthy('1.2.3.4', '8080', 'healthz');
		expect(fetchMock.mock.calls[0][0]).toBe('http://1.2.3.4:8080/healthz');
	});

	it('retries after network errors and non-2xx until healthy', async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error('ECONNREFUSED'))
			.mockResolvedValueOnce(new Response('', { status: 503 }))
			.mockResolvedValueOnce(new Response('ok', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);

		const promise = waitForHealthy('1.2.3.4', '80', '/healthz', 60_000, 1_000);
		await vi.runAllTimersAsync();

		expect(await promise).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('returns false when the timeout elapses without a healthy response', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));

		const promise = waitForHealthy('1.2.3.4', '80', '/healthz', 5_000, 1_000);
		await vi.runAllTimersAsync();

		expect(await promise).toBe(false);
	});
});
