import {
	getPublicValuePlan,
	type PublicValuePlanObject,
	publicValuePlanObject,
	VALUE_PRICING_VERSION,
} from "@hov-router/core";
import { Logger } from "@hov-router/logger";
import { getPublicRosterGeneration } from "../services/public-subscription-roster";
import {
	isValidPublicId,
	isValidPublicLabel,
	MAX_PUBLIC_SUBSCRIPTIONS,
	type PublicSubscriptionMapping,
	type PublicSubscriptionsConfig,
	parsePublicSubscriptionsConfig,
} from "../services/public-subscriptions-config";
import {
	toUsageWindowRecord,
	type UsageWindowRecord,
	valueOpenWindow,
} from "../services/usage-window-read";
import type { APIContext } from "../types";
import { labelRevealsAccount } from "./account-public-value";
import {
	buildPeriods,
	type PublicValuePeriod,
	type PublicValueWindow,
	selectCompleted,
} from "./public-value-periods";

interface PublicSubscriptionValue {
	schemaVersion: 2;
	valueBasis: "api_equivalent_usd";
	windowKey: "seven_day";
	pricingVersion: string;
	generatedAt: number;
	subscriptions: Array<{
		id: string;
		label: string;
		provider: string;
		/** The catalog plan stored on the account, or null when none is set. */
		plan: PublicValuePlanObject | null;
		sourceObservedAt: number | null;
		current: PublicValueWindow | null;
		completed: PublicValueWindow[];
		periods: PublicValuePeriod[];
	}>;
}

/** Closed rows read per account: covers the 3 previous months and the month to date. */
const CLOSED_READ_LIMIT = 200;
const MAX_BODY_BYTES = 256 * 1024;
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const GRANT_TYPES = new Set(["natural", "early_reset", "first_observed"]);
// The value page refuses a body past these bounds, so the feed refuses it first.
// points_used is REAL: a fractional reading is valid and must not fail the feed.
const pointsOrNull = (value: number | null): boolean =>
	value === null || (Number.isFinite(value) && value >= 0 && value <= 100_000);
const countOrNull = (value: number | null): boolean =>
	value === null ||
	(Number.isSafeInteger(value) && value >= 0 && value <= 10_000);

/** A body older than this is rebuilt behind the request that finds it. */
const CACHE_MS = 60_000;
/**
 * The oldest body the feed will serve. The value page treats a feed body older
 * than its 5-minute `STALE_MS` (pushbot `apps/startupbros-funnels/src/lib/value-index.ts`)
 * as stale, so this must stay below that. It is also what lets a slow build
 * land: a build is accepted whenever its body is still younger than this.
 */
export const MAX_AGE_MS = 240_000;
/**
 * A request with no servable body waits this long for a build, then answers
 * 503. The value page's feed fetch times out at 5 s, so this stays below it.
 */
export const REQUEST_WAIT_MS = 4_000;
/** The timer rebuilds CACHE_MS minus this after a body is cached, while builds are fast. */
export const REBUILD_LEAD_MS = 15_000;
/** Cap on the doubling wait after consecutive failed rebuilds. */
export const REBUILD_RETRY_MAX_MS = 300_000;
/** Floor on the timer's delay, so a body that keeps expiring early cannot spin it. */
export const REBUILD_MIN_DELAY_MS = 5_000;
/** Wait before the first retry of a failed rebuild; it doubles per failure up to the cap. */
export const REBUILD_RETRY_MS = 15_000;
/**
 * In roster ("accounts") mode a still-valid cached body is revalidated against
 * the database roster at most once per this interval per process, so a write
 * made by another process sharing the database is picked up within this bound.
 */
export const ROSTER_RECHECK_MS = 5_000;
/**
 * A build that takes this long logs its landing or rejection as a warning, so
 * production, which logs at warn, records the builds that open gaps: a gap
 * opens when two consecutive builds plus the CACHE_MS - REBUILD_LEAD_MS wait
 * pass MAX_AGE_MS. Faster builds stay at info.
 */
export const SLOW_BUILD_MS = 60_000;
/** Source clocks may lead this server by at most five seconds. */
const CLOCK_SKEW_MS = 5_000;
const timestamp = (value: number): boolean =>
	Number.isSafeInteger(value) && value >= 0;
