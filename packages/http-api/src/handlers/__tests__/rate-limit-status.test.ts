import { describe, expect, it } from "bun:test";
import {
	computeRateLimitStatusDisplay,
	extractUsageResetMs,
	getRepresentativeUsageResetMs,
	isUsageExhausted,
} from "../rate-limit-status";

/**
 * Incident 2026-07-09: MAX_200_ALT_2 showed `rateLimitStatus: "OK"` on the
 * dashboard while its weekly usage window sat at 100% (is_active, critical)
 * and every upstream request 429'd. The status string only reflected the last
 * unified-header snapshot (`rate_limit_status`, NULL for ALT_2) and an active
 * cooldown — usage exhaustion was invisible. These tests pin the desired
 * behavior: an exhausted usage window must take precedence over "OK" and over
 * stale "allowed*" header snapshots.
 */

const NOW = Date.UTC(2026, 6, 9, 2, 30, 0);

const base = {
	rate_limit_status: null as string | null,
	rate_limit_reset: null as number | null,
	rate_limited_until: null as number | null,
	usageUtilization: null as number | null,
	usageResetMs: null as number | null,
};

describe("computeRateLimitStatusDisplay — usage exhaustion (incident fix)", () => {
	it("reports usage_exhausted instead of OK when the representative window is at 100%", () => {
		// ALT_2 during the incident: no unified header snapshot, weekly 100%.
		const resetMs = NOW + 60 * 60000;
		const status = computeRateLimitStatusDisplay(
			{ ...base, usageUtilization: 100, usageResetMs: resetMs },
			NOW,
		);
		expect(status).toBe("usage_exhausted (60m)");
	});

	it("reports usage_exhausted without minutes when no reset time is known", () => {
		const status = computeRateLimitStatusDisplay(
			{ ...base, usageUtilization: 100 },
			NOW,
		);
		expect(status).toBe("usage_exhausted");
	});

	it("outranks a stale allowed_warning header snapshot", () => {
		// MAX_200_ALT during the incident: allowed_warning with far-future
		// reset, but the weekly window was already at 100%.
		const status = computeRateLimitStatusDisplay(
			{
				...base,
				rate_limit_status: "allowed_warning",
				rate_limit_reset: NOW + 2907 * 60000,
				usageUtilization: 100,
				usageResetMs: NOW + 2907 * 60000,
			},
			NOW,
		);
		expect(status).toBe("usage_exhausted (2907m)");
	});

	it("does NOT claim exhaustion when the known reset lies in the past (stale usage snapshot)", () => {
		const status = computeRateLimitStatusDisplay(
			{ ...base, usageUtilization: 100, usageResetMs: NOW - 1 },
			NOW,
		);
		expect(status).toBe("OK");
	});

	it("does not fire below 100%", () => {
		const status = computeRateLimitStatusDisplay(
			{ ...base, usageUtilization: 99 },
			NOW,
		);
		expect(status).toBe("OK");
	});

	it("outranks an active cooldown lock (usage exhaustion is the harder fact)", () => {
		const status = computeRateLimitStatusDisplay(
			{
				...base,
				rate_limited_until: NOW + 30_000,
				usageUtilization: 100,
				usageResetMs: NOW + 120 * 60000,
			},
			NOW,
		);
		expect(status).toBe("usage_exhausted (120m)");
	});
});

describe("computeRateLimitStatusDisplay — Codex credit drain", () => {
	const spent = {
		...base,
		usageUtilization: 100,
		usageResetMs: NOW + 60 * 60000,
	};

	it("does not report usage_exhausted when credit drain is active", () => {
		expect(
			computeRateLimitStatusDisplay({ ...spent, creditDrainActive: true }, NOW),
		).toBe("OK");
	});

	it("reports usage_exhausted when credit drain is off or unset", () => {
		expect(computeRateLimitStatusDisplay(spent, NOW)).toBe(
			"usage_exhausted (60m)",
		);
		expect(
			computeRateLimitStatusDisplay(
				{ ...spent, creditDrainActive: false },
				NOW,
			),
		).toBe("usage_exhausted (60m)");
	});
});

