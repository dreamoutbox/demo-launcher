import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DigitalOceanProdService } from '../src/digitalocean.prod';

/**
 * Runs createDroplet against a stubbed DigitalOcean API and returns the
 * `size` sent in the droplet creation payload.
 *
 * @param configSize - Default size passed to the service config (DO_SIZE)
 * @param projectSize - Per-project size override (projects.json "size")
 *
 * @example
 * await createAndGetSize('s-1vcpu-1gb', 's-1vcpu-2gb'); // 's-1vcpu-2gb'
 */
async function createAndGetSize(configSize: string | undefined, projectSize?: string): Promise<string> {
	let sentSize = '';
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
			if (url.endsWith('/firewalls?per_page=200')) {
				return json({ firewalls: [{ id: 'fw1', name: 'demo-launcher-firewall', tags: [] }] });
			}
			if (url.endsWith('/droplets') && init?.method === 'POST') {
				sentSize = JSON.parse(init.body as string).size;
				return json({ droplet: { id: 1 } });
			}
			if (url.endsWith('/droplets/1')) {
				return json({ droplet: { id: 1, status: 'active', networks: { v4: [{ ip_address: '1.2.3.4', type: 'public' }] } } });
			}
			return json({});
		}),
	);

	const service = new DigitalOceanProdService('key', { size: configSize, firewallName: 'demo-launcher-firewall' });
	const promise = service.createDroplet('p1', 'https://example.com/repo', projectSize);
	await vi.runAllTimersAsync();
	await promise;
	return sentSize;
}

describe('DigitalOceanProdService.createDroplet size', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('uses the project size when provided', async () => {
		expect(await createAndGetSize('s-1vcpu-1gb', 's-1vcpu-2gb')).toBe('s-1vcpu-2gb');
	});

	it('falls back to the configured default size when project size is missing', async () => {
		expect(await createAndGetSize('s-2vcpu-4gb')).toBe('s-2vcpu-4gb');
	});

	it('falls back to the built-in default when neither is set', async () => {
		expect(await createAndGetSize(undefined)).toBe('s-1vcpu-1gb');
	});
});
