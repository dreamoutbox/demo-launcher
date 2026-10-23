import { DropletInfo, IDigitalOceanService } from './types';
import { DigitalOceanApiError } from './digitalocean-error';
import {
	buildDropletTags,
	buildStartupScript,
	DEFAULT_FIREWALL_NAME,
	DEFAULT_FIREWALL_TAG,
	normalizePublicKey,
} from './helper';

export interface DigitalOceanConfig {
	region?: string;
	size?: string;
	image?: string;
	sshPublicKey?: string;
	firewallName?: string;
	firewallTag?: string;
}

export const DEFAULT_FIREWALL_INBOUND_RULES = [
	{
		protocol: 'tcp',
		ports: '22',
		sources: {
			addresses: ['0.0.0.0/0', '::/0'],
		},
	},
	{
		protocol: 'tcp',
		ports: '80',
		sources: {
			addresses: ['0.0.0.0/0', '::/0'],
		},
	},
	{
		protocol: 'tcp',
		ports: '443',
		sources: {
			addresses: ['0.0.0.0/0', '::/0'],
		},
	},
	{
		protocol: 'tcp',
		ports: '81',
		sources: {
			addresses: ['0.0.0.0/0', '::/0'],
		},
	},
	{
		protocol: 'tcp',
		ports: '8080',
		sources: {
			addresses: ['0.0.0.0/0', '::/0'],
		},
	},
	{
		protocol: 'tcp',
		ports: '3000',
		sources: {
			addresses: ['0.0.0.0/0', '::/0'],
		},
	},
	{
		protocol: 'icmp',
		ports: '0',
		sources: {
			addresses: ['0.0.0.0/0', '::/0'],
		},
	},
];

export const DEFAULT_FIREWALL_OUTBOUND_RULES = [
	{
		protocol: 'tcp',
		ports: 'all',
		destinations: {
			addresses: ['0.0.0.0/0', '::/0'],
		},
	},
	{
		protocol: 'udp',
		ports: 'all',
		destinations: {
			addresses: ['0.0.0.0/0', '::/0'],
		},
	},
	{
		protocol: 'icmp',
		ports: '0',
		destinations: {
			addresses: ['0.0.0.0/0', '::/0'],
		},
	},
];

export class DigitalOceanProdService implements IDigitalOceanService {
	private readonly baseUrl = 'https://api.digitalocean.com/v2';
	private readonly region: string;
	private readonly size: string;
	private readonly image: string;
	private readonly sshPublicKey?: string;
	private readonly firewallName: string;
	private readonly firewallTag: string;
	private cachedSshKeyId?: number | string;
	private cachedFirewallId?: string;

	/**
	 * Initializes the DigitalOcean production API service.
	 *
	 * @param apiKey - DigitalOcean personal access token
	 * @param config - Optional droplet configuration overrides for region, size, image, sshPublicKey, firewallName, and firewallTag
	 *
	 * @example
	 * ```ts
	 * const service = new DigitalOceanProdService(env.DO_API_KEY, {
	 *     region: env.DO_REGION,
	 *     size: env.DO_SIZE,
	 *     image: env.DO_IMAGE,
	 *     sshPublicKey: env.DROPLET_SSH_PUBLIC_KEY,
	 *     firewallName: env.DO_FIREWALL_NAME,
	 *     firewallTag: env.DO_FIREWALL_TAG,
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
		this.firewallName = config?.firewallName || DEFAULT_FIREWALL_NAME;
		this.firewallTag = config?.firewallTag || DEFAULT_FIREWALL_TAG;
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
		throw new DigitalOceanApiError(`DigitalOcean ensureSshKey failed (${createRes.status}): ${errText}`, createRes.status);
	}

	/**
	 * Ensures that a tag exists in the DigitalOcean account.
	 * If the tag already exists, treats it as success.
	 *
	 * @param name - Tag name to create or ensure
	 *
	 * @example
	 * ```ts
	 * await service.ensureTag('demo-launcher-fw');
	 * ```
	 */
	async ensureTag(name: string): Promise<void> {
		const res = await fetch(`${this.baseUrl}/tags`, {
			method: 'POST',
			headers: this.headers,
			body: JSON.stringify({ name }),
		});

		// 201 Created is success; 422 or 409 indicates the tag already exists
		if (res.ok || res.status === 422 || res.status === 409) {
			return;
		}

		const errText = await res.text();
		throw new DigitalOceanApiError(`DigitalOcean ensureTag failed (${res.status}): ${errText}`, res.status);
	}

