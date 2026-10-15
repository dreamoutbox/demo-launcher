import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			miniflare: {
				// Force development mode so tests ALWAYS use DigitalOceanMockService
				bindings: {
					ENVIRONMENT: 'development',
					DO_API_KEY: 'mock-test-api-key',
				},
			},
		}),
	],
});
