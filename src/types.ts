export interface DropletInfo {
	id: number;
	/** Public IPv4 address, or an empty string until DigitalOcean assigns one. */
	ip: string;
	status: string;
	tags: string[];
}

export interface IDigitalOceanService {
	/**
	 * Creates a droplet and returns as soon as DigitalOcean accepts the request.
	 * The returned `ip` is empty until the droplet is polled with `getDroplet`.
	 */
	createDroplet(projectId: string, repoUrl: string, size?: string, attemptId?: string): Promise<DropletInfo>;
	getDroplet(dropletId: number): Promise<DropletInfo | null>;
	deleteDroplet(dropletId: number): Promise<void>;
	listDroplets(): Promise<DropletInfo[]>;
}

/** Project demo lifecycle states stored in `project_demos.status`. */
export enum DemoStatus {
	STOPPED = 'STOPPED',
	LAUNCHING = 'LAUNCHING',
	RUNNING = 'RUNNING',
	FAILED = 'FAILED',
}

/** Queue-driven launch phases. */
export enum LaunchPhase {
	CREATE = 'CREATE',
	POLL_HEALTH = 'POLL_HEALTH',
}

export interface QueueMessage {
	projectId: string;
	/**
	 * Omitted by legacy messages, which are treated as `CREATE`.
	 * `POLL_HEALTH` messages require `attemptId`.
	 */
	phase?: LaunchPhase;
	attemptId?: string;
}

export enum ActionType {
	LAUNCH_DEMO = 'LAUNCH_DEMO',
	STOP_DEMO = 'STOP_DEMO',
}

export enum ActionStatus {
	QUEUED = 'QUEUED',
	REJECTED = 'REJECTED',
	SUCCESS = 'SUCCESS',
	FAILED = 'FAILED',
}

export interface ActionLogRecord {
	id: number;
	action: ActionType | string;
	project_id: string | null;
	ip_address: string | null;
	country: string | null;
	user_agent: string | null;
	status: ActionStatus | string;
	details: string | null;
	created_at: number;
}

export interface Env {
	mydb: D1Database;
	DEMO_LAUNCHER_QUEUE: Queue<QueueMessage>;
	LAUNCHER: DurableObjectNamespace<import('./launcher').ProjectLauncher>;
	DO_API_KEY: string;
	DO_USE_REAL_API?: boolean | string | number;
	DO_REGION?: string;
	DO_SIZE?: string;
	DO_IMAGE?: string;
	ENVIRONMENT?: 'development' | 'production';
	TURNSTILE_SECRET_KEY?: string;
	TURNSTILE_SITE_KEY?: string;
	ADMIN_KEY?: string;
	DROPLET_SSH_PUBLIC_KEY?: string;
	DROPLET_SSH_PRIVATE_KEY?: string;
	DO_FIREWALL_NAME?: string;
	DO_FIREWALL_TAG?: string;
	MAX_DEMO_TIME_SECONDS?: string;
	LAUNCH_ALLOW_TIME_RANGE?: string;
	LAUNCH_TIMEZONE?: string;
	ASSETS?: Fetcher;
}
