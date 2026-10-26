import { DurableObject } from 'cloudflare:workers';
import projects from './projects.json';
import { getDigitalOceanService } from './digitalocean';
import { DemoStatus, DropletInfo, Env, LaunchPhase } from './types';
import { Mutex } from './mutex';
import { buildLaunchTag } from './helper';
import { isNonRetryableError } from './digitalocean-error';

/** Delay between IP polling queue messages. */
const POLL_RETRY_DELAY_SECONDS = 10;
/** Give up when DigitalOcean has not assigned a public IPv4 in this time. */
const IP_POLL_DEADLINE_MS = 5 * 60_000;

interface ProjectDemoRow {
	project_id: string;
	status: DemoStatus;
	droplet_id: number | null;
	droplet_ip: string | null;
	tags: string | null;
	launched_at: number | null;
	attempt_id: string | null;
}

interface LaunchClaim {
	attemptId: string;
	dropletId: number | null;
}

/**
 * One Durable Object instance per project, identified by project ID.
 * Coordinates project launches and serializes concurrent requests using an instance mutex.
 *
 * The launch is split into two queue phases:
 * 1. `CREATE` creates the droplet and persists its id immediately.
 * 2. `POLL_HEALTH` resolves the public IP and runs the health check.
 *
 * A redelivered queue message is the recovery mechanism: `launch()` resumes a
 * LAUNCHING row and finds an already-created droplet by its `launch-<attemptId>` tag.
 */
export class ProjectLauncher extends DurableObject<Env> {
	private mutex = new Mutex();

	/**
	 * Claims the project and creates its droplet. Returns as soon as DigitalOcean
	 * accepts the create request, then enqueues a POLL_HEALTH message.
	 *
	 * @param projectId - Project ID from `src/projects.json`
	 *
	 * @example
	 * await stub.launch('go-pos');
	 */
	async launch(projectId: string): Promise<void> {
		const project = projects.find((p) => p.id === projectId);
		if (!project) {
			console.error(`[DO] Project "${projectId}" not found in src/projects.json. Skipping.`);
			return;
		}

		const unlock = await this.mutex.lock();

		try {
			const claim = await this.claimLaunch(projectId, Date.now());
			if (!claim) {
				console.log(`[DO] Project "${projectId}" is RUNNING. Skipping.`);
				return;
			}

			if (claim.dropletId) {
				console.log(`[DO] Resuming "${projectId}" with existing Droplet ${claim.dropletId}...`);
				await this.queueAddPollMessage(projectId, claim.attemptId);
				return;
			}

			const doService = getDigitalOceanService(this.env);

			// A previous process may have created a droplet before saving its id.
			const existing = await this.findDroplet(doService, projectId, claim.attemptId);
			if (existing) {
				console.log(`[DO] Recovered Droplet ${existing.id} for "${projectId}" attempt ${claim.attemptId}.`);
				if (!(await this.saveDroplet(projectId, claim.attemptId, existing))) {
					return;
				}
				await this.queueAddPollMessage(projectId, claim.attemptId);
				return;
			}

			console.log(`[DO] Launching DigitalOcean droplet for "${projectId}"...`);
			const droplet = await doService.createDroplet(project.id, project.repoUrl, project.size, claim.attemptId);

			if (!(await this.saveDroplet(projectId, claim.attemptId, droplet))) {
				// The attempt was stopped or superseded while the create request was in flight.
				console.warn(`[DO] Attempt ${claim.attemptId} for "${projectId}" was superseded; deleting Droplet ${droplet.id}.`);
				try {
					await doService.deleteDroplet(droplet.id);
				} catch (err) {
					console.error(`[DO] Failed to delete orphaned Droplet ${droplet.id}:`, err);
				}
				return;
			}

			await this.queueAddPollMessage(projectId, claim.attemptId);

			console.log(`[DO] Droplet ${droplet.id} created for "${projectId}". IP/health polling queued.`);
		} catch (err) {
			const nonRetryable = isNonRetryableError(err);
			const row = await this.getRow(projectId);

			// A non-retryable API error is a final failure. For retryable errors,
			// only mark FAILED when no droplet was recorded; otherwise the retry
			// resumes polling on the existing droplet.
			if (row?.status === DemoStatus.LAUNCHING && (nonRetryable || !row.droplet_id)) {
				await this.markFailed(projectId, row.attempt_id);
			}

			console.error(
				`[DO] Launch attempt for "${projectId}" failed${nonRetryable ? ' (non-retryable)' : '; queue will retry'}:`,
				err,
			);

			// Return normally so the queue acks instead of retrying.
			if (nonRetryable) {
				return;
			}

			throw err;
		} finally {
			unlock();
		}
	}

