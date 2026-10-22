import './types';

declare module './types' {
	interface Env {
		LAUNCH_ALLOW_TIME_RANGE?: string;
		LAUNCH_TIMEZONE?: string;
	}
}

/**
 * Result status for schedule evaluation.
 */
export enum ScheduleCheckResult {
	ALLOWED = 'ALLOWED',
	OUTSIDE_SCHEDULE = 'OUTSIDE_SCHEDULE',
	NO_RESTRICTION = 'NO_RESTRICTION',
}

/**
 * Representation of a parsed time window within a 24-hour day.
 */
export interface TimeRange {
	startSeconds: number;
	endSeconds: number;
	raw: string;
}

/**
 * Detailed outcome of a schedule check.
 */
export interface ScheduleEvaluation {
	allowed: boolean;
	status: ScheduleCheckResult;
	currentSeconds: number;
	matchedRange?: TimeRange;
}

/**
 * Converts a time string (HH:mm:ss or HH:mm) into seconds elapsed from midnight (0 to 86400).
 *
 * @param timeStr - The time string to parse (e.g., "07:00:00" or "20:00")
 * @returns Seconds from midnight (0-86400), or null if the string is invalid
 *
 * @example
 * ```ts
 * parseTimeToSeconds('07:30:00'); // 27000
 * parseTimeToSeconds('20:00');    // 72000
 * ```
 */
export function parseTimeToSeconds(timeStr: string): number | null {
	const trimmed = timeStr.trim();
	const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
	if (!match) {
		return null;
	}

	const hours = parseInt(match[1], 10);
	const minutes = parseInt(match[2], 10);
	const seconds = match[3] !== undefined ? parseInt(match[3], 10) : 0;

	// Support up to 24:00:00 as end of day
	if (hours === 24 && minutes === 0 && seconds === 0) {
		return 86400;
	}

	if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
		return null;
	}

	return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Parses a single start-end time range string into a TimeRange structure.
 *
 * @param rangeStr - Time range string in format "HH:mm:ss-HH:mm:ss" or "HH:mm-HH:mm"
 * @returns Parsed TimeRange object, or null if the range format is invalid
 *
 * @example
 * ```ts
 * parseSingleTimeRange('07:00:00-20:00:00');
 * // { startSeconds: 25200, endSeconds: 72000, raw: '07:00:00-20:00:00' }
 * ```
 */
export function parseSingleTimeRange(rangeStr: string): TimeRange | null {
	const trimmed = rangeStr.trim();
	if (!trimmed) {
		return null;
	}

	const separatorIndex = trimmed.indexOf('-');
	if (separatorIndex === -1) {
		return null;
	}

	const startPart = trimmed.slice(0, separatorIndex).trim();
	const endPart = trimmed.slice(separatorIndex + 1).trim();

	const startSeconds = parseTimeToSeconds(startPart);
	const endSeconds = parseTimeToSeconds(endPart);

	if (startSeconds === null || endSeconds === null) {
		return null;
	}

	return {
		startSeconds,
		endSeconds,
		raw: trimmed,
	};
}

/**
 * Parses a comma-separated list of time ranges into an array of TimeRange objects.
 * Empty or malformed segments are ignored.
 *
 * @param rangesStr - Comma-delimited list of time ranges (e.g., "07:00:00-20:00:00,21:00:00-23:00:00")
 * @returns Array of valid TimeRange objects
 *
 * @example
 * ```ts
 * parseTimeRanges('07:00:00-20:00:00,21:00:00-23:00:00');
 * ```
 */
export function parseTimeRanges(rangesStr?: string | null): TimeRange[] {
	if (!rangesStr || typeof rangesStr !== 'string') {
		return [];
	}

	return rangesStr
		.split(',')
		.map((part) => parseSingleTimeRange(part))
		.filter((range): range is TimeRange => range !== null);
}

/**
 * Evaluates whether a timestamp (in seconds from midnight) falls within a given time range.
 * Supports daytime ranges (start <= end) and overnight ranges spanning midnight (start > end).
 *
 * @param currentSeconds - Number of seconds elapsed since 00:00:00 (0 to 86399)
 * @param range - The TimeRange bounds to compare against
 * @returns True if currentSeconds falls within the range (inclusive), false otherwise
 *
 * @example
 * ```ts
 * isSecondsWithinRange(36000, { startSeconds: 25200, endSeconds: 72000, raw: '07:00:00-20:00:00' }); // true
 * ```
 */
