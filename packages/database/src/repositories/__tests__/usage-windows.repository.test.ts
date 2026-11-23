import { Database } from "bun:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { DatabaseOperations } from "../../database-operations";
import { ensureSchema, runMigrations } from "../../migrations";
import { UsageHistoryRepository } from "../usage-history.repository";
import { UsageWindowsRepository } from "../usage-windows.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function makeRepo(db: Database): UsageWindowsRepository {
	return new UsageWindowsRepository(new BunSqlAdapter(db));
}

async function verifyBoundedListOptions(
	repo: UsageWindowsRepository,
	accountId: string,
	otherAccountId: string,
): Promise<void> {
	for (const [owner, windowKey, startedAt, closed] of [
		[accountId, "seven_day", 1_000, true],
		[accountId, "seven_day", 11_000, true],
		[accountId, "seven_day", 21_000, true],
		[accountId, "seven_day", 31_000, false],
		[otherAccountId, "seven_day", 41_000, true],
		[accountId, "five_hour", 51_000, true],
	] as const) {
		const window = await repo.openWindow({
			accountId: owner,
			windowKey,
			startedAt,
			resetsAt: startedAt + 5_000,
			grantType: "natural",
		});
		if (closed) {
			await repo.closeWindow(window.id, {
				closedAt: window.resetsAt,
				valueUsd: 1,
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
			});
		}
	}
	const filters = { accountId, windowKey: "seven_day" };
	const closed = await repo.listWindows({ ...filters, closedOnly: true });
	expect(closed.map((window) => window.startedAt)).toEqual([
		21_000, 11_000, 1_000,
	]);
	expect(closed.every((window) => window.closedAt !== null)).toBe(true);

	expect(
		(await repo.listWindows({ ...filters, limit: 1 })).map(
			(window) => window.startedAt,
		),
	).toEqual([31_000]);
	expect(await repo.listWindows({ ...filters, limit: 200 })).toHaveLength(4);
	for (const limit of [0, 201, 1.5]) {
		await expect(repo.listWindows({ ...filters, limit })).rejects.toThrow(
			"limit must be an integer between 1 and 200",
		);
	}

	expect(
		(await repo.listWindows({ ...filters, startedAtOrAfter: 11_000 })).map(
			(window) => window.startedAt,
		),
	).toEqual([31_000, 21_000, 11_000]);
	const combined = await repo.listWindows({
		...filters,
		closedOnly: true,
		limit: 2,
		startedAtOrAfter: 11_000,
	});
	expect(combined.map((window) => window.resetsAt)).toEqual([26_000, 16_000]);
	expect(combined.every((window) => window.accountId === accountId)).toBe(true);
	expect(combined.every((window) => window.windowKey === "seven_day")).toBe(
		true,
	);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("usage_windows schema", () => {
	it("creates the usage_windows table", () => {
		const db = makeDb();
		const row = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='usage_windows'",
			)
			.get() as { name: string } | null;
		expect(row?.name).toBe("usage_windows");
		db.close();
	});

	it("creates the unique idempotent-backfill index", () => {
		const db = makeDb();
		const row = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_windows_unique'",
			)
			.get() as { name: string } | null;
		expect(row?.name).toBe("idx_usage_windows_unique");
		db.close();
	});

	it("creates the closed_at lookup index", () => {
		const db = makeDb();
		const row = db
			.query(
				"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_windows_closed'",
			)
			.get() as { name: string } | null;
		expect(row?.name).toBe("idx_usage_windows_closed");
		db.close();
	});
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("UsageWindowsRepository", () => {
	describe("openWindow / getOpenWindow", () => {
		it("opens a new window with the given grant type and zeroed peak utilization", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const window = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			expect(window.accountId).toBe("acc1");
			expect(window.windowKey).toBe("five_hour");
			expect(window.startedAt).toBe(1000);
			expect(window.resetsAt).toBe(6000);
			expect(window.closedAt).toBeNull();
			expect(window.grantType).toBe("natural");
			expect(window.peakUtilization).toBe(0);
			expect(window.first100At).toBeNull();
			expect(window.valueUsd).toBeNull();
			db.close();
		});

		it("is idempotent on (account_id, window_key, resets_at): a second open returns the same row", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const first = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			const second = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "early_reset",
			});
			// Losing insert is discarded; the surviving row keeps the original id
			// and grant_type from the first open.
			expect(second.id).toBe(first.id);
			expect(second.grantType).toBe("natural");
		});

		it("getOpenWindow returns null when no open window exists", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const result = await repo.getOpenWindow("acc1", "five_hour");
			expect(result).toBeNull();
			db.close();
		});

		it("getOpenWindow finds the open window and ignores closed ones", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const closed = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			await repo.closeWindow(closed.id, {
				closedAt: 6000,
				valueUsd: 1.5,
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
			});
			const open = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 6000,
				resetsAt: 11000,
				grantType: "natural",
			});
			const result = await repo.getOpenWindow("acc1", "five_hour");
			expect(result?.id).toBe(open.id);
			db.close();
		});
	});

	describe("recordUtilization", () => {
		it("raises peak_utilization only when the new reading is higher", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const window = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			await repo.recordUtilization(window.id, 40, 1500);
			let current = await repo.getOpenWindow("acc1", "five_hour");
			expect(current?.peakUtilization).toBe(40);

			// Lower reading does not regress the peak.
			await repo.recordUtilization(window.id, 20, 2000);
			current = await repo.getOpenWindow("acc1", "five_hour");
			expect(current?.peakUtilization).toBe(40);

			// Higher reading raises it again.
			await repo.recordUtilization(window.id, 75, 2500);
			current = await repo.getOpenWindow("acc1", "five_hour");
			expect(current?.peakUtilization).toBe(75);
			db.close();
		});

		it("sets first_100_at exactly once, on the first reading >= 100", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const window = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			await repo.recordUtilization(window.id, 60, 1500);
			let current = await repo.getOpenWindow("acc1", "five_hour");
			expect(current?.first100At).toBeNull();

			await repo.recordUtilization(window.id, 100, 2000);
			current = await repo.getOpenWindow("acc1", "five_hour");
			expect(current?.first100At).toBe(2000);
			expect(current?.peakUtilization).toBe(100);

			// A later reading (even another >=100 one) must not move first_100_at.
			await repo.recordUtilization(window.id, 105, 3000);
			current = await repo.getOpenWindow("acc1", "five_hour");
			expect(current?.first100At).toBe(2000);
			expect(current?.peakUtilization).toBe(105);
			db.close();
		});
	});

	describe("closeWindow", () => {
		it("round-trips closedAt and aggregates", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const window = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			const closed = await repo.closeWindow(window.id, {
				closedAt: 6000,
				valueUsd: 12.34,
				inputTokens: 1000,
				cacheReadInputTokens: 200,
				cacheCreationInputTokens: 50,
				outputTokens: 500,
				requestCount: 7,
				modelBreakdown: { "claude-opus-4": { requests: 7 } },
				unpricedTokens: 0,
				projectionVersion: "v1",
				pointsUsed: null,
				counterResets: null,
			});
			expect(closed).toBe(true);

			const rows = await repo.listWindows({ accountId: "acc1" });
			expect(rows).toHaveLength(1);
			const row = rows[0];
			expect(row.closedAt).toBe(6000);
			expect(row.valueUsd).toBe(12.34);
			expect(row.inputTokens).toBe(1000);
			expect(row.cacheReadInputTokens).toBe(200);
			expect(row.cacheCreationInputTokens).toBe(50);
			expect(row.outputTokens).toBe(500);
			expect(row.requestCount).toBe(7);
			expect(row.modelBreakdown).toEqual({ "claude-opus-4": { requests: 7 } });
			expect(row.unpricedTokens).toBe(0);
			expect(row.projectionVersion).toBe("v1");
			db.close();
		});

		it("returns false and does not overwrite an already-closed window", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			const window = await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			await repo.closeWindow(window.id, {
				closedAt: 6000,
				valueUsd: 1,
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
			});
			const secondClose = await repo.closeWindow(window.id, {
				closedAt: 9999,
				valueUsd: 999,
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
			});
			expect(secondClose).toBe(false);

			const rows = await repo.listWindows({ accountId: "acc1" });
			expect(rows[0].closedAt).toBe(6000);
			expect(rows[0].valueUsd).toBe(1);
			db.close();
		});
	});

	describe("listWindows", () => {
		it("supports closedOnly, inclusive startedAtOrAfter, bounded limits, and combined filters", async () => {
			const db = makeDb();
			try {
				await verifyBoundedListOptions(
					makeRepo(db),
					"bounded-acc",
					"other-acc",
				);
			} finally {
				db.close();
			}
		});

		it("filters by accountId and windowKey, ordered by resets_at desc", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 11000,
				resetsAt: 16000,
				grantType: "natural",
			});
			await repo.openWindow({
				accountId: "acc1",
				windowKey: "seven_day",
				startedAt: 1000,
				resetsAt: 20000,
				grantType: "natural",
			});
			await repo.openWindow({
				accountId: "acc2",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});

			const rows = await repo.listWindows({
				accountId: "acc1",
				windowKey: "five_hour",
			});
			expect(rows.map((r) => r.resetsAt)).toEqual([16000, 6000]);
			expect(rows.every((r) => r.accountId === "acc1")).toBe(true);
			db.close();
		});

		it("filters by sinceMs and lists across all accounts when accountId omitted", async () => {
			const db = makeDb();
			const repo = makeRepo(db);
			await repo.openWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			await repo.openWindow({
				accountId: "acc2",
				windowKey: "five_hour",
				startedAt: 11000,
				resetsAt: 16000,
				grantType: "natural",
			});

			const rows = await repo.listWindows({ sinceMs: 10000 });
			expect(rows).toHaveLength(1);
			expect(rows[0].accountId).toBe("acc2");
			db.close();
		});
	});
});

