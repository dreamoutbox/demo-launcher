import { DigitalOceanMockService } from './digitalocean.mock';
import { DigitalOceanProdService } from './digitalocean.prod';
import { Env, IDigitalOceanService } from './types';

/**
 * Checks if the current environment is local development.
 */
export function isDevelopment(env: Env, requestUrl?: string): boolean {
	const isLocalHost = requestUrl ? ['localhost', '127.0.0.1'].includes(new URL(requestUrl).hostname) : false;
	return env.ENVIRONMENT !== 'production' || isLocalHost;
}

/**
 * Factory for DigitalOcean service based on the environment.
 */
export function getDigitalOceanService(env: Env, requestUrl?: string): IDigitalOceanService {
	if (isDevelopment(env, requestUrl)) {
		return new DigitalOceanMockService(env.DO_API_KEY);
	}
	return new DigitalOceanProdService(env.DO_API_KEY);
}