export function isSecondsWithinRange(currentSeconds: number, range: TimeRange): boolean {
	if (range.startSeconds <= range.endSeconds) {
		return currentSeconds >= range.startSeconds && currentSeconds <= range.endSeconds;
	}
	// Overnight range spanning midnight, e.g. 22:00:00-04:00:00
	return currentSeconds >= range.startSeconds || currentSeconds <= range.endSeconds;
}

/**
 * Computes seconds elapsed since midnight for a Date in UTC or a specified timezone.
 *
 * @param date - The Date instance to evaluate
 * @param timeZone - Optional IANA timezone identifier (e.g. "Asia/Bangkok"). Defaults to UTC.
 * @returns Total seconds elapsed since midnight (0 to 86399)
 *
 * @example
 * ```ts
 * getSecondsFromDate(new Date('2026-10-22T07:30:00Z')); // 27000
 * ```
 */
export function getSecondsFromDate(date: Date, timeZone?: string): number {
	if (!timeZone || timeZone.toUpperCase() === 'UTC') {
		return date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
	}

	const formatter = new Intl.DateTimeFormat('en-US', {
		hourCycle: 'h23',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		timeZone,
	});

	const parts = formatter.formatToParts(date);
	let hours = 0;
	let minutes = 0;
	let seconds = 0;

	for (const part of parts) {
		if (part.type === 'hour') hours = parseInt(part.value, 10);
		if (part.type === 'minute') minutes = parseInt(part.value, 10);
		if (part.type === 'second') seconds = parseInt(part.value, 10);
	}

	return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Evaluates the launch schedule against a configured range string and current time.
 *
 * @param allowRangesStr - Comma-separated allow time ranges from configuration
 * @param dateOrSeconds - Date object or pre-calculated seconds from midnight (defaults to new Date())
 * @param timeZone - Optional timezone used when dateOrSeconds is a Date (defaults to UTC)
 * @returns Detailed ScheduleEvaluation with allowed boolean, status enum, and matched range if any
 *
 * @example
 * ```ts
 * evaluateLaunchSchedule('07:00:00-20:00:00', new Date('2026-10-22T10:00:00Z'));
 * // { allowed: true, status: ScheduleCheckResult.ALLOWED, ... }
 * ```
 */
export function evaluateLaunchSchedule(
	allowRangesStr?: string | null,
	dateOrSeconds: Date | number = new Date(),
	timeZone?: string,
): ScheduleEvaluation {
	const currentSeconds =
		typeof dateOrSeconds === 'number'
			? dateOrSeconds
			: getSecondsFromDate(dateOrSeconds, timeZone);

	if (!allowRangesStr || allowRangesStr.trim() === '') {
		return {
			allowed: true,
			status: ScheduleCheckResult.NO_RESTRICTION,
			currentSeconds,
		};
	}

	const ranges = parseTimeRanges(allowRangesStr);
	if (ranges.length === 0) {
		return {
			allowed: true,
			status: ScheduleCheckResult.NO_RESTRICTION,
			currentSeconds,
		};
	}

	const matched = ranges.find((range) => isSecondsWithinRange(currentSeconds, range));

	if (matched) {
		return {
			allowed: true,
			status: ScheduleCheckResult.ALLOWED,
			currentSeconds,
			matchedRange: matched,
		};
	}

	return {
		allowed: false,
		status: ScheduleCheckResult.OUTSIDE_SCHEDULE,
		currentSeconds,
	};
}

/**
 * Determines whether a launch request is permitted based on the configured allow time ranges.
 * If allowRangesStr is empty, null, or undefined, all times are permitted.
 *
 * @param allowRangesStr - Comma-separated allow time ranges from configuration
 * @param dateOrSeconds - Date object or pre-calculated seconds from midnight (defaults to new Date())
 * @param timeZone - Optional timezone used when dateOrSeconds is a Date (defaults to UTC)
 * @returns True if allowed or no restriction, false if outside schedule
 *
 * @example
 * ```ts
 * isLaunchTimeAllowed('07:00:00-20:00:00', new Date('2026-10-22T10:00:00Z')); // true
 * ```
 */
export function isLaunchTimeAllowed(
	allowRangesStr?: string | null,
	dateOrSeconds: Date | number = new Date(),
	timeZone?: string,
): boolean {
	return evaluateLaunchSchedule(allowRangesStr, dateOrSeconds, timeZone).allowed;
}
