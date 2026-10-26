let maxDemoTimeLabel = '-';

/**
 * Format seconds as a short label. Example: formatSeconds(1800) -> '30 minutes'
 */
function formatSeconds(seconds) {
	if (seconds % 3600 === 0) return `${seconds / 3600} hour(s)`;
	if (seconds % 60 === 0) return `${seconds / 60} minutes`;
	return `${seconds} seconds`;
}
let pollTimer = null;
let uptimeTimer = null;
let activeProjectId = null;
let activeLaunchedAt = null;
let launchRequestedAt = null;
let cachedProjects = [];

const listView = document.getElementById('list-view');
const detailView = document.getElementById('detail-view');
const projectsContainer = document.getElementById('projects-container');
const backBtn = document.getElementById('back-btn');

const detailTitle = document.getElementById('detail-title');
const detailRepo = document.getElementById('detail-repo');
const detailStatus = document.getElementById('detail-status');
const detailIp = document.getElementById('detail-ip');
const detailUptime = document.getElementById('detail-uptime');
const detailMaxTime = document.getElementById('detail-max-time');
const detailHealthRow = document.getElementById('detail-health-row');
const detailHealth = document.getElementById('detail-health');
const openIpContainer = document.getElementById('open-ip-container');
const openIpBtn = document.getElementById('open-ip-btn');
const detailReadme = document.getElementById('detail-readme');
const launchNote = document.getElementById('launch-note');
const turnstileError = document.getElementById('turnstile-error');

let healthTimer = null;

function stopHealthCheck() {
	if (healthTimer) {
		clearTimeout(healthTimer);
		healthTimer = null;
	}
}

async function probeAppHealth(projectId, ip) {
	if (!activeProjectId || activeProjectId !== projectId || !ip) {
		stopHealthCheck();
		return;
	}

	const project = cachedProjects.find((p) => p.id === projectId);
	const port = project?.healthcheckPort || project?.appPort || '80';
	const path = project?.healthcheckPath || '/';

	try {
		const res = await fetch(`/api/health-check?ip=${encodeURIComponent(ip)}&port=${encodeURIComponent(port)}&path=${encodeURIComponent(path)}`);
		const data = await res.json();
		if (!activeProjectId || activeProjectId !== projectId) return;

		if (data.healthy) {
			detailHealth.textContent = 'Ready (HTTP 200)';
			detailHealth.className = 'status-running';
			launchNote.classList.add('hidden');
			stopHealthCheck();
			return;
		}

		detailHealth.textContent = data.status ? `Starting up (HTTP ${data.status})...` : 'Starting up (booting app)...';
		detailHealth.className = 'status-launching';
	} catch {
		if (!activeProjectId || activeProjectId !== projectId) return;
		detailHealth.textContent = 'Starting up...';
		detailHealth.className = 'status-launching';
	}

	healthTimer = setTimeout(() => probeAppHealth(projectId, ip), 3000);
}

/**
 * Applies the status color class and text to an element.
 * Example: setStatus(el, 'RUNNING') -> green "RUNNING" text
 */
function setStatus(element, status) {
	element.textContent = status;
	element.className = `status-${status.toLowerCase()}`;
}

function statusClass(status) {
	return `status-${String(status).toLowerCase()}`;
}

/**
 * Formats milliseconds as "1h 12m 5s" / "4s".
 * Example: formatUptime(65000) -> '1m 5s'
 */
function formatUptime(ms) {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	const parts = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
	parts.push(`${seconds}s`);
	return parts.join(' ');
}

/**
 * Updates the uptime label locally every second from the last known launched_at.
 */
function updateUptime() {
	detailUptime.textContent = activeLaunchedAt === null ? '-' : formatUptime(Date.now() - activeLaunchedAt);
}

/**
 * Schedules the next status poll. Frequent polling is only needed while launching;
 * running/stopped demos are checked occasionally.
 * launchRequestedAt covers the short race where the queue consumer has not yet
 * marked the demo LAUNCHING right after the launch request returns.
 */
