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
import { DigitalOceanMockService, resetMockDroplets } from '../src/digitalocean.mock';
import { DigitalOceanProdService, DEFAULT_FIREWALL_INBOUND_RULES, DEFAULT_FIREWALL_OUTBOUND_RULES } from '../src/digitalocean.prod';
import { DigitalOceanApiError } from '../src/digitalocean-error';
import { getDigitalOceanService, isRealApiEnabled } from '../src/digitalocean';
import {
	buildDropletTags,
	buildStartupScript,
	DEFAULT_FIREWALL_NAME,
	DEFAULT_FIREWALL_TAG,
	normalizePublicKey,
} from '../src/helper';
import { ActionLogRecord, ActionStatus, ActionType, DemoStatus, Env, LaunchPhase, QueueMessage } from '../src/types';

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
                    tags TEXT,
                    launched_at INTEGER,
                    attempt_id TEXT
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
		resetMockDroplets();
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
		expect(sendSpy).toHaveBeenCalledWith({ projectId: testProject.id, phase: LaunchPhase.CREATE });
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

	it('2. Queue consumer should create a droplet, then poll its IP and mark it RUNNING', async () => {
		const createDropletSpy = vi.spyOn(DigitalOceanMockService.prototype, 'createDroplet');
		const sendSpy = vi.spyOn(testEnv.DEMO_LAUNCHER_QUEUE, 'send');
		// Mock droplet IPs are unroutable; report the app as healthy.
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { status: 200 }));

		// Phase 1: CREATE
		const batch = createMessageBatch<QueueMessage>('demo-launch-queue', [
			{
				id: 'msg-1',
				timestamp: new Date(),
				body: { projectId: testProject.id, phase: LaunchPhase.CREATE },
				attempts: 1,
			},
		]);

		const ctx = createExecutionContext();
		await worker.queue(batch, testEnv, ctx);
		const result = await getQueueResult(batch, ctx);

		expect(result.ackAll).toBe(false);
		expect(result.explicitAcks).toContain('msg-1');
		expect(createDropletSpy).toHaveBeenCalledTimes(1);
		expect(createDropletSpy).toHaveBeenCalledWith(
			testProject.id,
			testProject.repoUrl,
			testProject.size,
			expect.any(String),
		);

		const launchedRow = await testEnv.mydb
			.prepare('SELECT * FROM project_demos WHERE project_id = ?1')
			.bind(testProject.id)
			.first<{
				status: string;
				droplet_id: number;
				droplet_ip: string;
				tags: string;
				attempt_id: string;
			}>();

		expect(launchedRow).not.toBeNull();
		expect(launchedRow?.status).toBe(DemoStatus.LAUNCHING);
		expect(launchedRow?.droplet_id).toBeTypeOf('number');
		expect(launchedRow?.droplet_ip).toBe('');
		expect(launchedRow?.attempt_id).toBeTypeOf('string');
		expect(sendSpy).toHaveBeenCalledWith(
			{ projectId: testProject.id, phase: LaunchPhase.POLL_HEALTH, attemptId: launchedRow!.attempt_id },
			{ delaySeconds: 10 },
		);

		// Phase 2: POLL_HEALTH
		const pollBatch = createMessageBatch<QueueMessage>('demo-launch-queue', [
			{
				id: 'msg-2',
				timestamp: new Date(),
				body: { projectId: testProject.id, phase: LaunchPhase.POLL_HEALTH, attemptId: launchedRow!.attempt_id },
				attempts: 1,
			},
		]);

		const pollCtx = createExecutionContext();
		await worker.queue(pollBatch, testEnv, pollCtx);
		const pollResult = await getQueueResult(pollBatch, pollCtx);

		expect(pollResult.explicitAcks).toContain('msg-2');

		const row = await testEnv.mydb
			.prepare('SELECT * FROM project_demos WHERE project_id = ?1')
			.bind(testProject.id)
			.first<{
				status: string;
				droplet_id: number;
				droplet_ip: string;
				tags: string;
			}>();

		expect(row).not.toBeNull();
		expect(row?.status).toBe(DemoStatus.RUNNING);
		expect(row?.droplet_id).toBeTypeOf('number');
		expect(row?.droplet_ip).toMatch(/^192\.0\.2\.\d+$/);
		expect(row?.tags).toBeTypeOf('string');
		const parsedTags = JSON.parse(row!.tags);
		expect(parsedTags).toEqual(expect.arrayContaining(['demo-launcher', testProject.id, 'demo-launcher-fw']));
	});

	it('3. Mutex & D1 lock should prevent launching duplicate droplets on concurrent messages', async () => {
		const createDropletSpy = vi.spyOn(DigitalOceanMockService.prototype, 'createDroplet');
		// Mock droplet IPs are unroutable; report the app as healthy.
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { status: 200 }));

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
				`INSERT INTO project_demos (project_id, status, droplet_id, droplet_ip, tags, launched_at)
                 VALUES (?1, 'RUNNING', 111111, '192.0.2.10', '["demo-launcher","test-1"]', ?2),
                        (?3, 'RUNNING', 222222, '192.0.2.20', '["demo-launcher","test-2"]', ?4)`,
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

		// Verify expired demo is reset to STOPPED in D1 with tags = NULL
		const expiredRow = await testEnv.mydb
			.prepare('SELECT * FROM project_demos WHERE project_id = ?1')
			.bind(projects[0].id)
			.first<{ status: string; droplet_id: number | null; droplet_ip: string | null; tags: string | null }>();

		expect(expiredRow?.status).toBe('STOPPED');
		expect(expiredRow?.droplet_id).toBeNull();
		expect(expiredRow?.droplet_ip).toBeNull();
		expect(expiredRow?.tags).toBeNull();

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
			if (typeof url === 'string' && url.includes('/firewalls') && (!init || init.method === 'GET')) {
				return new Response(
					JSON.stringify({
						firewalls: [{ id: 'fw-1', name: 'demo-launcher-fw', tags: ['demo-launcher-fw'] }],
					}),
					{ status: 200 },
				);
			}
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
	}, 15000);

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

	it('13. DigitalOceanProdService.createDroplet should include ssh_keys and firewall tags in payload', async () => {
		const targetKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKeyForDroplet';
		let dropletPostBody: any = null;

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			if (typeof url === 'string' && url.includes('/firewalls') && (!init || init.method === 'GET')) {
				return new Response(
					JSON.stringify({
						firewalls: [{ id: 'fw-123', name: 'demo-launcher-fw', tags: ['demo-launcher-fw'] }],
					}),
					{ status: 200 },
				);
			}
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

		const droplet = await service.createDroplet(
			'test-ssh-proj',
			'https://github.com/example/repo.git',
			undefined,
			'attempt-123',
		);
		expect(droplet.id).toBe(888888);
		expect(droplet.ip).toBe('');
		expect(droplet.tags).toEqual(['demo-launcher', 'test-ssh-proj', 'demo-launcher-fw', 'launch-attempt-123']);
		expect(dropletPostBody).not.toBeNull();
		expect(dropletPostBody.ssh_keys).toEqual([54321]);
		expect(dropletPostBody.tags).toEqual([
			'demo-launcher',
			'test-ssh-proj',
			'demo-launcher-fw',
			'launch-attempt-123',
		]);
	}, 15000);

	it('14. ensureFirewall should return existing firewall ID and cache it without creating new firewall', async () => {
		let listCalls = 0;
		let postCalls = 0;

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			if (typeof url === 'string' && url.includes('/firewalls') && (!init || init.method === 'GET')) {
				listCalls++;
				return new Response(
					JSON.stringify({
						firewalls: [
							{
								id: 'fw-existing-id',
								name: 'demo-launcher-fw',
								tags: ['demo-launcher-fw'],
								inbound_rules: DEFAULT_FIREWALL_INBOUND_RULES,
							},
						],
					}),
					{ status: 200 },
				);
			}
			if (typeof url === 'string' && url.includes('/firewalls') && init?.method === 'POST') {
				postCalls++;
				return new Response(JSON.stringify({ firewall: { id: 'fw-unexpected' } }), { status: 201 });
			}
			return new Response('Not found', { status: 404 });
		});

		const service = new DigitalOceanProdService('test-key');
		const fwId1 = await service.ensureFirewall();
		const fwId2 = await service.ensureFirewall();

		expect(fwId1).toBe('fw-existing-id');
		expect(fwId2).toBe('fw-existing-id');
		expect(listCalls).toBe(1);
		expect(postCalls).toBe(0);
	});

	it('15. ensureFirewall should add tag to existing firewall if tag is missing', async () => {
		let tagAdded = false;

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			if (typeof url === 'string' && url.includes('/firewalls?per_page=200') && (!init || init.method === 'GET')) {
				return new Response(
					JSON.stringify({
						firewalls: [
							{
								id: 'fw-missing-tag',
								name: 'demo-launcher-fw',
								tags: [],
								inbound_rules: DEFAULT_FIREWALL_INBOUND_RULES,
							},
						],
					}),
					{ status: 200 },
				);
			}
			if (typeof url === 'string' && url.includes('/firewalls/fw-missing-tag/tags') && init?.method === 'POST') {
				const body = JSON.parse(init.body as string);
				if (body.tags?.includes('demo-launcher-fw')) {
					tagAdded = true;
				}
				return new Response(null, { status: 204 });
			}
			return new Response('Not found', { status: 404 });
		});

		const service = new DigitalOceanProdService('test-key');
		const fwId = await service.ensureFirewall();

		expect(fwId).toBe('fw-missing-tag');
		expect(tagAdded).toBe(true);
	});

	it('16. ensureFirewall should ensure tag and create firewall with default rules when missing', async () => {
		let tagCreated = false;
		let firewallCreated = false;
		let createdPayload: any = null;

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			if (typeof url === 'string' && url.includes('/firewalls?per_page=200') && (!init || init.method === 'GET')) {
				return new Response(JSON.stringify({ firewalls: [] }), { status: 200 });
			}
			if (typeof url === 'string' && url.includes('/tags') && init?.method === 'POST') {
				const body = JSON.parse(init.body as string);
				if (body.name === 'demo-launcher-fw') {
					tagCreated = true;
				}
				return new Response(JSON.stringify({ tag: { name: 'demo-launcher-fw' } }), { status: 201 });
			}
			if (typeof url === 'string' && url.includes('/firewalls') && init?.method === 'POST') {
				firewallCreated = true;
				createdPayload = JSON.parse(init.body as string);
				return new Response(
					JSON.stringify({
						firewall: {
							id: 'fw-created-new-id',
							name: 'demo-launcher-fw',
							tags: ['demo-launcher-fw'],
						},
					}),
					{ status: 201 },
				);
			}
			return new Response('Not found', { status: 404 });
		});

		const service = new DigitalOceanProdService('test-key');
		const fwId = await service.ensureFirewall();

		expect(fwId).toBe('fw-created-new-id');
		expect(tagCreated).toBe(true);
		expect(firewallCreated).toBe(true);
		expect(createdPayload.name).toBe('demo-launcher-fw');
		expect(createdPayload.tags).toEqual(['demo-launcher-fw']);
		expect(createdPayload.inbound_rules).toEqual(DEFAULT_FIREWALL_INBOUND_RULES);
		expect(createdPayload.outbound_rules).toEqual(DEFAULT_FIREWALL_OUTBOUND_RULES);
	});

	it('17. ensureFirewall should handle creation conflict race condition by re-listing and matching name', async () => {
		let listAttempt = 0;

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			if (typeof url === 'string' && url.includes('/firewalls?per_page=200') && (!init || init.method === 'GET')) {
				listAttempt++;
				if (listAttempt === 1) {
					return new Response(JSON.stringify({ firewalls: [] }), { status: 200 });
				}
				return new Response(
					JSON.stringify({
						firewalls: [{ id: 'fw-race-resolved', name: 'demo-launcher-fw', tags: ['demo-launcher-fw'] }],
					}),
					{ status: 200 },
				);
			}
			if (typeof url === 'string' && url.includes('/tags') && init?.method === 'POST') {
				return new Response(JSON.stringify({}), { status: 201 });
			}
			if (typeof url === 'string' && url.includes('/firewalls') && init?.method === 'POST') {
				return new Response(JSON.stringify({ id: 'unprocessable_entity', message: 'Name in use' }), { status: 422 });
			}
			return new Response('Not found', { status: 404 });
		});

		const service = new DigitalOceanProdService('test-key');
		const fwId = await service.ensureFirewall();

		expect(fwId).toBe('fw-race-resolved');
		expect(listAttempt).toBe(2);
	});

	it('18. getDigitalOceanService should apply DO_FIREWALL_NAME and DO_FIREWALL_TAG overrides', async () => {
		const customEnv: Env = {
			...testEnv,
			DO_USE_REAL_API: false,
			ENVIRONMENT: 'development',
			DO_FIREWALL_NAME: 'custom-fw',
			DO_FIREWALL_TAG: 'custom-fw-tag',
		};

		const service = getDigitalOceanService(customEnv);
		const droplet = await service.createDroplet('test-proj', 'https://github.com/example/repo.git');

		expect(droplet.tags).toEqual(['demo-launcher', 'test-proj', 'custom-fw-tag']);
	});

	it('19. POST /api/launch should reject request with 403 and log action when current time is outside LAUNCH_ALLOW_TIME_RANGE schedule', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-22T04:00:00Z')); // 04:00 UTC is outside 07:00-20:00 and 21:00-23:00

		const scheduledEnv: Env = {
			...testEnv,
			LAUNCH_ALLOW_TIME_RANGE: '07:00:00-20:00:00,21:00:00-23:00:00',
		};

		const req = new Request('http://localhost/api/launch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId: testProject.id, turnstileToken: 'dev-token' }),
		});

		const ctx = createExecutionContext();
		const res = await worker.fetch(req as any, scheduledEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(403);
		const data = (await res.json()) as { error: string; allowedRanges: string };
		expect(data.error).toBe('Launch requests are outside the allowed time schedule');
		expect(data.allowedRanges).toBe('07:00:00-20:00:00,21:00:00-23:00:00');

		// Verify audit log entry
		const logged = await testEnv.mydb
			.prepare('SELECT * FROM action_logs WHERE project_id = ?1 ORDER BY created_at DESC LIMIT 1')
			.bind(testProject.id)
			.first<ActionLogRecord>();

		expect(logged).not.toBeNull();
		expect(logged?.status).toBe(ActionStatus.REJECTED);
		expect(logged?.action).toBe(ActionType.LAUNCH_DEMO);
		expect(logged?.details).toContain('outside the allowed time schedule');

		vi.useRealTimers();
	});

	it('20. POST /api/launch should permit request when current time is within LAUNCH_ALLOW_TIME_RANGE schedule', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-22T12:00:00Z')); // 12:00 UTC is within 07:00-20:00

		const sendSpy = vi.spyOn(testEnv.DEMO_LAUNCHER_QUEUE, 'send');

		const scheduledEnv: Env = {
			...testEnv,
			LAUNCH_ALLOW_TIME_RANGE: '07:00:00-20:00:00,21:00:00-23:00:00',
		};

		const req = new Request('http://localhost/api/launch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ projectId: testProject.id, turnstileToken: 'dev-token' }),
		});

		const ctx = createExecutionContext();
		const res = await worker.fetch(req as any, scheduledEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(202);
		const data = (await res.json()) as { projectId: string; message: string };
		expect(data.projectId).toBe(testProject.id);
		expect(sendSpy).toHaveBeenCalledWith({ projectId: testProject.id, phase: LaunchPhase.CREATE });

		vi.useRealTimers();
	});

	it('21. redelivered CREATE should adopt an existing tagged droplet instead of creating another', async () => {
		const doService = new DigitalOceanMockService();
		const existingDroplet = await doService.createDroplet(
			testProject.id,
			testProject.repoUrl,
			testProject.size,
			'retry-attempt',
		);

		const createDropletSpy = vi.spyOn(DigitalOceanMockService.prototype, 'createDroplet');
		const sendSpy = vi.spyOn(testEnv.DEMO_LAUNCHER_QUEUE, 'send');

		// Simulate a crash after the droplet was created but before its id was saved.
		await testEnv.mydb
			.prepare(
				`INSERT INTO project_demos (project_id, status, launched_at, attempt_id)
                 VALUES (?1, 'LAUNCHING', ?2, 'retry-attempt')`,
			)
			.bind(testProject.id, Date.now() - 60_000)
			.run();

		const batch = createMessageBatch<QueueMessage>('demo-launch-queue', [
			{
				id: 'msg-retry',
				timestamp: new Date(),
				body: { projectId: testProject.id, phase: LaunchPhase.CREATE },
				attempts: 1,
			},
		]);

		const ctx = createExecutionContext();
		await worker.queue(batch, testEnv, ctx);
		const result = await getQueueResult(batch, ctx);

		expect(result.explicitAcks).toContain('msg-retry');
		expect(createDropletSpy).not.toHaveBeenCalled();
		expect(sendSpy).toHaveBeenCalledWith(
			{ projectId: testProject.id, phase: LaunchPhase.POLL_HEALTH, attemptId: 'retry-attempt' },
			{ delaySeconds: 10 },
		);

		const row = await testEnv.mydb
			.prepare('SELECT * FROM project_demos WHERE project_id = ?1')
			.bind(testProject.id)
			.first<{ status: string; droplet_id: number | null; attempt_id: string }>();

		expect(row?.status).toBe(DemoStatus.LAUNCHING);
		expect(row?.droplet_id).toBe(existingDroplet.id);
		expect(row?.attempt_id).toBe('retry-attempt');
	});

	it('22. non-retryable 422 should mark FAILED and ack instead of retrying', async () => {
		vi.spyOn(DigitalOceanMockService.prototype, 'createDroplet').mockRejectedValue(
			new DigitalOceanApiError('DigitalOcean createDroplet failed (422): droplet limit', 422),
		);

		const batch = createMessageBatch<QueueMessage>('demo-launch-queue', [
			{
				id: 'msg-422',
				timestamp: new Date(),
				body: { projectId: testProject.id, phase: LaunchPhase.CREATE },
				attempts: 1,
			},
		]);

		const ctx = createExecutionContext();
		await worker.queue(batch, testEnv, ctx);
		const result = await getQueueResult(batch, ctx);

		expect(result.explicitAcks).toContain('msg-422');
		expect(result.retryMessages).toEqual([]);

		const row = await testEnv.mydb
			.prepare('SELECT * FROM project_demos WHERE project_id = ?1')
			.bind(testProject.id)
			.first<{ status: string }>();

		expect(row?.status).toBe(DemoStatus.FAILED);
	});

	it('23. admin stop should delete an orphaned droplet by project tag when droplet_id is missing', async () => {
		const doService = new DigitalOceanMockService();
		const orphan = await doService.createDroplet(
			testProject.id,
			testProject.repoUrl,
			testProject.size,
			'orphan-attempt',
		);

		await testEnv.mydb
			.prepare(
				`INSERT INTO project_demos (project_id, status, launched_at, attempt_id)
                 VALUES (?1, 'LAUNCHING', ?2, 'orphan-attempt')`,
			)
			.bind(testProject.id, Date.now())
			.run();

		const deleteDropletSpy = vi.spyOn(DigitalOceanMockService.prototype, 'deleteDroplet');

		const req = new Request('http://localhost/api/admin/stop', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'x-admin-key': 'test-admin-key' },
			body: JSON.stringify({ projectId: testProject.id }),
		});

		const ctx = createExecutionContext();
		const res = await worker.fetch(req as any, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(res.status).toBe(200);
		expect(deleteDropletSpy).toHaveBeenCalledWith(orphan.id);

		const row = await testEnv.mydb
			.prepare('SELECT * FROM project_demos WHERE project_id = ?1')
			.bind(testProject.id)
			.first<{ status: string; droplet_id: number | null; attempt_id: string | null }>();

		expect(row?.status).toBe(DemoStatus.STOPPED);
		expect(row?.droplet_id).toBeNull();
		expect(row?.attempt_id).toBeNull();
	});

	it('24. GET /api/health-check should require ip parameter and return probe status', async () => {
		// Missing IP
		const reqNoIp = new Request('http://localhost/api/health-check', { method: 'GET' });
		const ctxNoIp = createExecutionContext();
		const resNoIp = await worker.fetch(reqNoIp as any, testEnv, ctxNoIp);
		await waitOnExecutionContext(ctxNoIp);

		expect(resNoIp.status).toBe(400);
		const jsonNoIp = await resNoIp.json();
		expect(jsonNoIp).toEqual({ error: 'Missing ip parameter' });

		// With IP and invalid port to test error response path
		const reqInvalid = new Request('http://localhost/api/health-check?ip=1.2.3.4&port=invalid', { method: 'GET' });
		const ctxInvalid = createExecutionContext();
		const resInvalid = await worker.fetch(reqInvalid as any, testEnv, ctxInvalid);
		await waitOnExecutionContext(ctxInvalid);

		expect(resInvalid.status).toBe(200);
		const jsonInvalid = (await resInvalid.json()) as { healthy: boolean; error?: string };
		expect(jsonInvalid.healthy).toBe(false);
		expect(jsonInvalid.error).toContain('Invalid port');
	});
});