	/**
	 * Resolves the droplet's public IP and runs its health check.
	 * If the IP is not assigned yet, re-enqueues itself and returns.
	 *
	 * @param projectId - Project ID
	 * @param attemptId - Launch attempt that owns this message
	 *
	 * @example
	 * await stub.pollAndHealth('go-pos', attemptId);
	 */
	async pollAndHealth(projectId: string, attemptId: string): Promise<void> {
		const unlock = await this.mutex.lock();

		try {
			let row = await this.getRow(projectId);
			if (!row || row.status !== DemoStatus.LAUNCHING || row.attempt_id !== attemptId) {
				console.log(`[DO] Ignoring stale poll message for "${projectId}" (attempt ${attemptId}).`);
				return;
			}

			const project = projects.find((p) => p.id === projectId);
			if (!project) {
				await this.markFailed(projectId, attemptId);
				return;
			}

			const doService = getDigitalOceanService(this.env);

			// The create phase may have died before saving droplet_id.
			let dropletId = row.droplet_id;
			if (!dropletId) {
				const found = await this.findDroplet(doService, projectId, attemptId);
				if (!found) {
					await this.markFailed(projectId, attemptId);
					console.error(`[DO] Droplet missing for "${projectId}" attempt ${attemptId}.`);
					return;
				}
				if (!(await this.saveDroplet(projectId, attemptId, found))) {
					return;
				}
				dropletId = found.id;
				row = { ...row, droplet_id: found.id, droplet_ip: found.ip, tags: JSON.stringify(found.tags) };
			}

			let ip = row.droplet_ip ?? '';
			let tags = row.tags ? (JSON.parse(row.tags) as string[]) : [];

			if (!ip) {
				const droplet = await doService.getDroplet(dropletId);
				if (!droplet) {
					await this.markFailed(projectId, attemptId);
					console.error(`[DO] Droplet ${dropletId} not found for "${projectId}".`);
					return;
				}

				ip = droplet.ip;
				tags = droplet.tags.length > 0 ? droplet.tags : tags;

				if (!ip) {
					const launchedAt = row.launched_at ?? Date.now();
					const elapsedMs = Date.now() - launchedAt;
					if (elapsedMs > IP_POLL_DEADLINE_MS) {
						await this.markFailed(projectId, attemptId);
						console.error(`[DO] Droplet ${dropletId} for "${projectId}" has no public IP after ${IP_POLL_DEADLINE_MS}ms.`);
						return;
					}

					const elapsedSeconds = Math.round(elapsedMs / 1000);
					console.log(
						`[DO] Droplet ${dropletId} for "${projectId}" has no public IP yet (elapsed: ${elapsedSeconds}s); polling again.`,
					);
					await this.queueAddPollMessage(projectId, attemptId);
					return;
				}

				await this.saveDroplet(projectId, attemptId, droplet);
			}

			if (await this.markRunning(projectId, attemptId, dropletId, ip, tags)) {
				console.log(`[DO] Project "${projectId}" is RUNNING at IP ${ip} (Droplet ID: ${dropletId})`);
			}
		} catch (err) {
			const nonRetryable = isNonRetryableError(err);
			console.error(
				`[DO] Poll/health failed for "${projectId}"${nonRetryable ? ' (non-retryable)' : '; queue will retry'}:`,
				err,
			);

			if (nonRetryable) {
				await this.markFailed(projectId, attemptId);
				return;
			}

			throw err;
		} finally {
			unlock();
		}
	}