describe("isUsageExhausted — shared staleness guard", () => {
	it("is exhausted at 100% with unknown reset", () => {
		expect(isUsageExhausted(100, null, NOW)).toBe(true);
	});

	it("is exhausted at 100% with a future reset", () => {
		expect(isUsageExhausted(100, NOW + 60_000, NOW)).toBe(true);
	});

	it("is NOT exhausted when the known reset lies in the past (stale snapshot)", () => {
		expect(isUsageExhausted(100, NOW - 1, NOW)).toBe(false);
	});

	it("is NOT exhausted below 100% or without data", () => {
		expect(isUsageExhausted(99, null, NOW)).toBe(false);
		expect(isUsageExhausted(null, null, NOW)).toBe(false);
	});
});

/**
 * 2026-11-20: max-secondary-wmgm and max-tertiary-will showed "Provider
 * warning" for days after their weekly windows rolled over to 0%. The column
 * still held the `allowed_warning` header from their last successful response
 * (11-16 / 11-17, near their limit); nothing rewrites it until another
 * response carries a unified status header, and the 429s they saw since carry
 * none. A soft notice whose stored reset has passed describes nothing current.
 */
describe("computeRateLimitStatusDisplay — stale soft header snapshot", () => {
	const PROD_NOW = Date.UTC(2026, 10, 20, 10, 20, 0);

	it("drops allowed_warning once its stored reset has passed (the real wmgm row)", () => {
		const status = computeRateLimitStatusDisplay(
			{
				...base,
				rate_limit_status: "allowed_warning",
				rate_limit_reset: 1794953744938, // 2026-11-17 22:15:44Z
				usageUtilization: 0,
				usageResetMs: Date.UTC(2026, 10, 26, 18, 0, 0),
			},
			PROD_NOW,
		);
		expect(status).toBe("OK");
	});

	it("drops queueing_soft once its stored reset has passed", () => {
		const status = computeRateLimitStatusDisplay(
			{
				...base,
				rate_limit_status: "queueing_soft",
				rate_limit_reset: NOW - 1,
			},
			NOW,
		);
		expect(status).toBe("OK");
	});

	it("falls through to an active cooldown when the stale soft notice is dropped", () => {
		const status = computeRateLimitStatusDisplay(
			{
				...base,
				rate_limit_status: "allowed_warning",
				rate_limit_reset: NOW - 60_000,
				rate_limited_until: NOW + 30_000,
			},
			NOW,
		);
		expect(status).toBe("Rate limited (1m)");
	});

	it("keeps a soft notice whose reset is still ahead", () => {
		const status = computeRateLimitStatusDisplay(
			{
				...base,
				rate_limit_status: "allowed_warning",
				rate_limit_reset: NOW + 67 * 60000,
			},
			NOW,
		);
		expect(status).toBe("allowed_warning (67m)");
	});

	it("keeps a soft notice with no stored reset (nothing says it expired)", () => {
		const status = computeRateLimitStatusDisplay(
			{ ...base, rate_limit_status: "allowed_warning" },
			NOW,
		);
		expect(status).toBe("allowed_warning");
	});

	it("leaves a past-reset hard status as reported (the card keeps its Clear cooldown action)", () => {
		const status = computeRateLimitStatusDisplay(
			{ ...base, rate_limit_status: "rate_limited", rate_limit_reset: NOW - 1 },
			NOW,
		);
		expect(status).toBe("rate_limited");
	});
});

describe("computeRateLimitStatusDisplay — existing behavior (parity)", () => {
	it("shows the unified header status with minutes until reset", () => {
		const status = computeRateLimitStatusDisplay(
			{
				...base,
				rate_limit_status: "allowed",
				rate_limit_reset: NOW + 67 * 60000,
			},
			NOW,
		);
		expect(status).toBe("allowed (67m)");
	});

	it("shows the unified header status without minutes when reset already passed", () => {
		const status = computeRateLimitStatusDisplay(
			{ ...base, rate_limit_status: "allowed", rate_limit_reset: NOW - 1000 },
			NOW,
		);
		expect(status).toBe("allowed");
	});

	it("falls back to the legacy cooldown display", () => {
		const status = computeRateLimitStatusDisplay(
			{ ...base, rate_limited_until: NOW + 30_000 },
			NOW,
		);
		expect(status).toBe("Rate limited (1m)");
	});

	it("returns OK when nothing is known", () => {
		expect(computeRateLimitStatusDisplay(base, NOW)).toBe("OK");
	});
});

