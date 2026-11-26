import { Database } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { Config } from "@hov-router/config";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@hov-router/database";
import { usageCache } from "@hov-router/providers";
import type { AccountResponse, SessionStats } from "@hov-router/types";
import { createAccountsListHandler } from "../accounts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const WAIT_MS = 20;

function stats(requests: number): SessionStats {
	return {
		requests,
		inputTokens: requests * 10,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
		outputTokens: requests,
		planCostUsd: 0,
		apiCostUsd: 0,
	};
}

const never = <T>() => new Promise<T>(() => {});

describe("GET /api/accounts with a slow reader", () => {
	let sqlite: Database;
	let adapter: BunSqlAdapter;
	let now: number;
	let sessionReads: number;
	let readSessionStats: (
		accounts: Array<{ id: string; session_start: number | null }>,
	) => Promise<Map<string, SessionStats>>;

	const config = {
		getUsageThrottlingFiveHourEnabled: () => false,
		getUsageThrottlingWeeklyEnabled: () => false,
	} as unknown as Config;

	function makeHandler() {
		const dbOps = {
			getAdapter: () => adapter,
			getStatsRepository: () => ({
				getSessionStats: (
					accounts: Array<{ id: string; session_start: number | null }>,
				) => {
					sessionReads++;
					return readSessionStats(accounts);
				},
			}),
			getLatestUsageSnapshot: async () => null,
		};
		return createAccountsListHandler(dbOps as never, config, undefined, {
			slowReadWaitMs: WAIT_MS,
		});
	}

	async function list(handler: () => Promise<Response>) {
		const started = performance.now();
		const response = await handler();
		const elapsed = performance.now() - started;
		expect(response.status).toBe(200);
		const body = (await response.json()) as AccountResponse[];
		return {
			elapsed,
			byName: new Map(body.map((account) => [account.name, account])),
		};
	}

	async function addAccount(
		id: string,
		provider: string,
		sessionStart: number | null,
	) {
		await adapter.run(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token,
				expires_at, created_at, session_start)
			 VALUES (?, ?, ?, 'refresh', 'access', ?, 0, ?)`,
			[id, id, provider, NOW + HOUR, sessionStart],
		);
	}

	beforeEach(async () => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		runMigrations(sqlite);
		adapter = new BunSqlAdapter(sqlite);
		now = NOW;
		spyOn(Date, "now").mockImplementation(() => now);
		sessionReads = 0;
		readSessionStats = async () => new Map();
		await addAccount("claude-a", "anthropic", NOW - HOUR);
		await addAccount("claude-b", "anthropic", NOW - 2 * HOUR);
		await addAccount("gateway", "openai-compatible", null);
	});

	afterEach(() => {
		mock.restore();
		sqlite.close();
		usageCache.clear();
	});

	it("answers within its wait when the session read is stuck, and says the totals are unavailable rather than zero", async () => {
		readSessionStats = () => never();
		const { elapsed, byName } = await list(makeHandler());

		expect(elapsed).toBeLessThan(1_000);
		expect(byName.get("claude-a")).toMatchObject({
			sessionStats: null,
			sessionStatsAsOf: null,
			sessionStatsUnavailable: true,
		});
		// No session to read: nothing is missing.
		expect(byName.get("gateway")).toMatchObject({
			sessionStats: null,
			sessionStatsUnavailable: false,
		});
	});

	it("serves the last good totals with the time they were read while a later read is slow", async () => {
		const handler = makeHandler();
		readSessionStats = async () =>
			new Map([
				["claude-a", stats(5)],
				["claude-b", stats(9)],
			]);
		const first = await list(handler);
		expect(first.byName.get("claude-a")).toMatchObject({
			sessionStats: stats(5),
			sessionStatsAsOf: NOW,
			sessionStatsUnavailable: false,
		});

		now = NOW + 60_000;
		readSessionStats = () => never();
		const second = await list(handler);
		expect(second.elapsed).toBeLessThan(1_000);
		expect(second.byName.get("claude-b")).toMatchObject({
			sessionStats: stats(9),
			sessionStatsAsOf: NOW,
			sessionStatsUnavailable: false,
		});
	});

	it("does not carry an earlier session's totals into a new session", async () => {
		const handler = makeHandler();
		readSessionStats = async () =>
			new Map([
				["claude-a", stats(5)],
				["claude-b", stats(9)],
			]);
		await list(handler);

		now = NOW + 60_000;
		await adapter.run("UPDATE accounts SET session_start = ? WHERE id = ?", [
			now,
			"claude-b",
		]);
		readSessionStats = () => never();
		const { byName } = await list(handler);
		expect(byName.get("claude-a")?.sessionStats).toEqual(stats(5));
		expect(byName.get("claude-b")).toMatchObject({
			sessionStats: null,
			sessionStatsAsOf: null,
			sessionStatsUnavailable: true,
		});
	});

	it("keeps one session read running however many polls arrive", async () => {
		const handler = makeHandler();
		readSessionStats = () => never();
		for (let poll = 0; poll < 4; poll++) {
			now = NOW + poll * 60_000;
			await list(handler);
		}
		expect(sessionReads).toBe(1);
	});

	it("stops serving earlier totals once they pass the maximum age", async () => {
		const handler = makeHandler();
		readSessionStats = async () => new Map([["claude-a", stats(5)]]);
		await list(handler);

		now = NOW + 10 * 60_000;
		readSessionStats = () => never();
		const { byName } = await list(handler);
		expect(byName.get("claude-a")).toMatchObject({
			sessionStats: null,
			sessionStatsUnavailable: true,
		});
	});

	it("reports a session with no requests yet as read, not unavailable", async () => {
		readSessionStats = async () => new Map();
		const { byName } = await list(makeHandler());
		expect(byName.get("claude-a")).toMatchObject({
			sessionStats: null,
			sessionStatsAsOf: NOW,
			sessionStatsUnavailable: false,
		});
	});

	it("reports a failed session read as unavailable and still lists every account", async () => {
		readSessionStats = async () => {
			throw new Error("off-thread interactive reader busy");
		};
		const { byName } = await list(makeHandler());
		expect(byName.size).toBe(3);
		expect(byName.get("claude-a")?.sessionStatsUnavailable).toBe(true);
	});

	it("retries a failed Codex payload read on the next poll instead of remembering it as no payloads", async () => {
		await addAccount("codex-quiet", "codex", null);
		const handler = makeHandler();
		const payloadReads = spyOn(adapter, "getOffThread").mockImplementation(
			async () => {
				throw new Error("off-thread interactive reader busy");
			},
		);
		await list(handler);
		now = NOW + 10_000;
		await list(handler);
		expect(payloadReads).toHaveBeenCalledTimes(2);
	});

	it("does not overwrite usage the proxy recorded while a slow payload read was running", async () => {
		await addAccount("codex-quiet", "codex", null);
		await adapter.run(
			"INSERT INTO requests (id, timestamp, method, path, success, response_time_ms, failover_attempts, account_used) VALUES ('r1', ?, 'POST', '/v1/responses', 1, 10, 0, 'codex-quiet')",
			[NOW - 60_000],
		);
		await adapter.run(
			"INSERT INTO request_payloads (id, json, timestamp) VALUES ('r1', ?, ?)",
			[
				JSON.stringify({
					response: {
						status: 200,
						headers: {
							"x-codex-primary-window-minutes": "300",
							"x-codex-primary-used-percent": "10",
							"x-codex-primary-reset-at": String(NOW / 1000 + 3600),
						},
					},
					meta: { timestamp: NOW - 60_000 },
				}),
				NOW - 60_000,
			],
		);
		let releasePayloads: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			releasePayloads = resolve;
		});
		const getOffThread = adapter.getOffThread.bind(adapter);
		spyOn(adapter, "getOffThread").mockImplementation(async (...args) => {
			await held;
			return getOffThread(...(args as Parameters<typeof getOffThread>));
		});

		await list(makeHandler());
		// The proxy records fresher usage while the read is still running.
		const live = {
			five_hour: { utilization: 70, resets_at: null },
			seven_day: { utilization: 20, resets_at: null },
		};
		usageCache.set("codex-quiet", live as never);
		releasePayloads();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(usageCache.get("codex-quiet")).toEqual(live as never);
	});

	it("does not hold the response on a stuck Codex payload read, or start another each poll", async () => {
		await addAccount("codex-quiet", "codex", null);
		const handler = makeHandler();
		const payloadReads = spyOn(adapter, "getOffThread").mockImplementation(() =>
			never(),
		);

		const first = await list(handler);
		expect(first.elapsed).toBeLessThan(1_000);
		expect(first.byName.get("codex-quiet")?.usageData ?? null).toBeNull();

		now = NOW + 60_000;
		const second = await list(handler);
		expect(second.elapsed).toBeLessThan(1_000);
		expect(payloadReads).toHaveBeenCalledTimes(1);
	});
});