// ---------------------------------------------------------------------------
// Facade smoke test: exercise the usage-windows methods through a real
// in-memory DatabaseOperations, mirroring the usage-history facade tests.
// ---------------------------------------------------------------------------

describe("DatabaseOperations usage-windows facade", () => {
	it("round-trips open / recordUtilization / close through the facade", async () => {
		const dbOps = new DatabaseOperations(":memory:", { walMode: false });
		try {
			const window = await dbOps.openUsageWindow({
				accountId: "acc1",
				windowKey: "five_hour",
				startedAt: 1000,
				resetsAt: 6000,
				grantType: "natural",
			});
			await dbOps.recordUsageWindowUtilization(window.id, 100, 2000);
			const open = await dbOps.getOpenUsageWindow("acc1", "five_hour");
			expect(open?.peakUtilization).toBe(100);
			expect(open?.first100At).toBe(2000);

			const closed = await dbOps.closeUsageWindow(window.id, {
				closedAt: 6000,
				valueUsd: 3.5,
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
			});
			expect(closed).toBe(true);

			const rows = await dbOps.listUsageWindows({ accountId: "acc1" });
			expect(rows).toHaveLength(1);
			expect(rows[0].valueUsd).toBe(3.5);
		} finally {
			await dbOps.dispose();
		}
	});
});

