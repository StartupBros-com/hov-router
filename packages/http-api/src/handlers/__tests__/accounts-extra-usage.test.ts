/**
 * What GET /api/accounts reports about a Claude login's extra usage: the state
 * from its cached usage reading, the holds from readings, and a hold from a
 * billed response. Runs the real list handler on an in-memory database with
 * readings seeded into the usage cache; it checks the reply's shape, not how
 * the dashboard reads it.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Config } from "@hov-router/config";
import { DatabaseOperations } from "@hov-router/database";
import { usageCache } from "@hov-router/providers";
import type { AccountResponse } from "@hov-router/types";
import {
	createAccountAutoPauseOnOverageHandler,
	createAccountsListHandler,
} from "../accounts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CONFIG = {
	getUsageThrottlingFiveHourEnabled: () => true,
	getUsageThrottlingWeeklyEnabled: () => true,
} as unknown as Config;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The recorded live Anthropic usage shape (the "live Anthropic payload shape"
 * fixture in packages/proxy/src/handlers/__tests__/usage-throttling.test.ts),
 * trimmed to the fields the usage normalizer and the state read. As recorded
 * it reports extra usage off in both forms.
 */
function liveReading(): Record<string, unknown> {
	const now = Date.now();
	return {
		limits: [
			{
				kind: "session",
				percent: 6,
				resets_at: iso(now + 3 * HOUR),
				scope: null,
				is_active: true,
			},
			{
				kind: "weekly_all",
				percent: 2,
				resets_at: iso(now + 96 * HOUR),
				scope: null,
				is_active: true,
			},
		],
		five_hour: { utilization: 6, resets_at: iso(now + 3 * HOUR) },
		seven_day: { utilization: 2, resets_at: iso(now + 96 * HOUR) },
		extra_usage: {
			is_enabled: false,
			monthly_limit: null,
			used_credits: null,
			utilization: null,
		},
		spend: { enabled: false },
	};
}

/** Edit: extra usage switched on in the `spend` form only. */
function spendOn() {
	const { extra_usage: _extra, ...rest } = liveReading();
	return { ...rest, spend: { enabled: true } };
}

/** Edit: extra usage switched on in the `extra_usage` form only. */
function extraUsageOn() {
	const { spend: _spend, ...rest } = liveReading();
	return { ...rest, extra_usage: { is_enabled: true } };
}

/** Edit: off, with a reason no recorded reading has carried. */
function offWithReason() {
	const { extra_usage: _extra, ...rest } = liveReading();
	return {
		...rest,
		spend: { enabled: false, disabled_reason: "org_level_disabled" },
	};
}

let dbOps: DatabaseOperations;
let fetchSpy: ReturnType<typeof spyOn>;
const seeded = new Set<string>();

beforeEach(() => {
	dbOps = new DatabaseOperations(":memory:", { walMode: false });
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
		input: string | URL | Request,
	) => {
		throw new Error(`unexpected network call: ${String(input)}`);
	}) as typeof fetch);
});

afterEach(async () => {
	expect(fetchSpy).not.toHaveBeenCalled();
	fetchSpy.mockRestore();
	for (const id of seeded) usageCache.delete(id);
	seeded.clear();
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
		billedFamily?: string | null;
		holds?: unknown;
	} = {},
) {
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at, auto_pause_on_overage_enabled, paused, pause_reason, overage_billed_at, overage_billed_family, extra_usage_holds)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			`name-${id}`,
			fields.provider ?? "anthropic",
			"refresh",
			"access",
			Date.now() + 3 * HOUR,
			Date.now() - 24 * HOUR,
			fields.switchOn ? 1 : 0,
			fields.paused ? 1 : 0,
			fields.pauseReason ?? null,
			fields.billedAt ?? null,
			fields.billedFamily ?? null,
			fields.holds === undefined ? null : JSON.stringify(fields.holds),
		],
	);
}

/** Cache a reading as if the poll stored it `ageMs` ago. */
function cacheReading(id: string, reading: unknown, ageMs = 30_000) {
	seeded.add(id);
	const takenAt = Date.now() - ageMs;
	const clock = spyOn(Date, "now").mockReturnValue(takenAt);
	try {
		usageCache.set(id, reading as never);
	} finally {
		clock.mockRestore();
	}
	return takenAt;
}

async function list(): Promise<Map<string, AccountResponse>> {
	const res = await createAccountsListHandler(dbOps, CONFIG)();
	expect(res.status).toBe(200);
	const body = (await res.json()) as AccountResponse[];
	return new Map(body.map((account) => [account.id, account]));
}

