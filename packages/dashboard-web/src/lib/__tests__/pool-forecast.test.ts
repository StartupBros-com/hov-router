import { describe, expect, it } from "bun:test";
import type { AccountResponse } from "@better-ccflare/types";
import {
	bankedResetAccounts,
	buildPoolGroups,
	dayWord,
	forecastHeadline,
	H,
	laneText,
	shouldShowNextBadge,
	simulate,
} from "../pool-forecast";
import { computePoolUsage, computeScopedPoolUsage } from "../pool-usage";

const NOW = Date.parse("2026-11-15T12:00:00Z");
function mkAccount(partial: Partial<AccountResponse>): AccountResponse {
	return {
		id: partial.id ?? "id",
		name: partial.name ?? "acc",
		provider: partial.provider ?? "anthropic",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: new Date(NOW).toISOString(),
		paused: false,
		requiresReauth: false,
		pauseReason: null,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "",
		priority: 0,
		autoFallbackEnabled: false,
		autoPauseOnOverageEnabled: false,
		peakHoursPauseEnabled: false,
		customEndpoint: null,
		modelMappings: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: true,
		crossRegionMode: null,
		modelFallbacks: null,
		billingType: null,
		sessionStats: null,
		isPrimary: false,
		...partial,
	};
}

function account(
	name: string,
	provider = "anthropic",
	pct = 60,
	reset: number | null = NOW + 48 * H,
): AccountResponse {
	return mkAccount({
		id: name,
		name,
		provider,
		usageData: {
			five_hour: {
				utilization: pct,
				resets_at: reset == null ? null : new Date(reset).toISOString(),
			},
			seven_day: {
				utilization: pct,
				resets_at: reset == null ? null : new Date(reset).toISOString(),
			},
		},
	});
}
const base = (
	state: "active" | "out" | "unknown",
	pct: number | null,
	resetMs: number | null,
) => ({ id: "a", name: "a", state, pct, resetMs, isPrimary: true });
describe("pool groups", () => {
	it("splits providers in plan order and includes 5-hour pools", () => {
		const { groups } = buildPoolGroups(
			[
				account("c", "codex"),
				account("a"),
				account("z", "zai"),
				account("b", "alibaba-coding-plan"),
			],
			NOW,
		);
		expect(groups.map((g) => g.title)).toEqual([
			"Claude Max weekly",
			"Claude Max 5-hour",
			"Codex Pro weekly",
			"Codex Pro 5-hour",
			"Alibaba Coding Plan weekly",
			"Alibaba Coding Plan 5-hour",
			"Z.ai 5-hour",
		]);
	});
	it("hides pools with no reset time unless an account is out of that pool's own quota", () => {
		expect(
			buildPoolGroups([account("a", "codex", 0, null)], NOW).hidden.map(
				(g) => g.title,
			),
		).toEqual(["Codex Pro weekly", "Codex Pro 5-hour"]);
		// Paused is operator steering, not an outage: with no reset time both pools stay hidden.
		const paused = account("a", "codex", 0, null);
		paused.paused = true;
		expect(buildPoolGroups([paused], NOW).groups).toEqual([]);
		// Out of 5-hour quota with no reset time: the 5-hour pool shows the outage;
		// the weekly pool holds the account back and, with no weekly reset, stays hidden.
		const fiveOut = mkAccount({
			id: "five-out",
			name: "five-out",
			provider: "codex",
			usageData: {
				five_hour: { utilization: 100, resets_at: null },
				seven_day: { utilization: 60, resets_at: null },
			},
		});
		const built = buildPoolGroups([fiveOut], NOW);
		expect(built.groups.map((g) => g.title)).toEqual(["Codex Pro 5-hour"]);
		expect(built.hidden.map((g) => g.title)).toEqual(["Codex Pro weekly"]);
	});
	it("does not repeat a weekly outage as a 5-hour pool", () => {
		const out = (name: string) =>
			mkAccount({
				id: name,
				name,
				provider: "codex",
				usageData: {
					five_hour: { utilization: 0, resets_at: null },
					seven_day: {
						utilization: 100,
						resets_at: new Date(NOW + 20 * H).toISOString(),
					},
				},
			});
		const built = buildPoolGroups([out("a"), out("b")], NOW);
		expect(built.groups.map((g) => g.title)).toEqual(["Codex Pro weekly"]);
		expect(built.hidden.map((g) => g.title)).toEqual(["Codex Pro 5-hour"]);
		const five = built.hidden[0];
		expect(five.accounts.map((a) => [a.state, a.reason])).toEqual([
			["held", "seven_day_exhausted"],
			["held", "seven_day_exhausted"],
		]);
	});
	it("holds back paused, cooling and other-window accounts with their own usage", () => {
		const paused = account("paused", "codex", 40, NOW + 50 * H);
		paused.paused = true;
		const cooling = account("cooling", "codex", 75, NOW + 90 * H);
		cooling.rateLimitedUntil = NOW + 5 * 60_000;
		const fiveOut = mkAccount({
			id: "five-out",
			name: "five-out",
			provider: "codex",
			usageData: {
				five_hour: {
					utilization: 100,
					resets_at: new Date(NOW + 2 * H).toISOString(),
				},
				seven_day: {
					utilization: 60,
					resets_at: new Date(NOW + 70 * H).toISOString(),
				},
			},
		});
		const { groups } = buildPoolGroups([paused, cooling, fiveOut], NOW);
		const weekly = groups.find((g) => g.id === "codex:weekly");
		const byName = (n: string) => weekly?.accounts.find((a) => a.name === n);
		expect(byName("paused")).toMatchObject({
			state: "held",
			reason: "paused",
			pct: 40,
			resetMs: NOW + 50 * H,
			backMs: null,
		});
		expect(byName("cooling")).toMatchObject({
			state: "held",
			reason: "rate_limited",
			pct: 75,
			resetMs: NOW + 90 * H,
			backMs: NOW + 5 * 60_000,
		});
		expect(byName("five-out")).toMatchObject({
			state: "held",
			reason: "five_hour_exhausted",
			pct: 60,
			resetMs: NOW + 70 * H,
			backMs: NOW + 2 * H,
		});
		const five = groups.find((g) => g.id === "codex:five_hour");
		expect(five?.accounts.find((a) => a.name === "five-out")).toMatchObject({
			state: "out",
			reason: "five_hour_exhausted",
			resetMs: NOW + 2 * H,
		});
		const now = NOW;
		expect(laneText(byName("paused") as never, now)).toBe(
			"paused: paused, 40% used, refills in 2d 2h",
		);
		expect(laneText(byName("cooling") as never, now)).toBe(
			"cooling: cooling down, back in 5m, 75% used",
		);
		expect(laneText(byName("five-out") as never, now)).toBe(
			"five-out: out of 5-hour quota, back in 2h, 60% used",
		);
	});
	it("preserves membership of shipped computations including family pools and unknown accounts", () => {
		const a = account("a");
		a.usageData = {
			...a.usageData,
			limits: [
				{
					kind: "weekly_scoped",
					percent: 40,
					resets_at: new Date(NOW + H).toISOString(),
					scope: { model: { display_name: "Fable" } },
				},
				{
					kind: "weekly_scoped",
					percent: 20,
					resets_at: new Date(NOW + 2 * H).toISOString(),
					scope: { model: { display_name: "Sonnet" } },
				},
			],
		} as AccountResponse["usageData"];
		const accounts = [
			a,
			account("b", "codex"),
			account("out", "codex", 100),
			account("alibaba", "alibaba-coding-plan"),
			account("zai", "zai"),
			mkAccount({ name: "unknown", id: "unknown" }),
			account("no-reset", "anthropic", 0, null),
		];
		const built = buildPoolGroups(accounts, NOW);
		const all = [...built.groups, ...built.hidden];
		expect(all.find((g) => g.kind === "family")?.title).toBe("Fable weekly");
		for (const provider of [
			"anthropic",
			"codex",
			"alibaba-coding-plan",
			"zai",
		]) {
			const members = accounts.filter((a) => a.provider === provider);
			const windows = [
				...(["five_hour", "seven_day"] as const).map((window) => ({
					id: `${provider}:${window === "seven_day" ? "weekly" : window}`,
					result: computePoolUsage(members, window, NOW),
				})),
				...computeScopedPoolUsage(members, NOW).map((x) => ({
					id: `${provider}:${x.family}`,
					result: x.result,
				})),
			];
			for (const { id, result } of windows) {
				const names = [
					...result.contributing,
					...result.exhausted,
					...result.excluded,
				]
					.map((a) => a.name)
					.sort();
				expect(
					all
						.filter((g) => g.id === id)
						.flatMap((g) => g.accounts.map((a) => a.name))
						.sort(),
				).toEqual(names);
			}
		}
	});
	it("counts accounts in the subtitle with the right plural", () => {
		const { groups } = buildPoolGroups(
			[account("solo", "codex"), account("a"), account("b")],
			NOW,
		);
		expect(groups.find((g) => g.id === "codex:weekly")?.subtitle).toBe(
			"1 account",
		);
		expect(groups.find((g) => g.id === "anthropic:weekly")?.subtitle).toBe(
			"2 accounts",
		);
	});
	it("sorts lanes by reset then name with missing times last", () => {
		const { groups } = buildPoolGroups(
			[
				account("z"),
				account("b", "anthropic", 40, NOW + H),
				account("a", "anthropic", 40, NOW + H),
				account("none", "anthropic", 40, null),
			],
			NOW,
		);
		expect(groups[0].accounts.map((a) => a.name)).toEqual([
			"a",
			"b",
			"z",
			"none",
		]);
	});
});
describe("simulation and wording", () => {
	it("spends in ten-minute steps and refills with unchanged prototype maths", () => {
		const sim = simulate([base("active", 50, NOW + 2.5 * H)], 5, NOW);
		if (!sim) throw new Error("Expected a simulation");
		expect(sim.forecast.series[0].left).toBe(50);
		expect(sim.forecast.series[1].left).toBeCloseTo(46.6666667);
		expect(sim.forecast.series[15].left).toBe(100);
		expect(sim.forecast.lanes.a[15]).toBe(100);
		expect(sim.hasPace).toBe(true);
	});
	it("draws seven days for short windows too, repeating their own reset cadence", () => {
		const sim = simulate([base("active", 50, NOW + 2.5 * H)], 5, NOW);
		if (!sim) throw new Error("Expected a simulation");
		expect(sim.forecast.horizonMs).toBe(168 * H);
		expect(sim.forecast.refills.slice(0, 2)).toEqual([
			{ t: NOW + 2.5 * H, name: "a" },
			{ t: NOW + 7.5 * H, name: "a" },
		]);
	});
	it("simulates zero demand and unknown accounts without inventing pace", () => {
		const sim = simulate([base("out", 100, NOW + H)], 168, NOW);
		if (!sim) throw new Error("Expected a simulation");
		expect(sim.forecast.series[0].left).toBe(0);
		expect(sim.forecast.series[6].left).toBe(100);
		expect(sim.forecast.dry).toEqual({
			startMs: NOW,
			endMs: NOW + H,
			endedBy: { t: NOW + H, name: "a", kind: "refill" },
		});
		expect(simulate([base("unknown", null, null)], 168, NOW)).toBeNull();
	});
	it("redistributes an empty account's share and excludes unknown capacity", () => {
		const sim = simulate(
			[
				base("active", 99, NOW + 4 * H),
				{ ...base("active", 50, NOW + 4 * H), id: "b", name: "b" },
				{ ...base("unknown", null, null), id: "c", name: "c" },
			],
			5,
			NOW,
		);
		if (!sim) throw new Error("Expected a simulation");
		expect(sim.forecast.capacity).toBe(200);
		expect(sim.forecast.lanes.a[1]).toBe(0);
		expect(sim.forecast.lanes.b[1]).toBeCloseTo(26.1666667);
		expect(sim.forecast.lanes.c).toBeUndefined();
	});
	it("does not infer pace in the first fifteen minutes or from zero use", () => {
		for (const a of [
			base("active", 50, NOW + 4.75 * H),
			base("active", 0, NOW + 4 * H),
		]) {
			const sim = simulate([a], 5, NOW);
			if (!sim) throw new Error("Expected a zero-spend simulation");
			expect(sim.forecast.series[1].left).toBe(100 - (a.pct ?? 0));
			expect(sim.hasPace).toBe(false);
		}
	});
	it("a paused pool is not out of quota and offers no reset", () => {
		const paused = ["a", "b"].map((name) => {
			const a = account(name, "codex", 40, NOW + 50 * H);
			a.paused = true;
			a.bankedResets = {
				tracked: true,
				availableCount: 2,
				stale: false,
			} as AccountResponse["bankedResets"];
			return a;
		});
		const g = buildPoolGroups(paused, NOW).groups[0];
		expect(g.title).toBe("Codex Pro weekly");
		expect(forecastHeadline(g, NOW, "UTC")).toEqual({
			tone: "none",
			headline: "No forecast yet",
			detail: "Every account in this pool is paused.",
		});
		expect(bankedResetAccounts(g, NOW)).toEqual([]);
		// Their own use, not 100% each: paused is not spent.
		expect(g.usedPct).toBe(40);
	});
	it("a cooling account rejoins with its own quota, never a refill", () => {
		const a = account("a", "anthropic", 20, NOW + 92 * H);
		const b = account("b", "anthropic", 30, NOW + 92 * H);
		b.rateLimitedUntil = NOW + 5 * 60_000;
		const g = buildPoolGroups([a, b], NOW).groups[0];
		const f = g.forecast;
		if (!f) throw new Error("Expected a forecast");
		// b is unavailable at the first step, then back with its own 70% left; its
		// pace stays in demand, so a carries all of the first step's spend.
		expect(f.series[0].left).toBe(80);
		expect(f.series[1].left).toBeCloseTo(150 - 50 / 76 / 6);
		expect(f.lanes.b[0]).toBe(70);
		expect(f.lanes.b[1]).toBe(70);
		expect(f.returns).toEqual([{ t: NOW + 5 * 60_000, name: "b" }]);
		expect(forecastHeadline(g, NOW).tone).toBe("lasts");
		expect(g.usedPct).toBe(25);
	});
	it("nothing available while a cooling account waits out its cooldown", () => {
		const out = account("out", "anthropic", 100, NOW + 30 * H);
		const cooling = account("cooling", "anthropic", 40, NOW + 92 * H);
		cooling.rateLimitedUntil = NOW + 5 * 60_000;
		const g = buildPoolGroups([out, cooling], NOW).groups[0];
		expect(forecastHeadline(g, NOW, "UTC")).toEqual({
			tone: "dry-now",
			headline: "Nothing available now",
			detail: "Back in 5m, when cooling is back",
		});
	});
	it("never offers a reset on a held-back account", () => {
		const low = account("low", "codex", 98, NOW + 30 * H);
		low.bankedResets = {
			tracked: true,
			availableCount: 1,
			stale: false,
		} as AccountResponse["bankedResets"];
		const paused = account("paused", "codex", 90, NOW + 60 * H);
		paused.paused = true;
		paused.bankedResets = {
			tracked: true,
			availableCount: 2,
			stale: false,
		} as AccountResponse["bankedResets"];
		const g = buildPoolGroups([low, paused], NOW).groups[0];
		expect(forecastHeadline(g, NOW).tone).toBe("soon");
		expect(bankedResetAccounts(g, NOW).map((a) => a.name)).toEqual(["low"]);
	});
	it("all out is red with a back-in detail; one fresh account means no forecast", () => {
		const out = account("a", "codex", 100);
		const g = buildPoolGroups([out], NOW).groups[0];
		expect(forecastHeadline(g, NOW, "UTC")).toEqual({
			tone: "dry-now",
			headline: "Out of quota now",
			detail: "Back in 2d, when a refills",
		});
		const fresh = account("fresh", "codex", 0, NOW + 168 * H);
		const mixed = buildPoolGroups([out, fresh], NOW).groups[0];
		expect(forecastHeadline(mixed, NOW).headline).toBe("No forecast yet");
		expect(bankedResetAccounts(mixed, NOW)).toEqual([]);
	});
	it("uses reported refill times in the dry detail and unused quota in the lasts detail", () => {
		const dry = buildPoolGroups(
			[account("a", "anthropic", 74, NOW + 76 * H)],
			NOW,
		).groups[0];
		expect(forecastHeadline(dry, NOW, "UTC")).toEqual({
			tone: "soon",
			headline: "On pace to run dry tomorrow",
			detail: "Then empty until a refills in 3d 4h",
		});
		const lasts = buildPoolGroups(
			[account("a", "anthropic", 30, NOW + 24 * H)],
			NOW,
		).groups[0];
		expect(forecastHeadline(lasts, NOW, "UTC")).toEqual({
			tone: "lasts",
			headline: "On pace to last the week",
			detail: "a refills next, in 1d, with about 65% unused",
		});
	});
	it("separates red at exactly 48h from plain beyond it", () => {
		const g = buildPoolGroups([account("a")], NOW).groups[0];
		if (!g.forecast) throw new Error("Expected a forecast");
		for (const [hours, tone] of [
			[48, "soon"],
			[48 + 1 / 6, "later"],
		] as const) {
			g.forecast.dry = {
				startMs: NOW + hours * H,
				endMs: NOW + 72 * H,
				endedBy: null,
			};
			expect(forecastHeadline(g, NOW, "UTC").tone).toBe(tone);
			expect(forecastHeadline(g, NOW, "UTC").headline).toBe(
				"On pace to run dry Tue",
			);
		}
		g.forecast.dry = null;
		expect(forecastHeadline(g, NOW).headline).toBe("On pace to last the week");
	});
	it("uses calendar day words in a pinned zone", () => {
		expect(
			[0, 24, 48, 168].map((h) => dayWord(NOW + h * H, NOW, "UTC")),
		).toEqual(["today", "tomorrow", "Tue", "next Sun"]);
		expect(
			dayWord(Date.parse("2026-11-16T01:00Z"), NOW, "America/New_York"),
		).toBe("today");
	});
	it("speaks lane state and gates next on active quota only", () => {
		const a = {
			...base("active", 74, NOW + 76 * H),
			emptiesAtMs: NOW + 48 * H,
			leftAtResetPct: 0,
		};
		expect(laneText(a, NOW, "UTC")).toBe(
			"a: 74% used, on pace to run out Tue, refills in 3d 4h",
		);
		expect(laneText({ ...a, state: "out" }, NOW)).toBe(
			"a: out of quota, back in 3d 4h",
		);
		expect(laneText({ ...a, state: "unknown" }, NOW)).toBe("a: no usage data");
		expect(shouldShowNextBadge(a)).toBe(true);
		for (const b of [
			{ ...a, state: "out" as const },
			{ ...a, state: "unknown" as const },
			{ ...a, pct: 100 },
			{ ...a, isPrimary: false },
		])
			expect(shouldShowNextBadge(b)).toBe(false);
	});
	it("offers each held Codex reset in red states, including stale counts", () => {
		// Out of quota, not paused: a paused account is held back and never offered one.
		const a = account("a", "codex", 100);
		a.bankedResets = {
			tracked: true,
			availableCount: 2,
			stale: false,
		} as AccountResponse["bankedResets"];
		const g = buildPoolGroups([a], NOW).groups[0];
		if (!a.bankedResets) throw new Error("Expected a held count");
		expect(bankedResetAccounts(g, NOW).map((a) => a.id)).toEqual(["a"]);
		a.bankedResets = { ...a.bankedResets, stale: true };
		expect(
			bankedResetAccounts(buildPoolGroups([a], NOW).groups[0], NOW),
		).toHaveLength(1);
		expect(bankedResetAccounts({ ...g, provider: "anthropic" }, NOW)).toEqual(
			[],
		);
		const projecting = buildPoolGroups(
			[account("projecting", "codex", 60)],
			NOW,
		).groups[0];
		projecting.members[0].bankedResets = a.bankedResets;
		if (!projecting.forecast) throw new Error("Expected a forecast");
		projecting.forecast.dry = {
			startMs: NOW + H,
			endMs: NOW + 48 * H,
			endedBy: null,
		};
		expect(bankedResetAccounts(projecting, NOW).map((a) => a.id)).toEqual([
			"projecting",
		]);
		projecting.forecast.dry = {
			startMs: NOW + 72 * H,
			endMs: NOW + 96 * H,
			endedBy: null,
		};
		expect(forecastHeadline(projecting, NOW).tone).toBe("later");
		expect(bankedResetAccounts(projecting, NOW)).toEqual([]);
		a.bankedResets = { ...a.bankedResets, availableCount: 0 };
		expect(
			bankedResetAccounts(buildPoolGroups([a], NOW).groups[0], NOW),
		).toEqual([]);
		const active = buildPoolGroups([account("fresh", "codex", 0)], NOW)
			.groups[0];
		expect(bankedResetAccounts(active, NOW)).toEqual([]);
	});
});

