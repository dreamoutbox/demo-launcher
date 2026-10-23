import { buildDropletTags, buildStartupScript, DEFAULT_FIREWALL_TAG } from './helper';
import { DropletInfo, IDigitalOceanService } from './types';

/**
 * In-memory droplets created by the mock service. Module scope lets separate
 * service instances see the same state within one worker/test isolate.
 */
const mockDroplets = new Map<number, DropletInfo>();

/** Clears all mock droplets. Intended for tests. */
export function resetMockDroplets(): void {
	mockDroplets.clear();
}

export class DigitalOceanMockService implements IDigitalOceanService {
	private readonly firewallTag: string;

	constructor(private apiKey?: string, firewallTag?: string) {
		this.firewallTag = firewallTag || DEFAULT_FIREWALL_TAG;
		console.log('[DO-MOCK] Initialized DigitalOcean Mock Service');
	}

	async createDroplet(projectId: string, repoUrl: string, _size?: string, attemptId?: string): Promise<DropletInfo> {
		const userData = buildStartupScript(repoUrl);
		console.log(`[DO-MOCK] Ensuring firewall (mock) with tag: ${this.firewallTag}`);
		console.log(`[DO-MOCK] Creating droplet for project "${projectId}"...`);
		console.log(`[DO-MOCK] Startup Script (Nginx + Git Pull + Entrypoint):\n${userData}`);

		const mockDropletId = Math.floor(10000000 + Math.random() * 90000000);
		const tags = buildDropletTags(projectId, this.firewallTag, attemptId);
		const droplet: DropletInfo = {
			id: mockDropletId,
			ip: '',
			status: 'new',
			tags,
		};

		mockDroplets.set(mockDropletId, droplet);

		console.log(`[DO-MOCK] Droplet Created -> ID: ${mockDropletId}, Tags: ${JSON.stringify(tags)}`);

		return droplet;
	}

	/**
	 * Returns the mock droplet, assigning a fake public IP on first lookup.
	 *
	 * @param dropletId - Droplet id returned by createDroplet
	 * @returns Droplet info, or null if it was never created/deleted
	 *
	 * @example
	 * await service.getDroplet(12345678);
	 */
	async getDroplet(dropletId: number): Promise<DropletInfo | null> {
		const droplet = mockDroplets.get(dropletId);
		if (!droplet) {
			return null;
		}

		if (!droplet.ip) {
			droplet.ip = `192.0.2.${(dropletId % 254) + 1}`; // TEST-NET-1 IP range
			droplet.status = 'active';
			mockDroplets.set(dropletId, droplet);
		}

		return droplet;
	}

	/**
	 * Mock droplet listing.
	 *
	 * @returns All droplets created during this isolate's lifetime
	 *
	 * @example
	 * await service.listDroplets();
	 */
	async listDroplets(): Promise<DropletInfo[]> {
		return Array.from(mockDroplets.values());
	}

	async deleteDroplet(dropletId: number): Promise<void> {
		console.log(`[DO-MOCK] Deleting droplet ID: ${dropletId}...`);
		mockDroplets.delete(dropletId);
		console.log(`[DO-MOCK] Droplet ${dropletId} deleted successfully.`);
	}
}
