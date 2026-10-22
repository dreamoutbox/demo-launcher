import { DropletInfo, IDigitalOceanService } from './types';
import { buildStartupScript, normalizePublicKey } from "./helper";

export interface DigitalOceanConfig {
	region?: string;
	size?: string;
	image?: string;
	sshPublicKey?: string;
}

export class DigitalOceanProdService implements IDigitalOceanService {
	private readonly baseUrl = 'https://api.digitalocean.com/v2';
	private readonly region: string;
	private readonly size: string;
	private readonly image: string;
	private readonly sshPublicKey?: string;
	private cachedSshKeyId?: number | string;

	/**
	 * Initializes the DigitalOcean production API service.
	 *
	 * @param apiKey - DigitalOcean personal access token
	 * @param config - Optional droplet configuration overrides for region, size, image, and sshPublicKey
	 *
	 * @example
	 * ```ts
	 * const service = new DigitalOceanProdService(env.DO_API_KEY, {
	 *     region: env.DO_REGION,
	 *     size: env.DO_SIZE,
	 *     image: env.DO_IMAGE,
	 *     sshPublicKey: env.DROPLET_SSH_PUBLIC_KEY,
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
		this.sshPublicKey = config?.sshPublicKey;
	}

	private get headers(): HeadersInit {
		return {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${this.apiKey}`,
		};
	}

	/**
	 * Ensures that the provided SSH public key exists in the DigitalOcean account.
	 * If the key already exists, returns its ID. If not, uploads it and returns the newly created ID.
	 *
	 * @param publicKey - Raw OpenSSH public key string
	 * @returns DigitalOcean SSH key ID
	 *
	 * @example
	 * ```ts
	 * const keyId = await service.ensureSshKey('ssh-ed25519 AAAAC3NzaC1...');
	 * ```
	 */
	async ensureSshKey(publicKey: string): Promise<number | string> {
		if (this.cachedSshKeyId !== undefined) {
			return this.cachedSshKeyId;
		}

		const cleanKey = publicKey.trim();
		const normalizedTarget = normalizePublicKey(cleanKey);

		// 1. Check if the key already exists in DigitalOcean
		const listRes = await fetch(`${this.baseUrl}/account/keys?per_page=200`, {
			method: 'GET',
			headers: this.headers,
		});

		if (listRes.ok) {
			const data = (await listRes.json()) as {
				ssh_keys?: Array<{ id: number; fingerprint: string; public_key: string }>;
			};
			const existing = data.ssh_keys?.find(
				(k) => normalizePublicKey(k.public_key) === normalizedTarget,
			);
			if (existing) {
				this.cachedSshKeyId = existing.id;
				return existing.id;
			}
		}

		// 2. Add the SSH key if not found
		const createRes = await fetch(`${this.baseUrl}/account/keys`, {
			method: 'POST',
			headers: this.headers,
			body: JSON.stringify({
				name: `demo-launcher-key-${Date.now()}`,
				public_key: cleanKey,
			}),
		});

		if (createRes.ok) {
			const createData = (await createRes.json()) as {
				ssh_key: { id: number; fingerprint: string };
			};
			this.cachedSshKeyId = createData.ssh_key.id;
			return createData.ssh_key.id;
		}

		// 3. If upload returns 422 (key in use or already exists), re-query to resolve ID
		if (createRes.status === 422) {
			const retryRes = await fetch(`${this.baseUrl}/account/keys?per_page=200`, {
				method: 'GET',
				headers: this.headers,
			});
			if (retryRes.ok) {
				const retryData = (await retryRes.json()) as {
					ssh_keys?: Array<{ id: number; fingerprint: string; public_key: string }>;
				};
				const matchedKey = retryData.ssh_keys?.find(
					(k) => normalizePublicKey(k.public_key) === normalizedTarget,
				);
				if (matchedKey) {
					this.cachedSshKeyId = matchedKey.id;
					return matchedKey.id;
				}
			}
		}

		const errText = await createRes.text();
		throw new Error(`DigitalOcean ensureSshKey failed (${createRes.status}): ${errText}`);
	}

	async createDroplet(projectId: string, repoUrl: string): Promise<DropletInfo> {
		const userData = buildStartupScript(repoUrl);

		let sshKeys: Array<number | string> | undefined;
		if (this.sshPublicKey && this.sshPublicKey.trim() !== '') {
			const keyId = await this.ensureSshKey(this.sshPublicKey);
			sshKeys = [keyId];
		}

		const dropletPayload: Record<string, unknown> = {
			name: `demo-${projectId}-${Date.now()}`,
			region: this.region,
			size: this.size,
			image: this.image,
			user_data: userData,
			tags: ['demo-launcher', projectId],
		};

		if (sshKeys && sshKeys.length > 0) {
			dropletPayload.ssh_keys = sshKeys;
		}

		const createRes = await fetch(`${this.baseUrl}/droplets`, {
			method: 'POST',
			headers: this.headers,
			body: JSON.stringify(dropletPayload),
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