describe("UsageWindowsRepository generation fences", () => {
	it("rejects stale-generation opens, utilization, and closes while permitting the replacement generation", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		const accountId = "generation-fence-account";
		const generationA = 100;
		const generationB = 200;
		db.run("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)", [
			accountId,
			"generation A",
			generationA,
		]);
		const existing = await repo.openWindow({
			accountId,
			windowKey: "seven_day",
			startedAt: 1_000,
			resetsAt: 7_000,
			grantType: "natural",
		});

		db.run("DELETE FROM accounts WHERE id = ?", [accountId]);
		db.run("INSERT INTO accounts (id, name, created_at) VALUES (?, ?, ?)", [
			accountId,
			"generation B",
			generationB,
		]);

		const staleOpen = await repo.openWindow(
			{
				accountId,
				windowKey: "seven_day",
				startedAt: 7_000,
				resetsAt: 14_000,
				grantType: "natural",
			},
			generationA,
		);
		expect(staleOpen).toBeNull();
		await repo.recordUtilization(existing.id, 90, 2_000, generationA);
		expect(
			(await repo.getOpenWindow(accountId, "seven_day"))?.peakUtilization,
		).toBe(0);
		expect(
			await repo.closeWindow(
				existing.id,
				{
					closedAt: 7_000,
					valueUsd: 1,
					inputTokens: 1,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					outputTokens: 0,
					requestCount: 1,
					modelBreakdown: null,
					unpricedTokens: 0,
					projectionVersion: "v1",
					pointsUsed: 42,
					counterResets: 2,
				},
				generationA,
			),
		).toBe(false);
		const afterStaleClose = await repo.getOpenWindow(accountId, "seven_day");
		expect(afterStaleClose?.closedAt).toBeNull();
		expect(afterStaleClose?.pointsUsed).toBeNull();
		expect(afterStaleClose?.counterResets).toBeNull();

		await repo.recordUtilization(existing.id, 90, 2_000, generationB);
		expect(
			(await repo.getOpenWindow(accountId, "seven_day"))?.peakUtilization,
		).toBe(90);
		expect(
			await repo.closeWindow(
				existing.id,
				{
					closedAt: 7_000,
					valueUsd: 1,
					inputTokens: 1,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					outputTokens: 0,
					requestCount: 1,
					modelBreakdown: null,
					unpricedTokens: 0,
					projectionVersion: "v1",
					pointsUsed: 90,
					counterResets: 0,
				},
				generationB,
			),
		).toBe(true);
		const closedByReplacement = (await repo.listWindows({ accountId })).find(
			(window) => window.id === existing.id,
		);
		expect(closedByReplacement?.pointsUsed).toBe(90);
		expect(closedByReplacement?.counterResets).toBe(0);
		const replacementOpen = await repo.openWindow(
			{
				accountId,
				windowKey: "seven_day",
				startedAt: 7_000,
				resetsAt: 14_000,
				grantType: "natural",
			},
			generationB,
		);
		expect(replacementOpen?.accountId).toBe(accountId);
		db.close();
	});
});

