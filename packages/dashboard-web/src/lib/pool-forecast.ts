import type { AccountResponse } from "@better-ccflare/types";
import { resetActionAvailability } from "../components/accounts/reset-redemption-flow";
import { providerPlanTitle } from "../utils/provider-utils";
import {
	accountWindowUsage,
	computePoolUsage,
	computeScopedPoolUsage,
	type ExcludedReason,
	formatFamilyLabel,
	type PoolCardWindow,
	type PoolUsageResult,
} from "./pool-usage";

export const H = 3600_000;
const WEEK_H = 168;
const FIVE_H = 5;

// The quota reason that means "this pool's own window is spent".
const OWN_REASON: Record<PoolCardWindow, ExcludedReason> = {
	five_hour: "five_hour_exhausted",
	seven_day: "seven_day_exhausted",
	weekly_scoped: "family_exhausted",
};
const QUOTA_REASONS = new Set<ExcludedReason>(Object.values(OWN_REASON));

export interface ForecastAccount {
	id: string;
	name: string;
	pct: number | null; // % of this window used; null = no usage data
	resetMs: number | null; // this window's own reset
	/**
	 * active: serving. out: this window's quota is spent. held: not serving for
	 * another reason (paused, cooling down, signed out, or its other window is
	 * spent), with its own usage kept. unknown: no usage data.
	 */
	state: "active" | "out" | "held" | "unknown";
	reason?: ExcludedReason;
	/** held only: when it can serve again; null when it will not on its own. */
	backMs?: number | null;
	isPrimary: boolean;
	emptiesAtMs: number | null; // simulated time this account first hits 0, within the horizon
	leftAtResetPct: number | null; // simulated quota still unused when its window resets (lost)
}

export interface DryPeriod {
	startMs: number;
	endMs: number | null; // null = still dry at the end of the horizon
	/** What first puts quota back: an account refilling, or a held one coming back. */
	endedBy: { t: number; name: string; kind: "refill" | "return" } | null;
}

export interface Forecast {
	// Total quota left across the group, sampled over the horizon (for the runway chart).
	series: Array<{ t: number; left: number }>;
	capacity: number; // accounts * 100
	dry: DryPeriod | null; // first dry period within the horizon
	nextRefill: { t: number; name: string } | null; // first reset after now
	refills: Array<{ t: number; name: string }>;
	returns: Array<{ t: number; name: string }>; // held accounts serving again

	// Each account's own quota left (0-100) at the same sample times as `series`.
	lanes: Record<string, number[]>;
	horizonMs: number;
}

export interface PoolGroup {
	id: string;
	provider: string;
	members: AccountResponse[];
	title: string;
	subtitle: string;
	kind: "weekly" | "family" | "five_hour";
	window: PoolCardWindow;
	result: PoolUsageResult;
	accounts: ForecastAccount[]; // sorted by soonest reset
	forecast: Forecast | null;
	usedPct: number | null; // plain headline: each account's own use, averaged
	hasPace: boolean;
	hasAnyReset: boolean;
}

const PROVIDER_GROUPS = [
	"anthropic",
	"codex",
	"alibaba-coding-plan",
	"zai",
].map((provider) => ({ provider, title: providerPlanTitle(provider) }));

export type BaseAccount = Omit<
	ForecastAccount,
	"emptiesAtMs" | "leftAtResetPct"
>;

