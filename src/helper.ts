import { connect } from 'cloudflare:sockets';
import { Env } from './types';
import { TurnstileStatus, TurnstileVerificationResult } from './turnstile';

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
 * Validates a git branch name to contain only safe characters: letters, digits, dots,
 * underscores, slashes, and hyphens, preventing shell and git flag injection.
 *
 * @param branch - The branch name to validate
 * @returns True if the branch name is valid and safe against shell injection
 *
 * @example
 * ```ts
 * isValidGitBranch('main'); // true
 * isValidGitBranch('feature/add-login'); // true
 * isValidGitBranch('; rm -rf /'); // false
 * ```
 */
export function isValidGitBranch(branch: string): boolean {
    return /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(branch);
}

/**
 * Generates the startup bash script (Cloud-Init user_data)
 * Installs Nginx, clones the target repo (optionally targeting a specific branch),
 * and executes demo-launcher-entrypoint.sh, piping command outputs to ./demo-launcher/startup.log.
 *
 * @param repoUrl - Git repository URL to clone and run
 * @param branch - Optional git branch name to check out
 * @returns Bash script string used as cloud-init user_data
 *
 * @example
 * ```ts
 * const script = buildStartupScript('https://github.com/dreamoutbox/demo-launcher-simple-project', 'main');
 * ```
 */
