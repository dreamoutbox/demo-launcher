import { Env } from './types';

export enum TurnstileStatus {
	SUCCESS = 'SUCCESS',
	MISSING_TOKEN = 'MISSING_TOKEN',
	INVALID_TOKEN = 'INVALID_TOKEN',
	VERIFICATION_FAILED = 'VERIFICATION_FAILED',
}

export interface TurnstileVerificationResult {
	success: boolean;
	status: TurnstileStatus;
	errorCodes?: string[];
}

interface TurnstileApiResponse {
	success: boolean;
	'error-codes'?: string[];
	challenge_ts?: string;
	hostname?: string;
	action?: string;
	cdata?: string;
}

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const DUMMY_SECRET_KEY = '1x0000000000000000000000000000000AA';

/**
 * Validates the Cloudflare Turnstile token for protected routes.
 * Non-production environments bypass external verification with Cloudflare,
 * but the client must still supply a non-empty answer.
 */
export async function verifyTurnstileToken(
	token: string | null | undefined,
	env: Env,
	clientIp?: string,
): Promise<TurnstileVerificationResult> {
	if (!token || token.trim() === '') {
		return {
			success: false,
			status: TurnstileStatus.MISSING_TOKEN,
		};
	}

	// Non-production environments bypass remote Cloudflare siteverify check
	if (env.ENVIRONMENT !== 'production') {
		return {
			success: true,
			status: TurnstileStatus.SUCCESS,
		};
	}

	const secretKey = env.TURNSTILE_SECRET_KEY || DUMMY_SECRET_KEY;
	const formData = new FormData();
	formData.append('secret', secretKey);
	formData.append('response', token);
	if (clientIp) {
		formData.append('remoteip', clientIp);
	}

	try {
		const res = await fetch(TURNSTILE_VERIFY_URL, {
			method: 'POST',
			body: formData,
		});

		const outcome = (await res.json()) as TurnstileApiResponse;
		if (outcome.success) {
			return {
				success: true,
				status: TurnstileStatus.SUCCESS,
			};
		}

		return {
			success: false,
			status: TurnstileStatus.INVALID_TOKEN,
			errorCodes: outcome['error-codes'],
		};
	} catch {
		return {
			success: false,
			status: TurnstileStatus.VERIFICATION_FAILED,
		};
	}
}
