import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForHealthy } from '../src/healthcheck';

describe('waitForHealthy', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('returns true on first 2xx and builds the url from ip/port/path', async () => {
		const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
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
