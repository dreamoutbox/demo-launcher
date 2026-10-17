import { DigitalOceanMockService } from './digitalocean.mock';
import { DigitalOceanProdService } from './digitalocean.prod';
import { isDevelopment } from './helper';
import { Env, IDigitalOceanService } from './types';

export { isDevelopment };

/**
 * Factory for DigitalOcean service based on the environment.
 */
export function getDigitalOceanService(env: Env, requestUrl?: string): IDigitalOceanService {
	if (isDevelopment(env, requestUrl)) {
		return new DigitalOceanMockService(env.DO_API_KEY);
	}
	return new DigitalOceanProdService(env.DO_API_KEY);
}
