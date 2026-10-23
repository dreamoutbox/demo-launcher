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
let activeProjectId = null;
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
const openIpContainer = document.getElementById('open-ip-container');
const openIpBtn = document.getElementById('open-ip-btn');
const detailReadme = document.getElementById('detail-readme');
const turnstileError = document.getElementById('turnstile-error');

let currentTurnstileToken = null;

// Turnstile callbacks attached to global window for implicit widget
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
			window.turnstile.reset();
		} catch (err) {
			console.warn('Turnstile reset error:', err);
		}
	}
}

// Load initial project list
async function loadProjectList() {
	try {
		const res = await fetch('/api/projects');
		const data = await res.json();
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
        <p>Status: <strong>${escapeHtml(currentStatus)}</strong></p>
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
	detailStatus.textContent = 'CHECKING...';
	detailIp.textContent = 'Fetching droplet IP...';
	detailUptime.textContent = '-';
	detailMaxTime.textContent = maxDemoTimeLabel;
	openIpContainer.classList.add('hidden');

	fetchProjectReadme(project.repoUrl);

	await pollProjectStatus();
	if (pollTimer) clearInterval(pollTimer);
	pollTimer = setInterval(pollProjectStatus, 2000);
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
	detailStatus.textContent = 'LAUNCHING...';
	detailIp.textContent = 'Fetching droplet IP (provisioning droplet)...';
	detailUptime.textContent = '0s';
	detailMaxTime.textContent = maxDemoTimeLabel;
	openIpContainer.classList.add('hidden');

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

	// Poll status every 2 seconds to fetch droplet IP and update uptime
	await pollProjectStatus();
	if (pollTimer) clearInterval(pollTimer);
	pollTimer = setInterval(pollProjectStatus, 2000);
}

// Polls GET /api/projects to update droplet IP and uptime for the active project
async function pollProjectStatus() {
	if (!activeProjectId) return;

	try {
		const res = await fetch('/api/projects');
		const data = await res.json();
		const statuses = data.statuses || [];
		const state = statuses.find((s) => s.project_id === activeProjectId);

		if (!state) {
			detailStatus.textContent = 'QUEUED (Waiting for queue consumer...)';
			detailIp.textContent = 'Waiting for droplet creation...';
			detailUptime.textContent = '-';
			openIpContainer.classList.add('hidden');
			return;
		}

		detailStatus.textContent = state.status;
		detailUptime.textContent = state.uptime_human || '0s';

		if (state.status === 'RUNNING' && state.droplet_ip) {
			detailIp.textContent = state.droplet_ip;
			openIpBtn.href = `http://${state.droplet_ip}${state.app_port && state.app_port !== '80' ? `:${state.app_port}` : ''}`;
			openIpContainer.classList.remove('hidden');
		} else if (state.status === 'LAUNCHING') {
			detailIp.textContent = 'Still launching... fetching droplet IP...';
			openIpContainer.classList.add('hidden');
		} else {
			detailIp.textContent = 'Not running';
			openIpContainer.classList.add('hidden');
		}
	} catch (err) {
		console.error('Failed to poll status:', err);
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
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
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