function accountsOf(
	result: PoolUsageResult,
	byName: Map<string, AccountResponse>,
	window: PoolCardWindow,
	now: number,
	family?: string,
): BaseAccount[] {
	const list: BaseAccount[] = [];
	const add = (
		name: string,
		row: Omit<BaseAccount, "id" | "name" | "isPrimary">,
	) => {
		const account = byName.get(name);
		// Pool rows come from these same accounts, so a miss cannot happen today;
		// skip it rather than throw, because a throw would blank the Overview tab.
		if (account)
			list.push({
				...row,
				id: account.id,
				name,
				isPrimary: account.isPrimary === true,
			});
	};
	for (const c of result.contributing)
		add(c.name, { pct: c.pct, resetMs: c.resetMs, state: "active" });
	// The shared pool computation files every account that cannot serve under
	// `exhausted`, whatever the cause, with that cause's reset. Only a spent
	// window of this pool is "out"; the rest keep their own use of this window.
	for (const e of result.exhausted) {
		const account = byName.get(e.name);
		const own = account
			? accountWindowUsage(account, window, now, family)
			: null;
		const ownReason = e.reason === OWN_REASON[window];
		if (QUOTA_REASONS.has(e.reason) && (ownReason || (own?.pct ?? 0) >= 100))
			add(e.name, {
				pct: 100,
				resetMs: ownReason ? e.resetMs : (own?.resetMs ?? null),
				state: "out",
				reason: e.reason,
			});
		else
			add(e.name, {
				pct: own?.pct ?? null,
				resetMs: own?.resetMs ?? null,
				state: "held",
				reason: e.reason,
				backMs:
					e.reason === "paused" || e.reason === "token_expired"
						? null
						: e.resetMs,
			});
	}
	for (const e of result.excluded)
		add(e.name, {
			pct: null,
			resetMs: e.resetMs,
			state: "unknown",
			reason: e.reason,
		});
	return list.sort((a, b) => {
		if (a.resetMs == null && b.resetMs == null)
			return a.name.localeCompare(b.name);
		if (a.resetMs == null) return 1;
		if (b.resetMs == null) return -1;
		return a.resetMs - b.resetMs || a.name.localeCompare(b.name);
	});
}

/** In the forecast: serving, spent, or held back with a known return and its own usage. */
function inForecast(a: BaseAccount): boolean {
	if (a.state === "active" || a.state === "out") return true;
	return a.state === "held" && a.backMs != null && a.pct != null;
}

/**
 * Step the group forward in 10-minute steps. Demand = the sum of each active or held account's
 * average pace since its window opened. Each step spends that demand across available accounts
 * that still have quota, in proportion to their own pace; an empty account's share moves to the
 * rest. A held account is unavailable until it comes back, with its own quota; its pace stays in
 * demand because the requests it served go elsewhere meanwhile. A paused or signed-out account
 * has no known return, so it is left out. At an account's reset it comes back full.
 */
