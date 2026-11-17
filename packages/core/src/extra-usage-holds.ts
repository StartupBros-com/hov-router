import type {
	CanonicalUsageWindow,
	ExtraUsageHold,
	ExtraUsageHoldState,
} from "@better-ccflare/types";
import { getModelFamily } from "./model-mappings";

/**
 * Rules for the Claude extra-usage switch: which usage windows hold a login
 * (or one model family on it) so the router stops sending it requests that
 * Anthropic would bill as extra usage, when those holds end, when a hold from
 * a billed response narrows to one family, and what extra-usage state the
 * dashboard shows. Pure: callers pass the clock and the windows.
 */

/**
 * A window starts or keeps a hold only when Anthropic marks it active, it
 * covers the whole login or one model family, it is spent, and its reset is
 * known and still ahead. Inactive limits never steer routing.
 */
function isHoldingWindow(window: CanonicalUsageWindow, now: number): boolean {
	return (
		window.active &&
		(window.scope === "account" || window.scope === "family") &&
		window.utilization >= 100 &&
		window.resetsAtMs !== null &&
		window.resetsAtMs > now
	);
}

function byWindowKey(a: ExtraUsageHold, b: ExtraUsageHold): number {
	return a.windowKey < b.windowKey ? -1 : a.windowKey > b.windowKey ? 1 : 0;
}

/**
 * Apply one usage reading to the stored holds.
 *
 * - A holding window starts a hold, or keeps an existing one; a spent reading
 *   with a later reset moves the hold's end to it, and the start stays.
 * - A stored hold ends when this reading shows its window active below 100,
 *   or once its reset is no longer ahead of the reading.
 * - A reading that omits the window, marks it inactive, or shows it spent
 *   with no reset or a past one, leaves the stored hold as it was.
 *
 * A reading older than the stored state changes nothing. The holds come back
 * sorted by window key, so an unchanged result compares equal.
 */
export function deriveExtraUsageHolds(
	previous: ExtraUsageHoldState | null,
	windows: readonly CanonicalUsageWindow[],
	readingAt: number,
): ExtraUsageHoldState {
	if (previous && readingAt < previous.readingAt) return previous;
	const stored = new Map(
		(previous?.holds ?? []).map((hold) => [hold.windowKey, hold]),
	);
	const next = new Map<string, ExtraUsageHold>();
	const ended = new Set<string>();
	for (const window of windows) {
		if (isHoldingWindow(window, readingAt)) {
			const resetsAtMs = window.resetsAtMs as number;
			const existing = stored.get(window.windowKey);
			next.set(window.windowKey, {
				windowKey: window.windowKey,
				scope: window.scope as ExtraUsageHold["scope"],
				modelFamily: window.modelFamily,
				resetsAtMs: existing
					? Math.max(existing.resetsAtMs, resetsAtMs)
					: resetsAtMs,
				startedAt: existing?.startedAt ?? readingAt,
			});
		} else if (window.active && window.utilization < 100) {
			ended.add(window.windowKey);
		}
	}
	for (const [windowKey, hold] of stored) {
		if (next.has(windowKey) || ended.has(windowKey)) continue;
		if (hold.resetsAtMs > readingAt) next.set(windowKey, hold);
	}
	return { readingAt, holds: [...next.values()].sort(byWindowKey) };
}

/** True when two hold lists hold the same windows with the same ends and starts. */
export function sameExtraUsageHolds(
	a: readonly ExtraUsageHold[],
	b: readonly ExtraUsageHold[],
): boolean {
	if (a.length !== b.length) return false;
	const left = [...a].sort(byWindowKey);
	const right = [...b].sort(byWindowKey);
	return left.every((hold, index) => {
		const other = right[index];
		return (
			other !== undefined &&
			hold.windowKey === other.windowKey &&
			hold.scope === other.scope &&
			hold.modelFamily === other.modelFamily &&
			hold.resetsAtMs === other.resetsAtMs &&
			hold.startedAt === other.startedAt
		);
	});
}

/** The stored holds that still apply: a hold applies while the clock is before its reset. */
export function liveExtraUsageHolds(
	state: ExtraUsageHoldState | null | undefined,
	now: number,
): ExtraUsageHold[] {
	return (state?.holds ?? []).filter((hold) => now < hold.resetsAtMs);
}

