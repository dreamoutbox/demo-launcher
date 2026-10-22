import { DropletInfo, IDigitalOceanService } from './types';
import { buildStartupScript } from "./helper";

export interface DigitalOceanConfig {
	region?: string;
	size?: string;
	image?: string;
}

export class DigitalOceanProdService implements IDigitalOceanService {
	private readonly baseUrl = 'https://api.digitalocean.com/v2';
	private readonly region: string;
	private readonly size: string;
	private readonly image: string;

	/**
	 * Initializes the DigitalOcean production API service.
	 *
	 * @param apiKey - DigitalOcean personal access token
	 * @param config - Optional droplet configuration overrides for region, size, and image
	 *
	 * @example
	 * ```ts
	 * const service = new DigitalOceanProdService(env.DO_API_KEY, {
	 *     region: env.DO_REGION,
	 *     size: env.DO_SIZE,
	 *     image: env.DO_IMAGE,
	 * });
	 * ```
	 */
	constructor(private readonly apiKey: string, config?: DigitalOceanConfig) {
		if (!apiKey) {
			throw new Error('DigitalOcean API key is required in production mode.');
		}
		this.region = config?.region || 'sgp1';
		this.size = config?.size || 's-1vcpu-1gb';
		this.image = config?.image || 'ubuntu-24-04-x64';
	}

	private get headers(): HeadersInit {
		return {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${this.apiKey}`,
		};
	}

	async createDroplet(projectId: string, repoUrl: string): Promise<DropletInfo> {
		const userData = buildStartupScript(repoUrl);

		const createRes = await fetch(`${this.baseUrl}/droplets`, {
			method: 'POST',
			headers: this.headers,
			body: JSON.stringify({
				name: `demo-${projectId}-${Date.now()}`,
				region: this.region,
				size: this.size,
				image: this.image,
				user_data: userData,
				tags: ['demo-launcher', projectId],
			}),
		});

		if (!createRes.ok) {
			const errText = await createRes.text();
			throw new Error(`DigitalOcean createDroplet failed (${createRes.status}): ${errText}`);
		}

		const createData = (await createRes.json()) as { droplet: { id: number } };
		const dropletId = createData.droplet.id;

		// Poll DigitalOcean until the public IPv4 is assigned (up to ~30 seconds)
		const maxAttempts = 10;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 3000));

			const getRes = await fetch(`${this.baseUrl}/droplets/${dropletId}`, {
				method: 'GET',
				headers: this.headers,
			});

			if (getRes.ok) {
				const getData = (await getRes.json()) as {
					droplet: {
						id: number;
						status: string;
						networks: { v4: Array<{ ip_address: string; type: string }> };
					};
				};

				const publicV4 = getData.droplet.networks.v4.find((n) => n.type === 'public');
				if (publicV4?.ip_address) {
					return {
						id: dropletId,
						ip: publicV4.ip_address,
						status: getData.droplet.status,
					};
				}
			}
		}

		throw new Error(`Timed out waiting for public IPv4 on Droplet ${dropletId}`);
	}

	async deleteDroplet(dropletId: number): Promise<void> {
		const res = await fetch(`${this.baseUrl}/droplets/${dropletId}`, {
			method: 'DELETE',
			headers: this.headers,
		});

		// 404 is treated as success in case the droplet was already manually destroyed
		if (!res.ok && res.status !== 404) {
			const errText = await res.text();
			throw new Error(`DigitalOcean deleteDroplet failed (${res.status}): ${errText}`);
		}
	}
}
