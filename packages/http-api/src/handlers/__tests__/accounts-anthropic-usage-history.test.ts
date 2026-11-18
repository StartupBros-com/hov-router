import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { usageCache } from "@better-ccflare/providers";
import type { AccountResponse } from "@better-ccflare/types";
import { createAccountsListHandler } from "../accounts";

/**
 * After a restart (until the first usage poll) or a usage-fetch outage longer
 * than the cache TTL, an Anthropic account has no cached reading. The accounts
 * list then falls back to the last stored usage_snapshots row, so a spent
 * account still reads "usage_exhausted" instead of its stored header status.
 */

const ACCOUNT_ID = "anthropic-acct";
const DAY = 24 * 60 * 60 * 1000;
const CONFIG = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
} as unknown as Config;

type Snapshot = {
	accountId: string;
	timestamp: number;
	windowKey: string;
	utilization: number;
	resetsAt: number | null;
};

type Usage = {
	five_hour: { utilization: number | null };
	seven_day: { utilization: number | null };
	seven_day_fable?: { utilization: number | null };
} | null;

describe("GET /api/accounts — Anthropic usage recovery from history", () => {
	let sqlite: Database;
	let adapter: BunSqlAdapter;
	let reads: string[];

	beforeEach(async () => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		runMigrations(sqlite);
		adapter = new BunSqlAdapter(sqlite);
		reads = [];
		usageCache.delete(ACCOUNT_ID);
		await adapter.run(
			`INSERT INTO accounts (
				id, name, provider, refresh_token, access_token, expires_at, created_at,
				rate_limit_status
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				ACCOUNT_ID,
				"Claude 1",
				"anthropic",
				"refresh-token",
				"access-token",
				Date.now() + 3_600_000,
				Date.now(),
				"allowed_warning",
			],
		);
	});

	afterEach(() => {
		usageCache.delete(ACCOUNT_ID);
		sqlite.close();
	});

	function snap(
		windowKey: string,
		utilization: number,
		resetsAt: number | null,
	): Snapshot {
		return {
			accountId: ACCOUNT_ID,
			timestamp: Date.now() - 60_000,
			windowKey,
			utilization,
			resetsAt,
		};
	}

	function makeHandler(snapshots: Snapshot[], failRead = false) {
		const dbOps = {
			getAdapter: () => adapter,
			getStatsRepository: () => ({
				getSessionStats: async () => new Map(),
			}),
			getLatestUsageSnapshot: async (accountId: string, windowKey: string) => {
				reads.push(windowKey);
				if (failRead) throw new Error("reader busy");
				return (
					snapshots.find(
						(s) => s.accountId === accountId && s.windowKey === windowKey,
					) ?? null
				);
			},
		};
		return createAccountsListHandler(dbOps as never, CONFIG);
	}

	async function readAccount(
		handler: () => Promise<Response>,
	): Promise<AccountResponse | undefined> {
		const response = await handler();
		const accounts = (await response.json()) as AccountResponse[];
		return accounts.find((a) => a.id === ACCOUNT_ID);
	}

	it("rebuilds usage from the stored weekly snapshot and reports usage_exhausted", async () => {
		const account = await readAccount(
			makeHandler([
				snap("seven_day", 100, Date.now() + 2 * DAY),
				snap("seven_day_fable", 40, Date.now() + 2 * DAY),
			]),
		);

		const usage = account?.usageData as Usage;
		expect(usage?.seven_day.utilization).toBe(100);
		expect(usage?.seven_day_fable?.utilization).toBe(40);
		// five_hour is not stored: unknown, not zero.
		expect(usage?.five_hour.utilization).toBeNull();
		expect(account?.usageUtilization).toBe(100);
		expect(account?.rateLimitStatus.startsWith("usage_exhausted")).toBe(true);
	});

	it("prefers a fresh cache entry and does not read the snapshot", async () => {
		usageCache.set(ACCOUNT_ID, {
			five_hour: {
				utilization: 10,
				resets_at: new Date(Date.now() + 3_600_000).toISOString(),
			},
			seven_day: {
				utilization: 20,
				resets_at: new Date(Date.now() + DAY).toISOString(),
			},
		} as never);

		const account = await readAccount(
			makeHandler([snap("seven_day", 100, Date.now() + 2 * DAY)]),
		);

		expect((account?.usageData as Usage)?.seven_day.utilization).toBe(20);
		expect(reads).toEqual([]);
		expect(account?.rateLimitStatus.startsWith("usage_exhausted")).toBe(false);
	});

	it("leaves usage null when nothing was ever stored", async () => {
		const account = await readAccount(makeHandler([]));
		expect(account?.usageData).toBeNull();
		expect(account?.usageUtilization).toBeNull();
		expect(account?.rateLimitStatus.startsWith("usage_exhausted")).toBe(false);
	});

	it("leaves usage null and still answers when the snapshot read fails", async () => {
		const account = await readAccount(makeHandler([], true));
		expect(account?.usageData).toBeNull();
	});

	it("never writes the rebuilt reading back to the usage cache", async () => {
		await readAccount(makeHandler([snap("seven_day", 100, Date.now() + DAY)]));
		expect(usageCache.get(ACCOUNT_ID)).toBeNull();
	});

	it("does not report exhaustion from a window whose stored reset has passed", async () => {
		const account = await readAccount(
			makeHandler([snap("seven_day", 100, Date.now() - 60_000)]),
		);
		expect(account?.usageData).toBeNull();
		expect(account?.usageUtilization).toBeNull();
		expect(account?.rateLimitStatus.startsWith("usage_exhausted")).toBe(false);
	});

	it("drops only the expired window and keeps a live one", async () => {
		const account = await readAccount(
			makeHandler([
				snap("seven_day", 100, Date.now() - 60_000),
				snap("seven_day_fable", 55, Date.now() + DAY),
			]),
		);
		const usage = account?.usageData as Usage;
		expect(usage?.seven_day.utilization).toBeNull();
		expect(usage?.seven_day_fable?.utilization).toBe(55);
	});
});
