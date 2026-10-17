import { Env } from './types';

/**
 * Checks if the current environment is local development.
 */

export function isDevelopment(env: Env, requestUrl?: string): boolean {
    const isLocalHost = requestUrl ? ['localhost', '127.0.0.1'].includes(new URL(requestUrl).hostname) : false;
    return env.ENVIRONMENT !== 'production' || isLocalHost;
}
