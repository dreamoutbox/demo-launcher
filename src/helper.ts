import { Env } from './types';

/**
 * Checks if the current environment is local development.
 */

export function isDevelopment(env: Env, requestUrl?: string): boolean {
    const isLocalHost = requestUrl ? ['localhost', '127.0.0.1'].includes(new URL(requestUrl).hostname) : false;
    return env.ENVIRONMENT !== 'production' || isLocalHost;
}

/**
 * Formats milliseconds into human-readable uptime (e.g., "1h 12m 5s" or "4s")
 */
export function formatUptime(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(' ');
}

/**
 * Generates the startup bash script (Cloud-Init user_data)
 * Installs Nginx, clones the target repo, and executes demo-launcher-entrypoint.sh,
 * piping command outputs to ./demo-launcher/startup.log.
 *
 * @param repoUrl - Git repository URL to clone and run
 * @returns Bash script string used as cloud-init user_data
 *
 * @example
 * ```ts
 * const script = buildStartupScript('https://github.com/dreamoutbox/demo-launcher-simple-project');
 * ```
 */
export function buildStartupScript(repoUrl: string): string {
    return `#!/bin/bash
set -euo pipefail

mkdir -p ./demo-launcher

{
# 1. Setup Nginx & Git first
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx git curl

systemctl enable nginx
systemctl start nginx

# 2. Pull Git Project
mkdir -p /opt/demo-app
git clone "${repoUrl}" /opt/demo-app
cd /opt/demo-app

# 3. Execute demo-launcher-entrypoint.sh if present
if [ -f "./demo-launcher-entrypoint.sh" ]; then
    chmod +x ./demo-launcher-entrypoint.sh
    ./demo-launcher-entrypoint.sh
else
    echo "<h1>Demo launched for ${repoUrl}</h1>" > /var/www/html/index.html
fi
} 2>&1 | tee ./demo-launcher/startup.log
`;
}

/**
 * Normalizes an OpenSSH public key by extracting only the key type and base64 material,
 * omitting any extraneous trailing comments and whitespace.
 *
 * @param key - The raw OpenSSH public key string (e.g. "ssh-ed25519 AAAAC3... user@host")
 * @returns Normalized "<type> <base64>" key string
 *
 * @example
 * ```ts
 * const normalized = normalizePublicKey('ssh-ed25519 AAAAC3NzaC1... user@host');
 * // returns 'ssh-ed25519 AAAAC3NzaC1...'
 * ```
 */
export function normalizePublicKey(key: string): string {
    const trimmed = key.trim();
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
        return `${parts[0]} ${parts[1]}`;
    }
    return trimmed;
}

export const DEFAULT_FIREWALL_NAME = 'demo-launcher-fw';
export const DEFAULT_FIREWALL_TAG = 'demo-launcher-fw';

/**
 * Builds a deduplicated list of tags to be assigned to a demo droplet.
 * Always includes 'demo-launcher', the given projectId, and the configured firewall tag.
 *
 * @param projectId - Unique identifier for the demo project
 * @param firewallTag - Optional firewall tag, defaults to DEFAULT_FIREWALL_TAG ('demo-launcher-fw')
 * @returns Array of unique tag strings
 *
 * @example
 * ```ts
 * const tags = buildDropletTags('shop-demo', 'custom-fw-tag');
 * // ['demo-launcher', 'shop-demo', 'custom-fw-tag']
 * ```
 */
export function buildDropletTags(projectId: string, firewallTag: string = DEFAULT_FIREWALL_TAG): string[] {
    return Array.from(new Set(['demo-launcher', projectId, firewallTag]));
}

const DEFAULT_MAX_DEMO_TIME_SECONDS = 60 * 60; // 1 hour

/**
 * Resolve max demo lifetime in ms from env.MAX_DEMO_TIME_SECONDS (falls back to default if unset/invalid).
 * Example: getMaxDemoTimeMs(env) // "1800" -> 1800000
 */
export function getMaxDemoTimeMs(env: Env): number {
    const seconds = Number(env.MAX_DEMO_TIME_SECONDS);
    return (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_MAX_DEMO_TIME_SECONDS) * 1000;
}
