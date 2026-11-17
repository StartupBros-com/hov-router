import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { normalizeProviderUsageWindows } from "@better-ccflare/core";
import type { CanonicalUsageWindow } from "@better-ccflare/types";
import { DatabaseOperations } from "../database-operations";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CREATED_AT = 1_700_000_000_000;
const NOW = 1_800_000_000_000;
const WEEK_RESET = NOW + 4 * DAY;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Usage readings as the poller normalizes them. Each starts from the recorded
 * live Anthropic shape (flat five_hour / seven_day plus a limits[] list; see
 * the "live Anthropic payload shape" fixture in
 * packages/proxy/src/handlers/__tests__/usage-throttling.test.ts), trimmed to
 * the fields the normalizer reads. Every per-model row added here is an edit:
 * nobody has recorded a spent per-model limit.
 */
function reading(
	scoped: { percent: number; reset: number | null } | null,
	model = "Opus",
): CanonicalUsageWindow[] {
	const limits: unknown[] = [
		{
			kind: "session",
			percent: 6,
			resets_at: iso(NOW + 3 * HOUR),
			scope: null,
			is_active: true,
		},
		{
			kind: "weekly_all",
			percent: 2,
			resets_at: iso(WEEK_RESET),
			scope: null,
			is_active: true,
		},
	];
	if (scoped) {
		limits.push({
			kind: "weekly_scoped",
			percent: scoped.percent,
			resets_at: scoped.reset === null ? null : iso(scoped.reset),
			scope: { model: { id: null, display_name: model }, surface: null },
			is_active: true,
		});
	}
	return normalizeProviderUsageWindows(
		{
			limits,
			five_hour: { utilization: 6, resets_at: iso(NOW + 3 * HOUR) },
			seven_day: { utilization: 2, resets_at: iso(WEEK_RESET) },
			spend: { enabled: false },
		},
		"anthropic",
	);
}
const opusSpent = () => reading({ percent: 100, reset: WEEK_RESET });

let dbOps: DatabaseOperations;

async function seed(
	id: string,
	fields: {
		provider?: string;
		switchOn?: boolean;
		paused?: boolean;
		pauseReason?: string | null;
		billedAt?: number | null;
		billedFamily?: string | null;
	} = {},
) {
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, created_at, auto_pause_on_overage_enabled, paused, pause_reason, overage_billed_at, overage_billed_family)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			id,
			fields.provider ?? "anthropic",
			CREATED_AT,
			fields.switchOn === false ? 0 : 1,
			fields.paused ? 1 : 0,
			fields.pauseReason ?? null,
			fields.billedAt ?? null,
			fields.billedFamily ?? null,
		],
	);
}

const inputs = (id: string) => dbOps.getExtraUsageHoldInputs(id);
const snapshotCount = async (id: string) =>
	(
		await dbOps
			.getAdapter()
			.get<{ n: number }>(
				"SELECT COUNT(*) AS n FROM usage_snapshots WHERE account_id = ?",
				[id],
			)
	)?.n ?? 0;

beforeEach(() => {
	dbOps = new DatabaseOperations(":memory:", { walMode: false });
});
afterEach(async () => {
	await dbOps.dispose();
});

