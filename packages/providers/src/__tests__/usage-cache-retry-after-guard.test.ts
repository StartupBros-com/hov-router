import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { usageCache } from "../usage-fetcher";

// Issue #869: Anthropic's usage endpoint answered 429 with retry-after 3600,
// and every check sent inside that hour drew a fresh hour. No request may
// leave for an account while its usage retry-after deadline is live.

const originalFetch = globalThis.fetch;
const started: string[] = [];
let nextId = 0;

function accountId(): string {
	const id = `usage-retry-after-guard-${++nextId}`;
	started.push(id);
	return id;
}

const usagePayload = () => ({
	five_hour: {
		utilization: 10,
		resets_at: new Date(Date.now() + 3_600_000).toISOString(),
	},
});

function rateLimited(retryAfter: string): Response {
	return new Response(JSON.stringify({ error: "rate_limited" }), {
		status: 429,
		headers: { "content-type": "application/json", "retry-after": retryAfter },
	});
}

/** Stubbed endpoint: answers in order, then repeats the last answer. */
function stubFetch(answers: (() => Response)[]): { count: () => number } {
	let calls = 0;
	globalThis.fetch = (async () => {
		const answer = answers[Math.min(calls, answers.length - 1)];
		calls++;
		return answer();
	}) as unknown as typeof fetch;
	return { count: () => calls };
}

async function until(predicate: () => boolean, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition never held");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

afterEach(() => {
	for (const id of started.splice(0)) {
		usageCache.stopPolling(id);
		usageCache.delete(id);
	}
	globalThis.fetch = originalFetch;
});

describe.serial("usage retry-after deadline", () => {
	it.serial(
		"blocks refreshNow and a polling restart, then the scheduled poll resumes after it",
		async () => {
			const id = accountId();
			const endpoint = stubFetch([
				() => rateLimited("0.3"),
				() => Response.json(usagePayload()),
			]);
			usageCache.startPolling(id, "fake-token", "anthropic", 60_000);
			await until(() => usageCache.getRateLimitedUntil(id) !== null);
			expect(endpoint.count()).toBe(1);

			expect(await usageCache.refreshNow(id)).toBe(false);
			expect(endpoint.count()).toBe(1);

			// Refresh usage restarts polling: stop, then start with a fetch.
			usageCache.stopPolling(id);
			expect(usageCache.getRateLimitedUntil(id)).not.toBeNull();
			const restored: string[] = [];
			usageCache.startPolling(
				id,
				"fake-token",
				"anthropic",
				60_000,
				undefined,
				undefined,
				(restoredId) => restored.push(restoredId),
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(await usageCache.refreshNow(id)).toBe(false);
			expect(endpoint.count()).toBe(1);

			// The restarted poll waits out the deadline instead of the 60 s interval.
			await until(() => endpoint.count() === 2);
			await until(() => usageCache.get(id) !== null);
			expect(usageCache.getRateLimitedUntil(id)).toBeNull();
			// The first reading after the lockout still knows it followed one, so
			// a stale router cooldown can be cleared (seat reassignment).
			expect(restored).toEqual([id]);
		},
	);

	it.serial(
		"a read or another account's 429 after the deadline keeps the lockout marker for the next reading",
		async () => {
			const id = accountId();
			const restored: string[] = [];
			const endpoint = stubFetch([
				() => rateLimited("3600"),
				() => Response.json(usagePayload()),
			]);
			usageCache.startPolling(
				id,
				"fake-token",
				"anthropic",
				60_000,
				undefined,
				undefined,
				(restoredId) => restored.push(restoredId),
			);
			await until(() => usageCache.getRateLimitedUntil(id) !== null);

			const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_001);
			try {
				// The accounts page and the proxy both read the deadline.
				expect(usageCache.getRateLimitedUntil(id)).toBeNull();
				// Another account's 429 sweeps expired entries.
				usageCache.recordUsageRetryAfter(accountId(), 1_000);
				expect(await usageCache.refreshNow(id)).toBe(true);
				expect(endpoint.count()).toBe(2);
				expect(restored).toEqual([id]);
			} finally {
				clock.mockRestore();
			}
		},
	);

	it.serial("survives a token reload's cache delete", async () => {
		const id = accountId();
		const endpoint = stubFetch([() => rateLimited("3600")]);
		usageCache.startPolling(id, "fake-token", "anthropic", 60_000);
		await until(() => usageCache.getRateLimitedUntil(id) !== null);
		usageCache.delete(id);
		expect(usageCache.getRateLimitedUntil(id)).not.toBeNull();
		expect(await usageCache.refreshNow(id)).toBe(false);
		expect(endpoint.count()).toBe(1);
	});

	it.serial(
		"stops blocking once the deadline has passed, and only for its own account",
		async () => {
			const locked = accountId();
			const free = accountId();
			const endpoint = stubFetch([() => Response.json(usagePayload())]);
			usageCache.startPolling(locked, "fake-token", "anthropic", 60_000);
			usageCache.startPolling(free, "fake-token", "anthropic", 60_000);
			await until(() => endpoint.count() === 2);

			const t0 = Date.now();
			const clock = spyOn(Date, "now").mockReturnValue(t0);
			try {
				usageCache.recordUsageRetryAfter(locked, 100);
				expect(await usageCache.refreshNow(free)).toBe(true);
				expect(endpoint.count()).toBe(3);

				clock.mockReturnValue(t0 + 99);
				expect(await usageCache.refreshNow(locked)).toBe(false);
				expect(endpoint.count()).toBe(3);

				clock.mockReturnValue(t0 + 101);
				expect(await usageCache.refreshNow(locked)).toBe(true);
				expect(endpoint.count()).toBe(4);
			} finally {
				clock.mockRestore();
			}
		},
	);

	it.serial("applies to a Codex usage 429 as well", async () => {
		const id = accountId();
		const endpoint = stubFetch([() => rateLimited("3600")]);
		usageCache.startPolling(id, "fake-token", "codex", 60_000);
		await until(() => usageCache.getRateLimitedUntil(id) !== null);
		expect(await usageCache.refreshNow(id, { awaitInFlight: true })).toBe(
			false,
		);
		expect(endpoint.count()).toBe(1);
	});

	it.serial("ignores a retry-after that is not a positive duration", () => {
		const id = accountId();
		for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			usageCache.recordUsageRetryAfter(id, ms);
			expect(usageCache.getRateLimitedUntil(id)).toBeNull();
		}
	});
});