describe("the extra-usage state on GET /api/accounts", () => {
	it("a reading in either form that reports extra usage on reads on, with its reading time", async () => {
		await seed("spend");
		await seed("extra");
		const spendAt = cacheReading("spend", spendOn());
		const extraAt = cacheReading("extra", extraUsageOn());
		const accounts = await list();
		expect(accounts.get("spend")?.extraUsage).toEqual({
			state: "on",
			readingAt: spendAt,
		});
		expect(accounts.get("extra")?.extraUsage).toEqual({
			state: "on",
			readingAt: extraAt,
		});
	});

	it("the recorded live reading reads off", async () => {
		await seed("a");
		const at = cacheReading("a", liveReading());
		expect((await list()).get("a")?.extraUsage).toEqual({
			state: "off",
			readingAt: at,
		});
	});

	it("a login with no cached reading reads not known, with no reading time", async () => {
		await seed("new");
		expect((await list()).get("new")?.extraUsage).toEqual({
			state: "unknown",
			readingAt: null,
		});
	});

	it("a reading older than the age capacity decisions trust reads not known, never off", async () => {
		await seed("old");
		const at = cacheReading("old", liveReading(), 5 * MINUTE);
		expect((await list()).get("old")?.extraUsage).toEqual({
			state: "unknown",
			readingAt: at,
		});
	});

	it("a reported state the router cannot place reads not known", async () => {
		await seed("why");
		const at = cacheReading("why", offWithReason());
		expect((await list()).get("why")?.extraUsage).toEqual({
			state: "unknown",
			readingAt: at,
		});
	});

	it("is reported whether or not the switch is on", async () => {
		await seed("on", { switchOn: true });
		cacheReading("on", spendOn());
		expect((await list()).get("on")?.extraUsage?.state).toBe("on");
	});
});

describe("holds on GET /api/accounts", () => {
	const hold = (windowKey: string, resetsAtMs: number) => ({
		windowKey,
		scope: windowKey === "seven_day_opus" ? "family" : "account",
		modelFamily: windowKey === "seven_day_opus" ? "opus" : null,
		resetsAtMs,
		startedAt: Date.now() - HOUR,
	});

	it("lists each hold from a reading whose reset is still ahead, and no other", async () => {
		const opus = hold("seven_day_opus", Date.now() + 2 * HOUR);
		await seed("a", {
			switchOn: true,
			holds: {
				readingAt: Date.now() - HOUR,
				holds: [opus, hold("five_hour", Date.now() - MINUTE)],
			},
		});
		const account = (await list()).get("a");
		expect(account?.extraUsageHolds).toEqual([opus]);
		expect(account?.extraUsageBilledHold).toBeNull();
	});

	it("lists no hold while the switch is off, since none is enforced", async () => {
		await seed("off", {
			holds: {
				readingAt: Date.now() - HOUR,
				holds: [hold("seven_day_opus", Date.now() + HOUR)],
			},
		});
		expect((await list()).get("off")?.extraUsageHolds).toEqual([]);
	});

	it("reports a hold from a billed response with its time and family", async () => {
		const billedAt = Date.now() - 10 * MINUTE;
		await seed("billed", {
			switchOn: true,
			paused: true,
			pauseReason: "overage",
			billedAt,
			billedFamily: "opus",
		});
		const account = (await list()).get("billed");
		expect(account?.extraUsageBilledHold).toEqual({ billedAt, family: "opus" });
		expect(account?.paused).toBe(true);
	});

	it("a login paused for extra usage before the upgrade, with the switch on, reports a billed hold with no billed time", async () => {
		await seed("legacy", {
			switchOn: true,
			paused: true,
			pauseReason: "overage",
		});
		expect((await list()).get("legacy")?.extraUsageBilledHold).toEqual({
			billedAt: null,
			family: null,
		});
	});

	it("a login paused for extra usage with the switch off reports no billed hold and stays paused", async () => {
		await seed("legacy-off", { paused: true, pauseReason: "overage" });
		const account = (await list()).get("legacy-off");
		expect(account?.extraUsageBilledHold).toBeNull();
		expect(account?.paused).toBe(true);
		expect(account?.pauseReason).toBe("overage");
	});

	it("a pause for another reason is not a billed hold", async () => {
		await seed("manual", {
			switchOn: true,
			paused: true,
			pauseReason: "manual",
		});
		expect((await list()).get("manual")?.extraUsageBilledHold).toBeNull();
	});
});

describe("existing clients", () => {
	it("a login that is not a Claude login carries none of the new fields", async () => {
		await seed("codex", { provider: "codex", switchOn: true });
		await seed("router", { provider: "openrouter" });
		const accounts = await list();
		for (const id of ["codex", "router"]) {
			const account = accounts.get(id) as unknown as Record<string, unknown>;
			expect(account).toBeDefined();
			expect("extraUsage" in account).toBe(false);
			expect("extraUsageHolds" in account).toBe(false);
			expect("extraUsageBilledHold" in account).toBe(false);
		}
	});

	it("autoPauseOnOverageEnabled keeps its meaning and type", async () => {
		await seed("on", { switchOn: true });
		await seed("off");
		const accounts = await list();
		expect(accounts.get("on")?.autoPauseOnOverageEnabled).toBe(true);
		expect(accounts.get("off")?.autoPauseOnOverageEnabled).toBe(false);
	});

	it("the old switch route's reply keeps exactly its fields", async () => {
		await seed("a");
		const res = await createAccountAutoPauseOnOverageHandler(dbOps)(
			new Request("http://localhost/api/accounts/a/auto-pause-on-overage", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ enabled: 1 }),
			}),
			"a",
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual([
			"autoPauseOnOverageEnabled",
			"message",
			"success",
		]);
		expect(body.autoPauseOnOverageEnabled).toBe(true);
	});
});
