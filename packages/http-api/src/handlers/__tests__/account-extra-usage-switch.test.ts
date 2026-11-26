import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { DatabaseOperations } from "@hov-router/database";
import { createAccountAutoPauseOnOverageHandler } from "../accounts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CREATED_AT = 1_700_000_000_000;
const NOW = 1_800_000_000_000;
const WEEK_RESET = NOW + 4 * DAY;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The recorded live Anthropic usage shape (see the "live Anthropic payload
 * shape" fixture in packages/proxy/src/handlers/__tests__/usage-throttling.test.ts),
 * trimmed to the fields the normalizer reads, with one edit: a weekly Opus
 * limit spent and active. Nobody has recorded a spent per-model limit.
 */
const opusSpentReading = {
	limits: [
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
		{
			kind: "weekly_scoped",
			percent: 100,
			resets_at: iso(WEEK_RESET),
			scope: { model: { id: null, display_name: "Opus" }, surface: null },
			is_active: true,
		},
	],
	five_hour: { utilization: 6, resets_at: iso(NOW + 3 * HOUR) },
	seven_day: { utilization: 2, resets_at: iso(WEEK_RESET) },
	spend: { enabled: false },
};

let dbOps: DatabaseOperations;
let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
	dbOps = new DatabaseOperations(":memory:", { walMode: false });
	// R25: no switch change may contact Anthropic or anything else.
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
		input: string | URL | Request,
	) => {
		throw new Error(`unexpected network call: ${String(input)}`);
	}) as typeof fetch);
});
afterEach(async () => {
	expect(fetchSpy).not.toHaveBeenCalled();
	fetchSpy.mockRestore();
	await dbOps.dispose();
});

async function seed(
	id: string,
	fields: {
		provider?: string;
		switchOn?: boolean;
		paused?: boolean;
		pauseReason?: string | null;
		billedAt?: number | null;
		holds?: string | null;
	} = {},
) {
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, created_at, auto_pause_on_overage_enabled, paused, pause_reason, overage_billed_at, overage_billed_family, extra_usage_holds)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			id,
			fields.provider ?? "anthropic",
			CREATED_AT,
			fields.switchOn ? 1 : 0,
			fields.paused ? 1 : 0,
			fields.pauseReason ?? null,
			fields.billedAt ?? null,
			fields.billedAt == null ? null : "opus",
			fields.holds ?? null,
		],
	);
}

function post(
	id: string,
	enabled: 0 | 1,
	snapshot: { data: unknown; observedAt: number } | null,
) {
	const handler = createAccountAutoPauseOnOverageHandler(dbOps, {
		getUsageSnapshot: () => snapshot,
		now: () => NOW,
	});
	return handler(
		new Request(`http://localhost/api/accounts/${id}/auto-pause-on-overage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled }),
		}),
		id,
	);
}

const row = (id: string) => dbOps.getExtraUsageHoldInputs(id);
const fresh = { data: opusSpentReading, observedAt: NOW - 60_000 };
const READING_HOLD = JSON.stringify({
	readingAt: NOW - HOUR,
	holds: [
		{
			windowKey: "seven_day_opus",
			scope: "family",
			modelFamily: "opus",
			resetsAtMs: WEEK_RESET,
			startedAt: NOW - HOUR,
		},
	],
});

describe("the extra-usage switch route", () => {
	it("turning the switch on with a fresh reading that shows weekly Opus spent stores an Opus hold", async () => {
		await seed("a");
		const res = await post("a", 1, fresh);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			success: true,
			autoPauseOnOverageEnabled: true,
		});
		const after = await row("a");
		expect(after?.switchOn).toBe(true);
		expect(after?.holds).toEqual({
			readingAt: NOW - 60_000,
			holds: [
				{
					windowKey: "seven_day_opus",
					scope: "family",
					modelFamily: "opus",
					resetsAtMs: WEEK_RESET,
					startedAt: NOW - 60_000,
				},
			],
		});
	});

	it("off then on stores the hold again with a fresh spent reading, and none with an older reading or none", async () => {
		await seed("a", { switchOn: true, holds: READING_HOLD });
		expect((await post("a", 0, fresh)).status).toBe(200);
		expect((await row("a"))?.holds).toBeNull();
		expect((await post("a", 1, fresh)).status).toBe(200);
		expect((await row("a"))?.holds?.holds).toHaveLength(1);

		await seed("stale");
		const stale = { data: opusSpentReading, observedAt: NOW - 4 * 60_000 };
		expect((await post("stale", 1, stale)).status).toBe(200);
		expect((await row("stale"))?.switchOn).toBe(true);
		expect((await row("stale"))?.holds).toBeNull();

		await seed("none");
		expect((await post("none", 1, null)).status).toBe(200);
		expect((await row("none"))?.switchOn).toBe(true);
		expect((await row("none"))?.holds).toBeNull();
	});

	it("turning the switch off ends a hold from a reading and a hold from a billed response together", async () => {
		await seed("a", {
			switchOn: true,
			paused: true,
			pauseReason: "overage",
			billedAt: NOW - 60_000,
			holds: READING_HOLD,
		});
		expect((await post("a", 0, fresh)).status).toBe(200);
		const after = await row("a");
		expect(after).toMatchObject({
			switchOn: false,
			holds: null,
			paused: false,
			pauseReason: null,
			overageBilledAt: null,
			overageBilledFamily: null,
		});
	});

	it("posting off to the old route clears a stored hold", async () => {
		await seed("a", { switchOn: true, holds: READING_HOLD });
		const res = await post("a", 0, null);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			autoPauseOnOverageEnabled: false,
		});
		expect((await row("a"))?.holds).toBeNull();
	});

	it("posting off for a login already off keeps its overage pause", async () => {
		await seed("a", { paused: true, pauseReason: "overage" });
		expect((await post("a", 0, null)).status).toBe(200);
		const after = await row("a");
		expect(after?.paused).toBe(true);
		expect(after?.pauseReason).toBe("overage");
	});

	it("still answers 400 for a provider other than anthropic and changes nothing", async () => {
		await seed("codex", { provider: "codex" });
		const res = await post("codex", 1, fresh);
		expect(res.status).toBe(400);
		expect((await row("codex"))?.switchOn).toBe(false);
	});

	it("answers 404 for an unknown account", async () => {
		expect((await post("missing", 1, fresh)).status).toBe(404);
	});
});
