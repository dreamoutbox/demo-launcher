import { DurableObject } from 'cloudflare:workers';
import projects from './projects.json';
import { getDigitalOceanService } from './digitalocean';
import { Env } from './types';
import { Mutex } from './mutex';

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
			console.log(`\n\nenv.DO_API_KEY = ${this.env.DO_API_KEY}\n\n`);
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

			//TODO: this can be failed (DO API error / exceeds droplets limit / etc) make this not consume queue message and retry later
			//TODO: limit retry to env.DO_MAX_DROPLET_CREATE_ATTEMPT
			const droplet = await doService.createDroplet(project.id, project.repoUrl, project.size);

			await this.env.mydb
				.prepare(
					`UPDATE project_demos
                     SET status = 'RUNNING', droplet_id = ?1, droplet_ip = ?2, tags = ?3, launched_at = ?4
                     WHERE project_id = ?5`,
				)
				.bind(droplet.id, droplet.ip, JSON.stringify(droplet.tags), Date.now(), project.id)
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
