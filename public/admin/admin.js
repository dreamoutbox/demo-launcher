import { clearStoredAdminKey, getStoredAdminKey, requireAdminKey } from './auth.js';

/**
 * Action Log Audit Viewer Client Script
 */
let currentLogs = [];
let currentPage = 0;
const pageSize = 50;
let autoRefreshTimer = null;

// DOM Elements
const logsTbody = document.getElementById('logs-tbody');
const refreshBtn = document.getElementById('refresh-btn');
const refreshIcon = document.getElementById('refresh-icon');
const autoRefreshCheck = document.getElementById('auto-refresh-check');
const filterSearch = document.getElementById('filter-search');
const filterAction = document.getElementById('filter-action');
const filterStatus = document.getElementById('filter-status');
const filterProject = document.getElementById('filter-project');

const paginationInfo = document.getElementById('pagination-info');
const prevPageBtn = document.getElementById('prev-page-btn');
const nextPageBtn = document.getElementById('next-page-btn');

const metricTotal = document.getElementById('metric-total');
const metricQueued = document.getElementById('metric-queued');
const metricRejected = document.getElementById('metric-rejected');
const metricUniqueIps = document.getElementById('metric-unique-ips');

const detailsModal = document.getElementById('details-modal');
const modalCloseBtn = document.getElementById('modal-close-btn');
const modalJson = document.getElementById('modal-json');

/**
 * Formats an epoch millisecond timestamp to local string and relative label.
 *
 * @param ms - Unix epoch in milliseconds
 * @returns Object with formatted date string and relative string
 *
 * @example
 * ```ts
 * const { formatted, relative } = formatTime(1771579200000);
 * ```
 */
function formatTime(ms) {
    if (!ms) return { formatted: '-', relative: '-' };
    const date = new Date(ms);
    const formatted = date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });

    const diffSec = Math.floor((Date.now() - ms) / 1000);
    let relative = 'just now';
    if (diffSec >= 60 && diffSec < 3600) {
        relative = `${Math.floor(diffSec / 60)}m ago`;
    } else if (diffSec >= 3600 && diffSec < 86400) {
        relative = `${Math.floor(diffSec / 3600)}h ago`;
    } else if (diffSec >= 86400) {
        relative = `${Math.floor(diffSec / 86400)}d ago`;
    } else if (diffSec > 5) {
        relative = `${diffSec}s ago`;
    }

    return { formatted, relative };
}

/**
 * Fetches action logs from the backend API using the configured admin key.
 *
 * @param page - Current zero-indexed page offset
 * @returns Promise resolving when data has been loaded and rendered
 *
 * @example
 * ```ts
 * await fetchActionLogs(0);
 * ```
 */
async function fetchActionLogs(page = 0) {
    const key = getStoredAdminKey();
    if (!key) {
        redirectToLogin();
        return;
    }

    refreshIcon.classList.add('spinning');
    const offset = page * pageSize;

    try {
        const response = await fetch(`/api/admin/action-logs?limit=${pageSize}&offset=${offset}`, {
            headers: {
                'x-admin-key': key,
            },
        });

        if (response.status === 401) {
            redirectToLogin();
            return;
        }

        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }

        const data = await response.json();
        currentLogs = data.logs || [];
        currentPage = page;

        updateMetrics(currentLogs, data.total || currentLogs.length);
        populateProjectFilter(currentLogs);
        renderTable();

        // Update pagination
        const total = data.total || currentLogs.length;
        const start = total === 0 ? 0 : offset + 1;
        const end = Math.min(offset + pageSize, total);
        paginationInfo.textContent = `Showing ${start} - ${end} of ${total} logs`;
        prevPageBtn.disabled = page === 0;
        nextPageBtn.disabled = end >= total;
    } catch (err) {
        console.error('Failed to fetch action logs:', err);
        logsTbody.innerHTML = `<tr><td colspan="7" class="empty-state" style="color: #c00;">Failed to load action logs. Verify network connection and API server.</td></tr>`;
    } finally {
        refreshIcon.classList.remove('spinning');
    }
}