function scheduleNextPoll(status) {
	const waitingForLaunch = launchRequestedAt !== null && Date.now() - launchRequestedAt < 30000;
	const frequent = status === 'LAUNCHING' || (!status && waitingForLaunch) || (status === 'STOPPED' && waitingForLaunch);
	if (pollTimer) clearTimeout(pollTimer);
	pollTimer = setTimeout(pollProjectStatus, frequent ? 2000 : 30000);
}

let currentTurnstileToken = null;
let turnstileWidgetId = null;
let turnstileApiPromise = null;

// Turnstile callbacks used by the explicitly rendered widget
window.onTurnstileSuccess = function (token) {
	currentTurnstileToken = token;
	clearTurnstileError();
};

window.onTurnstileExpired = function () {
	currentTurnstileToken = null;
};

window.onTurnstileError = function () {
	currentTurnstileToken = null;
	showTurnstileError('Turnstile challenge encountered an error. Please retry.');
};

function showTurnstileError(msg) {
	if (turnstileError) {
		turnstileError.textContent = msg;
		turnstileError.classList.remove('hidden');
	}
}

function clearTurnstileError() {
	if (turnstileError) {
		turnstileError.textContent = '';
		turnstileError.classList.add('hidden');
	}
}

function resetTurnstile() {
	currentTurnstileToken = null;
	clearTurnstileError();
	if (window.turnstile && typeof window.turnstile.reset === 'function') {
		try {
			window.turnstile.reset(turnstileWidgetId);
		} catch (err) {
			console.warn('Turnstile reset error:', err);
		}
	}
}

function loadTurnstileApi() {
	if (window.turnstile) return Promise.resolve();
	if (turnstileApiPromise) return turnstileApiPromise;

	turnstileApiPromise = new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
		script.async = true;
		script.onload = () => (window.turnstile ? resolve() : reject(new Error('Turnstile API failed to load.')));
		script.onerror = () => reject(new Error('Turnstile API failed to load.'));
		document.head.appendChild(script);
	});

	return turnstileApiPromise;
}

async function renderTurnstile(siteKey) {
	if (!siteKey) {
		showTurnstileError('Turnstile is unavailable because its site key was not provided.');
		return;
	}

	try {
		await loadTurnstileApi();
		if (turnstileWidgetId !== null) return;

		turnstileWidgetId = window.turnstile.render('#turnstile-widget', {
			sitekey: siteKey,
			callback: window.onTurnstileSuccess,
			'expired-callback': window.onTurnstileExpired,
			'error-callback': window.onTurnstileError,
		});
	} catch (err) {
		showTurnstileError(err.message);
	}
}

// Load initial project list
async function loadProjectList() {
	try {
		const res = await fetch('/api/projects');
		const data = await res.json();
		renderTurnstile(data.turnstileSiteKey);
		cachedProjects = data.projects || [];
		if (typeof data.maxDemoTimeSeconds === 'number') maxDemoTimeLabel = formatSeconds(data.maxDemoTimeSeconds);
		const statuses = data.statuses || [];

		if (cachedProjects.length === 0) {
			projectsContainer.textContent = 'No projects found in src/projects.json.';
			return;
		}

		projectsContainer.innerHTML = '';

		cachedProjects.forEach((project) => {
			const state = statuses.find((s) => s.project_id === project.id);
			const currentStatus = state ? state.status : 'STOPPED';

			const row = document.createElement('div');
			row.className = 'project-item';

			const info = document.createElement('div');
			info.className = 'project-info';
			info.innerHTML = `
        <strong>${escapeHtml(project.name)}</strong> (${escapeHtml(project.id)})
        <p>Status: <strong class="${statusClass(currentStatus)}">${escapeHtml(currentStatus)}</strong></p>
      `;

			const launchBtn = document.createElement('button');
			launchBtn.type = 'button';
			if (currentStatus === 'RUNNING') {
				launchBtn.textContent = 'View Running Demo';
				launchBtn.addEventListener('click', () => handleViewClick(project));
			} else {
				launchBtn.textContent = 'Launch Demo';
				launchBtn.addEventListener('click', () => handleLaunchClick(project));
			}

			row.appendChild(info);
			row.appendChild(launchBtn);
			projectsContainer.appendChild(row);
		});
	} catch (err) {
		projectsContainer.textContent = 'Error loading projects: ' + err.message;
	}
}