/** An account-wide hold covers every model; a family hold covers models of that family. */
export function extraUsageHoldCoversModel(
	hold: ExtraUsageHold,
	model: string,
): boolean {
	if (hold.scope === "account") return true;
	return (
		hold.modelFamily !== null && getModelFamily(model) === hold.modelFamily
	);
}

/**
 * The live hold that covers `model`, choosing the one that ends last when
 * several do (that end is when the model can be sent again), or null.
 */
/** The fields of a login the hold rules read; an `Account` has all of them. */
export interface ExtraUsageHoldLogin {
	readonly provider: string;
	readonly auto_pause_on_overage_enabled: boolean;
	readonly extra_usage_holds?: ExtraUsageHoldState | null;
}

/**
 * The live holds on a login that cover `model`. A login whose extra-usage
 * switch is off, or one that is not a Claude login, has none, whatever is
 * stored.
 */
export function coveringExtraUsageHolds(
	login: ExtraUsageHoldLogin,
	model: string,
	now: number,
): ExtraUsageHold[] {
	if (login.provider !== "anthropic" || !login.auto_pause_on_overage_enabled) {
		return [];
	}
	return liveExtraUsageHolds(login.extra_usage_holds, now).filter((hold) =>
		extraUsageHoldCoversModel(hold, model),
	);
}

/** The usage window kind a hold came from, in the routing selector's terms. */
export function extraUsageHoldWindowKind(
	hold: ExtraUsageHold,
): "session" | "weekly_all" | "weekly_scoped" {
	if (hold.scope === "family") return "weekly_scoped";
	return hold.windowKey === "five_hour" ? "session" : "weekly_all";
}

export function coveringExtraUsageHold(
	state: ExtraUsageHoldState | null | undefined,
	model: string,
	now: number,
): ExtraUsageHold | null {
	let covering: ExtraUsageHold | null = null;
	for (const hold of liveExtraUsageHolds(state, now)) {
		if (!extraUsageHoldCoversModel(hold, model)) continue;
		if (!covering || hold.resetsAtMs > covering.resetsAtMs) covering = hold;
	}
	return covering;
}

/**
 * Whether a reading narrows a hold from a billed response (the `overage`
 * pause, which holds every model) to the reading's own holds.
 *
 * The reading must be taken after the billed response and show a holding
 * window that covers the billed family: an account-wide window covers every
 * family, and a billed family of null is covered only by an account-wide
 * window. A pause with no billed time (from before billed times were stored)
 * is never narrowed.
 */
export function shouldNarrowBilledHold(
	billed: { billedAt: number | null; family: string | null },
	windows: readonly CanonicalUsageWindow[],
	readingAt: number,
): boolean {
	if (billed.billedAt === null || readingAt <= billed.billedAt) return false;
	return windows.some(
		(window) =>
			isHoldingWindow(window, readingAt) &&
			(window.scope === "account" ||
				(billed.family !== null && window.modelFamily === billed.family)),
	);
}

export type ExtraUsageState = "on" | "off" | "unknown";

/**
 * The extra-usage state shown for a Claude login, from its cached usage
 * reading only. `spend.enabled` decides when present, then
 * `extra_usage.is_enabled` (the precedence the capacity check uses). `true`
 * reads on; `false` reads off only when the block carries no
 * `disabled_reason`, since no reason has been observed and mapped. No
 * reading, a reading older than `maxAgeMs`, or one with neither field reads
 * not known.
 */
export function resolveExtraUsageState(
	reading: unknown,
	readingAt: number | null,
	now: number,
	maxAgeMs: number,
): ExtraUsageState {
	if (!reading || typeof reading !== "object" || readingAt === null) {
		return "unknown";
	}
	if (now - readingAt > maxAgeMs) return "unknown";
	const data = reading as {
		spend?: { enabled?: unknown; disabled_reason?: unknown } | null;
		extra_usage?: { is_enabled?: unknown; disabled_reason?: unknown } | null;
	};
	const decide = (
		enabled: unknown,
		reason: unknown,
	): ExtraUsageState | null => {
		if (typeof enabled !== "boolean") return null;
		if (enabled) return "on";
		return reason === undefined || reason === null ? "off" : "unknown";
	};
	return (
		decide(data.spend?.enabled, data.spend?.disabled_reason) ??
		decide(data.extra_usage?.is_enabled, data.extra_usage?.disabled_reason) ??
		"unknown"
	);
}
