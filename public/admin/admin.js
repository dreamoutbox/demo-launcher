/**
 * Action Log Audit Viewer Client Script
 */
const STORAGE_KEY = 'demo_launcher_admin_key';
let currentLogs = [];
let currentPage = 0;
const pageSize = 50;
let autoRefreshTimer = null;

// DOM Elements
const authWall = document.getElementById('auth-wall');
const mainContent = document.getElementById('main-content');
const adminKeyInput = document.getElementById('admin-key-input');
const saveKeyBtn = document.getElementById('save-key-btn');
const toggleKeyVisibilityBtn = document.getElementById('toggle-key-visibility-btn');
const authWallKeyInput = document.getElementById('auth-wall-key-input');
const authWallSubmitBtn = document.getElementById('auth-wall-submit-btn');

const logsTbody = document.getElementById('logs-tbody');
const refreshBtn = document.getElementById('refresh-btn');
const refreshIcon = document.getElementById('refresh-icon');
const autoRefreshCheck = document.getElementById('auto-refresh-check');
const filterSearch = document.getElementById('filter-search');
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

const cleanupForm = document.getElementById('cleanup-form');
const cleanupSecondsInput = document.getElementById('cleanup-seconds-input');
const cleanupSubmitBtn = document.getElementById('cleanup-submit-btn');
const cleanupStatusMsg = document.getElementById('cleanup-status-msg');

/**
 * Resolves the current admin key from URL query or localStorage.
 *
 * @returns The active admin key string or null if unconfigured
 *
 * @example
 * ```ts
 * const key = getStoredAdminKey();
 * ```
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
 * Stores the admin key into localStorage and updates input UI.
 *
 * @param key - The admin key string to store
 *
 * @example
 * ```ts
 * setStoredAdminKey('secret-123');
 * ```
 */
function setStoredAdminKey(key) {
    const cleanKey = (key || '').trim();
    if (cleanKey) {
        localStorage.setItem(STORAGE_KEY, cleanKey);
    } else {
        localStorage.removeItem(STORAGE_KEY);
    }
    adminKeyInput.value = cleanKey;
    authWallKeyInput.value = cleanKey;
}

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
        showAuthWall();
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
            showAuthWall();
            return;
        }

        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }

        const data = await response.json();
        hideAuthWall();
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
 * Renders the current action logs to the table matching filter criteria.
 *
 * @example
 * ```ts
 * renderTable();
 * ```
 */
function renderTable() {
    const query = filterSearch.value.toLowerCase().trim();
    const statusFilter = filterStatus.value;
    const projectFilter = filterProject.value;

    const filtered = currentLogs.filter((log) => {
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
              <td><span>${escapeHtml(log.action)}</span></td>
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

function showAuthWall() {
    authWall.classList.remove('hidden');
    mainContent.classList.add('hidden');
}

function hideAuthWall() {
    authWall.classList.add('hidden');
    mainContent.classList.remove('hidden');
}

// Event Listeners
saveKeyBtn.addEventListener('click', () => {
    setStoredAdminKey(adminKeyInput.value);
    fetchActionLogs(0);
});

adminKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        setStoredAdminKey(adminKeyInput.value);
        fetchActionLogs(0);
    }
});

toggleKeyVisibilityBtn.addEventListener('click', () => {
    const isPassword = adminKeyInput.type === 'password';
    adminKeyInput.type = isPassword ? 'text' : 'password';
    toggleKeyVisibilityBtn.textContent = isPassword ? 'Hide' : 'Show';
});

authWallSubmitBtn.addEventListener('click', () => {
    setStoredAdminKey(authWallKeyInput.value);
    fetchActionLogs(0);
});

authWallKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        setStoredAdminKey(authWallKeyInput.value);
        fetchActionLogs(0);
    }
});

refreshBtn.addEventListener('click', () => fetchActionLogs(currentPage));

filterSearch.addEventListener('input', renderTable);
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

/**
 * Triggers manual cron cleanup of expired droplets via /api/cron-cleanup.
 *
 * @param maxDemoTimeSeconds - Custom max demo time in seconds string or null
 * @returns Promise resolving when cleanup request completes
 *
 * @example
 * ```ts
 * await triggerManualCleanup('2');
 * ```
 */
async function triggerManualCleanup(maxDemoTimeSeconds) {
    if (!cleanupSubmitBtn) return;
    cleanupSubmitBtn.disabled = true;
    if (cleanupStatusMsg) {
        cleanupStatusMsg.textContent = 'Running cleanup...';
        cleanupStatusMsg.style.color = '#555';
    }

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

        const count = data.cleanedCount !== undefined ? data.cleanedCount : 0;
        if (cleanupStatusMsg) {
            cleanupStatusMsg.textContent = `Cleanup completed: ${count} demo(s) cleaned up.`;
            cleanupStatusMsg.style.color = '#006600';
        }

        fetchActionLogs(currentPage);
    } catch (err) {
        if (cleanupStatusMsg) {
            cleanupStatusMsg.textContent = `Cleanup failed: ${err.message}`;
            cleanupStatusMsg.style.color = '#c00';
        }
    } finally {
        cleanupSubmitBtn.disabled = false;
    }
}

if (cleanupForm) {
    cleanupForm.addEventListener('submit', (e) => {
        e.preventDefault();
        triggerManualCleanup(cleanupSecondsInput ? cleanupSecondsInput.value : '');
    });
}

// Initialize state on load
const initialKey = getStoredAdminKey();
if (initialKey) {
    adminKeyInput.value = initialKey;
    authWallKeyInput.value = initialKey;
}
fetchActionLogs(0);
