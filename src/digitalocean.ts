import { DigitalOceanMockService } from './digitalocean.mock';
import { DEFAULT_FIREWALL_INBOUND_RULES, DigitalOceanProdService } from './digitalocean.prod';
import { buildFirewallInboundRules, isDevelopment } from './helper';
import { DropletInfo, Env, IDigitalOceanService as BaseIDigitalOceanService } from './types';

export { isDevelopment };

export interface IDigitalOceanService extends BaseIDigitalOceanService {
	/**
	 * Creates a droplet and returns as soon as DigitalOcean accepts the request.
	 * The returned `ip` is empty until the droplet is polled with `getDroplet`.
	 *
	 * @param projectId - Project ID
	 * @param repoUrl - Repository git URL
	 * @param size - Optional droplet machine size override
	 * @param attemptId - Optional unique launch attempt identifier
	 * @param branch - Optional git branch name to check out
	 */
	createDroplet(
		projectId: string,
		repoUrl: string,
		size?: string,
		attemptId?: string,
		branch?: string,
	): Promise<DropletInfo>;
}

/**
 * Checks whether the real DigitalOcean API should be used instead of mock.
 * Returns true if DO_USE_REAL_API is set to true, 1, 'true', or '1'.
 *
 * @param env - Worker environment bindings containing optional DO_USE_REAL_API flag
 * @returns True if configured to use the real API
 *
 * @example
 * ```ts
 * if (isRealApiEnabled(env)) {
 *   // Connect to real DO API
 * }
 * ```
 */
export function isRealApiEnabled(env: Env): boolean {
	const val = env.DO_USE_REAL_API;
	return val === true || val === 1 || val === '1' || (typeof val === 'string' && val.toLowerCase() === 'true');
}

/**
 * Factory for DigitalOcean service based on the environment and configuration.
 * Connects to the real DO API if DO_USE_REAL_API is enabled or if not in development.
 *
 * @param env - Worker environment bindings
 * @param requestUrl - Optional incoming request URL used to detect localhost
 * @param projectEntries - Optional project list used to determine per-project firewall inbound ports
 * @returns DigitalOcean service instance
 *
 * @example
 * ```ts
 * const doService = getDigitalOceanService(env, request.url, projects);
 * ```
 */
export function getDigitalOceanService(
	env: Env,
	requestUrl?: string,
	projectEntries?: Array<{ firewallPorts?: string | string[] }>,
): IDigitalOceanService {
	const inboundRules = buildFirewallInboundRules(
		DEFAULT_FIREWALL_INBOUND_RULES,
		(env as any).DO_FIREWALL_EXTRA_INBOUND_PORTS,
		projectEntries ?? [],
	);
	const config = {
		region: env.DO_REGION,
		size: env.DO_SIZE,
		image: env.DO_IMAGE,
		sshPublicKey: env.DROPLET_SSH_PUBLIC_KEY,
		firewallName: env.DO_FIREWALL_NAME,
		firewallTag: env.DO_FIREWALL_TAG,
		inboundRules,
	};
	if (isRealApiEnabled(env)) {
		return new DigitalOceanProdService(env.DO_API_KEY, config);
	}
	if (isDevelopment(env)) {
		return new DigitalOceanMockService(env.DO_API_KEY, env.DO_FIREWALL_TAG);
	}
	return new DigitalOceanProdService(env.DO_API_KEY, config);
}