describe("review fixes", () => {
	const held = (a: AccountResponse, count = 1) => {
		a.bankedResets = {
			tracked: true,
			availableCount: count,
			stale: false,
		} as AccountResponse["bankedResets"];
		return a;
	};
	it("spends a third pass when the second empties another account", () => {
		// a empties in pass 1, b in pass 2; only a third pass gives c the rest.
		const sim = simulate(
			[
				base("active", 99, NOW + 4 * H),
				{ ...base("active", 80, NOW + 4 * H), id: "b", name: "b" },
				{ ...base("active", 30, NOW + 4 * H), id: "c", name: "c" },
			],
			5,
			NOW,
		);
		if (!sim) throw new Error("Expected a simulation");
		const demand = (99 + 80 + 30) / 6;
		expect(sim.forecast.lanes.a[1]).toBe(0);
		expect(sim.forecast.lanes.b[1]).toBe(0);
		expect(sim.forecast.lanes.c[1]).toBeCloseTo(70 - (demand - 1 - 20));
		expect(sim.forecast.series[1].left).toBeCloseTo(91 - demand);
	});
	it("never lets quota left go below zero", () => {
		const sim = simulate([base("active", 105, NOW + 4 * H)], 5, NOW);
		if (!sim) throw new Error("Expected a simulation");
		expect(sim.forecast.series[0].left).toBe(0);
		expect(sim.forecast.lanes.a[0]).toBe(0);
	});
	it("a paused account with quota left means nothing available, not out of quota", () => {
		const out = held(account("out", "codex", 100, NOW + 30 * H));
		const paused = account("paused", "codex", 30, NOW + 60 * H);
		paused.paused = true;
		const g = buildPoolGroups([out, paused], NOW).groups[0];
		expect(forecastHeadline(g, NOW, "UTC")).toEqual({
			tone: "dry-now",
			headline: "Nothing available now",
			detail: "Back in 1d 6h, when out refills",
		});
		// Only a refill ends this outage, so the out account's reset is offered.
		expect(bankedResetAccounts(g, NOW).map((a) => a.name)).toEqual(["out"]);
		// A paused account that is itself spent leaves the pool out of quota.
		const spentPaused = account("paused", "codex", 100, NOW + 60 * H);
		spentPaused.paused = true;
		const allOut = buildPoolGroups([out, spentPaused], NOW).groups[0];
		expect(forecastHeadline(allOut, NOW, "UTC").headline).toBe(
			"Out of quota now",
		);
	});
	it("offers no reset when an account comes back on its own before any refill", () => {
		const out = held(account("out", "codex", 100, NOW + 30 * H));
		const cooling = account("cooling", "codex", 40, NOW + 92 * H);
		cooling.rateLimitedUntil = NOW + 5 * 60_000;
		const g = buildPoolGroups([out, cooling], NOW).groups[0];
		expect(forecastHeadline(g, NOW, "UTC").detail).toBe(
			"Back in 5m, when cooling is back",
		);
		expect(bankedResetAccounts(g, NOW)).toEqual([]);
	});
	it("an account serving on purchased credits is serving, and is never offered a reset", () => {
		const drain = held(account("drain", "codex", 100, NOW + 30 * H));
		drain.codexCreditDrainEnabled = true;
		drain.codexCreditDrainActive = true;
		drain.codexCreditDrainServing = true;
		const out = held(account("out", "codex", 100, NOW + 60 * H));
		const g = buildPoolGroups([drain, out], NOW).groups[0];
		const d = g.accounts.find((a) => a.name === "drain");
		expect(d?.state).toBe("active");
		expect(d?.onCredits).toBe(true);
		expect(forecastHeadline(g, NOW, "UTC")).toEqual({
			tone: "later",
			headline: "Serving on credits",
			detail: "Plan quota back in 1d 6h, when drain refills",
		});
		expect(bankedResetAccounts(g, NOW)).toEqual([]);
		if (!d) throw new Error("Expected the drain account");
		expect(laneText(d, NOW)).toBe(
			"drain: serving on credits, plan quota refills in 1d 6h",
		);
		expect(shouldShowNextBadge({ ...d, isPrimary: true })).toBe(false);
	});
	it("never offers a reset on an account set to drain credits", () => {
		const armed = held(account("armed", "codex", 98, NOW + 30 * H));
		armed.codexCreditDrainEnabled = true;
		armed.codexCreditDrainActive = true;
		const low = held(account("low", "codex", 97, NOW + 40 * H));
		const g = buildPoolGroups([armed, low], NOW).groups[0];
		expect(forecastHeadline(g, NOW).tone).toBe("soon");
		expect(g.accounts.find((a) => a.name === "armed")?.onCredits).toBeFalsy();
		expect(bankedResetAccounts(g, NOW).map((a) => a.name)).toEqual(["low"]);
	});
	it("a reset time that has already passed reads as due now", () => {
		const out = account("a", "codex", 100, NOW - 10 * 60_000);
		const g = buildPoolGroups([out], NOW).groups[0];
		expect(forecastHeadline(g, NOW, "UTC")).toEqual({
			tone: "dry-now",
			headline: "Out of quota now",
			detail: "a is due to refill now",
		});
		const lane = g.accounts[0];
		expect(laneText(lane, NOW)).toBe("a: out of quota, back now");
		const lasts = buildPoolGroups(
			[
				account("a", "anthropic", 40, NOW - 10 * 60_000),
				account("b", "anthropic", 10, NOW + 100 * H),
			],
			NOW,
		).groups[0];
		const summary = forecastHeadline(lasts, NOW, "UTC");
		expect(summary.tone).toBe("lasts");
		expect(summary.detail).toBe("a is due to refill now");
	});
	it("keeps a pool on screen when its accounts are all held back but report reset times", () => {
		const paused = ["a", "b"].map((name) => {
			const a = account(name, "codex", 40, NOW + 50 * H);
			a.paused = true;
			return a;
		});
		const built = buildPoolGroups(paused, NOW);
		expect(built.groups.map((g) => g.title)).toContain("Codex Pro weekly");
	});
});