// ---------------------------------------------------------------------------
// Re-valuation queries (SQLite; the PG equivalents run in the live suite)
// ---------------------------------------------------------------------------

describe("UsageWindowsRepository re-valuation", () => {
	const closeInput = (projectionVersion: string | null, valueUsd = 1) => ({
		closedAt: 6000,
		valueUsd,
		inputTokens: 1,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 0,
		requestCount: 1,
		modelBreakdown: { m: { requestCount: 1 } } as Record<string, unknown>,
		unpricedTokens: 0,
		projectionVersion,
		pointsUsed: null,
		counterResets: null,
	});
	const revalue = {
		valueUsd: 2,
		modelBreakdown: { m: { requestCount: 1, valueUsd: 2 } } as Record<
			string,
			unknown
		>,
		unpricedTokens: 5,
		projectionVersion: "v2",
	};

	async function seed(
		repo: UsageWindowsRepository,
		key: string,
		version: string | null | "open",
	) {
		const w = await repo.openWindow({
			accountId: "acc1",
			windowKey: key,
			startedAt: 1000,
			resetsAt: 6000,
			grantType: "natural",
		});
		if (version !== "open") await repo.closeWindow(w.id, closeInput(version));
		return w;
	}

	it("lists only closed windows with a breakdown whose version differs (NULL counts)", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		const old = await seed(repo, "a", "v1");
		const nul = await seed(repo, "b", null);
		await seed(repo, "c", "v2");
		const openWindow = await seed(repo, "d", "open");
		db.run(
			"UPDATE usage_windows SET model_breakdown = '{\"m\":{}}', projection_version = 'v1' WHERE id = ?",
			[openWindow.id],
		);
		const noBreakdown = await repo.openWindow({
			accountId: "acc1",
			windowKey: "e",
			startedAt: 1000,
			resetsAt: 6000,
			grantType: "natural",
		});
		await repo.closeWindow(noBreakdown.id, {
			...closeInput("v1"),
			modelBreakdown: null,
		});
		const listing = await repo.listClosedWindowsNotAtProjectionVersion("v2");
		expect(listing.windows.map((r) => r.id).sort()).toEqual(
			[old.id, nul.id].sort(),
		);
		expect(listing.unreadable).toEqual([]);
		db.close();
	});

	it("reports rows with an unreadable breakdown instead of failing the listing", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		const badJson = await seed(repo, "a", "v1");
		const notObject = await seed(repo, "b", "v1");
		const good = await seed(repo, "c", "v1");
		db.run("UPDATE usage_windows SET model_breakdown = ? WHERE id = ?", [
			"{not json",
			badJson.id,
		]);
		db.run("UPDATE usage_windows SET model_breakdown = ? WHERE id = ?", [
			"[1]",
			notObject.id,
		]);
		const listing = await repo.listClosedWindowsNotAtProjectionVersion("v2");
		expect(listing.windows.map((r) => r.id)).toEqual([good.id]);
		expect(listing.unreadable).toEqual([
			{
				id: badJson.id,
				reason: "usage window model_breakdown contains invalid JSON",
			},
			{
				id: notObject.id,
				reason: "usage window model_breakdown must be a JSON object",
			},
		]);
		db.close();
	});

	it("revalueClosedWindow applies when the stored version matches, including NULL", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		const a = await seed(repo, "a", "v1");
		const b = await seed(repo, "b", null);
		expect(await repo.revalueClosedWindow(a.id, revalue, "v1")).toBe(true);
		expect(await repo.revalueClosedWindow(b.id, revalue, null)).toBe(true);
		const rows = await repo.listWindows({});
		for (const r of rows) {
			expect(r.valueUsd).toBe(2);
			expect(r.unpricedTokens).toBe(5);
			expect(r.projectionVersion).toBe("v2");
			expect(r.closedAt).toBe(6000);
			expect(r.inputTokens).toBe(1);
		}
		db.close();
	});

	it("revalueClosedWindow refuses a stale expected version and an open window", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		const a = await seed(repo, "a", "v1");
		const open = await seed(repo, "d", "open");
		expect(await repo.revalueClosedWindow(a.id, revalue, "other")).toBe(false);
		expect(await repo.revalueClosedWindow(a.id, revalue, null)).toBe(false);
		expect(await repo.revalueClosedWindow(open.id, revalue, null)).toBe(false);
		const rows = await repo.listWindows({});
		expect(rows.find((r) => r.id === a.id)?.valueUsd).toBe(1);
		expect(rows.find((r) => r.id === open.id)?.valueUsd).toBeNull();
		db.close();
	});
});