function publicWindow(
	window: UsageWindowRecord,
	valueUsd: number | null,
	now: number,
): PublicValueWindow {
	if (
		!timestamp(window.startedAt) ||
		!timestamp(window.resetsAt) ||
		window.resetsAt <= window.startedAt ||
		window.startedAt > now ||
		(window.closedAt !== null &&
			(!timestamp(window.closedAt) ||
				window.closedAt < window.startedAt ||
				window.closedAt > now + CLOCK_SKEW_MS)) ||
		(valueUsd !== null && (!Number.isFinite(valueUsd) || valueUsd < 0)) ||
		!GRANT_TYPES.has(window.grantType) ||
		!pointsOrNull(window.pointsUsed) ||
		!countOrNull(window.counterResets)
	)
		throw new FeedUnavailable("invalid_window");
	const unpriced = window.unpricedTokens;
	return {
		startedAt: window.startedAt,
		resetsAt: window.resetsAt,
		closedAt: window.closedAt,
		valueUsd,
		pricingCoverage:
			unpriced !== null && unpriced > 0
				? "partial"
				: unpriced === 0 && valueUsd !== null
					? "complete"
					: "unknown",
		grantType: window.grantType as PublicValueWindow["grantType"],
		// Open rows store NULL until close; utilization is a live counter, not points.
		pointsUsed: window.closedAt === null ? null : window.pointsUsed,
		counterResets: window.closedAt === null ? null : window.counterResets,
	};
}