export function buildStartupScript(repoUrl: string, branch?: string): string {
    // # nginx
    // #systemctl enable nginx
    // #systemctl start nginx

    let cloneCmd = `git clone "${repoUrl}" /opt/demo-app`;
    if (branch !== undefined && branch.trim() !== '') {
        const trimmedBranch = branch.trim();
        if (!isValidGitBranch(trimmedBranch)) {
            throw new Error(`Invalid git branch name: ${branch}`);
        }
        cloneCmd = `git clone --branch "${trimmedBranch}" --single-branch "${repoUrl}" /opt/demo-app`;
    }

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
${cloneCmd}
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
export const GLOBAL_LAUNCHER_NAME = 'global-launcher';
export const MAX_FIREWALL_INBOUND_RULES = 50;

export interface FirewallInboundRule {
    protocol: string;
    ports: string;
    sources: {
        addresses: string[];
    };
}

/**
 * Validates whether a port string is a valid single port (1-65535) or a valid port range (start-end).
 *
 * @param port - Port or range string to validate (e.g. '5432' or '8000-8100')
 * @returns True if the port string is numeric, within 1-65535, and ranges are not reversed
 *
 * @example
 * ```ts
 * isValidPortOrRange('8080'); // true
 * isValidPortOrRange('8000-8100'); // true
 * isValidPortOrRange('9000-8000'); // false
 * ```
 */
export function isValidPortOrRange(port: string): boolean {
    const trimmed = port.trim();
    if (trimmed === '') {
        return false;
    }
    if (/^\d+$/.test(trimmed)) {
        const num = Number.parseInt(trimmed, 10);
        return num >= 1 && num <= 65535;
    }
    const rangeMatch = /^(\d+)-(\d+)$/.exec(trimmed);
    if (!rangeMatch) {
        return false;
    }
    const start = Number.parseInt(rangeMatch[1], 10);
    const end = Number.parseInt(rangeMatch[2], 10);
    return start >= 1 && end <= 65535 && start <= end;
}

/**
 * Parses and validates a list or comma-separated string of port/range specifications.
 * Throws an Error if any entry is invalid.
 *
 * @param input - Comma-separated string or array of port/range strings
 * @returns Normalized array of unique valid port/range strings
 *
 * @example
 * ```ts
 * parsePortList('5432, 8000-8100'); // ['5432', '8000-8100']
 * parsePortList(['3000', '5432']); // ['3000', '5432']
 * ```
 */
export function parsePortList(input?: string | string[] | null): string[] {
    if (!input) {
        return [];
    }
    const rawList = Array.isArray(input) ? input : input.split(',');
    const result: string[] = [];
    for (const raw of rawList) {
        const trimmed = raw.trim();
        if (!trimmed) {
            continue;
        }
        if (!isValidPortOrRange(trimmed)) {
            throw new Error(`Invalid port or port range: "${trimmed}"`);
        }
        if (!result.includes(trimmed)) {
            result.push(trimmed);
        }
    }
    return result;
}

/**
 * Builds the complete list of firewall inbound rules by combining defaults, global extra ports from env,
 * and per-project ports defined in projects.json. Deduplicates TCP rules and caps the total at DigitalOcean's 50-rule limit.
 *
 * @param defaultRules - Baseline default firewall inbound rules
 * @param extraPortsEnv - Comma-separated port string from DO_FIREWALL_EXTRA_INBOUND_PORTS env
 * @param projectEntries - Array of project objects containing optional firewallPorts
 * @returns Array of deduplicated FirewallInboundRule objects
 *
 * @example
 * ```ts
 * const rules = buildFirewallInboundRules(DEFAULT_FIREWALL_INBOUND_RULES, '5432', [{ firewallPorts: ['8081'] }]);
 * ```
 */
export function buildFirewallInboundRules(
    defaultRules: FirewallInboundRule[],
    extraPortsEnv?: string | null,
    projectEntries?: Array<{ firewallPorts?: string[] }> | null,
): FirewallInboundRule[] {
    const rules: FirewallInboundRule[] = defaultRules.map((r) => ({
        protocol: r.protocol,
        ports: r.ports,
        sources: { addresses: [...r.sources.addresses] },
    }));

    const existingTcpPorts = new Set(
        rules.filter((r) => r.protocol.toLowerCase() === 'tcp').map((r) => r.ports),
    );

    const extraPorts = parsePortList(extraPortsEnv);
    const projectPorts: string[] = [];
    if (projectEntries) {
        for (const p of projectEntries) {
            if (p.firewallPorts) {
                projectPorts.push(...parsePortList(p.firewallPorts));
            }
        }
    }

    const allExtra = Array.from(new Set([...extraPorts, ...projectPorts]));
    for (const port of allExtra) {
        if (!existingTcpPorts.has(port)) {
            existingTcpPorts.add(port);
            rules.push({
                protocol: 'tcp',
                ports: port,
                sources: {
                    addresses: ['0.0.0.0/0', '::/0'],
                },
            });
        }
    }

    if (rules.length > MAX_FIREWALL_INBOUND_RULES) {
        throw new Error(
            `Total firewall inbound rules count (${rules.length}) exceeds DigitalOcean maximum limit of ${MAX_FIREWALL_INBOUND_RULES}`,
        );
    }

    return rules;
}

/**
 * Compares two lists of firewall inbound rules by their sorted protocol:ports signature.
 *
 * @param a - First list of inbound rules
 * @param b - Second list of inbound rules
 * @returns True if both lists have the exact same protocols and ports
 *
 * @example
 * ```ts
 * areInboundRulesEqual(existingRules, desiredRules);
 * ```
 */
export function areInboundRulesEqual(
    a?: Array<{ protocol?: string; ports?: string | number }>,
    b?: Array<{ protocol?: string; ports?: string | number }>,
): boolean {
    const normalize = (list?: Array<{ protocol?: string; ports?: string | number }>) => {
        if (!list) return '';
        return list
            .map((r) => `${String(r.protocol || '').toLowerCase()}:${String(r.ports || '')}`)
            .sort()
            .join('|');
    };
    return normalize(a) === normalize(b);
}

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

/**
 * Parses the MAX_INSTANCES environment variable into a positive integer limit, or null if unset/unlimited.
 *
 * @param env - Worker environment bindings containing optional MAX_INSTANCES
 * @returns Positive integer instance limit, or null if unlimited
 *
 * @example
 * ```ts
 * const limit = getMaxInstances(env);
 * ```
 */
export function getMaxInstances(env: Env): number | null {
    const raw = (env as any).MAX_INSTANCES;
    if (raw === undefined || raw === null || raw === '') {
        return null;
    }
    const num = Number.parseInt(String(raw), 10);
    return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * Counts the current number of active demo instances in D1 (status in LAUNCHING or RUNNING).
 *
 * @param env - Worker environment containing the D1 database binding
 * @returns Number of active demo instances
 *
 * @example
 * ```ts
 * const count = await countActiveDemos(env);
 * ```
 */
export async function countActiveDemos(env: Env): Promise<number> {
    const result = await env.mydb
        .prepare("SELECT COUNT(*) as total FROM project_demos WHERE status IN ('LAUNCHING', 'RUNNING')")
        .first<{ total: number }>();
    return result?.total ?? 0;
}

/**
 * Checks whether a specific project currently has an active demo in D1 (status in LAUNCHING or RUNNING).
 *
 * @param env - Worker environment containing the D1 database binding
 * @param projectId - Project ID to check
 * @returns True if the project has an active demo
 *
 * @example
 * ```ts
 * const active = await isProjectActive(env, 'go-pos');
 * ```
 */
export async function isProjectActive(env: Env, projectId: string): Promise<boolean> {
    const result = await env.mydb
        .prepare("SELECT status FROM project_demos WHERE project_id = ?1 AND status IN ('LAUNCHING', 'RUNNING')")
        .bind(projectId)
        .first<{ status: string }>();
    return result !== null;
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

/**
 * Creates a standard JSON error Response for a failed Turnstile verification.
 *
 * @param verification - The failed verification result from verifyTurnstileToken
 * @returns Response object with 400 (missing token) or 403 (invalid/failed) and JSON error details
 *
 * @example
 * ```ts
 * if (!verification.success) {
 *     return createTurnstileErrorResponse(verification);
 * }
 * ```
 */
export function createTurnstileErrorResponse(verification: TurnstileVerificationResult): Response {
    const isMissing = verification.status === TurnstileStatus.MISSING_TOKEN;
    const errorMsg = isMissing ? 'Turnstile token is required' : 'Turnstile verification failed';
    return Response.json(
        {
            error: errorMsg,
            status: verification.status,
            errorCodes: verification.errorCodes,
        },
        { status: isMissing ? 400 : 403 },
    );
}