// ---------------------------------------------------------------------------
// Limit cycles: points used and counter resets per window
// ---------------------------------------------------------------------------

describe("usage window limit cycles", () => {
	const TOLERANCE = 120_000;
	const baseClose = {
		valueUsd: 1,
		inputTokens: 1,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 0,
		requestCount: 1,
		modelBreakdown: null,
		unpricedTokens: 0,
		projectionVersion: "v1",
	};

	async function snapshot(
		db: Database,
		accountId: string,
		at: number,
		utilization: number,
		resetsAtMs: number | null,
		opts: { windowKey?: string; active?: boolean } = {},
	): Promise<void> {
		await new UsageHistoryRepository(new BunSqlAdapter(db)).recordSnapshot(
			accountId,
			[
				{
					windowKey: opts.windowKey ?? "seven_day",
					utilization,
					resetsAtMs,
					scope: "account",
					modelFamily: null,
					active: opts.active ?? true,
				},
			],
			at,
		);
	}

	function open(
		repo: UsageWindowsRepository,
		startedAt: number,
		resetsAt = 9000,
	) {
		return repo.openWindow({
			accountId: "acc1",
			windowKey: "seven_day",
			startedAt,
			resetsAt,
			grantType: "natural",
		});
	}

	it("round-trips the two fields through close and listing", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		const window = await open(repo, 1000);
		expect(window.pointsUsed).toBeNull();
		expect(window.counterResets).toBeNull();
		await repo.closeWindow(window.id, {
			...baseClose,
			closedAt: 9000,
			pointsUsed: 130.5,
			counterResets: 1,
		});
		const [row] = await repo.listWindows({ accountId: "acc1" });
		expect(row.pointsUsed).toBe(130.5);
		expect(row.counterResets).toBe(1);
		db.close();
	});

	it("recordLimitCycles writes once, never overwrites, never touches an open window", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		const window = await open(repo, 1000);
		expect(
			await repo.recordLimitCycles(window.id, {
				pointsUsed: 10,
				counterResets: 0,
			}),
		).toBe(false);
		expect(
			(await repo.getOpenWindow("acc1", "seven_day"))?.pointsUsed,
		).toBeNull();

		await repo.closeWindow(window.id, {
			...baseClose,
			closedAt: 9000,
			pointsUsed: null,
			counterResets: null,
		});
		expect(
			await repo.recordLimitCycles(window.id, {
				pointsUsed: 100,
				counterResets: 0,
			}),
		).toBe(true);
		expect(
			await repo.recordLimitCycles(window.id, {
				pointsUsed: 250,
				counterResets: 2,
			}),
		).toBe(false);
		const [row] = await repo.listWindows({ accountId: "acc1" });
		expect(row.pointsUsed).toBe(100);
		expect(row.counterResets).toBe(0);
		db.close();
	});

	it("recordLimitCycles never overwrites a recorded zero", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		const window = await open(repo, 1000);
		await repo.closeWindow(window.id, {
			...baseClose,
			closedAt: 9000,
			pointsUsed: 0,
			counterResets: 0,
		});
		expect(
			await repo.recordLimitCycles(window.id, {
				pointsUsed: 40,
				counterResets: 1,
			}),
		).toBe(false);
		db.close();
	});

	it("lists only closed, unmeasured windows that start at or after the oldest snapshot", async () => {
		const db = makeDb();
		const repo = makeRepo(db);
		await snapshot(db, "acc1", 5000, 10, 20_000);
		const tooOld = await open(repo, 4999, 10_000);
		const retained = await open(repo, 5000, 20_000);
		const measured = await open(repo, 6000, 30_000);
		const stillOpen = await open(repo, 7000, 40_000);
		const noSnapshots = await repo.openWindow({
			accountId: "acc2",
			windowKey: "seven_day",
			startedAt: 6000,
			resetsAt: 50_000,
			grantType: "natural",
		});
		for (const [w, points] of [
			[tooOld, null],
			[retained, null],
			[measured, 55],
			[noSnapshots, null],
		] as const) {
			await repo.closeWindow(w.id, {
				...baseClose,
				closedAt: 8000,
				pointsUsed: points,
				counterResets: points === null ? null : 0,
			});
		}
		const listing = await repo.listClosedWindowsMissingLimitCycles();
		expect(listing.windows.map((w) => w.id)).toEqual([retained.id]);
		expect(listing.unreadable).toEqual([]);
		expect(stillOpen.closedAt).toBeNull();
		db.close();
	});

	it("getWindowReadings keeps only the window's own active readings in range, in order", async () => {
		const db = makeDb();
		const history = new UsageHistoryRepository(new BunSqlAdapter(db));
		const resets = 100_000;
		await snapshot(db, "acc1", 1000, 10, resets);
		await snapshot(db, "acc1", 2000, 20, resets + 5_000); // jitter: same window
		await snapshot(db, "acc1", 2000, 21, resets); // same timestamp, later append
		await snapshot(db, "acc1", 3000, 30, resets + TOLERANCE); // boundary: kept
		await snapshot(db, "acc1", 3500, 99, resets + TOLERANCE + 1); // next window
		await snapshot(db, "acc1", 3600, 98, null); // no resets_at
		await snapshot(db, "acc1", 3700, 97, resets, { active: false });
		await snapshot(db, "acc1", 3800, 96, resets, { windowKey: "five_hour" });
		await snapshot(db, "acc2", 3900, 95, resets); // other account
		await snapshot(db, "acc1", 999, 94, resets); // before range
		await snapshot(db, "acc1", 4001, 93, resets); // after range
		await snapshot(db, "acc1", 4000, 40, resets); // range end inclusive
		expect(
			await history.getWindowReadings(
				"acc1",
				"seven_day",
				resets,
				1000,
				4000,
				TOLERANCE,
			),
		).toEqual([10, 20, 21, 30, 40]);
		db.close();
	});
});

