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
import { buildStartupScript, normalizePublicKey } from '../src/helper';
import { ActionLogRecord, ActionStatus, ActionType, Env, QueueMessage } from '../src/types';

// Cast test env to our strict Env interface
const testEnv = env as unknown as Env;

describe('GitHub Project Demo Launcher (Local Worker Tests)', () => {
	const testProject = projects[0]; // e.g., "awesome-shop-demo"

	beforeEach(async () => {
		// Reset and recreate the D1 tables in local memory before each test
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

		await testEnv.mydb.prepare('DROP TABLE IF EXISTS action_logs').run();
		await testEnv.mydb
			.prepare(
				`CREATE TABLE action_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    action TEXT NOT NULL,
                    project_id TEXT,
                    ip_address TEXT,
                    country TEXT,
                    user_agent TEXT,
                    status TEXT NOT NULL,
                    details TEXT,
                    created_at INTEGER NOT NULL
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

		const activeProjectId = projects[1]?.id ?? 'test-active-project';

		// Seed 1 expired demo (2 hours old) and 1 active demo (10 mins old)
		await testEnv.mydb
			.prepare(
				`INSERT INTO project_demos (project_id, status, droplet_id, droplet_ip, launched_at)
                 VALUES (?1, 'RUNNING', 111111, '192.0.2.10', ?2),
                        (?3, 'RUNNING', 222222, '192.0.2.20', ?4)`,
			)
			.bind(projects[0].id, twoHoursAgo, activeProjectId, tenMinutesAgo)
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
			.bind(activeProjectId)
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

	it('6. buildStartupScript should ensure ./demo-launcher dir exists and pipe command output to ./demo-launcher/startup.log', () => {
		const script = buildStartupScript('https://github.com/example/repo.git');

		expect(script).toContain('mkdir -p ./demo-launcher');
		expect(script).toContain('} 2>&1 | tee ./demo-launcher/startup.log');
		expect(script).toContain('git clone "https://github.com/example/repo.git" /opt/demo-app');
	});

	it('7. DigitalOceanProdService should use region, size, and image from config or fallback to defaults', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			if (typeof url === 'string' && url.includes('/droplets') && init?.method === 'POST') {
				const body = JSON.parse(init.body as string);
				return new Response(JSON.stringify({ droplet: { id: 999999 } }), { status: 200 });
			}
			// Droplet polling response
			return new Response(
				JSON.stringify({
					droplet: {
						id: 999999,
						status: 'active',
						networks: { v4: [{ ip_address: '203.0.113.1', type: 'public' }] },
					},
				}),
				{ status: 200 },
			);
		});

		// Custom config from env
		const customService = new DigitalOceanProdService('test-key', {
			region: 'nyc1',
			size: 's-2vcpu-4gb',
			image: 'debian-12-x64',
		});
		await customService.createDroplet('test-proj', 'https://github.com/example/repo.git');

		const postCall = fetchSpy.mock.calls.find(
			(call) => typeof call[0] === 'string' && call[0].includes('/droplets') && call[1]?.method === 'POST',
		);
		const postedBody = JSON.parse(postCall![1]!.body as string);
		expect(postedBody.region).toBe('nyc1');
		expect(postedBody.size).toBe('s-2vcpu-4gb');
		expect(postedBody.image).toBe('debian-12-x64');
	});

	it('8. POST /api/launch should log action requests in action_logs table', async () => {
		// Test rejected launch logs
		const rejectReq = new Request('http://localhost/api/launch', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'CF-Connecting-IP': '198.51.100.42',
				'CF-IPCountry': 'SG',
				'User-Agent': 'TestBrowser/1.0',
			},
			body: JSON.stringify({ projectId: testProject.id }),
		});

		const ctx1 = createExecutionContext();
		const res1 = await worker.fetch(rejectReq as any, testEnv, ctx1);
		await waitOnExecutionContext(ctx1);
		expect(res1.status).toBe(400);

		const { results: rejectedLogs } = await testEnv.mydb
			.prepare('SELECT * FROM action_logs WHERE ip_address = ?1')
			.bind('198.51.100.42')
			.all<ActionLogRecord>();

		expect(rejectedLogs.length).toBe(1);
		expect(rejectedLogs[0].action).toBe(ActionType.LAUNCH_DEMO);
		expect(rejectedLogs[0].status).toBe(ActionStatus.REJECTED);
		expect(rejectedLogs[0].country).toBe('SG');
		expect(rejectedLogs[0].user_agent).toBe('TestBrowser/1.0');

		// Test queued launch logs
		const queuedReq = new Request('http://localhost/api/launch', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'CF-Connecting-IP': '203.0.113.88',
				'CF-IPCountry': 'JP',
				'User-Agent': 'Mozilla/5.0 DemoClient',
			},
			body: JSON.stringify({ projectId: testProject.id, turnstileToken: 'dev-token' }),
		});

		const ctx2 = createExecutionContext();
		const res2 = await worker.fetch(queuedReq as any, testEnv, ctx2);
		await waitOnExecutionContext(ctx2);
		expect(res2.status).toBe(202);

		const { results: queuedLogs } = await testEnv.mydb
			.prepare('SELECT * FROM action_logs WHERE ip_address = ?1')
			.bind('203.0.113.88')
			.all<ActionLogRecord>();

		expect(queuedLogs.length).toBe(1);
		expect(queuedLogs[0].action).toBe(ActionType.LAUNCH_DEMO);
		expect(queuedLogs[0].status).toBe(ActionStatus.QUEUED);
		expect(queuedLogs[0].project_id).toBe(testProject.id);
		expect(queuedLogs[0].country).toBe('JP');
	});

	it('9. GET /api/admin/action-logs should require ADMIN_KEY and return logs', async () => {
		// Populate some log records first
		await testEnv.mydb
			.prepare(
				`INSERT INTO action_logs (action, project_id, ip_address, country, user_agent, status, details, created_at)
                 VALUES ('LAUNCH_DEMO', 'awesome-shop-demo', '192.0.2.1', 'US', 'TestAgent', 'QUEUED', 'Queued', ?1)`,
			)
			.bind(Date.now())
			.run();

		// Request without admin key -> 401
		const unauthReq = new Request('http://localhost/api/admin/action-logs', { method: 'GET' });
		const ctx1 = createExecutionContext();
		const unauthRes = await worker.fetch(unauthReq as any, testEnv, ctx1);
		await waitOnExecutionContext(ctx1);
		expect(unauthRes.status).toBe(401);

		// Request with invalid admin key -> 401
		const badKeyReq = new Request('http://localhost/api/admin/action-logs', {
			method: 'GET',
			headers: { 'x-admin-key': 'wrong-key' },
		});
		const ctx2 = createExecutionContext();
		const badKeyRes = await worker.fetch(badKeyReq as any, testEnv, ctx2);
		await waitOnExecutionContext(ctx2);
		expect(badKeyRes.status).toBe(401);

		// Request with valid admin key in x-admin-key header -> 200
		const headerReq = new Request('http://localhost/api/admin/action-logs', {
			method: 'GET',
			headers: { 'x-admin-key': 'test-admin-key' },
		});
		const ctx3 = createExecutionContext();
		const headerRes = await worker.fetch(headerReq as any, testEnv, ctx3);
		await waitOnExecutionContext(ctx3);
		expect(headerRes.status).toBe(200);
		const headerData = (await headerRes.json()) as { logs: ActionLogRecord[]; total: number };
		expect(headerData.total).toBeGreaterThanOrEqual(1);
		expect(headerData.logs[0].project_id).toBe('awesome-shop-demo');

		// Request with valid admin key in Authorization Bearer header -> 200
		const bearerReq = new Request('http://localhost/api/admin/action-logs', {
			method: 'GET',
			headers: { Authorization: 'Bearer test-admin-key' },
		});
		const ctx4 = createExecutionContext();
		const bearerRes = await worker.fetch(bearerReq as any, testEnv, ctx4);
		await waitOnExecutionContext(ctx4);
		expect(bearerRes.status).toBe(200);

		// Request with valid admin key in query parameter -> 200
		const queryReq = new Request('http://localhost/api/admin/action-logs?key=test-admin-key', {
			method: 'GET',
		});
		const ctx5 = createExecutionContext();
		const queryRes = await worker.fetch(queryReq as any, testEnv, ctx5);
		await waitOnExecutionContext(ctx5);
		expect(queryRes.status).toBe(200);
	});

	it('10. normalizePublicKey should extract key type and base64 material, omitting comment and whitespace', () => {
		const rawWithComment = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleUser123 demo-launcher@cloud';
		expect(normalizePublicKey(rawWithComment)).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleUser123');

		const rawWithoutComment = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleUser123';
		expect(normalizePublicKey(rawWithoutComment)).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleUser123');

		const withExtraWhitespace = '   ssh-ed25519   AAAAC3NzaC1lZDI1NTE5AAAAIExampleUser123   comment  ';
		expect(normalizePublicKey(withExtraWhitespace)).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleUser123');
	});

	it('11. ensureSshKey should return existing SSH key ID without creating new key when already present in DO', async () => {
		const targetKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExistingKey123 demo-launcher';
		let getCount = 0;
		let postCount = 0;

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			if (typeof url === 'string' && url.includes('/account/keys') && (!init || init.method === 'GET')) {
				getCount++;
				return new Response(
					JSON.stringify({
						ssh_keys: [
							{
								id: 112233,
								fingerprint: '3b:16:bf:e4:8b:00:8b:b8:59:8c:a9:d3:f0:19:be:02',
								public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExistingKey123 different-comment',
								name: 'existing-key',
							},
						],
					}),
					{ status: 200 },
				);
			}
			if (typeof url === 'string' && url.includes('/account/keys') && init?.method === 'POST') {
				postCount++;
				return new Response(JSON.stringify({ ssh_key: { id: 999999 } }), { status: 201 });
			}
			return new Response('Not found', { status: 404 });
		});

		const service = new DigitalOceanProdService('test-key', { sshPublicKey: targetKey });
		const keyId = await service.ensureSshKey(targetKey);

		expect(keyId).toBe(112233);
		expect(getCount).toBe(1);
		expect(postCount).toBe(0);

		// Second call should return cached key without fetching again
		const cachedKeyId = await service.ensureSshKey(targetKey);
		expect(cachedKeyId).toBe(112233);
		expect(getCount).toBe(1);
	});

	it('12. ensureSshKey should POST new key to DO account when not found in existing list', async () => {
		const targetKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINewKey456 demo-launcher';
		let getCount = 0;
		let postedBody: any = null;

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			if (typeof url === 'string' && url.includes('/account/keys') && (!init || init.method === 'GET')) {
				getCount++;
				return new Response(JSON.stringify({ ssh_keys: [] }), { status: 200 });
			}
			if (typeof url === 'string' && url.includes('/account/keys') && init?.method === 'POST') {
				postedBody = JSON.parse(init.body as string);
				return new Response(
					JSON.stringify({
						ssh_key: {
							id: 778899,
							fingerprint: 'aa:bb:cc:dd',
							public_key: targetKey,
							name: postedBody.name,
						},
					}),
					{ status: 201 },
				);
			}
			return new Response('Not found', { status: 404 });
		});

		const service = new DigitalOceanProdService('test-key', { sshPublicKey: targetKey });
		const keyId = await service.ensureSshKey(targetKey);

		expect(keyId).toBe(778899);
		expect(getCount).toBe(1);
		expect(postedBody).not.toBeNull();
		expect(postedBody.public_key).toBe(targetKey);
	});

	it('13. DigitalOceanProdService.createDroplet should include ssh_keys in payload when sshPublicKey is set', async () => {
		const targetKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKeyForDroplet';
		let dropletPostBody: any = null;

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			if (typeof url === 'string' && url.includes('/account/keys') && (!init || init.method === 'GET')) {
				return new Response(
					JSON.stringify({
						ssh_keys: [{ id: 54321, public_key: targetKey }],
					}),
					{ status: 200 },
				);
			}
			if (typeof url === 'string' && url.includes('/droplets') && init?.method === 'POST') {
				dropletPostBody = JSON.parse(init.body as string);
				return new Response(JSON.stringify({ droplet: { id: 888888 } }), { status: 200 });
			}
			// Polling GET
			return new Response(
				JSON.stringify({
					droplet: {
						id: 888888,
						status: 'active',
						networks: { v4: [{ ip_address: '203.0.113.88', type: 'public' }] },
					},
				}),
				{ status: 200 },
			);
		});

		const service = new DigitalOceanProdService('test-key', {
			region: 'sgp1',
			size: 's-1vcpu-1gb',
			image: 'ubuntu-24-04-x64',
			sshPublicKey: targetKey,
		});

		const droplet = await service.createDroplet('test-ssh-proj', 'https://github.com/example/repo.git');
		expect(droplet.id).toBe(888888);
		expect(droplet.ip).toBe('203.0.113.88');
		expect(dropletPostBody).not.toBeNull();
		expect(dropletPostBody.ssh_keys).toEqual([54321]);
	});
});
