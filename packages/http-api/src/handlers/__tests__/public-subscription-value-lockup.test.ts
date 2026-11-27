import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	spyOn,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@hov-router/logger";
import type { APIContext } from "../../types";

const scratch = mkdtempSync(join(tmpdir(), "hov-router-public-value-lockup-"));
process.env.HOV_ROUTER_DB_PATH = join(scratch, "isolated.db");
process.env.HOV_ROUTER_CONFIG_PATH = join(scratch, "isolated-config.json");
process.env.DATABASE_URL = "";
const handlerModule = await import("../public-subscription-value");
const { createPublicSubscriptionValueHandler } = handlerModule;
// Read through the module so a missing export is a failed assertion, not a crash.
const constants = handlerModule as unknown as Record<string, number>;
const MAX_AGE_MS = constants.MAX_AGE_MS as number;
const REQUEST_WAIT_MS = constants.REQUEST_WAIT_MS as number;

const T0 = 1_000_000;
const REBUILD_AHEAD_MS = 45_000;
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const flush = () => wait(5);

function mappingsFor(count: number) {
	return Array.from({ length: count }, (_, i) => ({
		accountId: `account-${i}`,
		accountCreatedAt: 100,
		id: `sub-${i}`,
		label: `Subscription ${i}`,
	}));
}

/** A db fake whose heavy aggregate read is under the test's control. */
function fakeDb() {
	const state = {
		calls: 0,
		aggregateCalls: 0,
		inFlight: 0,
		maxInFlight: 0,
		fail: false,
		/** Replaces the aggregate read; resolve the returned promise to finish it. */
		aggregate: undefined as undefined | (() => Promise<unknown[]>),
	};
	const counted =
		<A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
		async (...args: A) => {
			state.calls++;
			if (state.fail) throw new Error("reader busy");
			return read(...args);
		};
	const dbOps = {
		getLatestUsageSnapshot: counted(async () => undefined),
		listUsageWindows: counted(async () => []),
		getOpenUsageWindow: counted(async (accountId: string) => ({
			id: `window-${accountId}`,
			accountId,
			windowKey: "seven_day",
			startedAt: 500_000,
			resetsAt: 1_000_000_000,
			closedAt: null,
			grantType: "natural",
			peakUtilization: 0,
			first100At: null,
			valueUsd: null,
			inputTokens: null,
			cacheReadInputTokens: null,
			cacheCreationInputTokens: null,
			outputTokens: null,
			requestCount: null,
			modelBreakdown: null,
			unpricedTokens: null,
			projectionVersion: null,
			pointsUsed: null,
			counterResets: null,
		})),
		getAccount: counted(async (id: string) => ({
			id,
			created_at: 100,
			provider: "anthropic",
			public_value_plan: null,
		})),
		aggregateTokensByModel: counted(async () => {
			state.aggregateCalls++;
			state.inFlight++;
			state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
			try {
				return state.aggregate ? await state.aggregate() : [];
			} finally {
				state.inFlight--;
			}
		}),
	};
	return { state, dbOps };
}

/** A scheduler the test fires by hand; the deadline timer is the one at REQUEST_WAIT_MS. */
function manualScheduler() {
	const timers: Array<{
		run: () => Promise<void>;
		delayMs: number;
		cancelled: boolean;
	}> = [];
	return {
		schedule(run: () => Promise<void>, delayMs: number) {
			const timer = { run, delayMs, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		live: () => timers.filter((timer) => !timer.cancelled),
		/** Delays of the rebuild timer, leaving out request deadlines. */
		rebuildDelays: () =>
			timers
				.filter(
					(timer) => !timer.cancelled && timer.delayMs !== REQUEST_WAIT_MS,
				)
				.map((timer) => timer.delayMs),
		fireRebuild() {
			const live = timers.filter(
				(timer) => !timer.cancelled && timer.delayMs !== REQUEST_WAIT_MS,
			);
			expect(live.length).toBe(1);
			live[0].cancelled = true;
			return live[0].run();
		},
		fireDeadline() {
			const live = timers.filter(
				(timer) => !timer.cancelled && timer.delayMs === REQUEST_WAIT_MS,
			);
			expect(live.length).toBe(1);
			live[0].cancelled = true;
			return live[0].run();
		},
	};
}

function setup(accounts = 1) {
	const db = fakeDb();
	const clock = { t: T0 };
	const timers = manualScheduler();
	const config = JSON.stringify(mappingsFor(accounts));
	const handler = createPublicSubscriptionValueHandler(
		{ dbOps: db.dbOps } as unknown as APIContext,
		{ getConfig: () => config, now: () => clock.t, schedule: timers.schedule },
	);
	return { ...db, clock, timers, handler };
}

/** Fails the test, rather than hanging it, when `work` does not settle in time. */
async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`hung for ${ms} ms`)), ms);
	});
	try {
		return await Promise.race([work, late]);
	} finally {
		clearTimeout(timer);
	}
}

