/** A cached value and how old it is. */
export interface LastGood<T> {
	value: T;
	/** When the load that produced this value started (epoch ms). */
	asOf: number;
	/**
	 * True for a value read within `freshMs` or by the load this call waited
	 * on. False for an older value served because the current load is still
	 * running or failed.
	 */
	fresh: boolean;
	/** Set when this older value stands in for a load that failed. */
	error?: unknown;
}

export interface LastGoodCacheOptions {
	/** A value younger than this is answered without starting a load. */
	freshMs: number;
	/** A value this old or older is never served. */
	maxAgeMs: number;
	/** Completed keys kept; the oldest is dropped past this. Default 32. */
	maxKeys?: number;
	now?: () => number;
}

export interface LastGoodGetOptions<T> {
	/** How long this caller waits on a running load before falling back. */
	waitMs: number;
	/**
	 * The wait instead of `waitMs` when an older value can be served, so a
	 * caller with something to show is not held as long as one with nothing.
	 * Defaults to `waitMs`.
	 */
	staleWaitMs?: number;
	/** A fresh value this returns false for is reloaded, as if stale. */
	covers?: (value: T) => boolean;
}

/**
 * Single-flight cache for reads that can run far longer than a request
 * should wait (a dashboard aggregate on a saturated disk). Per key, at most
 * one load runs; callers join it, wait up to their own `waitMs`, then get the
 * last good value or `null`. A load the caller stopped waiting for keeps
 * running and becomes the value when it lands, so a later poll answers at
 * once instead of starting another read behind it. `createTtlCache` is the
 * plain variant with no fallback and no wait bound.
 */
export function createLastGoodCache<T>(options: LastGoodCacheOptions) {
	const now = options.now ?? Date.now;
	const maxKeys = options.maxKeys ?? 32;
	const values = new Map<string, { value: T; asOf: number }>();
	const flights = new Map<string, Promise<LastGood<T>>>();
	let generation = 0;

	function lastGood(key: string): LastGood<T> | null {
		const cached = values.get(key);
		if (!cached || now() - cached.asOf >= options.maxAgeMs) return null;
		return { value: cached.value, asOf: cached.asOf, fresh: false };
	}

	function start(key: string, load: () => Promise<T>): Promise<LastGood<T>> {
		const startedAt = now();
		const startedIn = generation;
		let loading: Promise<T>;
		try {
			loading = load();
		} catch (error) {
			loading = Promise.reject(error);
		}
		const flight: Promise<LastGood<T>> = loading
			.then((value) => {
				// clear() retires older loads; their waiting callers still get the result.
				const current = values.get(key);
				if (
					startedIn === generation &&
					(!current || current.asOf <= startedAt)
				) {
					values.delete(key);
					values.set(key, { value, asOf: startedAt });
					if (values.size > maxKeys) {
						const oldest = values.keys().next().value;
						if (oldest !== undefined) values.delete(oldest);
					}
				}
				return { value, asOf: startedAt, fresh: true };
			})
			.finally(() => {
				if (flights.get(key) === flight) flights.delete(key);
			});
		// Every caller may stop waiting; the load must not become an unhandled rejection.
		flight.catch(() => undefined);
		flights.set(key, flight);
		return flight;
	}

	return {
		async get(
			key: string,
			load: () => Promise<T>,
			{ waitMs, staleWaitMs, covers }: LastGoodGetOptions<T>,
		): Promise<LastGood<T> | null> {
			const cached = values.get(key);
			if (
				cached &&
				now() - cached.asOf < options.freshMs &&
				(covers?.(cached.value) ?? true)
			)
				return { value: cached.value, asOf: cached.asOf, fresh: true };

			const flight = flights.get(key) ?? start(key, load);
			const wait =
				staleWaitMs !== undefined && lastGood(key) ? staleWaitMs : waitMs;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const outcome = await Promise.race([
				flight.then(
					(result) => ({ kind: "landed" as const, result }),
					(error: unknown) => ({ kind: "failed" as const, error }),
				),
				new Promise<{ kind: "waited" }>((resolve) => {
					timer = setTimeout(
						() => resolve({ kind: "waited" }),
						Math.max(0, wait),
					);
				}),
			]).finally(() => clearTimeout(timer));

			if (outcome.kind === "landed") return outcome.result;
			const fallback = lastGood(key);
			if (outcome.kind === "failed") {
				if (fallback) return { ...fallback, error: outcome.error };
				throw outcome.error;
			}
			return fallback;
		},
		clear() {
			generation++;
			values.clear();
			flights.clear();
		},
	};
}
