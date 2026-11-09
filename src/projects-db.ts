import { isValidGitBranch, isValidPortOrRange, parsePortList } from './helper';
import { Env } from './types';

/**
 * Full project specification stored in D1. Supports arbitrary extra fields
 * so project-specific secrets or environment variables can be persisted.
 */
export interface ProjectConfig {
	id: string;
	name: string;
	repoUrl: string;
	branch?: string;
	healthcheckPort?: string;
	healthcheckPath?: string;
	appPort?: string;
	size?: string;
	firewallPorts?: string | string[];
	[key: string]: unknown;
}

/**
 * Sanitized project specification exposed publicly to end-users via GET /api/projects.
 * Strips any sensitive credentials, secret variables, or internal configuration fields.
 */
export interface PublicProjectConfig {
	id: string;
	name: string;
	repoUrl: string;
	branch?: string;
	healthcheckPort?: string;
	healthcheckPath?: string;
	appPort?: string;
	size?: string;
	firewallPorts?: string | string[];
}

export type ProjectValidationResult =
	| { valid: true; projects: ProjectConfig[] }
	| { valid: false; error: string };

/**
 * Validates raw JSON input representing a list of demo project specifications.
 * Accepts either a JSON array or an object with a `projects` array property.
 * Ensures required fields are populated, identifier syntax is safe, and port/branch
 * properties conform to expected formats.
 *
 * @param input - Arbitrary parsed JSON input to validate
 * @returns Object with valid flag and validated ProjectConfig array or error message
 *
 * @example
 * ```ts
 * const res = validateProjectsJson([{ id: 'go-pos', name: 'Go POS', repoUrl: 'https://github.com/org/repo' }]);
 * if (res.valid) {
 *     console.log('Validated projects:', res.projects.length);
 * }
 * ```
 */
export function validateProjectsJson(input: unknown): ProjectValidationResult {
	let list: unknown[];

	if (Array.isArray(input)) {
		list = input;
	} else if (typeof input === 'object' && input !== null && 'projects' in input && Array.isArray((input as any).projects)) {
		list = (input as any).projects;
	} else {
		return { valid: false, error: 'Expected a JSON array of projects or an object with a "projects" array' };
	}

	if (list.length === 0) {
		return { valid: false, error: 'Project list cannot be empty' };
	}

	const seenIds = new Set<string>();
	const validated: ProjectConfig[] = [];

	for (let i = 0; i < list.length; i++) {
		const item = list[i];
		const itemPrefix = `Project at index ${i}`;

		if (typeof item !== 'object' || item === null || Array.isArray(item)) {
			return { valid: false, error: `${itemPrefix} must be an object` };
		}

		const p = item as Record<string, unknown>;

		// 1. Validate ID
		if (typeof p.id !== 'string' || p.id.trim() === '') {
			return { valid: false, error: `${itemPrefix} is missing a non-empty string "id"` };
		}
		const id = p.id.trim();
		if (!/^[A-Za-z0-9_-]+$/.test(id)) {
			return { valid: false, error: `${itemPrefix} id "${id}" contains invalid characters (use alphanumeric, dash, underscore)` };
		}
		if (seenIds.has(id)) {
			return { valid: false, error: `Duplicate project id "${id}" found at index ${i}` };
		}
		seenIds.add(id);

		// 2. Validate Name
		if (typeof p.name !== 'string' || p.name.trim() === '') {
			return { valid: false, error: `${itemPrefix} ("${id}") is missing a non-empty string "name"` };
		}
		const name = p.name.trim();

		// 3. Validate Repo URL
		if (typeof p.repoUrl !== 'string' || p.repoUrl.trim() === '') {
			return { valid: false, error: `${itemPrefix} ("${id}") is missing a non-empty string "repoUrl"` };
		}
		const repoUrl = p.repoUrl.trim();
		try {
			const parsedUrl = new URL(repoUrl);
			if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
				return { valid: false, error: `${itemPrefix} ("${id}") repoUrl must use http or https protocol` };
			}
		} catch {
			return { valid: false, error: `${itemPrefix} ("${id}") repoUrl "${repoUrl}" is not a valid URL` };
		}

		// 4. Validate Branch (optional)
		let branch: string | undefined;
		if (p.branch !== undefined && p.branch !== null) {
			if (typeof p.branch !== 'string' || p.branch.trim() === '') {
				return { valid: false, error: `${itemPrefix} ("${id}") branch must be a non-empty string when provided` };
			}
			branch = p.branch.trim();
			if (!isValidGitBranch(branch)) {
				return { valid: false, error: `${itemPrefix} ("${id}") branch "${branch}" is invalid` };
			}
		}

		// 5. Validate Healthcheck Port and Path (optional)
		let healthcheckPort: string | undefined;
		if (p.healthcheckPort !== undefined && p.healthcheckPort !== null) {
			const portStr = String(p.healthcheckPort).trim();
			if (!isValidPortOrRange(portStr)) {
				return { valid: false, error: `${itemPrefix} ("${id}") healthcheckPort "${portStr}" is invalid` };
			}
			healthcheckPort = portStr;
		}

		let healthcheckPath: string | undefined;
		if (p.healthcheckPath !== undefined && p.healthcheckPath !== null) {
			if (typeof p.healthcheckPath !== 'string' || !p.healthcheckPath.startsWith('/')) {
				return { valid: false, error: `${itemPrefix} ("${id}") healthcheckPath must start with "/"` };
			}
			healthcheckPath = p.healthcheckPath.trim();
		}

		// 6. Validate App Port (optional)
		let appPort: string | undefined;
		if (p.appPort !== undefined && p.appPort !== null) {
			const portStr = String(p.appPort).trim();
			if (!isValidPortOrRange(portStr)) {
				return { valid: false, error: `${itemPrefix} ("${id}") appPort "${portStr}" is invalid` };
			}
			appPort = portStr;
		}

		// 7. Validate Size (optional)
		let size: string | undefined;
		if (p.size !== undefined && p.size !== null) {
			if (typeof p.size !== 'string' || p.size.trim() === '') {
				return { valid: false, error: `${itemPrefix} ("${id}") size must be a non-empty string when provided` };
			}
			size = p.size.trim();
		}

		// 8. Validate Firewall Ports (optional)
		let firewallPorts: string | string[] | undefined;
		if (p.firewallPorts !== undefined && p.firewallPorts !== null) {
			try {
				parsePortList(p.firewallPorts as string | string[]);
				firewallPorts = p.firewallPorts as string | string[];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return { valid: false, error: `${itemPrefix} ("${id}") firewallPorts error: ${msg}` };
			}
		}

		// Preserve all fields including potential secrets/extra metadata
		const projectConfig: ProjectConfig = {
			...p,
			id,
			name,
			repoUrl,
			...(branch !== undefined ? { branch } : {}),
			...(healthcheckPort !== undefined ? { healthcheckPort } : {}),
			...(healthcheckPath !== undefined ? { healthcheckPath } : {}),
			...(appPort !== undefined ? { appPort } : {}),
			...(size !== undefined ? { size } : {}),
			...(firewallPorts !== undefined ? { firewallPorts } : {}),
		};

		validated.push(projectConfig);
	}

	return { valid: true, projects: validated };
}

