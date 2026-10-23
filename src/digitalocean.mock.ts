import { buildDropletTags, buildStartupScript, DEFAULT_FIREWALL_TAG } from './helper';
import { DropletInfo, IDigitalOceanService } from './types';

export class DigitalOceanMockService implements IDigitalOceanService {
	private readonly firewallTag: string;

	constructor(private apiKey?: string, firewallTag?: string) {
		this.firewallTag = firewallTag || DEFAULT_FIREWALL_TAG;
		console.log('[DO-MOCK] Initialized DigitalOcean Mock Service');
	}

	async createDroplet(projectId: string, repoUrl: string): Promise<DropletInfo> {
		const userData = buildStartupScript(repoUrl);
		console.log(`[DO-MOCK] Ensuring firewall (mock) with tag: ${this.firewallTag}`);
		console.log(`[DO-MOCK] Creating droplet for project "${projectId}"...`);
		console.log(`[DO-MOCK] Startup Script (Nginx + Git Pull + Entrypoint):\n${userData}`);

		// Simulate a short provisioning delay
		await new Promise((resolve) => setTimeout(resolve, 1500));

		const mockDropletId = Math.floor(10000000 + Math.random() * 90000000);
		const mockIp = `192.0.2.${Math.floor(1 + Math.random() * 254)}`; // TEST-NET-1 IP range
		const tags = buildDropletTags(projectId, this.firewallTag);

		console.log(`[DO-MOCK] Droplet Created -> ID: ${mockDropletId}, IP: ${mockIp}, Tags: ${JSON.stringify(tags)}`);

		return {
			id: mockDropletId,
			ip: mockIp,
			status: 'active',
			tags,
		};
	}

	/**
	 * Mock droplet listing. The mock service is stateless per request, so nothing is returned.
	 *
	 * @returns Empty droplet list
	 *
	 * @example
	 * ```ts
	 * const droplets = await service.listDroplets();
	 * ```
	 */
	async listDroplets(): Promise<DropletInfo[]> {
		console.log('[DO-MOCK] Listing droplets (mock) -> []');
		return [];
	}

	async deleteDroplet(dropletId: number): Promise<void> {
		console.log(`[DO-MOCK] Deleting droplet ID: ${dropletId}...`);
		await new Promise((resolve) => setTimeout(resolve, 500));
		console.log(`[DO-MOCK] Droplet ${dropletId} deleted successfully.`);
	}
}