	/**
	 * Moves a project into LAUNCHING. An existing LAUNCHING row is resumed with
	 * the same attempt id so a redelivered CREATE message can adopt its droplet.
	 */
	private async claimLaunch(projectId: string, now: number): Promise<LaunchClaim | null> {
		const existing = await this.getRow(projectId);

		if (existing?.status === DemoStatus.RUNNING) {
			return null;
		}

		const resuming = existing?.status === DemoStatus.LAUNCHING;
		const attemptId = resuming && existing.attempt_id ? existing.attempt_id : crypto.randomUUID();

		if (!existing) {
			await this.env.mydb
				.prepare(
					`INSERT INTO project_demos (project_id, status, launched_at, attempt_id)
                     VALUES (?1, ?2, ?3, ?4)`,
				)
				.bind(projectId, DemoStatus.LAUNCHING, now, attemptId)
				.run();

			return { attemptId, dropletId: null };
		}

		if (resuming) {
			if (!existing.attempt_id) {
				const result = await this.env.mydb
					.prepare(
						`UPDATE project_demos SET attempt_id = ?1
                         WHERE project_id = ?2 AND status = ?3`,
					)
					.bind(attemptId, projectId, DemoStatus.LAUNCHING)
					.run();

				if (result.meta.changes === 0) {
					return null;
				}
			}

			return { attemptId, dropletId: existing.droplet_id };
		}

		const result = await this.env.mydb
			.prepare(
				`UPDATE project_demos
                 SET status = ?1, launched_at = ?2, attempt_id = ?3, droplet_id = NULL, droplet_ip = NULL, tags = NULL
                 WHERE project_id = ?4 AND status IN (?5, ?6)`,
			)
			.bind(DemoStatus.LAUNCHING, now, attemptId, projectId, DemoStatus.STOPPED, DemoStatus.FAILED)
			.run();

		if (result.meta.changes === 0) {
			return null;
		}

		return { attemptId, dropletId: null };
	}

	/**
	 * Saves droplet identity without touching status. Used immediately after create.
	 *
	 * @returns true when the attempt is still LAUNCHING and was updated
	 */
	private async saveDroplet(projectId: string, attemptId: string, droplet: DropletInfo): Promise<boolean> {
		const result = await this.env.mydb
			.prepare(
				`UPDATE project_demos
                 SET droplet_id = ?1, droplet_ip = ?2, tags = ?3
                 WHERE project_id = ?4 AND attempt_id = ?5 AND status = ?6`,
			)
			.bind(droplet.id, droplet.ip, JSON.stringify(droplet.tags), projectId, attemptId, DemoStatus.LAUNCHING)
			.run();

		return result.meta.changes > 0;
	}

	/** Enqueues another IP/health message after a short delay. */
	private async queueAddPollMessage(projectId: string, attemptId: string): Promise<void> {
		await this.env.DEMO_LAUNCHER_QUEUE.send(
			{ projectId, phase: LaunchPhase.POLL_HEALTH, attemptId },
			{ delaySeconds: POLL_RETRY_DELAY_SECONDS },
		);
	}

	/**
	 * Finds a droplet for an attempt. Prefers the attempt tag, then falls back to
	 * the project tag for droplets created before attempt tracking existed.
	 */
	private async findDroplet(
		doService: ReturnType<typeof getDigitalOceanService>,
		projectId: string,
		attemptId: string,
	): Promise<DropletInfo | null> {
		const droplets = await doService.listDroplets();
		const launchTag = buildLaunchTag(attemptId);

		return (
			droplets.find((droplet) => droplet.tags.includes(launchTag)) ??
			droplets.find((droplet) => droplet.tags.includes(projectId)) ??
			null
		);
	}

	private async markRunning(
		projectId: string,
		attemptId: string,
		dropletId: number,
		ip: string,
		tags: string[],
	): Promise<boolean> {
		const result = await this.env.mydb
			.prepare(
				`UPDATE project_demos
                 SET status = ?1, droplet_id = ?2, droplet_ip = ?3, tags = ?4
                 WHERE project_id = ?5 AND attempt_id = ?6 AND status = ?7`,
			)
			.bind(DemoStatus.RUNNING, dropletId, ip, JSON.stringify(tags), projectId, attemptId, DemoStatus.LAUNCHING)
			.run();

		return result.meta.changes > 0;
	}

	private async markFailed(projectId: string, attemptId: string | null): Promise<void> {
		await this.env.mydb
			.prepare(
				`UPDATE project_demos
                 SET status = ?1
                 WHERE project_id = ?2 AND (?3 IS NULL OR attempt_id = ?3) AND status = ?4`,
			)
			.bind(DemoStatus.FAILED, projectId, attemptId, DemoStatus.LAUNCHING)
			.run();
	}

	private async getRow(projectId: string): Promise<ProjectDemoRow | null> {
		return this.env.mydb
			.prepare(
				`SELECT project_id, status, droplet_id, droplet_ip, tags, launched_at, attempt_id
                 FROM project_demos
                 WHERE project_id = ?1`,
			)
			.bind(projectId)
			.first<ProjectDemoRow>();
	}
}
