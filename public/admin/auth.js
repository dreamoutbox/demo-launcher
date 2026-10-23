/**
 * Shared admin key storage helpers.
 * The key is kept in localStorage so every admin page and the navbar use the same session.
 */

export const ADMIN_KEY_STORAGE_KEY = 'demo_launcher_admin_key';

/**
 * Resolves the admin key from the URL query or localStorage.
 * URL keys are persisted so they survive navigation.
 *
 * @returns The stored admin key, or an empty string when none is set
 *
 * @example
 * const key = getStoredAdminKey();
 */
export function getStoredAdminKey() {
	const params = new URLSearchParams(window.location.search);
	const urlKey = params.get('admin_key') || params.get('key');
	if (urlKey) {
		localStorage.setItem(ADMIN_KEY_STORAGE_KEY, urlKey);
		return urlKey;
	}
	return localStorage.getItem(ADMIN_KEY_STORAGE_KEY) || '';
}

/**
 * Stores the admin key in localStorage.
 *
 * @param key - Admin key to persist; empty removes the stored key
 *
 * @example
 * setStoredAdminKey('secret-123');
 */
export function setStoredAdminKey(key) {
	const cleanKey = (key || '').trim();
	if (cleanKey) {
		localStorage.setItem(ADMIN_KEY_STORAGE_KEY, cleanKey);
	} else {
		localStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
	}
}

/**
 * Removes the stored admin key.
 *
 * @example
 * clearStoredAdminKey();
 */
export function clearStoredAdminKey() {
	localStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
}

/**
 * Returns the stored admin key, redirecting to the login page when missing.
 *
 * @returns The admin key, or null when the caller should stop initializing
 *
 * @example
 * const key = requireAdminKey();
 * if (key) loadPage();
 */
export function requireAdminKey() {
	const key = getStoredAdminKey();
	if (!key) {
		window.location.replace('/admin/login');
		return null;
	}
	return key;
}
