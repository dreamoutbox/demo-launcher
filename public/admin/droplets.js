import { getStoredAdminKey, requireAdminKey } from './auth.js';

let droplets = [];
let destroyingDropletId = null;

const refreshBtn = document.getElementById('refresh-btn');
const dropletsTbody = document.getElementById('droplets-tbody');
const dropletsStatus = document.getElementById('droplets-status');

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
 * Sets the toolbar status label text and color.
 *
 * @param text - Message string to display
 * @param color - Optional CSS color string, defaults to #555
 *
 * @example
 * ```ts
 * showMessage('Loaded 3 droplet(s).', '#067d06');
 * ```
 */
function showMessage(text, color = '#555') {
	dropletsStatus.textContent = text;
	dropletsStatus.style.color = color;
}

/**
 * Renders an array of tag strings as styled code pills.
 *
 * @param tags - Array of string tag names or serialized JSON
 * @returns HTML string of span pills
 *
 * @example
 * ```ts
 * const pills = renderTags(['demo-launcher', 'go-pos']);
 * ```
 */
function renderTags(tags) {
	if (!tags) return '-';
	let list = [];
	try {
		list = Array.isArray(tags) ? tags : JSON.parse(tags);
	} catch {
		return escapeHtml(tags);
	}

	if (!Array.isArray(list) || list.length === 0) return '-';
	return list.map((tag) => `<span class="code-pill">${escapeHtml(tag)}</span>`).join(' ');
}

/**
 * Fetches the live list of droplets from the backend admin API.
 *
 * @example
 * ```ts
 * await loadDroplets();
 * ```
 */
async function loadDroplets() {
	const key = getStoredAdminKey();
	if (!key) {
		window.location.replace('/admin/login');
		return;
	}

	refreshBtn.disabled = true;
	showMessage('Loading droplets...');

	try {
		const res = await fetch('/api/admin/droplets', {
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
		droplets = data.droplets || [];
		renderTable();
		showMessage(`Loaded ${droplets.length} droplet(s).`);
	} catch (err) {
		console.error('Failed to load droplets:', err);
		dropletsTbody.innerHTML = `<tr><td colspan="5" class="empty-state" style="color: #c00;">Failed to load droplets: ${escapeHtml(err.message)}</td></tr>`;
		showMessage('Failed to load droplets.', '#c00');
	} finally {
		refreshBtn.disabled = false;
	}
}

/**
 * Renders the fetched droplets into table rows.
 *
 * @example
 * ```ts
 * renderTable();
 * ```
 */
function renderTable() {
	if (droplets.length === 0) {
		dropletsTbody.innerHTML = '<tr><td colspan="5" class="empty-state">No active droplets found in account.</td></tr>';
		return;
	}

	dropletsTbody.innerHTML = droplets
		.map((droplet) => {
			const isDestroying = destroyingDropletId === droplet.id;
			const statusLower = (droplet.status || '').toLowerCase();
			const statusClass = statusLower === 'active' ? 'status-running' : 'status-launching';

			const actionButton = `
				<button type="button" class="btn-sm destroy-droplet-btn" data-droplet-id="${droplet.id}" ${isDestroying ? 'disabled' : ''}>
					${isDestroying ? 'Destroying...' : 'Destroy'}
				</button>
			`;

			return `
				<tr>
					<td><strong>${escapeHtml(droplet.id)}</strong></td>
					<td><strong class="${statusClass}">${escapeHtml(droplet.status)}</strong></td>
					<td>${droplet.ip ? escapeHtml(droplet.ip) : '-'}</td>
					<td>${renderTags(droplet.tags)}</td>
					<td>${actionButton}</td>
				</tr>
			`;
		})
		.join('');
}

/**
 * Sends a request to destroy a specific droplet and updates UI.
 *
 * @param dropletId - DigitalOcean droplet ID number to delete
 *
 * @example
 * ```ts
 * await destroyDroplet(12345678);
 * ```
 */
async function destroyDroplet(dropletId) {
	const key = getStoredAdminKey();
	if (!key) {
		window.location.replace('/admin/login');
		return;
	}

	if (!window.confirm(`Destroy Droplet ${dropletId}? This will delete the droplet permanently.`)) {
		return;
	}

	destroyingDropletId = dropletId;
	renderTable();
	showMessage(`Destroying droplet ${dropletId}...`);

	try {
		const res = await fetch('/api/admin/droplets/destroy', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-admin-key': key,
			},
			body: JSON.stringify({ dropletId }),
		});

		if (res.status === 401) {
			window.location.replace('/admin/login');
			return;
		}

		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			throw new Error(data.error || `HTTP ${res.status}`);
		}

		showMessage(`Droplet ${dropletId} destroyed successfully.`, '#067d06');
		await loadDroplets();
	} catch (err) {
		showMessage(`Failed to destroy droplet ${dropletId}: ${err.message}`, '#c00');
	} finally {
		destroyingDropletId = null;
		renderTable();
	}
}

refreshBtn.addEventListener('click', loadDroplets);

dropletsTbody.addEventListener('click', (e) => {
	const btn = e.target.closest('.destroy-droplet-btn');
	if (btn && btn.dataset.dropletId) {
		destroyDroplet(Number(btn.dataset.dropletId));
	}
});

if (requireAdminKey()) {
	loadDroplets();
}

