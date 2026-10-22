import { env } from 'cloudflare:workers';
import {
	createExecutionContext,
	waitOnExecutionContext,
	createMessageBatch,
	createScheduledController,
	getQueueResult,
} from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from '../src/index';
import projects from '../src/projects.json';
import { DigitalOceanMockService } from '../src/digitalocean.mock';
import { DigitalOceanProdService } from '../src/digitalocean.prod';
import { getDigitalOceanService, isRealApiEnabled } from '../src/digitalocean';
import { Env, QueueMessage } from '../src/types';

// Cast test env to our strict Env interface
const testEnv = env as unknown as Env;

describe('GitHub Project Demo Launcher (Local Worker Tests)', () => {
	const testProject = projects[0]; // e.g., "awesome-shop-demo"

	beforeEach(async () => {
		// Reset and recreate the D1 table in local memory before each test
		await testEnv.mydb.prepare('DROP TABLE IF EXISTS project_demos').run();
		await testEnv.mydb
			.prepare(
				`CREATE TABLE project_demos (
                    project_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    droplet_id INTEGER,
                    droplet_ip TEXT,
                    launched_at INTEGER
                )`,
			)
			.run();
		vi.restoreAllMocks();
	});

	it('1a. POST /api/launch should reject when Turnstile token is missing', async () => {
		const req = new Request('http://localhost/api/launch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId: testProject.id }),
		});

		const ctx = createExecutionContext();
		const res = await worker.fetch(req as any, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(400);
		const data = (await res.json()) as { error: string };
		expect(data.error).toBe('Turnstile token is required');
	});

	it('1b. POST /api/launch should bypass Turnstile check in dev and enqueue launch when token is supplied', async () => {
		const sendSpy = vi.spyOn(testEnv.DEMO_LAUNCHER_QUEUE, 'send');

		const req = new Request('http://localhost/api/launch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId: testProject.id, turnstileToken: 'dev-token' }),
		});

		const ctx = createExecutionContext();
		const res = await worker.fetch(req as any, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(202);
		const data = (await res.json()) as { projectId: string; message: string };
		expect(data.projectId).toBe(testProject.id);
		expect(sendSpy).toHaveBeenCalledWith({ projectId: testProject.id });
	});

	it('1c. POST /api/launch in production should verify token with Cloudflare siteverify', async () => {
		const prodEnv: Env = {
			...testEnv,
			ENVIRONMENT: 'production',
			TURNSTILE_SECRET_KEY: 'test-secret',
		};

		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const reqFail = new Request('http://localhost/api/launch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId: testProject.id, turnstileToken: 'invalid-token' }),
		});

		const ctx1 = createExecutionContext();
		const resFail = await worker.fetch(reqFail as any, prodEnv, ctx1);
		await waitOnExecutionContext(ctx1);

		expect(resFail.status).toBe(403);
		const dataFail = (await resFail.json()) as { error: string };
		expect(dataFail.error).toBe('Turnstile verification failed');

		fetchSpy.mockResolvedValueOnce(
			new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);

		const reqSuccess = new Request('http://localhost/api/launch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId: testProject.id, turnstileToken: 'valid-token' }),
		});

		const ctx2 = createExecutionContext();
		const resSuccess = await worker.fetch(reqSuccess as any, prodEnv, ctx2);
		await waitOnExecutionContext(ctx2);

		expect(resSuccess.status).toBe(202);
	});

	it('2. Queue consumer should create a mock droplet and save IP + RUNNING status in D1', async () => {
		const createDropletSpy = vi.spyOn(DigitalOceanMockService.prototype, 'createDroplet');

		// Build a synthetic queue batch
		const batch = createMessageBatch<QueueMessage>('demo-launch-queue', [
			{
				id: 'msg-1',
				timestamp: new Date(),
				body: { projectId: testProject.id },
				attempts: 1,
			},
		]);

		const ctx = createExecutionContext();
		await worker.queue(batch, testEnv, ctx);
		const result = await getQueueResult(batch, ctx);

		// Verify queue message was acknowledged
		expect(result.ackAll).toBe(false);
		expect(result.explicitAcks).toContain('msg-1');
		expect(createDropletSpy).toHaveBeenCalledTimes(1);
		expect(createDropletSpy).toHaveBeenCalledWith(testProject.id, testProject.repoUrl);

		// Verify D1 row was updated to RUNNING with droplet info
		const row = await testEnv.mydb.prepare('SELECT * FROM project_demos WHERE project_id = ?1').bind(testProject.id).first<{
			project_id: string;
			status: string;
			droplet_id: number;
			droplet_ip: string;
			launched_at: number;
		}>();

		expect(row).not.toBeNull();
		expect(row?.status).toBe('RUNNING');
		expect(row?.droplet_id).toBeTypeOf('number');
		expect(row?.droplet_ip).toMatch(/^192\.0\.2\.\d+$/);
	});

	it('3. Mutex & D1 lock should prevent launching duplicate droplets on concurrent messages', async () => {
		const createDropletSpy = vi.spyOn(DigitalOceanMockService.prototype, 'createDroplet');

		// Simulate 2 duplicate launch messages arriving in the same batch
		const batch = createMessageBatch<QueueMessage>('demo-launch-queue', [
			{
				id: 'msg-dup-1',
				timestamp: new Date(),
				body: { projectId: testProject.id },
				attempts: 1,
			},
			{
				id: 'msg-dup-2',
				timestamp: new Date(),
				body: { projectId: testProject.id },
				attempts: 1,
			},
		]);

		const ctx = createExecutionContext();
		await worker.queue(batch, testEnv, ctx);
		const result = await getQueueResult(batch, ctx);

		// Both messages should be acked, but createDroplet MUST only run ONCE
		expect(result.explicitAcks).toEqual(['msg-dup-1', 'msg-dup-2']);
		expect(createDropletSpy).toHaveBeenCalledTimes(1);
	});

	it('4. Scheduled CRON should delete expired droplets (> 1 hour) and reset D1 status to STOPPED', async () => {
		const deleteDropletSpy = vi.spyOn(DigitalOceanMockService.prototype, 'deleteDroplet');

		const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
		const tenMinutesAgo = Date.now() - 10 * 60 * 1000;

		// Seed 1 expired demo (2 hours old) and 1 active demo (10 mins old)
		await testEnv.mydb
			.prepare(
				`INSERT INTO project_demos (project_id, status, droplet_id, droplet_ip, launched_at)
                 VALUES (?1, 'RUNNING', 111111, '192.0.2.10', ?2),
                        (?3, 'RUNNING', 222222, '192.0.2.20', ?4)`,
			)
			.bind(projects[0].id, twoHoursAgo, projects[1].id, tenMinutesAgo)
			.run();

		// Trigger the scheduled CRON handler
		const controller = createScheduledController({
			scheduledTime: new Date(),
			cron: '*/5 * * * *',
		});
		const ctx = createExecutionContext();
		await worker.scheduled(controller, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		// Only the expired droplet (111111) should be deleted
		expect(deleteDropletSpy).toHaveBeenCalledTimes(1);
		expect(deleteDropletSpy).toHaveBeenCalledWith(111111);

		// Verify expired demo is reset to STOPPED in D1
		const expiredRow = await testEnv.mydb
			.prepare('SELECT * FROM project_demos WHERE project_id = ?1')
			.bind(projects[0].id)
			.first<{ status: string; droplet_id: number | null; droplet_ip: string | null }>();

		expect(expiredRow?.status).toBe('STOPPED');
		expect(expiredRow?.droplet_id).toBeNull();
		expect(expiredRow?.droplet_ip).toBeNull();

		// Verify recent demo is still RUNNING
		const activeRow = await testEnv.mydb
			.prepare('SELECT * FROM project_demos WHERE project_id = ?1')
			.bind(projects[1].id)
			.first<{ status: string; droplet_id: number | null }>();

		expect(activeRow?.status).toBe('RUNNING');
		expect(activeRow?.droplet_id).toBe(222222);
	});

	it('5. getDigitalOceanService should connect to real DO API when DO_USE_REAL_API is true or 1', () => {
		const baseEnv: Env = {
			...testEnv,
			DO_API_KEY: 'test-real-api-key',
			ENVIRONMENT: 'development',
		};

		// Verifies truthy variants connect to real DO API in development
		const trueEnv: Env = { ...baseEnv, DO_USE_REAL_API: true };
		const oneEnv: Env = { ...baseEnv, DO_USE_REAL_API: 1 };
		const strTrueEnv: Env = { ...baseEnv, DO_USE_REAL_API: 'true' };
		const strOneEnv: Env = { ...baseEnv, DO_USE_REAL_API: '1' };

		expect(isRealApiEnabled(trueEnv)).toBe(true);
		expect(isRealApiEnabled(oneEnv)).toBe(true);
		expect(isRealApiEnabled(strTrueEnv)).toBe(true);
		expect(isRealApiEnabled(strOneEnv)).toBe(true);

		expect(getDigitalOceanService(trueEnv, 'http://localhost')).toBeInstanceOf(DigitalOceanProdService);
		expect(getDigitalOceanService(oneEnv, 'http://localhost')).toBeInstanceOf(DigitalOceanProdService);
		expect(getDigitalOceanService(strTrueEnv, 'http://localhost')).toBeInstanceOf(DigitalOceanProdService);
		expect(getDigitalOceanService(strOneEnv, 'http://localhost')).toBeInstanceOf(DigitalOceanProdService);

		// Verifies falsy or undefined values fall back to mock service in development
		const falseEnv: Env = { ...baseEnv, DO_USE_REAL_API: false };
		const zeroEnv: Env = { ...baseEnv, DO_USE_REAL_API: 0 };
		const strFalseEnv: Env = { ...baseEnv, DO_USE_REAL_API: 'false' };
		const defaultEnv: Env = { ...baseEnv, DO_USE_REAL_API: undefined };

		expect(isRealApiEnabled(falseEnv)).toBe(false);
		expect(isRealApiEnabled(zeroEnv)).toBe(false);
		expect(isRealApiEnabled(strFalseEnv)).toBe(false);
		expect(isRealApiEnabled(defaultEnv)).toBe(false);

		expect(getDigitalOceanService(falseEnv, 'http://localhost')).toBeInstanceOf(DigitalOceanMockService);
		expect(getDigitalOceanService(zeroEnv, 'http://localhost')).toBeInstanceOf(DigitalOceanMockService);
		expect(getDigitalOceanService(strFalseEnv, 'http://localhost')).toBeInstanceOf(DigitalOceanMockService);
		expect(getDigitalOceanService(defaultEnv, 'http://localhost')).toBeInstanceOf(DigitalOceanMockService);
	});
});