/**
 * Updates top metric cards based on log data.
 *
 * @param logs - Array of retrieved ActionLogRecord objects
 * @param totalCount - Total number of records reported by API
 *
 * @example
 * ```ts
 * updateMetrics(logs, 142);
 * ```
 */
function updateMetrics(logs, totalCount) {
    metricTotal.textContent = totalCount.toLocaleString();

    const queuedCount = logs.filter((l) => l.status === 'QUEUED' || l.status === 'SUCCESS').length;
    metricQueued.textContent = queuedCount;

    const rejectedCount = logs.filter((l) => l.status === 'REJECTED' || l.status === 'FAILED').length;
    metricRejected.textContent = rejectedCount;

    const ips = new Set(logs.map((l) => l.ip_address).filter(Boolean));
    metricUniqueIps.textContent = ips.size;
}

/**
 * Dynamically populates the Project filter dropdown based on available project IDs.
 *
 * @param logs - Array of ActionLogRecord objects
 *
 * @example
 * ```ts
 * populateProjectFilter(logs);
 * ```
 */
function populateProjectFilter(logs) {
    const selectedValue = filterProject.value;
    const projects = Array.from(new Set(logs.map((l) => l.project_id).filter(Boolean)));

    // Keep default option
    filterProject.innerHTML = '<option value="">All Projects</option>';
    for (const proj of projects) {
        const opt = document.createElement('option');
        opt.value = proj;
        opt.textContent = proj;
        if (proj === selectedValue) opt.selected = true;
        filterProject.appendChild(opt);
    }
}

/**
 * Maps an action string to its badge styling CSS classes.
 *
 * @param action - Action name (e.g., 'LAUNCH_DEMO', 'STOP_DEMO')
 * @returns Space-separated CSS class names for styling the action badge
 *
 * @example
 * ```ts
 * const badgeCls = getActionClass('LAUNCH_DEMO'); // 'action-badge action-launch-demo'
 * ```
 */
function getActionClass(action) {
    const act = (action || '').toUpperCase();
    if (act === 'LAUNCH_DEMO') return 'action-badge action-launch-demo';
    if (act === 'STOP_DEMO') return 'action-badge action-stop-demo';
    if (act === 'CRON_CLEANUP') return 'action-badge action-cron-cleanup';
    return 'action-badge';
}

/**
 * Renders the current action logs to the table matching filter criteria.
 *
 * @example
 * ```ts
 * renderTable();
 * ```
 */
function renderTable() {
    const query = filterSearch.value.toLowerCase().trim();
    const actionFilter = filterAction ? filterAction.value : '';
    const statusFilter = filterStatus.value;
    const projectFilter = filterProject.value;

    const filtered = currentLogs.filter((log) => {
        if (actionFilter && log.action !== actionFilter) return false;
        if (statusFilter && log.status !== statusFilter) return false;
        if (projectFilter && log.project_id !== projectFilter) return false;
        if (query) {
            const matchIp = (log.ip_address || '').toLowerCase().includes(query);
            const matchProj = (log.project_id || '').toLowerCase().includes(query);
            const matchAgent = (log.user_agent || '').toLowerCase().includes(query);
            const matchCountry = (log.country || '').toLowerCase().includes(query);
            const matchDetails = (log.details || '').toLowerCase().includes(query);
            if (!matchIp && !matchProj && !matchAgent && !matchCountry && !matchDetails) {
                return false;
            }
        }
        return true;
    });

    if (filtered.length === 0) {
        logsTbody.innerHTML = `<tr><td colspan="7" class="empty-state">No matching action logs found.</td></tr>`;
        return;
    }

    logsTbody.innerHTML = filtered
        .map((log) => {
            const { formatted, relative } = formatTime(log.created_at);
            const statusLower = (log.status || '').toLowerCase();
            const badgeClass = statusLower === 'queued' || statusLower === 'success'
                ? 'badge-queued'
                : 'badge-rejected';

            const ipDisplay = log.ip_address || 'unknown';
            const countryDisplay = log.country ? `<span class="badge-country">${log.country}</span>` : '';
            const projectDisplay = log.project_id
                ? `<span class="code-pill">${escapeHtml(log.project_id)}</span>`
                : '<span style="color: #888;">-</span>';

            const detailsPreview = log.details ? 'Inspect' : '-';

            return `
            <tr>
              <td>
                <div class="time-primary">${formatted}</div>
                <div class="time-relative">${relative}</div>
              </td>
              <td><span class="${getActionClass(log.action)}">${escapeHtml(log.action)}</span></td>
              <td><span class="${badgeClass}">${escapeHtml(log.status)}</span></td>
              <td>${projectDisplay}</td>
              <td>
                <div class="ip-cell">
                  <span>${escapeHtml(ipDisplay)}</span>
                  ${countryDisplay}
                  <button type="button" class="copy-btn btn-sm" onclick="copyToClipboard('${escapeHtml(ipDisplay)}')" title="Copy IP">Copy</button>
                </div>
              </td>
              <td>
                <div class="user-agent-text" title="${escapeHtml(log.user_agent || '')}">${escapeHtml(log.user_agent || '-')}</div>
              </td>
              <td>
                ${log.details ? `<button type="button" class="btn-sm" onclick="openDetailsModal(${log.id})">Details</button>` : '<span style="color: #888;">-</span>'}
              </td>
            </tr>
          `;
        })
        .join('');
}

