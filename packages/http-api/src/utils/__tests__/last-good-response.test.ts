import { describe, expect, it } from "bun:test";
import { jsonResponse } from "@better-ccflare/http-common";
import {
	createLastGoodResponses,
	lastGoodResponseKey,
} from "../last-good-response";

const never = () => new Promise<Response>(() => {});

function responses(now: () => number) {
	return createLastGoodResponses({
		freshMs: 1_000,
		maxAgeMs: 10_000,
		waitMs: 40,
		staleWaitMs: 5,
		busyMessage: "still being computed",
		now,
	});
}

describe("last-good responses", () => {
	it("computes a 200 once and hands each caller its own readable copy", async () => {
		let calls = 0;
		const cache = responses(() => 0);
		const compute = async () => {
			calls++;
			return jsonResponse({ rows: [1, 2] }, 200, { "X-Test": "kept" });
		};
		const [a, b] = await Promise.all([
			cache.respond("k", compute),
			cache.respond("k", compute),
		]);
		expect(await a.json()).toEqual({ rows: [1, 2] });
		expect(await b.json()).toEqual({ rows: [1, 2] });
		expect(b.headers.get("X-Test")).toBe("kept");
		expect(calls).toBe(1);
	});

	it("passes an error response through without caching it", async () => {
		let calls = 0;
		const cache = responses(() => 0);
		const failing = async () => {
			calls++;
			return jsonResponse({ error: "Failed to fetch" }, 500);
		};
		const first = await cache.respond("k", failing);
		expect(first.status).toBe(500);
		expect(await first.json()).toEqual({ error: "Failed to fetch" });
		expect((await cache.respond("k", failing)).status).toBe(500);
		expect(calls).toBe(2);
	});

	it("answers 503 when the first computation outlasts the wait, and the result once it lands", async () => {
		let finish: (response: Response) => void = () => {};
		const cache = responses(() => 0);
		const slow = () =>
			new Promise<Response>((resolve) => {
				finish = resolve;
			});
		const busy = await cache.respond("k", slow);
		expect(busy.status).toBe(503);
		expect(await busy.json()).toEqual({ error: "still being computed" });

		finish(jsonResponse({ done: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const landed = await cache.respond("k", never);
		expect(landed.status).toBe(200);
		expect(await landed.json()).toEqual({ done: true });
	});

	it("serves the last good body with its age while a recomputation is slow", async () => {
		let now = 0;
		const cache = responses(() => now);
		await cache.respond("k", async () => jsonResponse({ v: 1 }));
		now = 4_000;
		const stale = await cache.respond("k", never);
		expect(stale.status).toBe(200);
		expect(await stale.json()).toEqual({ v: 1 });
		expect(stale.headers.get("Age")).toBe("4");
	});

	it("keys a request by path and query, ignoring parameter order", () => {
		expect(
			lastGoodResponseKey(
				new URL("http://x/api/insights/cache?range=7d&threshold=40"),
			),
		).toBe(
			lastGoodResponseKey(
				new URL("http://x/api/insights/cache?threshold=40&range=7d"),
			),
		);
		expect(
			lastGoodResponseKey(new URL("http://x/api/insights/cache?range=7d")),
		).not.toBe(
			lastGoodResponseKey(new URL("http://x/api/insights/context?range=7d")),
		);
	});
});
