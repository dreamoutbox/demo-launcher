/**
 * Error returned by a DigitalOcean HTTP API response.
 * The status decides whether a queue retry can reasonably succeed.
 */
export class DigitalOceanApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = 'DigitalOceanApiError';
	}

	/**
	 * 408 and 429 are transient, and 5xx are server-side failures.
	 * Other 4xx responses are configuration/validation errors that will not
	 * change until the request or account state is fixed.
	 */
	get retryable(): boolean {
		return this.status === 408 || this.status === 429 || this.status >= 500;
	}
}

/**
 * Returns true for errors that must not be retried by the queue.
 *
 * @param error - Unknown error thrown by a DigitalOcean service call
 *
 * @example
 * if (isNonRetryableError(err)) return; // queue will ack
 */
export function isNonRetryableError(error: unknown): boolean {
	return error instanceof DigitalOceanApiError && !error.retryable;
}