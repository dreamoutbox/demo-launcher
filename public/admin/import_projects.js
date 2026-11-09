import { getStoredAdminKey, requireAdminKey } from './auth.js';

let storedProjects = [];

const importForm = document.getElementById('import-form');
const projectsJsonInput = document.getElementById('projects-json-input');
const importSubmitBtn = document.getElementById('import-submit-btn');
const resetProjectsBtn = document.getElementById('reset-projects-btn');
const refreshTableBtn = document.getElementById('refresh-table-btn');
const feedbackMsg = document.getElementById('feedback-msg');
const projectsTbody = document.getElementById('projects-tbody');
const projectsCount = document.getElementById('projects-count');

/**
 * Escapes characters with special meaning in HTML entities to prevent XSS.
 *
 * @param str - Arbitrary input string or value to sanitize
 * @returns Sanitized string safe for embedding in innerHTML
 *
 * @example
 * ```ts
 * const safe = escapeHtml('<script>');
 * ```
 */
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
 * Displays status or validation feedback to the user.
 *
 * @param message - Text message to display
 * @param color - CSS color string (e.g. '#067d06' for success, '#c00' for error)
 *
 * @example
 * ```ts
 * showFeedback('Import successful', '#067d06');
 * ```
 */
function showFeedback(message, color = '#555') {
	feedbackMsg.textContent = message;
	feedbackMsg.style.color = color;
}

/**
 * Fetches all currently stored projects from the backend admin API and updates table.
 *
 * @example
 * ```ts
 * await loadProjects();
 * ```
 */
async function loadProjects() {
	const key = getStoredAdminKey();
	if (!key) {
		window.location.replace('/admin/login');
		return;
	}

	refreshTableBtn.disabled = true;

	try {
		const res = await fetch('/api/admin/projects', {
			headers: { 'x-admin-key': key },
		});

		if (res.status === 401) {
			window.location.replace('/admin/login');
			return;
		}

		if (!res.ok) {
			const errData = await res.json().catch(() => ({}));
			throw new Error(errData.error || `HTTP ${res.status}`);
		}

		const data = await res.json();
		storedProjects = data.projects || [];
		renderTable();
	} catch (err) {
		console.error('Failed to load projects:', err);
		projectsTbody.innerHTML = `<tr><td colspan="7" class="empty-state" style="color: #c00;">Failed to load projects: ${escapeHtml(err.message)}</td></tr>`;
	} finally {
		refreshTableBtn.disabled = false;
	}
}

/**
 * Renders stored project configurations into table rows.
 *
 * @example
 * ```ts
 * renderTable();
 * ```
 */
function renderTable() {
	projectsCount.textContent = storedProjects.length;

	if (storedProjects.length === 0) {
		projectsTbody.innerHTML = '<tr><td colspan="7" class="empty-state">No projects stored in database. Use the form above to import projects.json.</td></tr>';
		return;
	}

	projectsTbody.innerHTML = storedProjects
		.map((p) => {
			const portsList = [];
			if (p.appPort) portsList.push(`App: ${p.appPort}`);
			if (p.healthcheckPort) portsList.push(`Health: ${p.healthcheckPort}`);
			if (p.firewallPorts) {
				const fwStr = Array.isArray(p.firewallPorts) ? p.firewallPorts.join(',') : p.firewallPorts;
				portsList.push(`FW: ${fwStr}`);
			}
			const portsDisplay = portsList.length > 0 ? portsList.map((str) => `<span class="code-pill">${escapeHtml(str)}</span>`).join(' ') : '-';

			// Collect extra / custom fields not part of baseline
			const standardKeys = new Set(['id', 'name', 'repoUrl', 'branch', 'appPort', 'healthcheckPort', 'healthcheckPath', 'size', 'firewallPorts']);
			const extraKeys = Object.keys(p).filter((k) => !standardKeys.has(k));
			let extraDisplay = '-';
			if (extraKeys.length > 0) {
				const extraObj = {};
				for (const k of extraKeys) {
					extraObj[k] = p[k];
				}
				extraDisplay = `<pre class="json-viewer">${escapeHtml(JSON.stringify(extraObj, null, 2))}</pre>`;
			}

			return `
				<tr>
					<td><span class="code-pill"><strong>${escapeHtml(p.id)}</strong></span></td>
					<td>${escapeHtml(p.name)}</td>
					<td><a href="${escapeHtml(p.repoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.repoUrl)}</a></td>
					<td>${p.branch ? escapeHtml(p.branch) : '-'}</td>
					<td>${portsDisplay}</td>
					<td>${p.size ? escapeHtml(p.size) : '-'}</td>
					<td>${extraDisplay}</td>
				</tr>
			`;
		})
		.join('');
}

/**
 * Handles form submission: validates JSON client-side, posts to /api/admin/projects/import,
 * shows server response, and refreshes the table upon success.
 *
 * @param event - Submit event
 *
 * @example
 * ```ts
 * importForm.addEventListener('submit', handleImportSubmit);
 * ```
 */
async function handleImportSubmit(event) {
	event.preventDefault();

	const key = getStoredAdminKey();
	if (!key) {
		window.location.replace('/admin/login');
		return;
	}

	const rawText = projectsJsonInput.value.trim();
	if (!rawText) {
		showFeedback('Please paste JSON content into the textarea.', '#c00');
		return;
	}

	let parsedJson;
	try {
		parsedJson = JSON.parse(rawText);
	} catch (err) {
		showFeedback(`Invalid JSON syntax: ${err.message}`, '#c00');
		return;
	}

	importSubmitBtn.disabled = true;
	showFeedback('Validating and importing projects...', '#555');

	try {
		const res = await fetch('/api/admin/projects/import', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-admin-key': key,
			},
			body: JSON.stringify(parsedJson),
		});

		if (res.status === 401) {
			window.location.replace('/admin/login');
			return;
		}

		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			throw new Error(data.error || `HTTP ${res.status}`);
		}

		showFeedback(`Success: ${data.message}`, '#067d06');
		projectsJsonInput.value = '';
		await loadProjects();
	} catch (err) {
		showFeedback(`Validation/Import error: ${err.message}`, '#c00');
	} finally {
		importSubmitBtn.disabled = false;
	}
}

/**
 * Handles reset table button click: confirms with admin and calls /api/admin/projects/reset.
 *
 * @example
 * ```ts
 * resetProjectsBtn.addEventListener('click', handleResetClick);
 * ```
 */
async function handleResetClick() {
	const key = getStoredAdminKey();
	if (!key) {
		window.location.replace('/admin/login');
		return;
	}

	const confirmed = window.confirm(
		'Reset the projects table? All project configurations will be deleted from D1. Existing droplets and demo records will NOT be deleted.',
	);
	if (!confirmed) return;

	resetProjectsBtn.disabled = true;
	showFeedback('Resetting projects table...', '#555');

	try {
		const res = await fetch('/api/admin/projects/reset', {
			method: 'POST',
			headers: {
				'x-admin-key': key,
			},
		});

		if (res.status === 401) {
			window.location.replace('/admin/login');
			return;
		}

		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			throw new Error(data.error || `HTTP ${res.status}`);
		}

		showFeedback(`Success: ${data.message}`, '#067d06');
		await loadProjects();
	} catch (err) {
		showFeedback(`Reset failed: ${err.message}`, '#c00');
	} finally {
		resetProjectsBtn.disabled = false;
	}
}

importForm.addEventListener('submit', handleImportSubmit);
resetProjectsBtn.addEventListener('click', handleResetClick);
refreshTableBtn.addEventListener('click', loadProjects);

if (requireAdminKey()) {
	loadProjects();
}
