import { getStoredAdminKey, setStoredAdminKey } from './auth.js';

const loginForm = document.getElementById('login-form');
const adminKeyInput = document.getElementById('admin-key-input');
const toggleKeyVisibilityBtn = document.getElementById('toggle-key-visibility-btn');
const loginBtn = document.getElementById('login-btn');
const loginStatus = document.getElementById('login-status');
const turnstileError = document.getElementById('turnstile-error');

let currentTurnstileToken = null;
let turnstileWidgetId = null;
let turnstileApiPromise = null;

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
 * Displays an error inside the Turnstile message box.
 *
 * @param msg - Error message text
 *
 * @example
 * showTurnstileError('Turnstile challenge failed.');
 */
function showTurnstileError(msg) {
	if (turnstileError) {
		turnstileError.textContent = msg;
		turnstileError.classList.remove('hidden');
	}
}

/**
 * Clears and hides the Turnstile error message box.
 *
 * @example
 * clearTurnstileError();
 */
function clearTurnstileError() {
	if (turnstileError) {
		turnstileError.textContent = '';
		turnstileError.classList.add('hidden');
	}
}

/**
 * Resets the Turnstile challenge widget and clears the held token.
 *
 * @example
 * resetTurnstile();
 */
function resetTurnstile() {
	currentTurnstileToken = null;
	clearTurnstileError();
	if (window.turnstile && typeof window.turnstile.reset === 'function' && turnstileWidgetId !== null) {
		try {
			window.turnstile.reset(turnstileWidgetId);
		} catch (err) {
			console.warn('Turnstile reset error:', err);
		}
	}
}

/**
 * Loads the Cloudflare Turnstile explicit rendering script.
 *
 * @returns Promise resolving when the Turnstile API is available on window
 *
 * @example
 * await loadTurnstileApi();
 */
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

/**
 * Explicitly renders the Turnstile widget inside #turnstile-widget using the given site key.
 *
 * @param siteKey - Cloudflare Turnstile public site key
 *
 * @example
 * await renderTurnstile('1x00000000000000000000AA');
 */
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
			callback: (token) => {
				currentTurnstileToken = token;
				clearTurnstileError();
			},
			'expired-callback': () => {
				currentTurnstileToken = null;
			},
			'error-callback': () => {
				currentTurnstileToken = null;
				showTurnstileError('Turnstile challenge encountered an error. Please retry.');
			},
		});
	} catch (err) {
		showTurnstileError(err.message);
	}
}

/**
 * Validates the admin key and Turnstile token against /api/admin/verify, stores key on success, and redirects to demo list.
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

	const token =
		currentTurnstileToken ||
		(window.turnstile && typeof window.turnstile.getResponse === 'function' && turnstileWidgetId !== null
			? window.turnstile.getResponse(turnstileWidgetId)
			: null);

	if (!token) {
		showMessage('Please complete the Turnstile challenge.', '#c00');
		showTurnstileError('Please complete the Cloudflare Turnstile challenge before logging in.');
		return;
	}

	clearTurnstileError();
	loginBtn.disabled = true;
	showMessage('Checking admin key and Turnstile verification...');

	try {
		const res = await fetch('/api/admin/verify', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				adminKey: cleanKey,
				turnstileToken: token,
			}),
		});

		const data = await res.json().catch(() => ({}));

		if (res.status === 400 || res.status === 403) {
			showMessage(data.error || 'Turnstile verification failed.', '#c00');
			showTurnstileError(data.error || 'Turnstile verification failed.');
			resetTurnstile();
			return;
		}

		if (res.status === 401) {
			showMessage('Invalid admin key.', '#c00');
			resetTurnstile();
			return;
		}

		if (!res.ok) {
			throw new Error(data.error || `HTTP ${res.status}`);
		}

		setStoredAdminKey(cleanKey);
		window.location.href = '/admin/demo_list';
	} catch (err) {
		showMessage(`Login failed: ${err.message}`, '#c00');
		resetTurnstile();
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

// Fetch Turnstile config and initialize widget
fetch('/api/admin/verify')
	.then((res) => res.json())
	.then((data) => {
		if (data?.turnstileSiteKey) {
			renderTurnstile(data.turnstileSiteKey);
		}
	})
	.catch((err) => {
		showTurnstileError(`Failed to initialize Turnstile: ${err.message}`);
	});
