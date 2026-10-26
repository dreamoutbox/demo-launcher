import { connect } from 'cloudflare:sockets';
import { Env } from './types';

/**
 * Checks whether the current environment is development.
 *
 * @param env - Worker environment bindings containing optional ENVIRONMENT variable
 * @returns True when ENVIRONMENT is not 'production'
 *
 * @example
 * ```ts
 * if (isDevelopment(env)) {
 *     // Development-specific behavior
 * }
 * ```
 */
export function isDevelopment(env: Env): boolean {
    return env.ENVIRONMENT !== 'production';
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
    // # nginx
    // #systemctl enable nginx
    // #systemctl start nginx

    return `#!/bin/bash
set -euo pipefail

mkdir -p ./demo-launcher

{
# 1. Setup git curl
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl

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
 * Builds the tag that identifies a single launch attempt.
 *
 * @param attemptId - UUID persisted in `project_demos.attempt_id`
 * @returns Tag applied to the droplet created for that attempt
 *
 * @example
 * ```ts
 * buildLaunchTag('5d1c...'); // 'launch-5d1c...'
 * ```
 */
export function buildLaunchTag(attemptId: string): string {
    return `launch-${attemptId}`;
}

/**
 * Builds a deduplicated list of tags to be assigned to a demo droplet.
 * Always includes 'demo-launcher', the given projectId, and the configured firewall tag.
 * When an attemptId is supplied, adds a `launch-<attemptId>` tag so an interrupted
 * launch can find its droplet again.
 *
 * @param projectId - Unique identifier for the demo project
 * @param firewallTag - Optional firewall tag, defaults to DEFAULT_FIREWALL_TAG ('demo-launcher-fw')
 * @param attemptId - Optional launch attempt identifier
 * @returns Array of unique tag strings
 *
 * @example
 * ```ts
 * const tags = buildDropletTags('shop-demo', 'custom-fw-tag', 'abc123');
 * // ['demo-launcher', 'shop-demo', 'custom-fw-tag', 'launch-abc123']
 * ```
 */
export function buildDropletTags(
    projectId: string,
    firewallTag: string = DEFAULT_FIREWALL_TAG,
    attemptId?: string,
): string[] {
    const tags = ['demo-launcher', projectId, firewallTag];
    if (attemptId) {
        tags.push(buildLaunchTag(attemptId));
    }
    return Array.from(new Set(tags));
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

type SocketConnection = ReturnType<typeof connect>;

/**
 * Performs a TCP socket probe against a target IP and port to determine if the service is accepting connections.
 *
 * @param ip - Target droplet public IPv4 address
 * @param port - Application port string or number
 * @param _path - Unused in TCP probing, retained for signature compatibility with HTTP checks
 * @param timeoutMs - Maximum milliseconds to wait for TCP connection establishment (defaults to 4000ms)
 * @returns Object indicating whether the TCP port is reachable and healthy
 *
 * @example
 * ```ts
 * const result = await checkHealth('168.144.254.91', '8080');
 * if (result.healthy) {
 *     // TCP port is accepting connections
 * }
 * ```
 */
export async function checkHealth(
    ip: string,
    port: string | number,
    _path = '/',
    timeoutMs = 4_000,
): Promise<{ healthy: boolean; status?: number; error?: string }> {
    const portNum = typeof port === 'number' ? port : Number.parseInt(port, 10);
    if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) {
        return { healthy: false, error: `Invalid port: ${port}` };
    }

    let socket: SocketConnection | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        socket = connect({ hostname: ip, port: portNum });
        const openedPromise = socket.opened;
        openedPromise.catch(() => { });

        await Promise.race([
            openedPromise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`TCP probe timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);

        return { healthy: true, status: 200 };
    } catch (err) {
        return {
            healthy: false,
            error: err instanceof Error ? err.message : String(err),
        };
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
        if (socket) {
            try {
                await socket.close();
            } catch {
                // Socket may already be closed or rejected during connection failure
            }
        }
    }
}
