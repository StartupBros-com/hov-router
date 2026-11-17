import { describe, expect, it } from "bun:test";
import type { ExtraUsageHoldState } from "@better-ccflare/types";
import {
	coveringExtraUsageHold,
	deriveExtraUsageHolds,
	extraUsageHoldCoversModel,
	liveExtraUsageHolds,
	resolveExtraUsageState,
	sameExtraUsageHolds,
	shouldNarrowBilledHold,
} from "./extra-usage-holds";
import { normalizeProviderUsageWindows } from "./usage-windows";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const SESSION_RESET = NOW + 3 * HOUR;
const WEEK_RESET = NOW + 4 * DAY;

type Limit = {
	kind: string;
	percent: number | null;
	resets_at: string | null;
	scope: {
		model: { id: string | null; display_name: string };
		surface: null;
	} | null;
	is_active: boolean;
};

/**
 * The recorded live Anthropic usage payload, copied from the "live Anthropic
 * payload shape with seven_day_breakdown" fixture in
 * packages/proxy/src/handlers/__tests__/usage-throttling.test.ts, with its
 * clock pinned to NOW. Every other payload in this file is a labelled edit of
 * it: nobody has recorded a spent per-model limit, a spent limit with no or a
 * past reset, or two limits spent at once.
 */
function livePayload(): Record<string, unknown> & { limits: Limit[] } {
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

/** Edit: add a weekly per-model limit row (the shape the Fable row uses). */
function withScoped(
	payload: ReturnType<typeof livePayload>,
	displayName: string,
	percent: number,
	reset: number | null,
	active = true,
) {
	payload.limits.push({
		kind: "weekly_scoped",
		percent,
		resets_at: reset === null ? null : iso(reset),
		scope: { model: { id: null, display_name: displayName }, surface: null },
		is_active: active,
	});
	return payload;
}

const windows = (payload: unknown) =>
	normalizeProviderUsageWindows(payload, "anthropic");

/** Edit of the live shape: weekly Opus limit spent and active, resetting with the week. */
const opusSpent = () =>
	windows(withScoped(livePayload(), "Opus", 100, WEEK_RESET));

describe("holds from a reading", () => {
	it("the recorded live shape starts no hold", () => {
		expect(deriveExtraUsageHolds(null, windows(livePayload()), NOW)).toEqual({
			readingAt: NOW,
			holds: [],
		});
	});

	it("an active weekly Opus limit at 100% with a reset ahead holds the Opus family", () => {
		const state = deriveExtraUsageHolds(null, opusSpent(), NOW);
		expect(state.holds).toEqual([
			{
				windowKey: "seven_day_opus",
				scope: "family",
				modelFamily: "opus",
				resetsAtMs: WEEK_RESET,
				startedAt: NOW,
			},
		]);
	});

	it("a spent limit with no reset time, or a past one, starts no hold", () => {
		// Edits: the added Opus row has no reset, then a reset an hour ago.
		const noReset = windows(withScoped(livePayload(), "Opus", 100, null));
		const pastReset = windows(
			withScoped(livePayload(), "Opus", 100, NOW - HOUR),
		);
		expect(deriveExtraUsageHolds(null, noReset, NOW).holds).toEqual([]);
		expect(deriveExtraUsageHolds(null, pastReset, NOW).holds).toEqual([]);
		// Edit: the added Opus row resets at the reading instant.
		const resetNow = windows(withScoped(livePayload(), "Opus", 100, NOW));
		expect(deriveExtraUsageHolds(null, resetNow, NOW).holds).toEqual([]);
	});

	it("a spent window that is neither account-wide nor one model family starts no hold", () => {
		// Edit: the recorded null seven_day_oauth_apps window spent, with a reset ahead.
		const payload = livePayload();
		payload.seven_day_oauth_apps = {
			utilization: 100,
			resets_at: iso(WEEK_RESET),
		};
		const normalized = windows(payload);
		expect(
			normalized.find((w) => w.windowKey === "seven_day_oauth_apps")?.scope,
		).toBe("other");
		expect(deriveExtraUsageHolds(null, normalized, NOW).holds).toEqual([]);
	});

	it("an inactive limit at 100% with a reset ahead starts no hold", () => {
		// Edit: the added Opus row is marked inactive.
		const inactive = windows(
			withScoped(livePayload(), "Opus", 100, WEEK_RESET, false),
		);
		expect(deriveExtraUsageHolds(null, inactive, NOW).holds).toEqual([]);
	});

	it("an active five_hour limit at 100% holds every model", () => {
		// Edit: the session limit and its flat mirror at 100%.
		const payload = livePayload();
		payload.five_hour = { utilization: 100, resets_at: iso(SESSION_RESET) };
		const limit0 = payload.limits[0];
		if (limit0) limit0.percent = 100;
		const state = deriveExtraUsageHolds(null, windows(payload), NOW);
		expect(state.holds).toEqual([
			{
				windowKey: "five_hour",
				scope: "account",
				modelFamily: null,
				resetsAtMs: SESSION_RESET,
				startedAt: NOW,
			},
		]);
		const [hold] = state.holds;
		if (!hold) throw new Error("expected a five_hour hold");
		expect(extraUsageHoldCoversModel(hold, "claude-sonnet-5-5")).toBe(true);
		expect(extraUsageHoldCoversModel(hold, "claude-opus-5-5")).toBe(true);
	});

	it("holds two limits spent at once, each to its own reset", () => {
		// Edit: Opus and Fable rows both spent, Fable resetting a day earlier.
		const payload = withScoped(livePayload(), "Opus", 100, WEEK_RESET);
		const fable = payload.limits[2];
		if (fable) {
			fable.percent = 100;
			fable.is_active = true;
			fable.resets_at = iso(WEEK_RESET - DAY);
		}
		const state = deriveExtraUsageHolds(null, windows(payload), NOW);
		const byKey = Object.fromEntries(
			state.holds.map((h) => [h.windowKey, h.resetsAtMs]),
		);
		expect(byKey).toEqual({
			seven_day_fable: WEEK_RESET - DAY,
			seven_day_opus: WEEK_RESET,
		});
	});

	it("a later reading below 100 ends the hold; one that omits the limit or marks it inactive keeps it", () => {
		const held = deriveExtraUsageHolds(null, opusSpent(), NOW);
		// Edit: the Opus row at 40%.
		const below = windows(withScoped(livePayload(), "Opus", 40, WEEK_RESET));
		expect(deriveExtraUsageHolds(held, below, NOW + HOUR).holds).toEqual([]);
		// The recorded live shape carries no Opus row at all.
		expect(
			deriveExtraUsageHolds(held, windows(livePayload()), NOW + HOUR).holds,
		).toEqual(held.holds);
		// Edit: the Opus row at 40% but marked inactive.
		const inactiveBelow = windows(
			withScoped(livePayload(), "Opus", 40, WEEK_RESET, false),
		);
		expect(
			deriveExtraUsageHolds(held, inactiveBelow, NOW + HOUR).holds,
		).toEqual(held.holds);
	});

	it("a later spent reading with a later reset moves the hold's end and keeps its start", () => {
		const held = deriveExtraUsageHolds(null, opusSpent(), NOW);
		// Edit: the Opus row still spent, resetting a day later.
		const later = windows(
			withScoped(livePayload(), "Opus", 100, WEEK_RESET + DAY),
		);
		const next = deriveExtraUsageHolds(held, later, NOW + HOUR);
		expect(next.readingAt).toBe(NOW + HOUR);
		expect(next.holds).toEqual([
			{
				windowKey: "seven_day_opus",
				scope: "family",
				modelFamily: "opus",
				resetsAtMs: WEEK_RESET + DAY,
				startedAt: NOW,
			},
		]);
	});

	it("a later reading drops a hold whose reset has passed", () => {
		const held = deriveExtraUsageHolds(null, opusSpent(), NOW);
		expect(
			deriveExtraUsageHolds(held, windows(livePayload()), WEEK_RESET).holds,
		).toEqual([]);
	});

	it("a later spent reading with an earlier reset keeps the later end", () => {
		const held = deriveExtraUsageHolds(null, opusSpent(), NOW);
		// Edit: the Opus row still spent, resetting a day earlier.
		const earlier = windows(
			withScoped(livePayload(), "Opus", 100, WEEK_RESET - DAY),
		);
		expect(
			deriveExtraUsageHolds(held, earlier, NOW + HOUR).holds[0]?.resetsAtMs,
		).toBe(WEEK_RESET);
	});

	it("a reading older than the stored state changes nothing", () => {
		const held = deriveExtraUsageHolds(null, opusSpent(), NOW);
		// Edit: the Opus row at 40%, read before the stored reading.
		const below = windows(withScoped(livePayload(), "Opus", 40, WEEK_RESET));
		expect(deriveExtraUsageHolds(held, below, NOW - 1)).toBe(held);
	});

	it("an unchanged result compares equal whatever the order", () => {
		const a = deriveExtraUsageHolds(null, opusSpent(), NOW);
		const b = deriveExtraUsageHolds(a, opusSpent(), NOW + HOUR);
		expect(b.readingAt).toBe(NOW + HOUR);
		expect(sameExtraUsageHolds(a.holds, b.holds)).toBe(true);
		const moved = deriveExtraUsageHolds(
			a,
			windows(withScoped(livePayload(), "Opus", 100, WEEK_RESET + DAY)),
			NOW + HOUR,
		);
		expect(sameExtraUsageHolds(a.holds, moved.holds)).toBe(false);
		const [opusHold] = a.holds;
		if (!opusHold) throw new Error("expected an Opus hold");
		const two: ExtraUsageHoldState["holds"] = [
			{ ...opusHold, windowKey: "seven_day_opus" },
			{
				...opusHold,
				windowKey: "five_hour",
				scope: "account",
				modelFamily: null,
			},
		];
		expect(sameExtraUsageHolds(two, [...two].reverse())).toBe(true);
	});
});

describe("whether a hold applies", () => {
	const state: ExtraUsageHoldState = {
		readingAt: NOW,
		holds: [
			{
				windowKey: "seven_day_opus",
				scope: "family",
				modelFamily: "opus",
				resetsAtMs: WEEK_RESET,
				startedAt: NOW,
			},
		],
	};

	it("applies before the reset and not at the reset instant", () => {
		expect(liveExtraUsageHolds(state, WEEK_RESET - 1)).toHaveLength(1);
		expect(liveExtraUsageHolds(state, WEEK_RESET)).toEqual([]);
		expect(
			coveringExtraUsageHold(state, "claude-opus-5-5", WEEK_RESET - 1),
		).toBe(state.holds[0] ?? null);
		expect(
			coveringExtraUsageHold(state, "claude-opus-5-5", WEEK_RESET),
		).toBeNull();
	});

	it("a family hold covers only that family", () => {
		expect(coveringExtraUsageHold(state, "claude-sonnet-5-5", NOW)).toBeNull();
		expect(
			coveringExtraUsageHold(state, "claude-opus-5-5", NOW)?.windowKey,
		).toBe("seven_day_opus");
	});

	it("of several covering holds, the one that ends last is returned", () => {
		const both: ExtraUsageHoldState = {
			readingAt: NOW,
			holds: [
				...state.holds,
				{
					windowKey: "five_hour",
					scope: "account",
					modelFamily: null,
					resetsAtMs: SESSION_RESET,
					startedAt: NOW,
				},
			],
		};
		expect(
			coveringExtraUsageHold(both, "claude-opus-5-5", NOW)?.resetsAtMs,
		).toBe(WEEK_RESET);
		expect(
			coveringExtraUsageHold(both, "claude-sonnet-5-5", NOW)?.windowKey,
		).toBe("five_hour");
	});

	it("no stored state applies nothing", () => {
		expect(liveExtraUsageHolds(null, NOW)).toEqual([]);
		expect(coveringExtraUsageHold(null, "claude-opus-5-5", NOW)).toBeNull();
	});
});

describe("narrowing a hold from a billed response", () => {
	const BILLED_AT = NOW - 60_000;

	it("a reading after the billed time with weekly Opus spent narrows an Opus billed hold", () => {
		expect(
			shouldNarrowBilledHold(
				{ billedAt: BILLED_AT, family: "opus" },
				opusSpent(),
				NOW,
			),
		).toBe(true);
	});

	it("a reading with nothing spent leaves the billed hold", () => {
		expect(
			shouldNarrowBilledHold(
				{ billedAt: BILLED_AT, family: "opus" },
				windows(livePayload()),
				NOW,
			),
		).toBe(false);
	});

	it("a reading with only Fable spent leaves an Opus billed hold", () => {
		// Edit: the recorded Fable row spent and active.
		const payload = livePayload();
		const fable = payload.limits[2];
		if (fable) {
			fable.percent = 100;
			fable.is_active = true;
		}
		expect(
			shouldNarrowBilledHold(
				{ billedAt: BILLED_AT, family: "opus" },
				windows(payload),
				NOW,
			),
		).toBe(false);
	});

	it("a reading taken at or before the billed time never narrows it", () => {
		const billed = { billedAt: NOW, family: "opus" };
		expect(shouldNarrowBilledHold(billed, opusSpent(), NOW)).toBe(false);
		expect(shouldNarrowBilledHold(billed, opusSpent(), NOW - 1)).toBe(false);
	});

	it("a billed hold with no billed time is never narrowed", () => {
		expect(
			shouldNarrowBilledHold(
				{ billedAt: null, family: "opus" },
				opusSpent(),
				NOW,
			),
		).toBe(false);
	});

	it("a billed family of null narrows only on an account-wide spent limit", () => {
		const billed = { billedAt: BILLED_AT, family: null };
		expect(shouldNarrowBilledHold(billed, opusSpent(), NOW)).toBe(false);
		// Edit: the flat weekly window at 100% (a flat window wins over its
		// limits row when both are present).
		const payload = livePayload();
		payload.seven_day = { utilization: 100, resets_at: iso(WEEK_RESET) };
		expect(shouldNarrowBilledHold(billed, windows(payload), NOW)).toBe(true);
	});

	it("an account-wide spent limit narrows any billed family", () => {
		// Edit: the session limit's flat mirror at 100%.
		const payload = livePayload();
		payload.five_hour = { utilization: 100, resets_at: iso(SESSION_RESET) };
		expect(
			shouldNarrowBilledHold(
				{ billedAt: BILLED_AT, family: "sonnet" },
				windows(payload),
				NOW,
			),
		).toBe(true);
	});
});

describe("displayed extra-usage state", () => {
	const MAX_AGE = 10 * 60_000;

	it("the recorded live shape reads off", () => {
		expect(resolveExtraUsageState(livePayload(), NOW, NOW, MAX_AGE)).toBe(
			"off",
		);
	});

	it("spend.enabled true and extra_usage.is_enabled true each read on", () => {
		// Edits: spend switched on; then spend removed and extra_usage switched on.
		expect(
			resolveExtraUsageState(
				{ ...livePayload(), spend: { enabled: true } },
				NOW,
				NOW,
				MAX_AGE,
			),
		).toBe("on");
		const { spend: _spend, ...withoutSpend } = livePayload();
		expect(
			resolveExtraUsageState(
				{ ...withoutSpend, extra_usage: { is_enabled: true } },
				NOW,
				NOW,
				MAX_AGE,
			),
		).toBe("on");
	});

	it("spend.enabled false reads off with no disabled_reason and not known with one", () => {
		// Edit: spend carries a disabled_reason.
		expect(
			resolveExtraUsageState(
				{
					...livePayload(),
					spend: { enabled: false, disabled_reason: "out_of_credits" },
				},
				NOW,
				NOW,
				MAX_AGE,
			),
		).toBe("unknown");
		expect(
			resolveExtraUsageState(
				{ ...livePayload(), spend: { enabled: false } },
				NOW,
				NOW,
				MAX_AGE,
			),
		).toBe("off");
	});

	it("spend decides before extra_usage", () => {
		expect(
			resolveExtraUsageState(
				{
					...livePayload(),
					spend: { enabled: true },
					extra_usage: { is_enabled: false },
				},
				NOW,
				NOW,
				MAX_AGE,
			),
		).toBe("on");
	});

	it("a reading with neither field reads not known", () => {
		const { spend: _spend, extra_usage: _extra, ...neither } = livePayload();
		expect(resolveExtraUsageState(neither, NOW, NOW, MAX_AGE)).toBe("unknown");
	});

	it("no reading, or one past the cache lifetime, reads not known", () => {
		expect(resolveExtraUsageState(null, null, NOW, MAX_AGE)).toBe("unknown");
		expect(
			resolveExtraUsageState(livePayload(), NOW - MAX_AGE - 1, NOW, MAX_AGE),
		).toBe("unknown");
		expect(
			resolveExtraUsageState(livePayload(), NOW - MAX_AGE, NOW, MAX_AGE),
		).toBe("off");
	});
});
