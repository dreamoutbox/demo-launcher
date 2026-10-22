import { buildStartupScript } from './helper';
import { DropletInfo, IDigitalOceanService } from './types';

export class DigitalOceanMockService implements IDigitalOceanService {
	constructor(private apiKey?: string) {
		console.log('[DO-MOCK] Initialized DigitalOcean Mock Service');
	}

	async createDroplet(projectId: string, repoUrl: string): Promise<DropletInfo> {
		const userData = buildStartupScript(repoUrl);
		console.log(`[DO-MOCK] Creating droplet for project "${projectId}"...`);
		console.log(`[DO-MOCK] Startup Script (Nginx + Git Pull + Entrypoint):\n${userData}`);

		// Simulate a short provisioning delay
		await new Promise((resolve) => setTimeout(resolve, 1500));

		const mockDropletId = Math.floor(10000000 + Math.random() * 90000000);
		const mockIp = `192.0.2.${Math.floor(1 + Math.random() * 254)}`; // TEST-NET-1 IP range

		console.log(`[DO-MOCK] Droplet Created -> ID: ${mockDropletId}, IP: ${mockIp}`);

		return {
			id: mockDropletId,
			ip: mockIp,
			status: 'active',
		};
	}

	async deleteDroplet(dropletId: number): Promise<void> {
		console.log(`[DO-MOCK] Deleting droplet ID: ${dropletId}...`);
		await new Promise((resolve) => setTimeout(resolve, 500));
		console.log(`[DO-MOCK] Droplet ${dropletId} deleted successfully.`);
	}
}