describe("usage_windows limit-cycle migration", () => {
	it("adds both columns to an existing table and leaves existing rows NULL", () => {
		const db = makeDb();
		db.run("ALTER TABLE usage_windows DROP COLUMN points_used");
		db.run("ALTER TABLE usage_windows DROP COLUMN counter_resets");
		db.run(
			`INSERT INTO usage_windows (id, account_id, window_key, started_at, resets_at, closed_at, grant_type, peak_utilization)
			 VALUES ('old', 'acc1', 'seven_day', 1000, 9000, 9000, 'natural', 50)`,
		);
		const columns = () =>
			(
				db.prepare("PRAGMA table_info(usage_windows)").all() as {
					name: string;
				}[]
			).map((c) => c.name);
		expect(columns()).not.toContain("points_used");
		expect(columns()).not.toContain("counter_resets");

		runMigrations(db);

		expect(columns()).toEqual(
			expect.arrayContaining(["points_used", "counter_resets"]),
		);
		const row = db
			.prepare(
				"SELECT points_used, counter_resets FROM usage_windows WHERE id = 'old'",
			)
			.get() as { points_used: number | null; counter_resets: number | null };
		expect(row.points_used).toBeNull();
		expect(row.counter_resets).toBeNull();
		runMigrations(db);
		db.close();
	});
});

