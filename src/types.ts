export interface DropletInfo {
	id: number;
	ip: string;
	status: string;
}

export interface IDigitalOceanService {
	createDroplet(projectId: string, repoUrl: string): Promise<DropletInfo>;
	deleteDroplet(dropletId: number): Promise<void>;
}

export interface QueueMessage {
	projectId: string;
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
}
