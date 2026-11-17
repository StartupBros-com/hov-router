/**
 * Holds and hard capacity read the same Anthropic reading through two parsers:
 * holds through the core window normalizer, hard capacity through
 * collectWindows. On every reading here, the account-wide holds a reading
 * starts name the same windows hard capacity excludes the login for, so a
 * login never routes past a window one path calls spent and the other does
 * not.
 *
 * The base payload is the recorded live shape from usage-throttling.test.ts
 * ("live Anthropic payload shape with seven_day_breakdown") with its clock
 * pinned. Every spent reading is a labelled edit of it: nobody has recorded a
 * spent limit.
 */
import { describe, expect, it } from "bun:test";
import {
	deriveExtraUsageHolds,
	extraUsageHoldWindowKind,
	normalizeProviderUsageWindows,
} from "@better-ccflare/core";
import { evaluateHardCapacity } from "../usage-throttling";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const SESSION_RESET = NOW + 3 * HOUR;
const WEEK_RESET = NOW + 4 * DAY;
const iso = (ms: number) => new Date(ms).toISOString();

interface Reading {
	limits: Array<Record<string, unknown> & { kind: string }>;
	five_hour: { utilization: number; resets_at: string | null };
	seven_day: { utilization: number; resets_at: string | null };
	[key: string]: unknown;
}

function livePayload(): Reading {
	return {
		limits: [
			{
				kind: "session",
				percent: 6,
				resets_at: iso(SESSION_RESET),
				scope: null,
				is_active: true,
			},
			{
				kind: "weekly_all",
				percent: 2,
				resets_at: iso(WEEK_RESET),
				scope: null,
				is_active: true,
			},
			{
				kind: "weekly_scoped",
				percent: 0,
				resets_at: iso(WEEK_RESET),
				scope: { model: { id: null, display_name: "Fable" }, surface: null },
				is_active: false,
			},
		],
		five_hour: { utilization: 6, resets_at: iso(SESSION_RESET) },
		seven_day: { utilization: 2, resets_at: iso(WEEK_RESET) },
		seven_day_oauth_apps: null,
		seven_day_opus: null,
		seven_day_sonnet: null,
		seven_day_cowork: null,
		seven_day_omelette: null,
		tangelo: null,
		iguana_necktie: {
			utilization: null,
			resets_at: null,
			limit_dollars: 0,
			used_dollars: 0,
			remaining_dollars: 0,
			locked_reason: null,
		},
		seven_day_breakdown: {
			as_of: iso(NOW),
			window_started_at: iso(NOW - 3 * DAY),
			rows: [
				{ key: "fable", display_name: "Fable", percent: 0 },
				{ key: "other", display_name: "Other", percent: 2 },
			],
		},
		extra_usage: {
			is_enabled: false,
			monthly_limit: null,
			used_credits: null,
			utilization: null,
		},
		spend: { enabled: false },
		member_dashboard_available: false,
	};
}

/** Edit: the session limit (and its five_hour mirror) at `percent`. */
function sessionAt(payload: Reading, percent: number, reset: number | null) {
	const resetsAt = reset === null ? null : iso(reset);
	Object.assign(payload.limits[0], { percent, resets_at: resetsAt });
	payload.five_hour = { utilization: percent, resets_at: resetsAt };
	return payload;
}

/** Edit: the weekly limit (and its seven_day mirror) at `percent`. */
function weekAt(payload: Reading, percent: number) {
	Object.assign(payload.limits[1], { percent });
	payload.seven_day = { utilization: percent, resets_at: iso(WEEK_RESET) };
	return payload;
}

function heldKinds(payload: Reading): string[] {
	const windows = normalizeProviderUsageWindows(payload, "anthropic");
	return deriveExtraUsageHolds(null, windows, NOW)
		.holds.filter((hold) => hold.scope === "account")
		.map(extraUsageHoldWindowKind)
		.sort();
}

function excludedKinds(payload: Reading): string[] {
	return evaluateHardCapacity(payload as never, {
		requestModel: "claude-sonnet-5-5",
		observedAt: NOW,
		provider: "anthropic",
		now: NOW,
	})
		.exclusions.filter((exclusion) => exclusion.scope === "account")
		.map((exclusion) => exclusion.windowKind)
		.sort();
}

describe("account-wide holds agree with hard capacity", () => {
	const readings: Array<[string, () => Reading]> = [
		["the recorded live shape", livePayload],
		["edit: session spent", () => sessionAt(livePayload(), 100, SESSION_RESET)],
		[
			"edit: session over 100%",
			() => sessionAt(livePayload(), 104, SESSION_RESET),
		],
		["edit: session at 99%", () => sessionAt(livePayload(), 99, SESSION_RESET)],
		["edit: week spent", () => weekAt(livePayload(), 100)],
		[
			"edit: session and week spent",
			() => weekAt(sessionAt(livePayload(), 100, SESSION_RESET), 100),
		],
		[
			"edit: session spent with a reset already past",
			() => sessionAt(livePayload(), 100, NOW - HOUR),
		],
	];

	for (const [label, reading] of readings) {
		it(label, () => {
			expect(heldKinds(reading())).toEqual(excludedKinds(reading()));
		});
	}

	it("the spent readings do exclude the login, so agreement is not vacuous", () => {
		expect(
			excludedKinds(weekAt(sessionAt(livePayload(), 100, SESSION_RESET), 100)),
		).toEqual(["session", "weekly_all"]);
	});

	it("differs on a spent limit with no reset: hard capacity excludes until the reading goes stale, no hold starts", () => {
		const payload = () => sessionAt(livePayload(), 100, null);
		expect(excludedKinds(payload())).toEqual(["session"]);
		expect(heldKinds(payload())).toEqual([]);
	});
});
