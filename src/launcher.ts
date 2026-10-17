import { DurableObject } from 'cloudflare:workers';
import projects from './projects.json';
import { getDigitalOceanService } from './digitalocean';
import { Env } from './types';

/**
 * In-memory mutex to serialize asynchronous operations within a Durable Object instance.
 */
class Mutex {
	private queue: Promise<void> = Promise.resolve();

	async lock(): Promise<() => void> {
		let unlockNext!: () => void;
		const nextLock = new Promise<void>((resolve) => {
			unlockNext = resolve;
		});
		const willWait = this.queue;
		this.queue = this.queue.then(() => nextLock);
		await willWait;
		return unlockNext;
	}
}

/**
 * One Durable Object instance per project, identified by project ID.
 * Coordinates project launches and serializes concurrent requests using an instance mutex.
 */
export class ProjectLauncher extends DurableObject<Env> {
	private mutex = new Mutex();

	async launch(projectId: string): Promise<void> {
		const project = projects.find((p) => p.id === projectId);
		if (!project) {
			console.error(`[DO] Project "${projectId}" not found in src/projects.json. Skipping.`);
			return;
		}

		const unlock = await this.mutex.lock();
		try {
			const doService = getDigitalOceanService(this.env);
			const now = Date.now();

			// Atomic check-and-set: only proceed if the project is STOPPED or FAILED
			const lockResult = await this.env.mydb
				.prepare(
					`INSERT INTO project_demos (project_id, status, launched_at)
                     VALUES (?1, 'LAUNCHING', ?2)
                     ON CONFLICT(project_id) DO UPDATE
                     SET status = 'LAUNCHING', launched_at = ?2
                     WHERE project_demos.status IN ('STOPPED', 'FAILED')`,
				)
				.bind(project.id, now)
				.run();

			if (lockResult.meta.changes === 0) {
				console.log(`[DO] Project "${project.id}" is already LAUNCHING or RUNNING. Skipping.`);
				return;
			}

			console.log(`[DO] Launching DigitalOcean droplet for "${project.id}"...`);
			const droplet = await doService.createDroplet(project.id, project.repoUrl);

			await this.env.mydb
				.prepare(
					`UPDATE project_demos
                     SET status = 'RUNNING', droplet_id = ?1, droplet_ip = ?2, launched_at = ?3
                     WHERE project_id = ?4`,
				)
				.bind(droplet.id, droplet.ip, Date.now(), project.id)
				.run();

			console.log(`[DO] Project "${project.id}" is RUNNING at IP ${droplet.ip} (Droplet ID: ${droplet.id})`);
		} catch (err) {
			console.error(`[DO] Failed to launch project "${project.id}":`, err);
			await this.env.mydb
				.prepare(`UPDATE project_demos SET status = 'FAILED' WHERE project_id = ?1`)
				.bind(project.id)
				.run();
			throw err;
		} finally {
			unlock();
		}
	}
}
