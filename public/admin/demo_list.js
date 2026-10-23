/**
 * Admin Demo List client script.
 * Lists every configured project with its live demo status and allows force-stopping instances.
 */
const STORAGE_KEY = 'demo_launcher_admin_key';
let projects = [];
let statuses = [];
let stoppingProjectId = null;

const adminKeyInput = document.getElementById('admin-key-input');
const saveKeyBtn = document.getElementById('save-key-btn');
const toggleKeyVisibilityBtn = document.getElementById('toggle-key-visibility-btn');
const refreshBtn = document.getElementById('refresh-btn');
const demoTbody = document.getElementById('demo-tbody');
const listStatus = document.getElementById('demo-list-status');

/**
 * Resolves the current admin key from URL query or localStorage.
 * Example: getStoredAdminKey() -> 'secret-123'
 */
function getStoredAdminKey() {
	const urlParams = new URLSearchParams(window.location.search);
	const urlKey = urlParams.get('admin_key') || urlParams.get('key');
	if (urlKey) {
		localStorage.setItem(STORAGE_KEY, urlKey);
		return urlKey;
	}
	return localStorage.getItem(STORAGE_KEY) || '';
}

/**
 * Stores the admin key into localStorage and updates the input field.
 * Example: setStoredAdminKey('secret-123')
 */
function setStoredAdminKey(key) {
	const cleanKey = (key || '').trim();
	if (cleanKey) {
		localStorage.setItem(STORAGE_KEY, cleanKey);
	} else {
		localStorage.removeItem(STORAGE_KEY);
	}
	adminKeyInput.value = cleanKey;
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

function escapeHtml(str) {
	if (!str) return '';
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
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
		demoTbody.innerHTML = `<tr><td colspan="6" class="empty-state" style="color: #c00;">Failed to load demo projects: ${escapeHtml(err.message)}</td></tr>`;
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
		demoTbody.innerHTML = '<tr><td colspan="6">No projects configured.</td></tr>';
		return;
	}

	demoTbody.innerHTML = projects
		.map((project) => {
			const state = statuses.find((s) => s.project_id === project.id);
			const status = state ? state.status : 'STOPPED';
			const launchedAt = state && state.launched_at ? state.launched_at : null;
			const dropletIp = state && state.droplet_ip ? state.droplet_ip : '-';
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
					<td>${escapeHtml(dropletIp)}</td>
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
		showMessage('Enter and set your Admin Key before stopping a demo.', '#c00');
		adminKeyInput.focus();
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
			showMessage('Unauthorized: set a valid Admin Key.', '#c00');
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

saveKeyBtn.addEventListener('click', () => {
	setStoredAdminKey(adminKeyInput.value);
	showMessage('Admin key saved.', '#067d06');
});

adminKeyInput.addEventListener('keydown', (e) => {
	if (e.key === 'Enter') {
		setStoredAdminKey(adminKeyInput.value);
		showMessage('Admin key saved.', '#067d06');
	}
});

toggleKeyVisibilityBtn.addEventListener('click', () => {
	const isPassword = adminKeyInput.type === 'password';
	adminKeyInput.type = isPassword ? 'text' : 'password';
	toggleKeyVisibilityBtn.textContent = isPassword ? 'Hide' : 'Show';
});

refreshBtn.addEventListener('click', loadDemos);

demoTbody.addEventListener('click', (e) => {
	const button = e.target.closest('.stop-demo-btn');
	if (button) stopDemo(button.dataset.projectId);
});

// Initialize
adminKeyInput.value = getStoredAdminKey();
loadDemos();
setInterval(updateUptimes, 1000);
