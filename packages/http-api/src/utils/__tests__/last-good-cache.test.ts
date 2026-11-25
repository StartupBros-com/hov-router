import { describe, expect, it } from "bun:test";
import { createLastGoodCache } from "../last-good-cache";

/** A load the test settles by hand, counting how often it was started. */
function manualLoads<T>() {
	const pending: Array<{
		resolve: (value: T) => void;
		reject: (error: unknown) => void;
	}> = [];
	return {
		started: () => pending.length,
		load: () =>
			new Promise<T>((resolve, reject) => {
				pending.push({ resolve, reject });
			}),
		resolve: (index: number, value: T) => pending[index].resolve(value),
		reject: (index: number, error: unknown) => pending[index].reject(error),
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("last-good cache", () => {
	it("answers from a fresh value without loading", async () => {
		let now = 1_000;
		let calls = 0;
		const cache = createLastGoodCache<number>({
			freshMs: 100,
			maxAgeMs: 1_000,
			now: () => now,
		});
		const load = async () => ++calls;
		expect(await cache.get("k", load, { waitMs: 50 })).toEqual({
			value: 1,
			asOf: 1_000,
			fresh: true,
		});
		now = 1_099;
		expect(await cache.get("k", load, { waitMs: 50 })).toEqual({
			value: 1,
			asOf: 1_000,
			fresh: true,
		});
		expect(calls).toBe(1);
		now = 1_100;
		expect((await cache.get("k", load, { waitMs: 50 }))?.value).toBe(2);
		expect(calls).toBe(2);
	});

	it("shares one running load between callers and never stacks a second", async () => {
		const loads = manualLoads<string>();
		const cache = createLastGoodCache<string>({
			freshMs: 100,
			maxAgeMs: 1_000,
			now: () => 0,
		});
		const first = cache.get("k", loads.load, { waitMs: 1_000 });
		const second = cache.get("k", loads.load, { waitMs: 1_000 });
		// Short waits that give up still do not start another load.
		expect(await cache.get("k", loads.load, { waitMs: 1 })).toBeNull();
		expect(await cache.get("k", loads.load, { waitMs: 1 })).toBeNull();
		expect(loads.started()).toBe(1);
		loads.resolve(0, "done");
		expect((await first)?.value).toBe("done");
		expect((await second)?.value).toBe("done");
	});

	it("serves the last good value, marked not fresh, when a load outlasts the wait", async () => {
		let now = 0;
		const loads = manualLoads<string>();
		const cache = createLastGoodCache<string>({
			freshMs: 100,
			maxAgeMs: 10_000,
			now: () => now,
		});
		const seeded = cache.get("k", loads.load, { waitMs: 1_000 });
		loads.resolve(0, "old");
		await seeded;

		now = 5_000;
		const started = performance.now();
		expect(await cache.get("k", loads.load, { waitMs: 20 })).toEqual({
			value: "old",
			asOf: 0,
			fresh: false,
		});
		expect(performance.now() - started).toBeLessThan(500);
		expect(loads.started()).toBe(2);

		// The abandoned load keeps running; when it lands it becomes the value.
		loads.resolve(1, "new");
		await flush();
		now = 5_050;
		expect(await cache.get("k", loads.load, { waitMs: 20 })).toEqual({
			value: "new",
			asOf: 5_000,
			fresh: true,
		});
		expect(loads.started()).toBe(2);
	});

	it("returns null within the wait when nothing usable is cached, then the landed value", async () => {
		const loads = manualLoads<number>();
		let now = 0;
		const cache = createLastGoodCache<number>({
			freshMs: 100,
			maxAgeMs: 1_000,
			now: () => now,
		});
		expect(await cache.get("k", loads.load, { waitMs: 10 })).toBeNull();
		loads.resolve(0, 42);
		await flush();
		now = 10;
		expect(await cache.get("k", loads.load, { waitMs: 10 })).toEqual({
			value: 42,
			asOf: 0,
			fresh: true,
		});
	});

	it("never serves a value past its maximum age", async () => {
		let now = 0;
		const loads = manualLoads<number>();
		const cache = createLastGoodCache<number>({
			freshMs: 100,
			maxAgeMs: 1_000,
			now: () => now,
		});
		const seeded = cache.get("k", loads.load, { waitMs: 1_000 });
		loads.resolve(0, 1);
		await seeded;
		now = 999;
		expect((await cache.get("k", loads.load, { waitMs: 5 }))?.value).toBe(1);
		now = 1_000;
		expect(await cache.get("k", loads.load, { waitMs: 5 })).toBeNull();
	});

	it("falls back to the last good value when a load fails, and rethrows when there is none", async () => {
		let now = 0;
		const loads = manualLoads<number>();
		const cache = createLastGoodCache<number>({
			freshMs: 100,
			maxAgeMs: 1_000,
			now: () => now,
		});
		const failing = cache.get("k", loads.load, { waitMs: 1_000 });
		loads.reject(0, new Error("disk"));
		await expect(failing).rejects.toThrow("disk");

		const seeded = cache.get("k", loads.load, { waitMs: 1_000 });
		loads.resolve(1, 7);
		await seeded;
		now = 500;
		const fallback = cache.get("k", loads.load, { waitMs: 1_000 });
		const failure = new Error("disk");
		loads.reject(2, failure);
		// The fallback names the failure, so a caller can report it rather than
		// mistake it for a load that is still running.
		expect(await fallback).toEqual({
			value: 7,
			asOf: 0,
			fresh: false,
			error: failure,
		});
		// A fallback served because the load is still running carries no error.
		now = 600;
		const waiting = await cache.get("k", loads.load, { waitMs: 1 });
		expect(waiting).toEqual({ value: 7, asOf: 0, fresh: false });
	});

	it("reloads a fresh value that does not cover what the caller needs", async () => {
		let calls = 0;
		const cache = createLastGoodCache<number[]>({
			freshMs: 1_000,
			maxAgeMs: 10_000,
			now: () => 0,
		});
		const load = async () => {
			calls++;
			return calls === 1 ? [1] : [1, 2];
		};
		await cache.get("k", load, { waitMs: 50 });
		const covered = await cache.get("k", load, {
			waitMs: 50,
			covers: (value) => value.includes(1),
		});
		expect(covered?.value).toEqual([1]);
		expect(calls).toBe(1);
		const widened = await cache.get("k", load, {
			waitMs: 50,
			covers: (value) => value.includes(2),
		});
		expect(widened?.value).toEqual([1, 2]);
		expect(calls).toBe(2);
	});

	it("keeps keys apart and retires running loads on clear", async () => {
		const loads = manualLoads<string>();
		const cache = createLastGoodCache<string>({
			freshMs: 100,
			maxAgeMs: 1_000,
			now: () => 0,
		});
		const a = cache.get("a", async () => "a", { waitMs: 50 });
		expect((await a)?.value).toBe("a");
		const retired = cache.get("b", loads.load, { waitMs: 1_000 });
		cache.clear();
		loads.resolve(0, "retired");
		// The waiting caller still gets its answer; the cache does not keep it.
		expect((await retired)?.value).toBe("retired");
		let calls = 0;
		await cache.get(
			"b",
			async () => {
				calls++;
				return "after";
			},
			{ waitMs: 50 },
		);
		expect(calls).toBe(1);
		expect(
			(await cache.get("a", async () => "a2", { waitMs: 50 }))?.value,
		).toBe("a2");
	});

	it("waits only the shorter stale wait when an older value can answer", async () => {
		let now = 0;
		const loads = manualLoads<string>();
		const cache = createLastGoodCache<string>({
			freshMs: 100,
			maxAgeMs: 10_000,
			now: () => now,
		});
		// Nothing cached: the full wait applies.
		const empty = cache.get("k", loads.load, {
			waitMs: 60,
			staleWaitMs: 1,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		loads.resolve(0, "first");
		expect((await empty)?.value).toBe("first");

		now = 500;
		const started = performance.now();
		const stale = await cache.get("k", loads.load, {
			waitMs: 5_000,
			staleWaitMs: 1,
		});
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(stale).toEqual({ value: "first", asOf: 0, fresh: false });
	});
});