/**
 * Opens details modal displaying structured JSON for a given log ID.
 *
 * @param logId - Record identifier
 *
 * @example
 * ```ts
 * openDetailsModal(42);
 * ```
 */
window.openDetailsModal = function (logId) {
    const log = currentLogs.find((l) => l.id === logId);
    if (!log) return;

    let parsedDetails = log.details;
    try {
        parsedDetails = JSON.parse(log.details || '{}');
    } catch {
        // Keep as string
    }

    const fullPayload = {
        id: log.id,
        action: log.action,
        status: log.status,
        project_id: log.project_id,
        ip_address: log.ip_address,
        country: log.country,
        user_agent: log.user_agent,
        created_at: log.created_at,
        created_at_iso: new Date(log.created_at).toISOString(),
        details: parsedDetails,
    };

    modalJson.textContent = JSON.stringify(fullPayload, null, 2);
    detailsModal.classList.remove('hidden');
};

/**
 * Copies a string value to the user's clipboard.
 *
 * @param text - Text string to copy
 *
 * @example
 * ```ts
 * copyToClipboard('198.51.100.1');
 * ```
 */
window.copyToClipboard = function (text) {
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(text);
};

/**
 * Escapes HTML entities to prevent XSS.
 *
 * @param str - Input string
 * @returns Escaped HTML string
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
 * Sends the user to the login page when the admin key is missing or rejected.
 */
function redirectToLogin() {
    clearStoredAdminKey();
    window.location.replace('/admin/login');
}

// Event Listeners
refreshBtn.addEventListener('click', () => fetchActionLogs(currentPage));

filterSearch.addEventListener('input', renderTable);
if (filterAction) filterAction.addEventListener('change', renderTable);
filterStatus.addEventListener('change', renderTable);
filterProject.addEventListener('change', renderTable);

prevPageBtn.addEventListener('click', () => {
    if (currentPage > 0) fetchActionLogs(currentPage - 1);
});

nextPageBtn.addEventListener('click', () => {
    fetchActionLogs(currentPage + 1);
});

modalCloseBtn.addEventListener('click', () => {
    detailsModal.classList.add('hidden');
});

detailsModal.addEventListener('click', (e) => {
    if (e.target === detailsModal) detailsModal.classList.add('hidden');
});

autoRefreshCheck.addEventListener('change', (e) => {
    if (e.target.checked) {
        autoRefreshTimer = setInterval(() => fetchActionLogs(currentPage), 5000);
    } else {
        if (autoRefreshTimer) clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
});

// Initialize only when an admin key is present; requireAdminKey redirects otherwise.
if (requireAdminKey()) {
    fetchActionLogs(0);
}