function response(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

interface FeedCacheEntry {
	raw: string | undefined;
	body: PublicSubscriptionValue;
	expiresAt: number;
	/** Roster mode only: identity of the roster this body was built from. */
	signature?: string;
	rosterCheckedAt: number;
}

type UsableConfig = Extract<
	PublicSubscriptionsConfig,
	{ status: "enabled" | "accounts" }
>;

/** Runs `run` after `delayMs` on a timer that never keeps the process alive. */
function scheduleDetached(
	run: () => Promise<void>,
	delayMs: number,
): () => void {
	const timer = setTimeout(run, delayMs);
	timer.unref();
	return () => clearTimeout(timer);
}

class FeedUnavailable extends Error {
	constructor(
		readonly reason: string,
		readonly publicId?: string,
	) {
		super(reason);
	}
}
const log = new Logger("PublicSubscriptionValueHandler");

/**
 * Runs one account's valuation and logs how long it took, so a slow build can be
 * traced to the account whose reads were slow. Logs the public id and position
 * only; never the account name.
 */
async function timedAccountValuation<T>(
	publicId: string,
	index: number,
	accounts: number,
	valuation: () => Promise<T>,
): Promise<T> {
	const startedAt = performance.now();
	let outcome = "failed";
	try {
		const value = await valuation();
		outcome = "ok";
		return value;
	} finally {
		log.info("Public subscription value account valued", {
			id: publicId,
			index,
			accounts,
			outcome,
			ms: Math.round(performance.now() - startedAt),
		});
	}
}

/** A read-only, explicitly enrolled projection. Public requests never select accounts or periods. */
export function createPublicSubscriptionValueHandler(
	context: APIContext,
	options: {
		getConfig?: () => string | undefined;
		now?: () => number;
		/** Roster generation for the DB-backed ("accounts") mode cache key. */
		getRosterGeneration?: () => number;
		/** Schedules the rebuild ahead of expiry; returns a cancel function. */
		schedule?: (run: () => Promise<void>, delayMs: number) => () => void;
	} = {},
) {
	const getConfig =
		options.getConfig ?? (() => process.env.HOV_ROUTER_PUBLIC_SUBSCRIPTIONS);
	const now = options.now ?? Date.now;
	const getGeneration =
		options.getRosterGeneration ?? getPublicRosterGeneration;
	const schedule = options.schedule ?? scheduleDetached;
	let cancelRebuild: (() => void) | undefined;
	const loggedConfigs = new Set<string | undefined>();
	const loggedFailures = new Map<string, number>();
	const refreshes = new Map<
		string | undefined,
		Promise<{ body: PublicSubscriptionValue; signature?: string }>
	>();
	const loggedPlans = new Map<string, number>();
	let rosterRecheck: Promise<string> | undefined;
	/** One running build per cache key; a request or the timer joins it. */
	const flights = new Map<string | undefined, Promise<FeedCacheEntry>>();
	let failures = 0;
	/** While a failed rebuild backs off, a request does not start another. */
	let retryNotBefore = 0;
	let cache: FeedCacheEntry | undefined;

	function logFailure(error: unknown) {
		const reason =
			error instanceof FeedUnavailable ? error.reason : "unexpected";
		// A broken clock must not prevent diagnostics, or hide the original error.
		let at = 0;
		try {
			const value = now();
			if (timestamp(value)) at = value;
		} catch {
			/* log the original failure */
		}
		const previous = loggedFailures.get(reason);
		if (previous !== undefined && at >= previous && at - previous < CACHE_MS)
			return;
		loggedFailures.set(reason, at);
		if (error instanceof FeedUnavailable)
			log.warn("Public subscription value unavailable", {
				reason,
				...(error.publicId ? { id: error.publicId } : {}),
			});
		else log.error("Public subscription value unavailable: unexpected", error);
	}

	/**
	 * The catalog object for a stored plan key. A key the catalog no longer
	 * holds sends null and warns once a minute per key; it never fails the feed.
	 */
	function planFor(
		key: string | null,
		at: number,
	): PublicValuePlanObject | null {
		if (key === null) return null;
		const entry = getPublicValuePlan(key);
		if (entry) return publicValuePlanObject(entry);
		const previous = loggedPlans.get(key);
		if (previous === undefined || at < previous || at - previous >= CACHE_MS) {
			loggedPlans.set(key, at);
			log.warn("Public subscription plan not in the catalog", { plan: key });
		}
		return null;
	}

	/**
	 * Reads the published roster. Called only from refresh (a cache miss), so the
	 * database is never queried per public request. Anything malformed fails the
	 * whole feed closed.
	 */
	async function readRoster(): Promise<PublicSubscriptionMapping[]> {
		return validateRosterRows(
			await context.dbOps.listPublishedPublicValue(
				MAX_PUBLIC_SUBSCRIPTIONS + 1,
			),
		);
	}

	function validateRosterRows(
		rows: Awaited<ReturnType<typeof context.dbOps.listPublishedPublicValue>>,
	): PublicSubscriptionMapping[] {
		if (rows.length > MAX_PUBLIC_SUBSCRIPTIONS)
			throw new FeedUnavailable("too_many");
		const ids = new Set<string>();
		const labels = new Set<string>();
		const mappings: PublicSubscriptionMapping[] = [];
		for (const row of rows) {
			const label = row.public_value_label;
			const id = row.public_value_id;
			const createdAt = Number(row.created_at);
			if (!isValidPublicLabel(label)) throw new FeedUnavailable("bad_label");
			if (!isValidPublicId(id)) throw new FeedUnavailable("bad_id");
			if (!timestamp(createdAt))
				throw new FeedUnavailable("bad_account_created_at", id);
			const labelKey = label.toLowerCase();
			if (ids.has(id)) throw new FeedUnavailable("duplicate_id", id);
			if (labels.has(labelKey))
				throw new FeedUnavailable("duplicate_label", id);
			ids.add(id);
			labels.add(labelKey);
			mappings.push({
				accountId: row.id,
				accountCreatedAt: createdAt,
				id,
				label,
				plan: row.public_value_plan ?? null,
			});
		}
		return mappings.sort(
			(a, b) =>
				(a.label.toLowerCase() < b.label.toLowerCase()
					? -1
					: a.label.toLowerCase() > b.label.toLowerCase()
						? 1
						: 0) || a.accountCreatedAt - b.accountCreatedAt,
		);
	}

	/** Order-independent identity of a validated roster. */
	function rosterSignature(mappings: PublicSubscriptionMapping[]): string {
		return mappings
			.map((m) =>
				JSON.stringify([
					m.accountId,
					m.id,
					m.label,
					m.accountCreatedAt,
					m.plan ?? null,
				]),
			)
			.sort()
			.join("\n");
	}

	async function refresh(
		source: PublicSubscriptionMapping[] | "accounts",
		at: number,
	): Promise<{ body: PublicSubscriptionValue; signature?: string }> {
		const fromRoster = source === "accounts";
		const mappings = fromRoster ? await readRoster() : source;
		const signature = fromRoster ? rosterSignature(mappings) : undefined;
		// One account at a time: each open-window valuation is a heavy aggregate on
		// the single-lane bulk reader, so they must never queue up together.
		const subscriptions: PublicSubscriptionValue["subscriptions"] = [];
		for (const [index, mapping] of mappings.entries()) {
			subscriptions.push(
				await timedAccountValuation(
					mapping.id,
					index,
					mappings.length,
					async () => {
						const [snapshot, open, closed] = await Promise.all([
							context.dbOps.getLatestUsageSnapshot(
								mapping.accountId,
								"seven_day",
							),
							context.dbOps.getOpenUsageWindow(mapping.accountId, "seven_day"),
							context.dbOps.listUsageWindows({
								accountId: mapping.accountId,
								windowKey: "seven_day",
								closedOnly: true,
								limit: CLOSED_READ_LIMIT,
								startedAtOrAfter: mapping.accountCreatedAt,
							}),
						]);
						const current =
							open &&
							open.startedAt >= mapping.accountCreatedAt &&
							open.startedAt <= at &&
							at < open.resetsAt
								? await valueOpenWindow(context.dbOps, open, at)
								: null;
						// Check generation after every read, including live valuation: replaced
						// accounts must never publish rows belonging to their prior generation.
						const account = await context.dbOps.getAccount(mapping.accountId);
						if (!account || account.created_at !== mapping.accountCreatedAt)
							throw new FeedUnavailable("generation_mismatch", mapping.id);
						// Roster mode: the row must still be published exactly as read.
						if (
							fromRoster &&
							(account.public_value_enabled !== true ||
								account.public_value_label !== mapping.label ||
								account.public_value_id !== mapping.id ||
								(account.public_value_plan ?? null) !==
									(mapping.plan ?? null) ||
								// A rename can make a stored label reveal the account name.
								labelRevealsAccount(mapping.label, account))
						)
							throw new FeedUnavailable("roster_changed", mapping.id);
						const observed = snapshot?.timestamp;
						const provider =
							account.provider === "codex" ? "openai" : account.provider;
						if (!PROVIDER_PATTERN.test(provider))
							throw new FeedUnavailable("bad_provider", mapping.id);
						const plan = planFor(account.public_value_plan ?? null, at);
						const currentWindow = current
							? publicWindow(current, current.valueSoFarUsd, at)
							: null;
						const closedWindows = closed.map((window) =>
							publicWindow(toUsageWindowRecord(window), window.valueUsd, at),
						);
						return {
							id: mapping.id,
							label: mapping.label,
							provider,
							plan,
							sourceObservedAt:
								observed !== undefined &&
								timestamp(observed) &&
								observed >= mapping.accountCreatedAt &&
								observed <= at + CLOCK_SKEW_MS
									? observed
									: null,
							current: currentWindow,
							completed: selectCompleted(closedWindows, at),
							periods: buildPeriods(closedWindows, currentWindow, at),
						};
					},
				),
			);
		}
		const body: PublicSubscriptionValue = {
			schemaVersion: 2,
			valueBasis: "api_equivalent_usd",
			windowKey: "seven_day",
			pricingVersion: VALUE_PRICING_VERSION,
			generatedAt: at,
			subscriptions,
		};
		if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES)
			throw new FeedUnavailable("too_large");
		return { body, signature };
	}

	/**
	 * The cache key and refresh source for a usable config. Roster mode keys the
	 * cache on the write generation so an admin write is visible on the next
	 * request, and never shares a key with env JSON.
	 */
	function feedTarget(raw: string | undefined, config: UsableConfig) {
		const generation = config.status === "accounts" ? getGeneration() : 0;
		return {
			raw,
			generation,
			key: config.status === "accounts" ? `accounts:${generation}` : raw,
			source:
				config.status === "accounts" ? ("accounts" as const) : config.mappings,
		};
	}

	/**
	 * Builds a body for `target`, or joins the build already running for it, and
	 * refuses it if the config or roster changed while it was built.
	 */
	async function build(
		target: ReturnType<typeof feedTarget>,
		at: number,
	): Promise<FeedCacheEntry> {
		let pending = refreshes.get(target.key);
		if (!pending) {
			pending = refresh(target.source, at);
			refreshes.set(target.key, pending);
		}
		let built: { body: PublicSubscriptionValue; signature?: string };
		try {
			built = await pending;
		} finally {
			if (refreshes.get(target.key) === pending) refreshes.delete(target.key);
		}
		if (getConfig() !== target.raw) throw new FeedUnavailable("config_changed");
		if (target.source === "accounts" && getGeneration() !== target.generation)
			throw new FeedUnavailable("roster_changed");
		const body = built.body;
		return {
			raw: target.key,
			body,
			signature: built.signature,
			rosterCheckedAt: body.generatedAt,
			expiresAt: Math.min(
				body.generatedAt + MAX_AGE_MS,
				...body.subscriptions.flatMap((subscription) =>
					subscription.current ? [subscription.current.resetsAt] : [],
				),
			),
		};
	}

	function armRebuild(delayMs: number) {
		cancelRebuild?.();
		cancelRebuild = schedule(() => {
			cancelRebuild = undefined;
			return rebuildAhead();
		}, delayMs);
	}

	function armAhead(entry: FeedCacheEntry, at: number) {
		// A body clamped to an open window's reset is rebuilt at that reset at the
		// latest; rebuilding earlier cannot move it.
		armRebuild(
			Math.max(
				Math.min(CACHE_MS - REBUILD_LEAD_MS, entry.expiresAt - at),
				REBUILD_MIN_DELAY_MS,
			),
		);
	}

	/** Records a failed rebuild and returns how long to back off before the next. */
	function noteFailure(error: unknown): number {
		logFailure(error);
		failures++;
		const delay = Math.min(
			REBUILD_RETRY_MS * 2 ** (failures - 1),
			REBUILD_RETRY_MAX_MS,
		);
		try {
			const at = now();
			if (timestamp(at)) retryNotBefore = at + delay;
		} catch {
			/* the delay still applies to the timer */
		}
		return delay;
	}

	/**
	 * Builds a body and, if it is still within MAX_AGE_MS when it lands, makes it
	 * the cache and arms the timer, whether or not a request is waiting for it.
	 */
	async function runBuild(
		target: ReturnType<typeof feedTarget>,
	): Promise<FeedCacheEntry> {
		const startedAt = performance.now();
		let bodyAgeMs: number | undefined;
		log.info("Public subscription value build started", {
			mode: target.source === "accounts" ? "accounts" : "env",
			consecutiveFailures: failures,
		});
		try {
			const at = now();
			if (!timestamp(at)) throw new FeedUnavailable("clock");
			const entry = await build(target, at);
			const landedAt = now();
			if (!timestamp(landedAt)) throw new FeedUnavailable("clock");
			bodyAgeMs = landedAt - entry.body.generatedAt;
			if (landedAt < entry.body.generatedAt || landedAt >= entry.expiresAt)
				throw new FeedUnavailable("expired");
			const ms = Math.round(performance.now() - startedAt);
			log[ms >= SLOW_BUILD_MS ? "warn" : "info"](
				"Public subscription value build landed",
				{ ms, bodyAgeMs, accounts: entry.body.subscriptions.length },
			);
			cache = entry;
			failures = 0;
			retryNotBefore = 0;
			armAhead(entry, landedAt);
			return entry;
		} catch (error) {
			const ms = Math.round(performance.now() - startedAt);
			log[ms >= SLOW_BUILD_MS ? "warn" : "info"](
				"Public subscription value build rejected",
				{
					outcome:
						error instanceof FeedUnavailable ? error.reason : "unexpected",
					ms,
					...(bodyAgeMs === undefined ? {} : { bodyAgeMs }),
				},
			);
			const delay = noteFailure(error);
			// Keep the feed warm when no request arrives; the delay doubles per failure.
			if (cache) armRebuild(delay);
			throw error;
		}
	}

	/** Starts a build for `target`, or joins the one running (single-flight). */
	function startFlight(
		target: ReturnType<typeof feedTarget>,
	): Promise<FeedCacheEntry> {
		let flight = flights.get(target.key);
		if (!flight) {
			const started: Promise<FeedCacheEntry> = runBuild(target).finally(() => {
				if (flights.get(target.key) === started) flights.delete(target.key);
			});
			// A build nobody awaits (the timer's, or one a request gave up on) still settles.
			started.catch(() => undefined);
			flights.set(target.key, started);
			flight = started;
		}
		return flight;
	}

	/** Rejects if `work` has not settled within REQUEST_WAIT_MS; `work` keeps running. */
	function withDeadline<T>(work: Promise<T>): Promise<T> {
		let cancel = () => {};
		const timeout = new Promise<never>((_, reject) => {
			cancel = schedule(async () => {
				reject(new FeedUnavailable("request_deadline"));
			}, REQUEST_WAIT_MS);
		});
		return Promise.race([work, timeout]).finally(cancel);
	}

	async function rebuildAhead(): Promise<void> {
		let flight: Promise<FeedCacheEntry>;
		try {
			const raw = getConfig();
			const config = parsePublicSubscriptionsConfig(raw);
			if (config.status === "disabled" || config.status === "invalid") return;
			flight = startFlight(feedTarget(raw, config));
		} catch (error) {
			armRebuild(noteFailure(error));
			return;
		}
		// A failed build was recorded and its retry armed by runBuild.
		await flight.catch(() => undefined);
	}

	return async (): Promise<Response> => {
		try {
			const raw = getConfig();
			const config = parsePublicSubscriptionsConfig(raw);
			if (config.status === "disabled")
				return response({ error: "Not found" }, 404);
			if (!loggedConfigs.has(raw)) {
				loggedConfigs.add(raw);
				if (config.status === "invalid")
					log.warn("Invalid public subscriptions config", {
						reason: config.reason,
						...(config.index === undefined ? {} : { index: config.index }),
					});
				else if (config.status === "accounts")
					log.info("Public subscriptions enabled from the account roster");
				else
					log.info("Public subscriptions enabled", {
						subscriptions: config.mappings.length,
					});
			}
			if (config.status === "invalid")
				return response({ error: "Unavailable" }, 503);
			const target = feedTarget(raw, config);
			const at = now();
			if (!timestamp(at)) throw new FeedUnavailable("clock");
			const cached = cache;
			let entry =
				cached &&
				cached.raw === target.key &&
				at >= cached.body.generatedAt &&
				at < cached.expiresAt
					? cached
					: undefined;
			if (
				entry &&
				config.status === "accounts" &&
				entry.signature !== undefined &&
				at - entry.rosterCheckedAt >= ROSTER_RECHECK_MS
			) {
				// One shared, cheap roster query per interval. An error or a wait past
				// the request deadline propagates to the generic 503 path; a body whose
				// roster could not be confirmed is never served.
				let pendingCheck = rosterRecheck;
				if (!pendingCheck) {
					const started = readRoster().then(rosterSignature);
					pendingCheck = started;
					rosterRecheck = started;
					const clear = () => {
						if (rosterRecheck === started) rosterRecheck = undefined;
					};
					started.then(clear, clear);
				}
				const signature = await withDeadline(pendingCheck);
				if (signature === entry.signature) entry.rosterCheckedAt = at;
				else entry = undefined;
			}
			if (entry) {
				// An aging body answers now; the rebuild runs behind it.
				// The timer runs it, after this response is sent.
				if (
					at - entry.body.generatedAt >= CACHE_MS &&
					at >= retryNotBefore &&
					!flights.has(target.key)
				)
					armRebuild(0);
			} else {
				entry = await withDeadline(startFlight(target));
			}
			const responseAt = now();
			if (!timestamp(responseAt)) throw new FeedUnavailable("clock");
			if (responseAt < entry.body.generatedAt || responseAt >= entry.expiresAt)
				throw new FeedUnavailable("expired");
			return response(entry.body);
		} catch (error) {
			logFailure(error);
			return response({ error: "Unavailable" }, 503);
		}
	};
}
