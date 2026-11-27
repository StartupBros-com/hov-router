import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseOperations as DatabaseOperationsType } from "@hov-router/database";

const temp = mkdtempSync(join(tmpdir(), "hov-router-window-read-"));
process.env.DATABASE_URL = "";
process.env.HOV_ROUTER_DB_PATH = join(temp, "isolated.db");
process.env.HOV_ROUTER_CONFIG_PATH = join(temp, "config.json");
const { DatabaseOperations } = await import("@hov-router/database");
const { readUsageWindows, valueOpenWindow, toUsageWindowRecord } = await import(
	"../usage-window-read"
);

describe("shared usage window read", () => {
	let db: DatabaseOperationsType;
	beforeEach(async () => {
		db = new DatabaseOperations(":memory:", { walMode: false });
		await db
			.getAdapter()
			.run(
				"INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)",
				["fixture", "private fixture", "anthropic", 100],
			);
	});
	afterEach(async () => {
		await db.dispose();
	});
	afterAll(() => {
		rmSync(temp, { recursive: true, force: true });
	});

	it("uses canonical live valuation and keeps private overdue-window behavior", async () => {
		const startedAt = Date.parse("2026-09-01T00:00:00Z");
		await db.openUsageWindow({
			accountId: "fixture",
			windowKey: "seven_day",
			startedAt,
			resetsAt: startedAt + 7000,
			grantType: "natural",
		});
		await db
			.getAdapter()
			.run(
				`INSERT INTO requests (id, timestamp, method, path, account_used, status_code, success, model, billing_type, input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens) VALUES ('fixture-request', ?, 'POST', '/v1/messages', 'fixture', 200, 1, 'gpt-5.6-terra', 'plan', 1000000, 0, 0, 0)`,
				[startedAt + 1000],
			);
		const open = await db.getOpenUsageWindow("fixture", "seven_day");
		if (!open) throw new Error("missing fixture window");
		const live = {
			openWindow: await valueOpenWindow(db, open, startedAt + 2000),
		};
		expect(live.openWindow?.valueSoFarUsd).toBe(2);
		expect(live.openWindow?.unpricedTokens).toBe(0);
		const privateResult = await readUsageWindows(
			db,
			"fixture",
			"seven_day",
			8,
			startedAt + 8000,
		);
		expect(privateResult.openWindow?.valueSoFarUsd).toBe(2);
		expect(privateResult.openWindow?.unpricedTokens).toBe(0);
		expect(privateResult.openWindow?.utilization).toBe(0);
		expect(privateResult.openWindow?.ageHours).toBe(8000 / 3_600_000);
	});

	it("keeps supplied private history unchanged and selects the first open row", async () => {
		const open = await db.openUsageWindow({
			accountId: "fixture",
			windowKey: "seven_day",
			startedAt: 200,
			resetsAt: 2000,
			grantType: "natural",
		});
		const closed = { ...open, id: "closed", closedAt: 900, valueUsd: 42 };
		const supplied = [open, closed];
		const result = await readUsageWindows(
			db,
			"fixture",
			"seven_day",
			1,
			1000,
			supplied,
		);
		expect(result.windows).toEqual([toUsageWindowRecord(closed)]);
		expect(result.openWindow?.id).toBe(open.id);
		expect(supplied).toEqual([open, closed]);
	});

	it("keeps backdated first observations in private history and never settles reads", async () => {
		// The public feed omits these (see public-subscription-value.test.ts); the
		// private Window Value view must keep showing them.
		const row = await db.openUsageWindow({
			accountId: "fixture",
			windowKey: "seven_day",
			startedAt: 50,
			resetsAt: 900,
			grantType: "first_observed",
		});
		const overdue = await readUsageWindows(db, "fixture", "seven_day", 8, 1000);
		expect(overdue.openWindow?.id).toBe(row.id);
		expect(overdue.openWindow?.grantType).toBe("first_observed");
		expect(
			(await db.getOpenUsageWindow("fixture", "seven_day"))?.closedAt,
		).toBeNull();
		await db.closeUsageWindow(row.id, {
			closedAt: 900,
			valueUsd: 1,
			inputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
			requestCount: 0,
			modelBreakdown: null,
			unpricedTokens: 0,
			projectionVersion: "fixture",
			pointsUsed: null,
			counterResets: null,
		});
		const closed = await readUsageWindows(db, "fixture", "seven_day", 8, 1600);
		expect(closed.openWindow).toBeNull();
		expect(closed.windows.map((window) => window.id)).toEqual([row.id]);
	});

	it("carries recorded limit points and counter resets into private history", async () => {
		const row = await db.openUsageWindow({
			accountId: "fixture",
			windowKey: "seven_day",
			startedAt: 10,
			resetsAt: 500,
			grantType: "natural",
		});
		await db.closeUsageWindow(row.id, {
			closedAt: 500,
			valueUsd: 1,
			inputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
			requestCount: 0,
			modelBreakdown: null,
			unpricedTokens: 0,
			projectionVersion: "fixture",
			pointsUsed: 230,
			counterResets: 2,
		});
		const result = await readUsageWindows(db, "fixture", "seven_day", 8, 1600);
		expect(result.windows[0]).toMatchObject({
			pointsUsed: 230,
			counterResets: 2,
		});
	});

	it("returns empty private history", async () => {
		expect(await readUsageWindows(db, "fixture", "seven_day", 8, 1000)).toEqual(
			{ windows: [], openWindow: null },
		);
	});
});
