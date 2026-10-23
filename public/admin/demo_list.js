import { getStoredAdminKey, requireAdminKey } from './auth.js';

/**
 * Admin Demo List client script.
 * Lists every configured project with its live demo status and allows force-stopping instances.
 */
let projects = [];
let statuses = [];
let stoppingProjectId = null;

const refreshBtn = document.getElementById('refresh-btn');
const demoTbody = document.getElementById('demo-tbody');
const listStatus = document.getElementById('demo-list-status');
const cleanupForm = document.getElementById('cleanup-form');
const cleanupSecondsInput = document.getElementById('cleanup-seconds-input');
const cleanupSubmitBtn = document.getElementById('cleanup-submit-btn');
const cleanupStatusMsg = document.getElementById('cleanup-status-msg');

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
 * Formats an epoch millisecond timestamp as a local date and time.
 * Example: formatDateTime(1771579200000) -> 'Feb 20, 2026, 12:00:00 PM'
 */
function formatDateTime(ms) {
	if (!ms) return '-';
	return new Date(ms).toLocaleString();
}

function escapeHtml(str) {
	if (!str) return '';
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Renders a droplet's JSON-encoded tag list as labeled pills.
 * Example: renderTags('["demo-launcher","go-pos"]')
 */
function renderTags(tags) {
	if (!tags) return '-';

	let parsed = [];
	try {
		parsed = Array.isArray(tags) ? tags : JSON.parse(tags);
	} catch {
		return escapeHtml(tags);
	}

	if (!Array.isArray(parsed) || parsed.length === 0) return '-';
	return parsed.map((tag) => `<span class="code-pill">${escapeHtml(tag)}</span>`).join(' ');
}

function statusClass(status) {
	return `status-${String(status).toLowerCase()}`;
}

function showMessage(text, color = '#555') {
	listStatus.textContent = text;
	listStatus.style.color = color;
}

/**
 * Fetches all projects and their demo states, then renders the table.
 * Example: await loadDemos()
 */
async function loadDemos() {
	refreshBtn.disabled = true;
	showMessage('Loading demos...');
	try {
		const res = await fetch('/api/projects');
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		projects = data.projects || [];
		statuses = data.statuses || [];
		renderTable();
		showMessage(`Loaded ${projects.length} project(s).`);
	} catch (err) {
		console.error('Failed to load demos:', err);
		demoTbody.innerHTML = `<tr><td colspan="9" class="empty-state" style="color: #c00;">Failed to load demo projects: ${escapeHtml(err.message)}</td></tr>`;
		showMessage('Failed to load demos.', '#c00');
	} finally {
		refreshBtn.disabled = false;
	}
}

/**
 * Renders every configured project, defaulting missing states to STOPPED.
 * Example: renderTable()
 */
function renderTable() {
	if (projects.length === 0) {
		demoTbody.innerHTML = '<tr><td colspan="9">No projects configured.</td></tr>';
		return;
	}

	demoTbody.innerHTML = projects
		.map((project) => {
			const state = statuses.find((s) => s.project_id === project.id);
			const status = state ? state.status : 'STOPPED';
			const launchedAt = state && state.launched_at ? state.launched_at : null;
			const dropletId = state && state.droplet_id ? state.droplet_id : null;
			const dropletIp = state && state.droplet_ip ? state.droplet_ip : null;
			const isStopped = status === 'STOPPED' || status === 'FAILED';
			const isStopping = stoppingProjectId === project.id;

			const stopButton = isStopped
				? '<span class="toolbar-message">-</span>'
				: `<button type="button" class="btn-sm stop-demo-btn" data-project-id="${escapeHtml(project.id)}" ${isStopping ? 'disabled' : ''}>${isStopping ? 'Stopping...' : 'Stop Demo'}</button>`;

			return `
				<tr>
					<td>
						<strong>${escapeHtml(project.name)}</strong>
						<div class="toolbar-message">${escapeHtml(project.id)}</div>
					</td>
					<td><strong class="${statusClass(status)}">${escapeHtml(status)}</strong></td>
					<td>${dropletId ?? '-'}</td>
					<td>${escapeHtml(dropletIp ?? '-')}</td>
					<td>${renderTags(state?.tags)}</td>
					<td>${formatDateTime(launchedAt)}</td>
					<td data-launched-at="${launchedAt ?? ''}">${launchedAt ? formatUptime(Date.now() - launchedAt) : '-'}</td>
					<td><a href="${escapeHtml(project.repoUrl)}" target="_blank" rel="noopener noreferrer">Repository</a></td>
					<td>${stopButton}</td>
				</tr>
			`;
		})
		.join('');
}

/**
 * Updates uptime cells locally every second without re-fetching the API.
 * Example: updateUptimes()
 */
function updateUptimes() {
	demoTbody.querySelectorAll('[data-launched-at]').forEach((cell) => {
		const launchedAt = Number(cell.dataset.launchedAt);
		cell.textContent = launchedAt ? formatUptime(Date.now() - launchedAt) : '-';
	});
}

/**
 * Calls the admin stop API for a project and refreshes the table.
 * Example: await stopDemo('go-pos')
 */
async function stopDemo(projectId) {
	const key = getStoredAdminKey();
	if (!key) {
		window.location.replace('/admin/login');
		return;
	}

	if (!window.confirm(`Stop the demo instance for "${projectId}"?`)) return;

	stoppingProjectId = projectId;
	renderTable();
	showMessage(`Stopping ${projectId}...`);

	try {
		const res = await fetch('/api/admin/stop', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-admin-key': key,
			},
			body: JSON.stringify({ projectId }),
		});
		const data = await res.json().catch(() => ({}));

		if (res.status === 401) {
			window.location.replace('/admin/login');
			return;
		}
		if (!res.ok) {
			throw new Error(data.error || `HTTP ${res.status}`);
		}

		showMessage(`Stopped ${projectId}.`, '#067d06');
		await loadDemos();
	} catch (err) {
		showMessage(`Failed to stop ${projectId}: ${err.message}`, '#c00');
	} finally {
		stoppingProjectId = null;
		renderTable();
	}
}