describe("getRepresentativeUsageResetMs — shared provider-aware reset derivation", () => {
	it("zai: reads the reset from the tokens_limit payload key despite the five_hour display label", () => {
		const resetAt = NOW + 3_600_000;
		const data = {
			time_limit: null,
			tokens_limit: {
				used: 100,
				remaining: 0,
				percentage: 100,
				resetAt,
				type: "tokens",
			},
		};
		expect(getRepresentativeUsageResetMs(data, "zai")).toBe(resetAt);
	});

	it("anthropic: uses the representative (max-utilization) window's resets_at", () => {
		const data = {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: { utilization: 100, resets_at: "2026-07-11T08:00:00.000Z" },
		};
		expect(getRepresentativeUsageResetMs(data, "anthropic")).toBe(
			Date.UTC(2026, 6, 11, 8, 0, 0),
		);
	});

	it("nanogpt: uses the busier window's resetAt", () => {
		const resetAt = NOW + 7_200_000;
		const data = {
			active: true,
			limits: { daily: 1, monthly: 1 },
			enforceDailyLimit: true,
			daily: { used: 1, remaining: 0, percentUsed: 1, resetAt },
			monthly: {
				used: 0,
				remaining: 1,
				percentUsed: 0.1,
				resetAt: NOW + 30 * 86_400_000,
			},
			state: "active",
			graceUntil: null,
		};
		expect(getRepresentativeUsageResetMs(data, "nanogpt")).toBe(resetAt);
	});

	it("returns null for unknown providers or missing data", () => {
		expect(getRepresentativeUsageResetMs(null, "zai")).toBeNull();
		expect(getRepresentativeUsageResetMs({}, "openai-compatible")).toBeNull();
	});

	it("anthropic: limits[]-only payload (2026 API) falls back to the matching limit's own resets_at", () => {
		// Post-merge regression (PR #299 x PR #296): five_hour/seven_day are
		// absent as properties on limits[]-only payloads, so the flat-window
		// extraction must fall back to the limits[] entry itself instead of
		// silently returning null (which disabled the staleness guard).
		const weeklyReset = "2026-07-11T08:00:00.000Z";
		const data = {
			limits: [
				{ kind: "session", percent: 30, resets_at: "2026-07-10T10:00:00.000Z" },
				{ kind: "weekly_all", percent: 100, resets_at: weeklyReset },
			],
		};
		expect(getRepresentativeUsageResetMs(data, "anthropic")).toBe(
			Date.UTC(2026, 6, 11, 8, 0, 0),
		);
	});

	it("anthropic: limits[]-only payload with no matching kind returns null", () => {
		const data = {
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: "2026-07-11T08:00:00.000Z",
				},
			],
		};
		expect(getRepresentativeUsageResetMs(data, "anthropic")).toBeNull();
	});
});

describe("extractUsageResetMs", () => {
	it("reads ISO resets_at from anthropic-style windows", () => {
		const data = {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: { utilization: 100, resets_at: "2026-07-11T08:00:00.000Z" },
		};
		expect(extractUsageResetMs(data, "seven_day")).toBe(
			Date.UTC(2026, 6, 11, 8, 0, 0),
		);
	});

	it("reads numeric resetAt from zai/nanogpt-style windows", () => {
		const resetAt = NOW + 3_600_000;
		const data = { tokens_limit: { percentage: 100, resetAt } };
		expect(extractUsageResetMs(data, "tokens_limit")).toBe(resetAt);
	});

	it("returns null for unknown windows or missing data", () => {
		expect(extractUsageResetMs(null, "seven_day")).toBeNull();
		expect(extractUsageResetMs({}, "seven_day")).toBeNull();
		expect(extractUsageResetMs({ seven_day: {} }, null)).toBeNull();
	});
});