// Navigates directly to detail view for already running demos
async function handleViewClick(project) {
	activeProjectId = project.id;

	listView.classList.add('hidden');
	detailView.classList.remove('hidden');

	detailTitle.textContent = project.name;
	detailRepo.textContent = project.repoUrl;
	detailRepo.href = project.repoUrl.replace(/\.git$/, '');
	setStatus(detailStatus, 'CHECKING');
	detailIp.textContent = 'Fetching droplet IP...';
	detailUptime.textContent = '-';
	detailMaxTime.textContent = maxDemoTimeLabel;
	launchNote.classList.add('hidden');
	openIpContainer.classList.add('hidden');
	activeLaunchedAt = null;
	launchRequestedAt = null;
	stopHealthCheck();
	detailHealthRow.classList.add('hidden');
	detailHealth.textContent = 'Checking...';
	detailHealth.className = '';

	startUptimeTimer();
	fetchProjectReadme(project.repoUrl);

	await pollProjectStatus();
}

function startUptimeTimer() {
	if (uptimeTimer) clearInterval(uptimeTimer);
	uptimeTimer = setInterval(updateUptime, 1000);
}

// Triggered when user clicks Launch on a project
async function handleLaunchClick(project) {
	const token =
		currentTurnstileToken ||
		(window.turnstile && typeof window.turnstile.getResponse === 'function' ? window.turnstile.getResponse() : null);

	if (!token) {
		showTurnstileError('Please complete the Cloudflare Turnstile challenge before launching a demo.');
		return;
	}

	clearTurnstileError();
	activeProjectId = project.id;

	// Switch to detail page immediately
	listView.classList.add('hidden');
	detailView.classList.remove('hidden');

	detailTitle.textContent = project.name;
	detailRepo.textContent = project.repoUrl;
	detailRepo.href = project.repoUrl.replace(/\.git$/, '');
	setStatus(detailStatus, 'LAUNCHING');
	detailIp.textContent = 'Still launching...';
	detailUptime.textContent = '-';
	detailMaxTime.textContent = maxDemoTimeLabel;
	launchNote.classList.remove('hidden');
	openIpContainer.classList.add('hidden');
	activeLaunchedAt = Date.now();
	launchRequestedAt = Date.now();
	stopHealthCheck();
	detailHealthRow.classList.add('hidden');
	detailHealth.textContent = 'Checking...';
	detailHealth.className = '';

	startUptimeTimer();

	// Fetch GitHub README in parallel
	fetchProjectReadme(project.repoUrl);

	// Send POST /api/launch with Turnstile token
	try {
		const res = await fetch('/api/launch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				projectId: project.id,
				turnstileToken: token,
				'cf-turnstile-response': token,
			}),
		});

		if (!res.ok) {
			const errData = await res.json().catch(() => ({}));
			detailStatus.textContent = 'Launch rejected: ' + (errData.error || res.statusText);
			resetTurnstile();
			return;
		}
	} catch (err) {
		detailStatus.textContent = 'Error sending launch request: ' + err.message;
		resetTurnstile();
		return;
	}

	// Reset widget so next launch requires fresh verification
	resetTurnstile();

	// Start polling: frequent while launching, slower once running/stopped
	await pollProjectStatus();
}

