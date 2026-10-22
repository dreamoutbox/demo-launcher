import { describe, it, expect } from 'vitest';
import {
	parseTimeToSeconds,
	parseSingleTimeRange,
	parseTimeRanges,
	isSecondsWithinRange,
	getSecondsFromDate,
	evaluateLaunchSchedule,
	isLaunchTimeAllowed,
	ScheduleCheckResult,
} from '../src/time-range';

describe('Time Range Parser & Schedule Evaluator', () => {
	describe('parseTimeToSeconds', () => {
		it('should parse valid HH:mm:ss strings to seconds from midnight', () => {
			expect(parseTimeToSeconds('00:00:00')).toBe(0);
			expect(parseTimeToSeconds('07:00:00')).toBe(7 * 3600); // 25200
			expect(parseTimeToSeconds('20:00:00')).toBe(20 * 3600); // 72000
			expect(parseTimeToSeconds('23:59:59')).toBe(23 * 3600 + 59 * 60 + 59); // 86399
			expect(parseTimeToSeconds('24:00:00')).toBe(86400);
		});

		it('should parse valid HH:mm strings with default 0 seconds', () => {
			expect(parseTimeToSeconds('07:30')).toBe(7 * 3600 + 30 * 60);
			expect(parseTimeToSeconds('21:00')).toBe(21 * 3600);
		});

		it('should return null for malformed or out-of-range times', () => {
			expect(parseTimeToSeconds('')).toBeNull();
			expect(parseTimeToSeconds('invalid')).toBeNull();
			expect(parseTimeToSeconds('25:00:00')).toBeNull();
			expect(parseTimeToSeconds('12:60:00')).toBeNull();
			expect(parseTimeToSeconds('12:00:60')).toBeNull();
			expect(parseTimeToSeconds('-01:00:00')).toBeNull();
		});
	});

	describe('parseSingleTimeRange', () => {
		it('should parse a valid time range string', () => {
			const range = parseSingleTimeRange('07:00:00-20:00:00');
			expect(range).toEqual({
				startSeconds: 25200,
				endSeconds: 72000,
				raw: '07:00:00-20:00:00',
			});
		});

		it('should handle whitespace around delimiters', () => {
			const range = parseSingleTimeRange('  07:00:00  -  20:00:00  ');
			expect(range).toEqual({
				startSeconds: 25200,
				endSeconds: 72000,
				raw: '07:00:00  -  20:00:00',
			});
		});

		it('should return null for invalid range strings', () => {
			expect(parseSingleTimeRange('')).toBeNull();
			expect(parseSingleTimeRange('07:00:00')).toBeNull();
			expect(parseSingleTimeRange('07:00:00-invalid')).toBeNull();
			expect(parseSingleTimeRange('invalid-20:00:00')).toBeNull();
		});
	});

	describe('parseTimeRanges', () => {
		it('should parse comma-separated time ranges from env format', () => {
			const input = '07:00:00-20:00:00,21:00:00-23:00:00';
			const ranges = parseTimeRanges(input);

			expect(ranges).toHaveLength(2);
			expect(ranges[0]).toEqual({
				startSeconds: 25200,
				endSeconds: 72000,
				raw: '07:00:00-20:00:00',
			});
			expect(ranges[1]).toEqual({
				startSeconds: 75600,
				endSeconds: 82800,
				raw: '21:00:00-23:00:00',
			});
		});

		it('should ignore malformed items and parse valid ones', () => {
			const input = '07:00:00-20:00:00,bad_entry,,21:00:00-23:00:00';
			const ranges = parseTimeRanges(input);

			expect(ranges).toHaveLength(2);
			expect(ranges[0].startSeconds).toBe(25200);
			expect(ranges[1].startSeconds).toBe(75600);
		});

		it('should return an empty array for undefined, null, or empty string', () => {
			expect(parseTimeRanges(undefined)).toEqual([]);
			expect(parseTimeRanges(null)).toEqual([]);
			expect(parseTimeRanges('')).toEqual([]);
			expect(parseTimeRanges('   ')).toEqual([]);
		});
	});

	describe('isSecondsWithinRange', () => {
		const standardRange = { startSeconds: 25200, endSeconds: 72000, raw: '07:00:00-20:00:00' };
		const overnightRange = { startSeconds: 79200, endSeconds: 14400, raw: '22:00:00-04:00:00' };

		it('should check daytime ranges correctly (inclusive boundaries)', () => {
			expect(isSecondsWithinRange(25199, standardRange)).toBe(false); // 06:59:59
			expect(isSecondsWithinRange(25200, standardRange)).toBe(true);  // 07:00:00 (exact start)
			expect(isSecondsWithinRange(43200, standardRange)).toBe(true);  // 12:00:00
			expect(isSecondsWithinRange(72000, standardRange)).toBe(true);  // 20:00:00 (exact end)
			expect(isSecondsWithinRange(72001, standardRange)).toBe(false); // 20:00:01
		});

		it('should check overnight ranges spanning midnight correctly', () => {
			expect(isSecondsWithinRange(79200, overnightRange)).toBe(true); // 22:00:00 (exact start)
			expect(isSecondsWithinRange(82800, overnightRange)).toBe(true); // 23:00:00
			expect(isSecondsWithinRange(3600, overnightRange)).toBe(true);  // 01:00:00 (next morning)
			expect(isSecondsWithinRange(14400, overnightRange)).toBe(true); // 04:00:00 (exact end)
			expect(isSecondsWithinRange(14401, overnightRange)).toBe(false); // 04:00:01
			expect(isSecondsWithinRange(43200, overnightRange)).toBe(false); // 12:00:00
		});
	});

	describe('getSecondsFromDate', () => {
		it('should extract seconds from UTC Date', () => {
			const date = new Date('2026-10-22T07:30:15Z');
			expect(getSecondsFromDate(date)).toBe(7 * 3600 + 30 * 60 + 15);
		});

		it('should support specific IANA timezones', () => {
			// 05:00:00 UTC is 12:00:00 in Asia/Bangkok (UTC+7)
			const date = new Date('2026-10-22T05:00:00Z');
			const bangkokSeconds = getSecondsFromDate(date, 'Asia/Bangkok');
			expect(bangkokSeconds).toBe(12 * 3600);
		});
	});

	describe('evaluateLaunchSchedule & isLaunchTimeAllowed', () => {
		const schedule = '07:00:00-20:00:00,21:00:00-23:00:00';

		it('should permit all requests when schedule configuration is empty or unset', () => {
			const evalUnset = evaluateLaunchSchedule(undefined, 3600);
			expect(evalUnset.allowed).toBe(true);
			expect(evalUnset.status).toBe(ScheduleCheckResult.NO_RESTRICTION);
			expect(isLaunchTimeAllowed(undefined, 3600)).toBe(true);

			const evalEmpty = evaluateLaunchSchedule('', 3600);
			expect(evalEmpty.allowed).toBe(true);
			expect(evalEmpty.status).toBe(ScheduleCheckResult.NO_RESTRICTION);
			expect(isLaunchTimeAllowed('', 3600)).toBe(true);
		});

		it('should allow timestamps inside the configured schedule windows', () => {
			// 08:00:00 (in range 1: 07:00-20:00)
			const eval1 = evaluateLaunchSchedule(schedule, 8 * 3600);
			expect(eval1.allowed).toBe(true);
			expect(eval1.status).toBe(ScheduleCheckResult.ALLOWED);
			expect(eval1.matchedRange?.raw).toBe('07:00:00-20:00:00');
			expect(isLaunchTimeAllowed(schedule, 8 * 3600)).toBe(true);

			// 22:00:00 (in range 2: 21:00-23:00)
			const eval2 = evaluateLaunchSchedule(schedule, 22 * 3600);
			expect(eval2.allowed).toBe(true);
			expect(eval2.status).toBe(ScheduleCheckResult.ALLOWED);
			expect(eval2.matchedRange?.raw).toBe('21:00:00-23:00:00');
			expect(isLaunchTimeAllowed(schedule, 22 * 3600)).toBe(true);
		});

		it('should reject timestamps outside the configured schedule windows', () => {
			// 06:00:00 (before range 1)
			const eval1 = evaluateLaunchSchedule(schedule, 6 * 3600);
			expect(eval1.allowed).toBe(false);
			expect(eval1.status).toBe(ScheduleCheckResult.OUTSIDE_SCHEDULE);
			expect(isLaunchTimeAllowed(schedule, 6 * 3600)).toBe(false);

			// 20:30:00 (gap between range 1 and range 2)
			const eval2 = evaluateLaunchSchedule(schedule, 20 * 3600 + 30 * 60);
			expect(eval2.allowed).toBe(false);
			expect(eval2.status).toBe(ScheduleCheckResult.OUTSIDE_SCHEDULE);
			expect(isLaunchTimeAllowed(schedule, 20 * 3600 + 30 * 60)).toBe(false);

			// 23:30:00 (after range 2)
			const eval3 = evaluateLaunchSchedule(schedule, 23 * 3600 + 30 * 60);
			expect(eval3.allowed).toBe(false);
			expect(eval3.status).toBe(ScheduleCheckResult.OUTSIDE_SCHEDULE);
			expect(isLaunchTimeAllowed(schedule, 23 * 3600 + 30 * 60)).toBe(false);
		});

		it('should accept Date instances for evaluation', () => {
			const insideDate = new Date('2026-10-22T10:30:00Z');
			expect(isLaunchTimeAllowed(schedule, insideDate)).toBe(true);

			const outsideDate = new Date('2026-10-22T04:15:00Z');
			expect(isLaunchTimeAllowed(schedule, outsideDate)).toBe(false);
		});
	});
});