	/**
	 * Ensures that the demo firewall exists and includes the configured droplet tag.
	 * Returns the cached firewall ID if already resolved.
	 * If the firewall exists, checks whether the firewall tag is assigned and adds it if missing.
	 * If the firewall does not exist, ensures the tag and creates the firewall.
	 *
	 * @returns DigitalOcean Firewall ID string
	 *
	 * @example
	 * ```ts
	 * const firewallId = await service.ensureFirewall();
	 * ```
	 */
	async ensureFirewall(): Promise<string> {
		if (this.cachedFirewallId !== undefined) {
			return this.cachedFirewallId;
		}

		// 1. Check if the firewall already exists by name
		const listRes = await fetch(`${this.baseUrl}/firewalls?per_page=200`, {
			method: 'GET',
			headers: this.headers,
		});

		if (listRes.ok) {
			const data = (await listRes.json()) as {
				firewalls?: Array<{
					id: string;
					name: string;
					tags?: string[];
					droplet_ids?: number[];
					inbound_rules?: unknown[];
				}>;
			};
			const existing = data.firewalls?.find((fw) => fw.name === this.firewallName);
			if (existing) {
				// Rule count differs from the code defaults -> push the defaults (PUT replaces rules, so keep tags/droplets)
				if ((existing.inbound_rules?.length ?? 0) !== DEFAULT_FIREWALL_INBOUND_RULES.length) {
					const updateRes = await fetch(`${this.baseUrl}/firewalls/${existing.id}`, {
						method: 'PUT',
						headers: this.headers,
						body: JSON.stringify({
							name: existing.name,
							inbound_rules: DEFAULT_FIREWALL_INBOUND_RULES,
							outbound_rules: DEFAULT_FIREWALL_OUTBOUND_RULES,
							droplet_ids: existing.droplet_ids ?? [],
							tags: Array.from(new Set([...(existing.tags ?? []), this.firewallTag])),
						}),
					});
					if (!updateRes.ok) {
						const errText = await updateRes.text();
						throw new DigitalOceanApiError(`DigitalOcean update firewall rules failed (${updateRes.status}): ${errText}`, updateRes.status);
					}
					this.cachedFirewallId = existing.id;
					return existing.id;
				}
				if (!existing.tags?.includes(this.firewallTag)) {
					const tagRes = await fetch(`${this.baseUrl}/firewalls/${existing.id}/tags`, {
						method: 'POST',
						headers: this.headers,
						body: JSON.stringify({ tags: [this.firewallTag] }),
					});
					if (!tagRes.ok && tagRes.status !== 422 && tagRes.status !== 409) {
						const errText = await tagRes.text();
						throw new DigitalOceanApiError(`DigitalOcean add tag to firewall failed (${tagRes.status}): ${errText}`, tagRes.status);
					}
				}
				this.cachedFirewallId = existing.id;
				return existing.id;
			}
		}

		// 2. Tag must exist before creating firewall referencing it
		await this.ensureTag(this.firewallTag);

		// 3. Create the firewall
		const createRes = await fetch(`${this.baseUrl}/firewalls`, {
			method: 'POST',
			headers: this.headers,
			body: JSON.stringify({
				name: this.firewallName,
				inbound_rules: DEFAULT_FIREWALL_INBOUND_RULES,
				outbound_rules: DEFAULT_FIREWALL_OUTBOUND_RULES,
				tags: [this.firewallTag],
			}),
		});

		if (createRes.ok) {
			const createData = (await createRes.json()) as {
				firewall: { id: string };
			};
			this.cachedFirewallId = createData.firewall.id;
			return createData.firewall.id;
		}

		// 4. Handle creation race condition: re-query and match by name
		if (createRes.status === 422 || createRes.status === 409) {
			const retryRes = await fetch(`${this.baseUrl}/firewalls?per_page=200`, {
				method: 'GET',
				headers: this.headers,
			});
			if (retryRes.ok) {
				const retryData = (await retryRes.json()) as {
					firewalls?: Array<{ id: string; name: string; tags?: string[] }>;
				};
				const matched = retryData.firewalls?.find((fw) => fw.name === this.firewallName);
				if (matched) {
					if (!matched.tags?.includes(this.firewallTag)) {
						await fetch(`${this.baseUrl}/firewalls/${matched.id}/tags`, {
							method: 'POST',
							headers: this.headers,
							body: JSON.stringify({ tags: [this.firewallTag] }),
						});
					}
					this.cachedFirewallId = matched.id;
					return matched.id;
				}
			}
		}

		const errText = await createRes.text();
		throw new DigitalOceanApiError(`DigitalOcean ensureFirewall failed (${createRes.status}): ${errText}`, createRes.status);
	}

