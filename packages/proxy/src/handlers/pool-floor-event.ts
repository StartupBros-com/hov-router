/**
 * Pool-floor observability.
 *
 * #155 was a scope/duration inversion: a narrowly-scoped upstream 429 became an
 * account-wide hold, and the routable pool drained one account at a time with
 * nothing warning until every candidate was gone and requests 503'd. The
 * evidence needed to see it coming already existed per candidate — scope,
 * window, hold expiry, evidence expiry — it was just never combined into a
 * single operator-visible signal at the point where candidates are excluded.
 *
 * This module builds that signal. It is TELEMETRY ONLY: nothing here decides
 * whether an account is routable, and `buildPoolFloorEvent` is pure so the
 * shape can be pinned by tests without standing up proxy machinery.
 *
 * The event carries policy facts only — lane, counts, scopes, windows, hold and
 * evidence expiry, and account identity. No credentials, headers, prompt
 * content or provider messages.
 */
import type {
	RoutingCapacityBlocker,
	RoutingCapacityCandidateExclusion,
} from "./account-selector";

/** Accounts listed individually before the tail is summarised as a count. */
export const MAX_POOL_FLOOR_ACCOUNTS = 10;

/** Minimum gap between two alarms for the same lane and severity. */
export const POOL_FLOOR_THROTTLE_MS = 60_000;

/**
 * Ceiling on distinct throttle keys held at once.
 *
 * The key includes the lane, which is the effective model — derived from a
 * client-supplied model string. Without a bound, a caller sending many distinct
 * model names would grow this map for the life of the process.
 */
export const MAX_POOL_FLOOR_THROTTLE_KEYS = 256;

/** Default: warn while the lane is down to its last routable candidate. */
const DEFAULT_APPROACHING_THRESHOLD = 1;

export type PoolFloorSeverity = "floor" | "approaching";

/** One (scope, window, source) blocker shape and how many candidates hit it. */
export interface PoolFloorBlockerSummary {
	readonly scope: RoutingCapacityBlocker["scope"];
	readonly window: string;
	readonly windowKind: RoutingCapacityBlocker["windowKind"];
	readonly source: RoutingCapacityBlocker["source"];
	readonly modelFamily: string | null;
	readonly count: number;
}

export interface PoolFloorExcludedAccount {
	readonly accountId: string;
	readonly accountName: string;
	/** Null means an indefinite hold, NOT an immediate recovery. */
	readonly blockedUntil: number | null;
	readonly scopes: readonly string[];
	readonly windows: readonly string[];
}

export interface PoolFloorEvent {
	readonly severity: PoolFloorSeverity;
	/** Effective (post-rewrite) model this decision routed for. */
	readonly lane: string | null;
	readonly modelFamily: string | null;
	readonly candidatesBefore: number | null;
	readonly candidatesAfter: number | null;
	readonly excludedAccountCount: number;
	readonly blockers: readonly PoolFloorBlockerSummary[];
	readonly excludedAccounts: readonly PoolFloorExcludedAccount[];
	/** Soonest future hold expiry across excluded candidates; null if none. */
	readonly earliestRecoveryAtMs: number | null;
	/** Soonest point at which this evidence goes stale and is re-derived. */
	readonly evidenceExpiresAtMs: number | null;
	readonly truncatedAccountCount: number;
}

export interface PoolFloorEventInput {
	readonly lane: string | null;
	readonly modelFamily: string | null;
	readonly candidatesBefore: number | null;
	readonly candidatesAfter: number | null;
	readonly exclusions: readonly RoutingCapacityCandidateExclusion[];
	readonly now: number;
	/** Warn at or below this surviving count; 0 disables the warning tier. */
	readonly approachingThreshold?: number;
}

/**
 * Parse `HOV_ROUTER_POOL_FLOOR_THRESHOLD`. A malformed, negative or fractional
 * value falls back to the default rather than silently disabling the alarm —
 * a typo must not cost an operator the warning tier.
 */
export function poolFloorApproachingThreshold(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") {
		return DEFAULT_APPROACHING_THRESHOLD;
	}
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		return DEFAULT_APPROACHING_THRESHOLD;
	}
	return parsed;
}

function blockerKey(blocker: RoutingCapacityBlocker): string {
	return [
		blocker.scope,
		blocker.window,
		blocker.windowKind,
		blocker.source,
		blocker.modelFamily ?? "",
	].join("\u0000");
}

/**
 * Build the event, or null when this decision is not a pool-floor condition.
 *
 * Returns null when nothing was excluded for capacity (an empty pool with no
 * exclusions is a different failure — no accounts, all paused — and this alarm
 * would misattribute it), and when the surviving count is unknown (claiming a
 * floor without knowing the pool size is a false alarm).
 */
