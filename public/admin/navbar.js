import { clearStoredAdminKey } from './auth.js';

/**
 * Reusable admin navbar web component.
 * Include with <admin-nav></admin-nav> and load this module on the page.
 */
class AdminNav extends HTMLElement {
	connectedCallback() {
		if (this.dataset.rendered === 'true') return;
		this.dataset.rendered = 'true';

		this.innerHTML = `
			<nav class="admin-nav">
				<a href="/admin/demo_list.html">Demo List</a>
				<a href="/admin/action_log.html">Action Logs</a>
				<button type="button" class="btn-sm admin-nav-logout">Logout</button>
			</nav>
		`;

		this.querySelector('.admin-nav-logout').addEventListener('click', () => {
			clearStoredAdminKey();
			window.location.href = '/admin/login';
		});
	}
}

customElements.define('admin-nav', AdminNav);
