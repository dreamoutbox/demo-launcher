import { getStoredAdminKey, setStoredAdminKey } from './auth.js';

const loginForm = document.getElementById('login-form');
const adminKeyInput = document.getElementById('admin-key-input');
const toggleKeyVisibilityBtn = document.getElementById('toggle-key-visibility-btn');
const loginBtn = document.getElementById('login-btn');
const loginStatus = document.getElementById('login-status');

/**
 * Shows a status message under the login form.
 *
 * @param text - Message to display
 * @param color - CSS color for the message
 *
 * @example
 * showMessage('Invalid admin key.', '#c00');
 */
function showMessage(text, color = '#555') {
	loginStatus.textContent = text;
	loginStatus.style.color = color;
}

/**
 * Validates the admin key against the API, stores it on success, then opens the demo list.
 *
 * @param key - Candidate admin key
 *
 * @example
 * await login('secret-123');
 */
async function login(key) {
	const cleanKey = (key || '').trim();
	if (!cleanKey) {
		showMessage('Admin key is required.', '#c00');
		return;
	}

	loginBtn.disabled = true;
	showMessage('Checking admin key...');

	try {
		const res = await fetch('/api/admin/action-logs?limit=1', {
			headers: { 'x-admin-key': cleanKey },
		});

		if (res.status === 401) {
			showMessage('Invalid admin key.', '#c00');
			return;
		}
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}

		setStoredAdminKey(cleanKey);
		window.location.href = '/admin/demo_list';
	} catch (err) {
		showMessage(`Login failed: ${err.message}`, '#c00');
	} finally {
		loginBtn.disabled = false;
	}
}

loginForm.addEventListener('submit', (event) => {
	event.preventDefault();
	login(adminKeyInput.value);
});

toggleKeyVisibilityBtn.addEventListener('click', () => {
	const isPassword = adminKeyInput.type === 'password';
	adminKeyInput.type = isPassword ? 'text' : 'password';
	toggleKeyVisibilityBtn.textContent = isPassword ? 'Hide' : 'Show';
});

adminKeyInput.value = getStoredAdminKey();
