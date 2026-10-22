import { DigitalOceanMockService } from './digitalocean.mock';
import { DigitalOceanProdService } from './digitalocean.prod';
import { isDevelopment } from './helper';
import { Env, IDigitalOceanService } from './types';

export { isDevelopment };

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
 * @returns DigitalOcean service instance
 *
 * @example
 * ```ts
 * const doService = getDigitalOceanService(env, request.url);
 * ```
 */
export function getDigitalOceanService(env: Env, requestUrl?: string): IDigitalOceanService {
	if (isRealApiEnabled(env)) {
		return new DigitalOceanProdService(env.DO_API_KEY);
	}
	if (isDevelopment(env, requestUrl)) {
		return new DigitalOceanMockService(env.DO_API_KEY);
	}
	return new DigitalOceanProdService(env.DO_API_KEY);
}