export function simulate(
	accounts: BaseAccount[],
	windowH: number,
	now: number,
): {
	forecast: Forecast;
	empties: Map<string, number>;
	leftAtReset: Map<string, number>;
	/** At least one account has a measurable pace; without one the forecast is only refills. */
	hasPace: boolean;
} | null {
	const paces: number[] = [];
	const state = accounts.filter(inForecast).map((a) => {
		let pace: number | null = null;
		if (a.state !== "out" && a.pct != null && a.resetMs != null) {
			const elapsedH = windowH - (a.resetMs - now) / H;
			if (elapsedH > 0.25 && a.pct > 0) pace = a.pct / elapsedH;
		}
		if (pace != null) paces.push(pace);
		const backMs = a.state === "held" ? (a.backMs ?? null) : null;
		return {
			name: a.name,
			left: a.state === "out" ? 0 : 100 - (a.pct ?? 0),
			pace,
			resetMs: a.resetMs,
			backMs,
			available: backMs == null || backMs <= now,
		};
	});
	const demand = paces.reduce((s, p) => s + p, 0);
	if (state.length === 0) return null;
	const avgPace = paces.length ? demand / paces.length : 0;
	// The chart clock is a week; windowH still controls pace and refill cadence.
	const horizonMs = WEEK_H * H;
	const stepMs = 10 * 60_000;
	const series: Forecast["series"] = [];
	const refills: Forecast["refills"] = [];
	const returns: Forecast["returns"] = [];
	const empties = new Map<string, number>();
	const leftAtReset = new Map<string, number>();
	const lanes: Record<string, number[]> = Object.fromEntries(
		state.map((s) => [s.name, [] as number[]]),
	);
	let dry: DryPeriod | null = null;
	for (let t = now; t <= now + horizonMs; t += stepMs) {
		// Events this step that put usable quota back, for naming what ends a dry period.
		const gains: NonNullable<DryPeriod["endedBy"]>[] = [];
		for (const s of state) {
			if (!s.available && s.backMs != null && s.backMs <= t) {
				s.available = true;
				returns.push({ t: s.backMs, name: s.name });
				if (s.left > 0)
					gains.push({ t: s.backMs, name: s.name, kind: "return" });
			}
			if (s.resetMs != null && s.resetMs <= t) {
				refills.push({ t: s.resetMs, name: s.name });
				if (s.available)
					gains.push({ t: s.resetMs, name: s.name, kind: "refill" });
				if (!leftAtReset.has(s.name)) leftAtReset.set(s.name, s.left);
				s.left = 100;
				s.resetMs += windowH * H;
			}
		}
		const total = state.reduce((sum, s) => sum + (s.available ? s.left : 0), 0);
		series.push({ t, left: total });
		for (const s of state) lanes[s.name].push(s.left);
		if (total <= 0.001) {
			if (dry == null) dry = { startMs: t, endMs: null, endedBy: null };
		} else if (dry != null && dry.endMs == null) {
			dry.endMs = t;
			// Earliest gain this step; on a tie a refill reads truer than a return.
			dry.endedBy =
				gains.sort(
					(a, b) =>
						a.t - b.t || (a.kind === b.kind ? 0 : a.kind === "refill" ? -1 : 1),
				)[0] ?? null;
		}
		let toSpend = (demand * stepMs) / H;
		for (let pass = 0; pass < 4 && toSpend > 1e-9; pass++) {
			const active = state.filter((s) => s.available && s.left > 0);
			if (active.length === 0) break;
			const weight = active.reduce((sum, s) => sum + (s.pace ?? avgPace), 0);
			if (weight <= 0) break;
			let spent = 0;
			for (const s of active) {
				const share = (toSpend * (s.pace ?? avgPace)) / weight;
				const take = Math.min(share, s.left);
				s.left -= take;
				spent += take;
				if (s.left <= 0.001 && !empties.has(s.name))
					empties.set(s.name, t + stepMs);
			}
			toSpend -= spent;
		}
	}
	const sortedRefills = refills.sort((a, b) => a.t - b.t);
	return {
		forecast: {
			series,
			capacity: state.length * 100,
			dry,
			nextRefill: sortedRefills[0] ?? null,
			refills: sortedRefills,
			returns: returns.sort((a, b) => a.t - b.t),
			lanes,
			horizonMs,
		},
		empties,
		leftAtReset,
		hasPace: paces.length > 0,
	};
}

/**
 * The pool's used share: the shipped pool average, except that a held-back
 * account counts its own use. The shipped average counts every account that
 * cannot serve as 100%, so an all-paused pool would read "100% used".
 */
function usedAcross(list: BaseAccount[]): number | null {
	const known = list.filter((a) => a.state !== "unknown" && a.pct != null);
	if (known.length === 0) return null;
	return known.reduce((sum, a) => sum + (a.pct ?? 0), 0) / known.length;
}

function buildGroup(
	id: string,
	title: string,
	subtitle: string,
	kind: PoolGroup["kind"],
	window: PoolCardWindow,
	result: PoolUsageResult,
	accounts: AccountResponse[],
	now: number,
	family?: string,
): PoolGroup {
	const byName = new Map(accounts.map((a) => [a.name, a]));
	const list = accountsOf(result, byName, window, now, family);
	const sim = simulate(list, window === "five_hour" ? FIVE_H : WEEK_H, now);
	const withEmpties: ForecastAccount[] = list.map((a) => ({
		...a,
		emptiesAtMs:
			a.state === "active" ? (sim?.empties.get(a.name) ?? null) : null,
		leftAtResetPct:
			a.state === "active" ? (sim?.leftAtReset.get(a.name) ?? null) : null,
	}));
	return {
		id,
		provider: accounts[0].provider,
		members: accounts.filter((a) => list.some((member) => member.id === a.id)),
		title,
		subtitle,
		kind,
		window,
		result,
		accounts: withEmpties,
		forecast: sim?.forecast ?? null,
		usedPct: usedAcross(list),
		hasPace: sim?.hasPace ?? false,
		hasAnyReset: list.some((a) => a.resetMs != null),
	};
}