/**
 * Strips private or internal properties from a ProjectConfig for safe public consumption.
 *
 * @param project - Full project configuration object stored in DB
 * @returns Publicly safe project configuration object
 *
 * @example
 * ```ts
 * const publicData = sanitizeProjectForPublic(projectWithSecrets);
 * ```
 */
export function sanitizeProjectForPublic(project: ProjectConfig): PublicProjectConfig {
	const result: PublicProjectConfig = {
		id: project.id,
		name: project.name,
		repoUrl: project.repoUrl,
	};

	if (project.branch !== undefined) result.branch = project.branch;
	if (project.healthcheckPort !== undefined) result.healthcheckPort = project.healthcheckPort;
	if (project.healthcheckPath !== undefined) result.healthcheckPath = project.healthcheckPath;
	if (project.appPort !== undefined) result.appPort = project.appPort;
	if (project.size !== undefined) result.size = project.size;
	if (project.firewallPorts !== undefined) result.firewallPorts = project.firewallPorts;

	return result;
}

/**
 * Fetches all project configurations stored in the D1 `projects` table.
 *
 * @param env - Worker environment containing the D1 database binding
 * @returns Array of full ProjectConfig objects sorted by ID ascending
 *
 * @example
 * ```ts
 * const allProjects = await getProjectsFromDb(env);
 * ```
 */
export async function getProjectsFromDb(env: Env): Promise<ProjectConfig[]> {
	const { results } = await env.mydb
		.prepare('SELECT data FROM projects ORDER BY id ASC')
		.all<{ data: string }>();

	return results.map((row) => JSON.parse(row.data) as ProjectConfig);
}

/**
 * Fetches a single project configuration from the D1 `projects` table by its unique ID.
 *
 * @param env - Worker environment containing the D1 database binding
 * @param projectId - Unique project identifier
 * @returns Full ProjectConfig object or null if not found
 *
 * @example
 * ```ts
 * const project = await getProjectByIdFromDb(env, 'go-pos');
 * ```
 */
export async function getProjectByIdFromDb(env: Env, projectId: string): Promise<ProjectConfig | null> {
	const row = await env.mydb
		.prepare('SELECT data FROM projects WHERE id = ?1')
		.bind(projectId)
		.first<{ data: string }>();

	if (!row) {
		return null;
	}

	return JSON.parse(row.data) as ProjectConfig;
}

/**
 * Validates and batch inserts or replaces project specifications into the D1 `projects` table.
 * Preserves all fields from input JSON objects.
 *
 * @param env - Worker environment containing the D1 database binding
 * @param rawInput - Raw parsed JSON input (array or object containing projects array)
 * @returns Array of successfully imported ProjectConfig objects
 *
 * @example
 * ```ts
 * const imported = await importProjectsToDb(env, rawJsonArray);
 * ```
 */
export async function importProjectsToDb(env: Env, rawInput: unknown): Promise<ProjectConfig[]> {
	const validation = validateProjectsJson(rawInput);
	if (!validation.valid) {
		throw new Error(validation.error);
	}

	const now = Date.now();
	const statements = validation.projects.map((p) =>
		env.mydb
			.prepare(
				`INSERT INTO projects (id, data, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET data = ?2, updated_at = ?3`,
			)
			.bind(p.id, JSON.stringify(p), now),
	);

	await env.mydb.batch(statements);
	return validation.projects;
}

/**
 * Clears all records from the D1 `projects` table. Does not alter `project_demos`
 * or delete DigitalOcean droplets, preserving demo tracking and cleanup ability.
 *
 * @param env - Worker environment containing the D1 database binding
 * @returns Number of deleted project records
 *
 * @example
 * ```ts
 * const { deletedCount } = await resetProjectsTable(env);
 * ```
 */
export async function resetProjectsTable(env: Env): Promise<{ deletedCount: number }> {
	const result = await env.mydb.prepare('DELETE FROM projects').run();
	return { deletedCount: result.meta.changes ?? 0 };
}