/**
 * Triggers manual cron cleanup of expired droplets via /api/cron-cleanup.
 *
 * @param maxDemoTimeSeconds - Custom max demo time in seconds string or null
 *
 * @example
 * await triggerManualCleanup('2');
 */
async function triggerManualCleanup(maxDemoTimeSeconds) {
	cleanupSubmitBtn.disabled = true;
	cleanupStatusMsg.textContent = 'Running cleanup...';
	cleanupStatusMsg.style.color = '#555';

	try {
		const params = new URLSearchParams();
		if (maxDemoTimeSeconds && maxDemoTimeSeconds.trim() !== '') {
			params.set('maxDemoTimeSeconds', maxDemoTimeSeconds.trim());
		}
		const queryString = params.toString();
		const url = queryString ? `/api/cron-cleanup?${queryString}` : '/api/cron-cleanup';

		const response = await fetch(url);
		const data = await response.json();

		if (!response.ok) {
			throw new Error(data.error || `HTTP ${response.status}`);
		}

		const count = data.cleanedUp !== undefined ? data.cleanedUp.length : 0;
		cleanupStatusMsg.textContent = `Cleanup completed: ${count} demo(s) cleaned up.`;
		cleanupStatusMsg.style.color = '#006600';

		await loadDemos();
	} catch (err) {
		cleanupStatusMsg.textContent = `Cleanup failed: ${err.message}`;
		cleanupStatusMsg.style.color = '#c00';
	} finally {
		cleanupSubmitBtn.disabled = false;
	}
}

refreshBtn.addEventListener('click', loadDemos);

demoTbody.addEventListener('click', (e) => {
	const button = e.target.closest('.stop-demo-btn');
	if (button) stopDemo(button.dataset.projectId);
});

cleanupForm.addEventListener('submit', (e) => {
	e.preventDefault();
	triggerManualCleanup(cleanupSecondsInput.value);
});

// Initialize only when an admin key is present; requireAdminKey redirects otherwise.
if (requireAdminKey()) {
	loadDemos();
	setInterval(updateUptimes, 1000);
}