export function buildPoolGroups(
	accounts: AccountResponse[],
	now: number,
): { groups: PoolGroup[]; hidden: PoolGroup[] } {
	const groups: PoolGroup[] = [];
	for (const { provider, title } of PROVIDER_GROUPS) {
		const members = accounts.filter((a) => a.provider === provider);
		if (members.length === 0) continue;
		const weekly = computePoolUsage(members, "seven_day", now);
		if (listCount(weekly) > 0) {
			groups.push(
				buildGroup(
					`${provider}:weekly`,
					`${title} weekly`,
					accountCount(weekly),
					"weekly",
					"seven_day",
					weekly,
					members,
					now,
				),
			);
		}
		for (const { family, result } of computeScopedPoolUsage(members, now)) {
			groups.push(
				buildGroup(
					`${provider}:${family}`,
					`${formatFamilyLabel(family)} weekly`,
					accountCount(result),
					"family",
					"weekly_scoped",
					result,
					members,
					now,
					family,
				),
			);
		}
		const five = computePoolUsage(members, "five_hour", now);
		if (listCount(five) > 0) {
			groups.push(
				buildGroup(
					`${provider}:five_hour`,
					`${title} 5-hour`,
					accountCount(five),
					"five_hour",
					"five_hour",
					five,
					members,
					now,
				),
			);
		}
	}
	// A pool with no reset time has no timeline to draw, but an account out of
	// that pool's own quota is an outage and keeps it on screen. A held-back
	// account does not: its cause already shows in the pool that owns it.
	const shown = (g: PoolGroup) =>
		g.hasAnyReset || g.accounts.some((a) => a.state === "out");
	return {
		groups: groups.filter(shown),
		hidden: groups.filter((g) => !shown(g)),
	};
}