	/**
	 * Creates a droplet and returns as soon as DigitalOcean accepts the request.
	 * No IP polling happens here; callers should poll with `getDroplet`.
	 *
	 * @param projectId - Project identifier used in the droplet name and tags
	 * @param repoUrl - Git repository cloned by the startup script
	 * @param size - Optional per-project size override
	 * @param attemptId - Optional launch attempt identifier added as a tag
	 * @returns Droplet id, empty IP, status, and tags
	 *
	 * @example
	 * const droplet = await service.createDroplet('go-pos', repoUrl, 's-1vcpu-1gb', attemptId);
	 */
	async createDroplet(projectId: string, repoUrl: string, size?: string, attemptId?: string): Promise<DropletInfo> {
		const userData = buildStartupScript(repoUrl);

		// Ensure firewall exists and is tagged before provisioning droplet
		await this.ensureFirewall();

		let sshKeys: Array<number | string> | undefined;
		if (this.sshPublicKey && this.sshPublicKey.trim() !== '') {
			const keyId = await this.ensureSshKey(this.sshPublicKey);
			sshKeys = [keyId];
		}

		const tags = buildDropletTags(projectId, this.firewallTag, attemptId);

		const dropletPayload: Record<string, unknown> = {
			name: `demo-${projectId}-${Date.now()}`,
			region: this.region,
			size: size || this.size,
			image: this.image,
			user_data: userData,
			tags,
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
			throw new DigitalOceanApiError(`DigitalOcean createDroplet failed (${createRes.status}): ${errText}`, createRes.status);
		}

		const createData = (await createRes.json()) as { droplet: { id: number; status?: string } };

		return {
			id: createData.droplet.id,
			ip: '',
			status: createData.droplet.status ?? 'new',
			tags,
		};
	}

	/**
	 * Fetches a droplet and resolves its public IPv4 address.
	 *
	 * @param dropletId - DigitalOcean droplet id
	 * @returns Droplet info, or null when DigitalOcean reports 404
	 *
	 * @example
	 * const droplet = await service.getDroplet(123456);
	 */
	async getDroplet(dropletId: number): Promise<DropletInfo | null> {
		const res = await fetch(`${this.baseUrl}/droplets/${dropletId}`, {
			method: 'GET',
			headers: this.headers,
		});

		if (res.status === 404) {
			return null;
		}

		if (!res.ok) {
			const errText = await res.text();
			throw new DigitalOceanApiError(`DigitalOcean getDroplet failed (${res.status}): ${errText}`, res.status);
		}

		const data = (await res.json()) as {
			droplet: {
				id: number;
				status: string;
				tags?: string[];
				networks?: { v4?: Array<{ ip_address: string; type: string }> };
			};
		};

		const publicV4 = data.droplet.networks?.v4?.find((n) => n.type === 'public');

		return {
			id: data.droplet.id,
			ip: publicV4?.ip_address ?? '',
			status: data.droplet.status,
			tags: data.droplet.tags ?? [],
		};
	}

	/**
	 * Lists every droplet in the DigitalOcean account, following pagination.
	 *
	 * @returns All droplets with id, public IPv4 (or empty string when unassigned), status, and tags
	 *
	 * @example
	 * ```ts
	 * const droplets = await service.listDroplets();
	 * ```
	 */
	async listDroplets(): Promise<DropletInfo[]> {
		const droplets: DropletInfo[] = [];
		let page = 1;

		while (true) {
			const res = await fetch(`${this.baseUrl}/droplets?per_page=200&page=${page}`, {
				method: 'GET',
				headers: this.headers,
			});

			if (!res.ok) {
				const errText = await res.text();
				throw new DigitalOceanApiError(`DigitalOcean listDroplets failed (${res.status}): ${errText}`, res.status);
			}

			const data = (await res.json()) as {
				droplets: Array<{
					id: number;
					status: string;
					tags: string[];
					networks: { v4: Array<{ ip_address: string; type: string }> };
				}>;
				links?: { pages?: { next?: string } };
			};

			for (const droplet of data.droplets) {
				const publicV4 = droplet.networks.v4.find((n) => n.type === 'public');
				droplets.push({
					id: droplet.id,
					ip: publicV4?.ip_address ?? '',
					status: droplet.status,
					tags: droplet.tags ?? [],
				});
			}

			if (!data.links?.pages?.next) {
				return droplets;
			}
			page++;
		}
	}

	async deleteDroplet(dropletId: number): Promise<void> {
		const res = await fetch(`${this.baseUrl}/droplets/${dropletId}`, {
			method: 'DELETE',
			headers: this.headers,
		});

		// 404 is treated as success in case the droplet was already manually destroyed
		if (!res.ok && res.status !== 404) {
			const errText = await res.text();
			throw new DigitalOceanApiError(`DigitalOcean deleteDroplet failed (${res.status}): ${errText}`, res.status);
		}
	}
}
