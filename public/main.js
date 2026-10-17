const MAX_DEMO_TIME_LABEL = '1 hour';
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
	detailMaxTime.textContent = MAX_DEMO_TIME_LABEL;
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
	detailMaxTime.textContent = MAX_DEMO_TIME_LABEL;
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
			openIpBtn.href = `http://${state.droplet_ip}`;
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

// Extracts owner/repo from GitHub URL and fetches raw README.md
async function fetchProjectReadme(repoUrl) {
	detailReadme.textContent = 'Loading README from GitHub...';

	// Match https://github.com/owner/repo(.git)
	const match = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/i);
	if (!match) {
		detailReadme.textContent = 'Could not parse GitHub owner/repo from ' + repoUrl;
		return;
	}

	const [, owner, repo] = match;

	// Try GitHub API first (automatically finds default branch README), fallback to raw main/master
	try {
		const apiRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
			headers: { Accept: 'application/vnd.github.v3.raw' },
		});

		if (apiRes.ok) {
			detailReadme.textContent = await apiRes.text();
			return;
		}

		// Fallback if repo is mocked or not found
		detailReadme.textContent = `No public README.md found at https://github.com/${owner}/${repo}.\n(If this is a mock repo URL in src/projects.json, replace it with a real public GitHub repo URL to preview its README.)`;
	} catch (err) {
		detailReadme.textContent = 'Failed to load README: ' + err.message;
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