describe("a usage reading updates the stored holds", () => {
	it("a reading with weekly Opus spent stores an Opus hold, and history is still written", async () => {
		await seed("a");
		await dbOps.recordUsageSnapshot("a", opusSpent(), NOW, CREATED_AT);
		expect((await inputs("a"))?.holds).toEqual({
			readingAt: NOW,
			holds: [
				{
					windowKey: "seven_day_opus",
					scope: "family",
					modelFamily: "opus",
					resetsAtMs: WEEK_RESET,
					startedAt: NOW,
				},
			],
		});
		expect(await snapshotCount("a")).toBe(3);
	});

	it("a later reading below 100 ends the stored hold", async () => {
		await seed("a");
		await dbOps.recordUsageSnapshot("a", opusSpent(), NOW);
		await dbOps.recordUsageSnapshot(
			"a",
			reading({ percent: 40, reset: WEEK_RESET }),
			NOW + HOUR,
		);
		expect((await inputs("a"))?.holds).toEqual({
			readingAt: NOW + HOUR,
			holds: [],
		});
	});

	it("a spent limit with no reset time, or one already past, stores no hold", async () => {
		await seed("no-reset");
		await seed("past-reset");
		await dbOps.recordUsageSnapshot(
			"no-reset",
			reading({ percent: 100, reset: null }),
			NOW,
		);
		await dbOps.recordUsageSnapshot(
			"past-reset",
			reading({ percent: 100, reset: NOW - HOUR }),
			NOW,
		);
		for (const id of ["no-reset", "past-reset"])
			expect((await inputs(id))?.holds?.holds ?? []).toEqual([]);
	});

	it("a reading that changes no hold leaves the stored reading time on the one that last changed it", async () => {
		await seed("a");
		await dbOps.recordUsageSnapshot("a", opusSpent(), NOW);
		await dbOps.recordUsageSnapshot("a", opusSpent(), NOW + HOUR);
		expect((await inputs("a"))?.holds?.readingAt).toBe(NOW);
	});

	it("a reading for a Codex account, or a Claude login with the switch off, writes no hold", async () => {
		await seed("codex", { provider: "codex" });
		await seed("off", { switchOn: false });
		await dbOps.recordUsageSnapshot("codex", opusSpent(), NOW);
		await dbOps.recordUsageSnapshot("off", opusSpent(), NOW);
		expect((await inputs("codex"))?.holds).toBeNull();
		expect((await inputs("off"))?.holds).toBeNull();
		expect(await snapshotCount("codex")).toBe(3);
		expect(await snapshotCount("off")).toBe(3);
	});

	it("a reading for an older account generation writes no hold", async () => {
		await seed("a");
		await dbOps.recordUsageSnapshot("a", opusSpent(), NOW, CREATED_AT - 1);
		expect((await inputs("a"))?.holds).toBeNull();
	});

	it("a failure in the hold step still leaves the history rows written", async () => {
		await seed("a");
		const repo = (
			dbOps as unknown as {
				accounts: { writeExtraUsageHolds: (...args: unknown[]) => unknown };
			}
		).accounts;
		const failing = spyOn(repo, "writeExtraUsageHolds").mockImplementation(
			async () => {
				throw new Error("disk I/O error");
			},
		);
		try {
			await dbOps.recordUsageSnapshot("a", opusSpent(), NOW);
			expect(failing).toHaveBeenCalledTimes(1);
		} finally {
			failing.mockRestore();
		}
		expect(await snapshotCount("a")).toBe(3);
		expect((await inputs("a"))?.holds).toBeNull();
	});

	it("a failed history write still applies the reading to the holds, and the error is still raised", async () => {
		await seed("a");
		const history = (
			dbOps as unknown as {
				usageHistory: { recordSnapshot: (...args: unknown[]) => unknown };
			}
		).usageHistory;
		const failing = spyOn(history, "recordSnapshot").mockImplementation(
			async () => {
				throw new Error("disk I/O error");
			},
		);
		try {
			await expect(
				dbOps.recordUsageSnapshot("a", opusSpent(), NOW),
			).rejects.toThrow("disk I/O error");
		} finally {
			failing.mockRestore();
		}
		expect((await inputs("a"))?.holds?.holds).toHaveLength(1);
	});
});

describe("a reading narrows a hold from a billed response", () => {
	const BILLED_AT = NOW - 60_000;

	it("a reading after the billed time with weekly Opus spent ends the overage pause and stores the Opus hold", async () => {
		await seed("a", {
			paused: true,
			pauseReason: "overage",
			billedAt: BILLED_AT,
			billedFamily: "opus",
		});
		await dbOps.recordUsageSnapshot("a", opusSpent(), NOW);
		const after = await inputs("a");
		expect(after?.paused).toBe(false);
		expect(after?.pauseReason).toBeNull();
		expect(after?.holds?.holds.map((h) => h.windowKey)).toEqual([
			"seven_day_opus",
		]);
	});

	it("a reading with nothing spent leaves the overage pause", async () => {
		await seed("a", {
			paused: true,
			pauseReason: "overage",
			billedAt: BILLED_AT,
			billedFamily: "opus",
		});
		await dbOps.recordUsageSnapshot("a", reading(null), NOW);
		const after = await inputs("a");
		expect(after?.paused).toBe(true);
		expect(after?.pauseReason).toBe("overage");
	});

	it("a reading with only weekly Fable spent leaves an Opus billed hold on every model", async () => {
		await seed("a", {
			paused: true,
			pauseReason: "overage",
			billedAt: BILLED_AT,
			billedFamily: "opus",
		});
		await dbOps.recordUsageSnapshot(
			"a",
			reading({ percent: 100, reset: WEEK_RESET }, "Fable"),
			NOW,
		);
		const after = await inputs("a");
		expect(after?.paused).toBe(true);
		expect(after?.pauseReason).toBe("overage");
		expect(after?.holds?.holds.map((h) => h.modelFamily)).toEqual(["fable"]);
	});

	it("a pause from before the upgrade, with no billed time, is never narrowed", async () => {
		await seed("a", { paused: true, pauseReason: "overage" });
		await dbOps.recordUsageSnapshot("a", opusSpent(), NOW);
		const after = await inputs("a");
		expect(after?.paused).toBe(true);
		expect(after?.pauseReason).toBe("overage");
		expect(after?.holds?.holds).toHaveLength(1);
	});

	it("a manual pause is never ended by a reading", async () => {
		await seed("a", {
			paused: true,
			pauseReason: "manual",
			billedAt: BILLED_AT,
			billedFamily: "opus",
		});
		await dbOps.recordUsageSnapshot("a", opusSpent(), NOW);
		const after = await inputs("a");
		expect(after?.paused).toBe(true);
		expect(after?.pauseReason).toBe("manual");
	});
});