export function formatDuration(ms: number): string {
	const totalMinutes = Math.max(0, Math.round(ms / 60_000));
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

function listCount(r: PoolUsageResult) {
	return r.contributing.length + r.exhausted.length + r.excluded.length;
}

function accountCount(r: PoolUsageResult) {
	const n = listCount(r);
	return `${n} ${n === 1 ? "account" : "accounts"}`;
}

export type ForecastTone = "dry-now" | "soon" | "later" | "lasts" | "none";

export function dayWord(
	atMs: number,
	nowMs: number,
	timeZone?: string,
): string {
	const dayNumber = (t: number) => {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(t);
		const value = (type: string) =>
			Number(parts.find((p) => p.type === type)?.value);
		return Date.UTC(value("year"), value("month") - 1, value("day")) / 86400000;
	};
	const delta = dayNumber(atMs) - dayNumber(nowMs);
	if (delta === 0) return "today";
	if (delta === 1) return "tomorrow";
	const weekday = (t: number) =>
		new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(t);
	return delta >= 6 && weekday(atMs) === weekday(nowMs)
		? `next ${weekday(atMs)}`
		: weekday(atMs);
}

export function forecastHeadline(
	group: PoolGroup,
	now: number,
	timeZone?: string,
): { tone: ForecastTone; headline: string; detail: string } {
	const f = group.forecast;
	const counted = group.accounts.filter((a) => a.state !== "unknown");
	// Operator steering, not an outage: nothing to forecast and nothing red.
	if (
		counted.length > 0 &&
		counted.every((a) => a.state === "held" && a.reason === "paused")
	)
		return {
			tone: "none",
			headline: "No forecast yet",
			detail: "Every account in this pool is paused.",
		};
	const spent = (a: ForecastAccount) =>
		a.state === "out" || (a.state === "active" && (a.pct ?? 0) >= 100);
	const usable = (a: ForecastAccount) =>
		a.state === "active" ? (a.pct ?? 0) < 100 : false;
	if (counted.length > 0 && !counted.some(usable)) {
		// "Out of quota" only when every account the forecast counts is spent;
		// one that is only cooling down will be back on its own.
		const forecastable = counted.filter(inForecast);
		const quotaOut = forecastable.length > 0 && forecastable.every(spent);
		const end = f?.dry?.startMs === now ? f.dry.endedBy : null;
		return {
			tone: "dry-now",
			headline: quotaOut ? "Out of quota now" : "Nothing available now",
			detail: end
				? `Back in ${formatDuration(end.t - now)}, when ${end.name} ${end.kind === "refill" ? "refills" : "is back"}`
				: quotaOut
					? "No refill this week"
					: "Nothing is due back this week",
		};
	}
	if (!f || !group.hasPace)
		return {
			tone: "none",
			headline: "No forecast yet",
			detail:
				"No account in this pool has used enough of its window to project a pace.",
		};
	if (f.dry) {
		const start = f.dry.startMs;
		const end = f.dry.endedBy;
		return {
			tone: start - now <= 48 * H ? "soon" : "later",
			headline: `On pace to run dry ${dayWord(start, now, timeZone)}`,
			detail: end
				? `Then empty until ${end.name} ${end.kind === "refill" ? "refills" : "is back"} in ${formatDuration(end.t - now)}`
				: "Then empty for the rest of the week",
		};
	}
	const next = f.nextRefill;
	const left = next
		? group.accounts.find((a) => a.name === next.name)?.leftAtResetPct
		: null;
	return {
		tone: "lasts",
		headline: "On pace to last the week",
		detail: next
			? `${next.name} refills next, in ${formatDuration(next.t - now)}${left != null && left >= 10 ? `, with about ${Math.round(left)}% unused` : ""}`
			: "No refill this week",
	};
}

export function emptyBeforeReset(a: ForecastAccount): number | null {
	if (
		a.state !== "active" ||
		a.emptiesAtMs == null ||
		(a.resetMs != null && a.emptiesAtMs >= a.resetMs)
	)
		return null;
	return a.emptiesAtMs;
}
export function inText(ms: number | null, now: number): string | null {
	return ms == null || ms <= now ? null : `in ${formatDuration(ms - now)}`;
}
export function laneText(
	a: ForecastAccount,
	now: number,
	timeZone?: string,
): string {
	const reset = inText(a.resetMs, now);
	if (a.state === "unknown") return `${a.name}: no usage data`;
	if (a.state === "out")
		return `${a.name}: out of quota, ${reset ? `back ${reset}` : "no reset time"}`;
	if (a.state === "held") {
		const used = a.pct != null ? `, ${Math.round(a.pct)}% used` : "";
		if (a.reason === "paused")
			return `${a.name}: paused${used}, ${reset ? `refills ${reset}` : "no reset time"}`;
		if (a.reason === "token_expired")
			return `${a.name}: sign-in expired${used}`;
		const back = inText(a.backMs ?? null, now);
		return `${a.name}: ${heldLabel(a.reason)}${back ? `, back ${back}` : ""}${used}`;
	}
	const empty = emptyBeforeReset(a);
	const unused =
		a.leftAtResetPct != null && a.leftAtResetPct >= 10 && !empty
			? `, about ${Math.round(a.leftAtResetPct)}% unused at reset`
			: "";
	return `${a.name}: ${Math.round(a.pct ?? 0)}% used${empty ? `, on pace to run out ${dayWord(empty, now, timeZone)}` : ""}, ${reset ? `refills ${reset}` : "no reset time"}${unused}`;
}
/** Why a held account is not serving, in a few words, for its badge and lane note. */
export function heldLabel(reason: ExcludedReason | undefined): string {
	switch (reason) {
		case "rate_limited":
		case "usage_rate_limited":
			return "cooling down";
		case "five_hour_exhausted":
			return "out of 5-hour quota";
		case "seven_day_exhausted":
		case "family_exhausted":
			return "out of weekly quota";
		case "paused":
			return "paused";
		case "token_expired":
			return "sign-in expired";
		default:
			return "not available";
	}
}
export function shouldShowNextBadge(
	a: Pick<ForecastAccount, "isPrimary" | "state" | "pct">,
): boolean {
	return a.isPrimary && a.state === "active" && a.pct != null && a.pct < 100;
}
export function bankedResetAccounts(
	group: PoolGroup,
	now: number,
): AccountResponse[] {
	const tone = forecastHeadline(group, now).tone;
	if (group.provider !== "codex" || (tone !== "dry-now" && tone !== "soon"))
		return [];
	// A reset restores quota, so offer it only where quota is what is missing:
	// never on a paused, cooling or signed-out account. It cannot be undone.
	const serving = new Set(
		group.accounts
			.filter((a) => a.state === "active" || a.state === "out")
			.map((a) => a.id),
	);
	return group.members.filter(
		(a) =>
			serving.has(a.id) &&
			a.bankedResets &&
			resetActionAvailability(a.bankedResets).shown,
	);
}
