import { describe, expect, it } from "bun:test";
import { formatClockTime } from "@hov-router/ui-common";
import {
	ANTHROPIC_USAGE_SETTINGS_URL,
	type ExtraUsageStatusInput,
	extraUsageStatus,
} from "./extra-usage-status";

const now = Date.UTC(2026, 10, 16, 12, 0);
const clock = { locale: "en-US", timeZone: "UTC" } as const;
const at = (ms: number) => formatClockTime(ms, now, clock);
const HOUR = 60 * 60 * 1000;

function login(
	overrides: Partial<ExtraUsageStatusInput> = {},
): ExtraUsageStatusInput {
	return {
		provider: "anthropic",
		autoPauseOnOverageEnabled: false,
		autoFallbackEnabled: false,
		rateLimitReset: null,
		extraUsage: { state: "unknown", readingAt: null },
		extraUsageHolds: [],
		extraUsageBilledHold: null,
		...overrides,
	};
}

const opusHold = {
	windowKey: "seven_day_opus",
	scope: "family" as const,
	modelFamily: "opus",
	resetsAtMs: now + 3 * HOUR,
	startedAt: now - HOUR,
};

describe("extraUsageStatus", () => {
	it("links to Anthropic's usage settings page", () => {
		expect(ANTHROPIC_USAGE_SETTINGS_URL).toBe(
			"https://claude.ai/settings/usage",
		);
	});

	it("reads on with its reading time and one sentence of warning", () => {
		const status = extraUsageStatus(
			login({ extraUsage: { state: "on", readingAt: now - 60_000 } }),
			now,
			clock,
		);
		expect(status?.state).toBe("on");
		expect(status?.stateLine).toBe(
			`Extra usage is on at Anthropic as of ${at(now - 60_000)}.`,
		);
		expect(status?.warning).toBe(
			"Anthropic bills this login’s requests past a spent plan limit.",
		);
	});

	it("keeps the warning to the billing fact, since the switch sits beside it", () => {
		const on = (autoPauseOnOverageEnabled: boolean) =>
			extraUsageStatus(
				login({
					autoPauseOnOverageEnabled,
					extraUsage: { state: "on", readingAt: now },
				}),
				now,
				clock,
			)?.warning;
		expect(on(true)).toBe(on(false));
		expect(on(true)).not.toContain("switch");
	});

	it("reads off with no warning", () => {
		const status = extraUsageStatus(
			login({ extraUsage: { state: "off", readingAt: now } }),
			now,
			clock,
		);
		expect(status?.stateLine).toBe(
			`Extra usage is off at Anthropic as of ${at(now)}.`,
		);
		expect(status?.warning).toBeNull();
	});

	it("leaves out the time when an on or off state has no reading time", () => {
		const status = extraUsageStatus(
			login({ extraUsage: { state: "off", readingAt: null } }),
			now,
			clock,
		);
		expect(status?.stateLine).toBe("Extra usage is off at Anthropic.");
	});

	it("reads not known with no reading time when there is no reading", () => {
		const status = extraUsageStatus(login(), now, clock);
		expect(status?.state).toBe("unknown");
		expect(status?.stateLine).toBe("Extra usage at Anthropic is not known.");
		expect(status?.warning).toBeNull();
	});

	it("keeps the reading time on a state that reads not known", () => {
		const readingAt = now - 5 * 60_000;
		const status = extraUsageStatus(
			login({ extraUsage: { state: "unknown", readingAt } }),
			now,
			clock,
		);
		expect(status?.stateLine).toBe(
			`Extra usage at Anthropic is not known (last reading ${at(readingAt)}).`,
		);
	});

	it("shows a model hold with the model, the spent limit, how it ends and a short cue", () => {
		const status = extraUsageStatus(
			login({ autoPauseOnOverageEnabled: true, extraUsageHolds: [opusHold] }),
			now,
			clock,
		);
		expect(status?.holds).toEqual([
			{
				key: "reading:seven_day_opus:opus",
				windowKey: "seven_day_opus",
				held: "Opus",
				why: "Opus (Weekly) limit spent",
				ends: `Ends at ${at(opusHold.resetsAtMs)} or when you turn the switch off.`,
				cue: `Opus held until ${at(opusHold.resetsAtMs)}`,
			},
		]);
	});

	it("names every model for a hold on the whole login", () => {
		const status = extraUsageStatus(
			login({
				autoPauseOnOverageEnabled: true,
				extraUsageHolds: [
					{
						...opusHold,
						windowKey: "seven_day",
						scope: "account",
						modelFamily: null,
					},
				],
			}),
			now,
			clock,
		);
		expect(status?.holds[0]?.held).toBe("Every model");
		expect(status?.holds[0]?.why).toBe("Weekly limit spent");
		expect(status?.holds[0]?.cue).toBe(
			`All models held until ${at(opusHold.resetsAtMs)}`,
		);
	});

	it("gives the row one cue while a whole-login hold lasts at least as long as the others", () => {
		const status = extraUsageStatus(
			login({
				autoPauseOnOverageEnabled: true,
				extraUsageHolds: [
					opusHold,
					{
						...opusHold,
						windowKey: "five_hour",
						scope: "account",
						modelFamily: null,
						resetsAtMs: now + HOUR,
					},
					{
						...opusHold,
						windowKey: "seven_day",
						scope: "account",
						modelFamily: null,
						resetsAtMs: now + 40 * HOUR,
					},
				],
			}),
			now,
			clock,
		);
		// Every hold keeps its full line for Settings; only the row's cue is shared.
		expect(status?.holds.map((hold) => hold.windowKey)).toEqual([
			"seven_day_opus",
			"five_hour",
			"seven_day",
		]);
		expect(status?.holds.map((hold) => hold.cue)).toEqual([
			null,
			null,
			`All models held until ${at(now + 40 * HOUR)}`,
		]);
	});

	it("keeps a model hold's cue when it outlasts the whole-login hold", () => {
		const status = extraUsageStatus(
			login({
				autoPauseOnOverageEnabled: true,
				extraUsageHolds: [
					opusHold,
					{
						...opusHold,
						windowKey: "five_hour",
						scope: "account",
						modelFamily: null,
						resetsAtMs: now + HOUR,
					},
				],
			}),
			now,
			clock,
		);
		expect(status?.holds.map((hold) => hold.cue)).toEqual([
			`Opus held until ${at(opusHold.resetsAtMs)}`,
			`All models held until ${at(now + HOUR)}`,
		]);
	});

	it("drops a hold whose reset has passed since the list was fetched", () => {
		const status = extraUsageStatus(
			login({
				autoPauseOnOverageEnabled: true,
				extraUsageHolds: [{ ...opusHold, resetsAtMs: now - 1 }],
			}),
			now,
			clock,
		);
		expect(status?.holds).toEqual([]);
	});

	it("shows no hold while the switch is off", () => {
		const status = extraUsageStatus(
			login({
				extraUsageHolds: [opusHold],
				extraUsageBilledHold: { billedAt: now, family: "opus" },
			}),
			now,
			clock,
		);
		expect(status?.holds).toEqual([]);
	});

	it("names only resume and the switch for a billed hold without Return after reset", () => {
		const billedAt = now - HOUR;
		const status = extraUsageStatus(
			login({
				autoPauseOnOverageEnabled: true,
				rateLimitReset: new Date(now + 2 * HOUR).toISOString(),
				extraUsageBilledHold: { billedAt, family: "opus" },
			}),
			now,
			clock,
		);
		expect(status?.holds).toEqual([
			{
				key: "billed",
				windowKey: null,
				held: "Every model",
				why: `Anthropic billed an Opus request as extra usage at ${at(billedAt)}`,
				ends: "Ends when you resume this login or when you turn the switch off.",
				// The row already reads Paused and Auto-paused: overage for this hold.
				cue: null,
			},
		]);
	});

	it("adds the stored reset time with Return after reset on", () => {
		const reset = now + 2 * HOUR;
		const status = extraUsageStatus(
			login({
				autoPauseOnOverageEnabled: true,
				autoFallbackEnabled: true,
				rateLimitReset: new Date(reset).toISOString(),
				extraUsageBilledHold: { billedAt: now, family: "sonnet" },
			}),
			now,
			clock,
		);
		expect(status?.holds[0]?.ends).toBe(
			`Ends when you resume this login, after ${at(reset)} or when you turn the switch off.`,
		);
	});

	it("says the login returns on its next request once the stored reset has passed", () => {
		const status = extraUsageStatus(
			login({
				autoPauseOnOverageEnabled: true,
				autoFallbackEnabled: true,
				rateLimitReset: new Date(now - HOUR).toISOString(),
				extraUsageBilledHold: { billedAt: now - 2 * HOUR, family: "opus" },
			}),
			now,
			clock,
		);
		expect(status?.holds[0]?.ends).toBe(
			"Ends when you resume this login, at its next request (its reset time has passed) or when you turn the switch off.",
		);
	});

	it("names no reset when Return after reset is on but none is stored", () => {
		const status = extraUsageStatus(
			login({
				autoPauseOnOverageEnabled: true,
				autoFallbackEnabled: true,
				extraUsageBilledHold: { billedAt: now, family: "opus" },
			}),
			now,
			clock,
		);
		expect(status?.holds[0]?.ends).toBe(
			"Ends when you resume this login or when you turn the switch off.",
		);
	});

	it("explains a billed hold from before the billed time was stored", () => {
		const status = extraUsageStatus(
			login({
				autoPauseOnOverageEnabled: true,
				extraUsageBilledHold: { billedAt: null, family: null },
			}),
			now,
			clock,
		);
		expect(status?.holds[0]?.why).toBe(
			"Anthropic billed a request as extra usage",
		);
	});

	it("lists a billed hold before the holds from readings", () => {
		const status = extraUsageStatus(
			login({
				autoPauseOnOverageEnabled: true,
				extraUsageHolds: [opusHold],
				extraUsageBilledHold: { billedAt: now, family: "opus" },
			}),
			now,
			clock,
		);
		expect(status?.holds.map((hold) => hold.key)).toEqual([
			"billed",
			"reading:seven_day_opus:opus",
		]);
	});

	it("returns nothing for another provider or a server that sends no state", () => {
		expect(extraUsageStatus(login({ provider: "codex" }), now, clock)).toBe(
			null,
		);
		expect(
			extraUsageStatus(login({ extraUsage: undefined }), now, clock),
		).toBeNull();
	});
});