let spies: Array<{ mockRestore: () => void }> = [];
beforeEach(() => {
	spies = [
		spyOn(Logger.prototype, "warn").mockImplementation(() => undefined),
		spyOn(Logger.prototype, "info").mockImplementation(() => undefined),
		spyOn(Logger.prototype, "error").mockImplementation(() => undefined),
	];
});
afterEach(() => {
	for (const spy of spies) spy.mockRestore();
});
afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("public subscription value feed under a slow reader", () => {
	it("answers 70 s after a good build from the cached body, with no database call and fast", async () => {
		const { handler, clock, state, timers } = setup();
		expect((await handler()).status).toBe(200);
		const callsAfterBuild = state.calls;
		// The timer never ran (a starved or failed timer): the body is 70 s old.
		clock.t = T0 + 70_000;
		const started = performance.now();
		const response = await handler();
		const elapsed = performance.now() - started;
		expect(response.status).toBe(200);
		expect((await response.json()).generatedAt).toBe(T0);
		expect(state.calls).toBe(callsAfterBuild);
		expect(elapsed).toBeLessThan(100);
		// The rebuild is queued behind the response, not awaited by it.
		expect(timers.rebuildDelays()).toEqual([0]);
	});

	it("accepts a build whose aggregate read took 100 s, because its body is still within MAX_AGE_MS", async () => {
		const { handler, clock, state, timers } = setup();
		expect((await handler()).status).toBe(200);
		let finishRead: () => void = () => {};
		state.aggregate = () =>
			new Promise((done) => {
				finishRead = () => done([]);
			});
		clock.t = T0 + REBUILD_AHEAD_MS;
		const rebuilding = timers.fireRebuild();
		await flush();
		clock.t = T0 + REBUILD_AHEAD_MS + 100_000;
		finishRead();
		await rebuilding;
		const callsBefore = state.calls;
		const response = await handler();
		expect(response.status).toBe(200);
		expect((await response.json()).generatedAt).toBe(T0 + REBUILD_AHEAD_MS);
		// Served from the accepted build, not rebuilt by the request.
		expect(state.calls).toBe(callsBefore);
	});

	it("never has more than one aggregate read in flight across accounts", async () => {
		const { handler, state } = setup(5);
		state.aggregate = async () => {
			await wait(2);
			return [];
		};
		expect((await handler()).status).toBe(200);
		expect(state.aggregateCalls).toBe(5);
		expect(state.maxInFlight).toBe(1);
	});

	it("answers 503 within REQUEST_WAIT_MS when no body is servable, then serves the build once it lands", async () => {
		const { handler, clock, state, timers } = setup();
		let finishRead: () => void = () => {};
		state.aggregate = () =>
			new Promise((done) => {
				finishRead = () => done([]);
			});
		const request = handler();
		await flush();
		expect(REQUEST_WAIT_MS).toBeLessThan(5_000);
		await timers.fireDeadline();
		const response = await settlesWithin(request, 1_000);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "Unavailable" });
		// The build continues and, landing within MAX_AGE_MS, becomes the cache.
		clock.t = T0 + 90_000;
		finishRead();
		await flush();
		expect(timers.rebuildDelays()).toEqual([REBUILD_AHEAD_MS]);
		const callsBefore = state.calls;
		const next = await handler();
		expect(next.status).toBe(200);
		expect((await next.json()).generatedAt).toBe(T0);
		expect(state.calls).toBe(callsBefore);
	});

	it("backs off failed rebuilds 15, 30, 60 s up to a 300 s cap, and a success resets it", async () => {
		const { handler, clock, state, timers } = setup();
		expect((await handler()).status).toBe(200);
		state.fail = true;
		const delays: number[] = [];
		for (let i = 0; i < 8; i++) {
			clock.t += 60_000;
			await timers.fireRebuild();
			delays.push(...timers.rebuildDelays());
		}
		expect(delays).toEqual([
			15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000,
		]);
		state.fail = false;
		clock.t += 60_000;
		await timers.fireRebuild();
		expect(timers.rebuildDelays()).toEqual([REBUILD_AHEAD_MS]);
		state.fail = true;
		clock.t += 60_000;
		await timers.fireRebuild();
		expect(timers.rebuildDelays()).toEqual([15_000]);
	});

	it("never serves a body at or past MAX_AGE_MS", async () => {
		const { handler, clock, state } = setup();
		expect((await handler()).status).toBe(200);
		state.fail = true;
		clock.t = T0 + MAX_AGE_MS - 1;
		const young = await handler();
		expect(young.status).toBe(200);
		expect((await young.json()).generatedAt).toBe(T0);
		clock.t = T0 + MAX_AGE_MS;
		const old = await handler();
		expect(old.status).toBe(503);
		expect(await old.json()).toEqual({ error: "Unavailable" });
	});
});