describe("listEarlyResetCandidates", () => {
	it("reads on the bulk reader, off the main thread (#991)", async () => {
		// The member-notice pass runs this scan every minute. On the main
		// connection its uncached pages stopped the event loop on a busy disk.
		const db = makeDb();
		const adapter = new BunSqlAdapter(db);
		const repo = new UsageWindowsRepository(adapter);
		db.run(
			"INSERT INTO accounts (id,name,provider,created_at) VALUES ('acc1','acc1','anthropic',0)",
		);
		await repo.openWindow({
			accountId: "acc1",
			windowKey: "seven_day",
			startedAt: 5000,
			resetsAt: 5000 + 7 * 86_400_000,
			grantType: "early_reset",
		});
		const bulkSql: string[] = [];
		adapter.setOffThreadReader({
			all: async <R>(sql: string, params: unknown[] = []) => {
				bulkSql.push(sql);
				return db.query(sql).all(...(params as never[])) as R[];
			},
			get: async () => {
				throw new Error("unexpected get");
			},
		});
		adapter.setOffThreadReader(
			{
				all: async () => {
					throw new Error("interactive reader used");
				},
				get: async () => {
					throw new Error("interactive reader used");
				},
			},
			"interactive",
		);
		const query = spyOn(adapter, "query");
		try {
			expect(await repo.listEarlyResetCandidates(0)).toEqual([
				{
					accountId: "acc1",
					provider: "anthropic",
					startedAt: 5000,
					previousClosedAt: null,
					previousStartedAt: null,
				},
			]);
			expect(bulkSql).toHaveLength(1);
			expect(bulkSql[0]).toContain("grant_type = 'early_reset'");
			expect(query).not.toHaveBeenCalled();
		} finally {
			db.close();
		}
	});
});