// Polls GET /api/projects to update droplet IP and uptime for the active project
async function pollProjectStatus() {
	if (!activeProjectId) return;

	const projectId = activeProjectId;

	try {
		const res = await fetch('/api/projects');
		const data = await res.json();
		if (projectId !== activeProjectId) return; // user switched/left while request was in flight

		const statuses = data.statuses || [];
		const state = statuses.find((s) => s.project_id === projectId);

		if (!state) {
			setStatus(detailStatus, 'LAUNCHING');
			detailIp.textContent = 'Still launching...';
			activeLaunchedAt = null;
			updateUptime();
			launchNote.classList.remove('hidden');
			openIpContainer.classList.add('hidden');
			scheduleNextPoll('LAUNCHING');
			return;
		}

		if (state.status !== 'STOPPED') launchRequestedAt = null;
		setStatus(detailStatus, state.status);
		activeLaunchedAt = state.launched_at ?? null;
		updateUptime();
		launchNote.classList.toggle('hidden', state.status !== 'LAUNCHING');

		if (state.status === 'RUNNING' && state.droplet_ip) {
			detailIp.textContent = state.droplet_ip;
			openIpBtn.href = `http://${state.droplet_ip}${state.app_port && state.app_port !== '80' ? `:${state.app_port}` : ''}`;
			openIpContainer.classList.remove('hidden');
			detailHealthRow.classList.remove('hidden');
			if (!healthTimer && detailHealth.textContent !== 'Ready (HTTP 200)') {
				probeAppHealth(projectId, state.droplet_ip);
			}
		} else if (state.status === 'LAUNCHING') {
			detailIp.textContent = 'Still launching...';
			openIpContainer.classList.add('hidden');
			detailHealthRow.classList.add('hidden');
			stopHealthCheck();
		} else {
			detailIp.textContent = 'Not running';
			openIpContainer.classList.add('hidden');
			detailHealthRow.classList.add('hidden');
			stopHealthCheck();
		}

		scheduleNextPoll(state.status);
	} catch (err) {
		console.error('Failed to poll status:', err);
		scheduleNextPoll('LAUNCHING');
	}
}

let readmeController;

async function fetchProjectReadme(repoUrl) {
	readmeController?.abort(); // avoid stale render when switching projects quickly
	readmeController = new AbortController();
	const { signal } = readmeController;

	detailReadme.textContent = 'Loading README from GitHub...';

	// Handles dots in repo names (e.g. next.js), strips optional .git
	const match = repoUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
	if (!match) {
		detailReadme.textContent = `Could not parse GitHub owner/repo from ${repoUrl}`;
		return;
	}
	const owner = match[1];
	const repo = match[2].replace(/\.git$/, '');

	try {
		const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
			headers: { Accept: 'application/vnd.github.raw+json' },
			signal,
		});
		if (!res.ok) {
			detailReadme.textContent = `No public README found at https://github.com/${owner}/${repo} (HTTP ${res.status}).`;
			return;
		}

		const markdown = await res.text(); // already UTF-8, no atob needed

		// HEAD resolves to the default branch on both hosts, so no extra branch lookup
		const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/`;
		const blobBase = `https://github.com/${owner}/${repo}/blob/HEAD/`;

		const tpl = document.createElement('template');
		tpl.innerHTML = DOMPurify.sanitize(marked.parse(markdown, { gfm: true }));

		tpl.content.querySelectorAll('img[src]').forEach((img) => {
			img.src = new URL(img.getAttribute('src'), rawBase).href;
		});
		tpl.content.querySelectorAll('a[href]').forEach((a) => {
			const href = a.getAttribute('href');
			if (href.startsWith('#')) return;
			a.href = new URL(href, blobBase).href;
			a.target = '_blank';
			a.rel = 'noopener noreferrer';
		});

		detailReadme.replaceChildren(tpl.content);
	} catch (err) {
		if (err.name === 'AbortError') return;
		detailReadme.textContent = `Failed to load README: ${err.message}`;
	}
}

// Back button returns to list view and stops polling detail status
backBtn.addEventListener('click', () => {
	activeProjectId = null;
	activeLaunchedAt = null;
	launchRequestedAt = null;
	stopHealthCheck();
	if (pollTimer) {
		clearTimeout(pollTimer);
		pollTimer = null;
	}
	if (uptimeTimer) {
		clearInterval(uptimeTimer);
		uptimeTimer = null;
	}
	detailView.classList.add('hidden');
	listView.classList.remove('hidden');
	resetTurnstile();
	loadProjectList();
});

function escapeHtml(str) {
	return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Initialize on page load
loadProjectList();