export function buildPoolFloorEvent(
	input: PoolFloorEventInput,
): PoolFloorEvent | null {
	if (input.exclusions.length === 0) return null;
	const after = input.candidatesAfter;
	if (after === null || !Number.isFinite(after)) return null;

	const threshold = input.approachingThreshold ?? DEFAULT_APPROACHING_THRESHOLD;
	let severity: PoolFloorSeverity;
	if (after <= 0) {
		severity = "floor";
	} else if (threshold > 0 && after <= threshold) {
		severity = "approaching";
	} else {
		return null;
	}

	// Insertion-ordered so the summary reads in the order blockers were hit.
	const blockerCounts = new Map<string, PoolFloorBlockerSummary>();
	const accounts = new Map<
		string,
		{
			accountId: string;
			accountName: string;
			blockedUntil: number | null;
			scopes: Set<string>;
			windows: Set<string>;
		}
	>();
	let earliestRecoveryAtMs: number | null = null;
	let evidenceExpiresAtMs: number | null = null;

	for (const exclusion of input.exclusions) {
		// One account can be excluded for several models; it is still one
		// account missing from the pool, so identity is deduplicated here.
		let account = accounts.get(exclusion.accountId);
		if (!account) {
			account = {
				accountId: exclusion.accountId,
				accountName: exclusion.accountName,
				blockedUntil: null,
				scopes: new Set<string>(),
				windows: new Set<string>(),
			};
			accounts.set(exclusion.accountId, account);
		}

		const blockedUntil = exclusion.blockedUntil;
		if (
			typeof blockedUntil === "number" &&
			Number.isFinite(blockedUntil) &&
			blockedUntil > input.now
		) {
			// A hold that already expired is not a recovery time.
			account.blockedUntil =
				account.blockedUntil === null
					? blockedUntil
					: Math.min(account.blockedUntil, blockedUntil);
			earliestRecoveryAtMs =
				earliestRecoveryAtMs === null
					? blockedUntil
					: Math.min(earliestRecoveryAtMs, blockedUntil);
		}

		for (const blocker of exclusion.exclusions) {
			account.scopes.add(blocker.scope);
			account.windows.add(blocker.window);

			const key = blockerKey(blocker);
			const existing = blockerCounts.get(key);
			blockerCounts.set(
				key,
				existing
					? { ...existing, count: existing.count + 1 }
					: {
							scope: blocker.scope,
							window: blocker.window,
							windowKind: blocker.windowKind,
							source: blocker.source,
							modelFamily: blocker.modelFamily,
							count: 1,
						},
			);

			if (Number.isFinite(blocker.evidenceExpiresAt)) {
				evidenceExpiresAtMs =
					evidenceExpiresAtMs === null
						? blocker.evidenceExpiresAt
						: Math.min(evidenceExpiresAtMs, blocker.evidenceExpiresAt);
			}
		}
	}

	const allAccounts = [...accounts.values()];
	const listed = allAccounts.slice(0, MAX_POOL_FLOOR_ACCOUNTS);

	return {
		severity,
		lane: input.lane,
		modelFamily: input.modelFamily,
		candidatesBefore: input.candidatesBefore,
		candidatesAfter: after,
		excludedAccountCount: allAccounts.length,
		blockers: [...blockerCounts.values()],
		excludedAccounts: listed.map((account) => ({
			accountId: account.accountId,
			accountName: account.accountName,
			blockedUntil: account.blockedUntil,
			scopes: [...account.scopes],
			windows: [...account.windows],
		})),
		earliestRecoveryAtMs,
		evidenceExpiresAtMs,
		truncatedAccountCount: allAccounts.length - listed.length,
	};
}

/**
 * Throttle repeats per (lane, severity). During an outage every request would
 * otherwise re-emit the same alarm.
 *
 * Severity is part of the key on purpose: an "approaching" alarm must never
 * suppress the "floor" alarm that follows it, which is the escalation an
 * operator actually needs to see.
 */
export function shouldEmitPoolFloorEvent(
	state: Map<string, number>,
	lane: string | null,
	severity: PoolFloorSeverity,
	now: number,
	throttleMs: number = POOL_FLOOR_THROTTLE_MS,
): boolean {
	const key = `${severity}\u0000${lane ?? ""}`;
	const last = state.get(key);
	if (last !== undefined && now - last < throttleMs) return false;
	if (!state.has(key) && state.size >= MAX_POOL_FLOOR_THROTTLE_KEYS) {
		pruneThrottleState(state, now, throttleMs);
	}
	state.set(key, now);
	return true;
}

/**
 * Keep the throttle map bounded before admitting a new key.
 *
 * Entries older than the throttle window suppress nothing, so dropping them is
 * free. Only if that is not enough does this evict the least-recently-emitted
 * key — which at worst costs one duplicate alarm for a lane nobody has seen in
 * a while, and never suppresses one.
 */
function pruneThrottleState(
	state: Map<string, number>,
	now: number,
	throttleMs: number,
): void {
	for (const [existing, ts] of state) {
		if (now - ts >= throttleMs) state.delete(existing);
	}
	if (state.size < MAX_POOL_FLOOR_THROTTLE_KEYS) return;
	let oldestKey: string | null = null;
	let oldestTs = Number.POSITIVE_INFINITY;
	for (const [existing, ts] of state) {
		if (ts < oldestTs) {
			oldestTs = ts;
			oldestKey = existing;
		}
	}
	if (oldestKey !== null) state.delete(oldestKey);
}

/** The subset of Logger this module needs, so tests need no real logger. */
export interface PoolFloorLogger {
	warn(message: string, data?: unknown): void;
	error(message: string, data?: unknown): void;
}

/**
 * Build, throttle and log the event. Returns what was emitted, or null when
 * the condition did not apply or the alarm was throttled.
 *
 * Never throws: this is observability sitting on the request path, and a
 * logging fault must not take routing down with it.
 */
export function emitPoolFloorEvent(
	logger: PoolFloorLogger,
	state: Map<string, number>,
	input: PoolFloorEventInput,
): PoolFloorEvent | null {
	try {
		const event = buildPoolFloorEvent(input);
		if (!event) return null;
		if (
			!shouldEmitPoolFloorEvent(state, event.lane, event.severity, input.now)
		) {
			return null;
		}
		if (event.severity === "floor") {
			logger.error(
				"Routing pool floor: capacity exclusions left no routable candidates",
				event,
			);
		} else {
			logger.warn(
				"Routing pool approaching floor: capacity exclusions left few routable candidates",
				event,
			);
		}
		return event;
	} catch {
		return null;
	}
}
