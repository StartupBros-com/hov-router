import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	spyOn,
} from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@better-ccflare/logger";
import type { APIContext } from "../../types";

const scratch = mkdtempSync(join(tmpdir(), "ccflare-public-value-v2-"));
process.env.BETTER_CCFLARE_DB_PATH = join(scratch, "isolated.db");
process.env.BETTER_CCFLARE_CONFIG_PATH = join(scratch, "isolated-config.json");
process.env.DATABASE_URL = "";
const { DatabaseOperations } = await import("@better-ccflare/database");
const { createPublicSubscriptionValueHandler, MAX_AGE_MS } = await import(
	"../public-subscription-value"
);

const EXAMPLE_PATH = join(
	import.meta.dir,
	"fixtures",
	"subscription-value-v2.example.json",
);
const EXAMPLE_SHA256 =
	"72505003d58dfefc24b0d9705a9dd782d82bdee6db4ac84db4b292e278aa1471";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const OCT1 = Date.UTC(2026, 9, 1);
/** Days after 1 October 2026 00:00 UTC. */
const t = (days: number) => OCT1 + days * DAY;
const AT = t(33.5); // 3 November 2026 12:00 UTC

const db = new DatabaseOperations(":memory:");
const context = { dbOps: db } as APIContext;
const mapping = {
	accountId: "private-account",
	accountCreatedAt: 100,
	id: "my-weekly",
	label: "Weekly subscription",
};
let config: string | undefined;
let now = AT;
let handler: ReturnType<typeof createPublicSubscriptionValueHandler>;
let warn: ReturnType<typeof spyOn<Logger, "warn">>;
let info: ReturnType<typeof spyOn<Logger, "info">>;
let error: ReturnType<typeof spyOn<Logger, "error">>;

interface Seed {
	id: string;
	startedAt: number;
	resetsAt: number;
	closedAt: number;
	grant?: string;
	value: number | null;
	points?: number | null;
	counterResets?: number | null;
	accountId?: string;
}

async function insertWindow(seed: Seed) {
	await db
		.getAdapter()
		.run(
			"INSERT INTO usage_windows (id,account_id,window_key,started_at,resets_at,closed_at,grant_type,peak_utilization,value_usd,unpriced_tokens,points_used,counter_resets) VALUES (?, ?, 'seven_day', ?, ?, ?, ?, 0, ?, ?, ?, ?)",
			[
				seed.id,
				seed.accountId ?? mapping.accountId,
				seed.startedAt,
				seed.resetsAt,
				seed.closedAt,
				seed.grant ?? "natural",
				seed.value,
				seed.value === null ? null : 0,
				seed.points ?? null,
				seed.counterResets ?? null,
			],
		);
}

beforeEach(async () => {
	await db.getAdapter().run("DELETE FROM requests");
	await db.getAdapter().run("DELETE FROM usage_windows");
	await db.getAdapter().run("DELETE FROM usage_snapshots");
	await db.getAdapter().run("DELETE FROM accounts");
	await db
		.getAdapter()
		.run(
			"INSERT INTO accounts (id,name,provider,created_at) VALUES (?, 'SECRET LABEL', 'anthropic', ?)",
			[mapping.accountId, 100],
		);
	config = JSON.stringify([mapping]);
	now = AT;
	handler = createPublicSubscriptionValueHandler(context, {
		getConfig: () => config,
		now: () => now,
	});
	warn = spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
	info = spyOn(Logger.prototype, "info").mockImplementation(() => undefined);
	error = spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});
afterEach(() => {
	warn.mockRestore();
	info.mockRestore();
	error.mockRestore();
});
afterAll(async () => {
	await db.close();
	rmSync(scratch, { recursive: true, force: true });
});

/**
 * Timeline in days after 1 Oct 00:00 UTC (Sep 29 = -2, Nov 1 = 31, now = 33.5):
 *   A  [-2, 1)    early close (resets at 5), 300, straddles Sep/Oct
 *   B  [1, 8)     first_observed, 140
 *   C  [8, 15)    null value, null counterResets
 *   D  [15, 22)   700
 *   E  [22, 29)   early_reset, 700
 *   gap 29 to 29.5
 *   O  [29.5, now) open, live value 30 (1,000,000 gpt-5.5 output tokens at $30/M)
 */
async function seedScenario() {
	await insertWindow({
		id: "A",
		startedAt: t(-2),
		resetsAt: t(5),
		closedAt: t(1),
		value: 300,
		points: 30,
		counterResets: 1,
	});
	await insertWindow({
		id: "B",
		startedAt: t(1),
		resetsAt: t(8),
		closedAt: t(8),
		grant: "first_observed",
		value: 140,
		points: 10,
		counterResets: 0,
	});
	await insertWindow({
		id: "C",
		startedAt: t(8),
		resetsAt: t(15),
		closedAt: t(15),
		value: null,
	});
	await insertWindow({
		id: "D",
		startedAt: t(15),
		resetsAt: t(22),
		closedAt: t(22),
		value: 700,
		points: 99,
		counterResets: 3,
	});
	await insertWindow({
		id: "E",
		startedAt: t(22),
		resetsAt: t(29),
		closedAt: t(29),
		grant: "early_reset",
		value: 700,
		points: 70,
		counterResets: 2,
	});
	await db.openUsageWindow({
		accountId: mapping.accountId,
		windowKey: "seven_day",
		startedAt: t(29.5),
		resetsAt: t(36.5),
		grantType: "natural",
	});
	await db
		.getAdapter()
		.run(
			"INSERT INTO requests (id,timestamp,method,path,account_used,billing_type,model,input_tokens,cache_read_input_tokens,cache_creation_input_tokens,output_tokens) VALUES ('live-1', ?, 'POST', '/v1/messages', ?, 'plan', 'gpt-5.5', 0, 0, 0, 1000000)",
			[t(31), mapping.accountId],
		);
}

const keys = (value: object) => Object.keys(value).sort();

describe("public subscription value feed, version 2", () => {
	it("pins the frozen example and answers exactly its keys at every level", async () => {
		const raw = readFileSync(EXAMPLE_PATH);
		expect(createHash("sha256").update(raw).digest("hex")).toBe(EXAMPLE_SHA256);
		const example = JSON.parse(raw.toString("utf8"));
		await seedScenario();
		const body = await (await handler()).json();
		expect(keys(body)).toEqual(keys(example));
		expect(body.schemaVersion).toBe(2);
		const [exampleSub] = example.subscriptions;
		const [sub] = body.subscriptions;
		expect(keys(sub)).toEqual(keys(exampleSub));
		expect(sub.plan).toBeNull();
		expect(sub.provider).toBe("anthropic");
		expect(keys(sub.current)).toEqual(keys(exampleSub.current));
		expect(keys(sub.completed[0])).toEqual(keys(exampleSub.completed[0]));
		expect(keys(sub.periods[0])).toEqual(keys(exampleSub.periods[0]));
		expect(sub.periods).toHaveLength(5);
		expect(sub.periods.map((p: { kind: string }) => p.kind)).toEqual([
			"trailing_30_days",
			"calendar_month",
			"calendar_month",
			"calendar_month",
			"calendar_month",
		]);
		expect(example.subscriptions[1].plan).toBeNull();
	});

	it("computes period values, coverage, early resets and counter resets by the closed-window span", async () => {
		await seedScenario();
		const body = await (await handler()).json();
		const [sub] = body.subscriptions;
		expect(sub.current).toEqual({
			startedAt: t(29.5),
			resetsAt: t(36.5),
			closedAt: null,
			valueUsd: 30,
			pricingCoverage: "complete",
			grantType: "natural",
			pointsUsed: null,
			counterResets: null,
		});
		expect(
			sub.completed.map((w: { resetsAt: number }) => (w.resetsAt - OCT1) / DAY),
		).toEqual([29, 22, 15, 8, 5]);
		expect(sub.completed[0]).toMatchObject({
			grantType: "early_reset",
			pointsUsed: 70,
			counterResets: 2,
		});
		expect(sub.completed[2]).toMatchObject({
			valueUsd: null,
			pricingCoverage: "unknown",
			pointsUsed: null,
			counterResets: null,
		});
		const [trailing, month, oct, sep, aug] = sub.periods;
		// Trailing [3.5, 33.5): B 4.5/7 of 140 = 90, D 700, E 700, O 4/4 of 30.
		expect(trailing.startsAt).toBe(AT - 30 * DAY);
		expect(trailing.endsAt).toBe(AT);
		expect(trailing.valueUsd).toBeCloseTo(90 + 700 + 700 + 30, 6);
		expect(trailing.coveredMs).toBe(29.5 * DAY);
		expect(trailing.lowerBound).toBe(true);
		expect(trailing.earlyResets).toBe(1);
		expect(trailing.counterResets).toBeNull(); // C closed in range with null
		// Month to date [31, 33.5): the open window's last 2.5 of its 4 days.
		expect(month.startsAt).toBe(t(31));
		expect(month.valueUsd).toBeCloseTo((30 * 2.5) / 4, 6);
		expect(month.coveredMs).toBe(2.5 * DAY);
		expect(month.lowerBound).toBe(false);
		expect(month.earlyResets).toBe(0);
		expect(month.counterResets).toBe(0);
		// October [0, 31): A 1/3 of 300 = 100 (closed span), B, D, E, O 1.5/4 of 30.
		expect(oct.startsAt).toBe(t(0));
		expect(oct.endsAt).toBe(t(31));
		expect(oct.valueUsd).toBeCloseTo(100 + 140 + 700 + 700 + 11.25, 6);
		expect(oct.coveredMs).toBe(30.5 * DAY);
		expect(oct.lowerBound).toBe(true);
		expect(oct.earlyResets).toBe(1);
		expect(oct.counterResets).toBeNull();
		// September [-30, 0): A 2/3 of 300 = 200.
		expect(sep.startsAt).toBe(Date.UTC(2026, 8, 1));
		expect(sep.endsAt).toBe(t(0));
		expect(sep.valueUsd).toBeCloseTo(200, 6);
		expect(sep.coveredMs).toBe(2 * DAY);
		expect(sep.lowerBound).toBe(true);
		expect(sep.counterResets).toBe(0);
		// August: nothing overlaps.
		expect(aug.startsAt).toBe(Date.UTC(2026, 7, 1));
		expect(aug.endsAt).toBe(Date.UTC(2026, 8, 1));
		expect(aug.valueUsd).toBeNull();
		expect(aug.coveredMs).toBe(0);
		expect(aug.lowerBound).toBe(true);
		expect(aug.earlyResets).toBe(0);
		expect(aug.counterResets).toBe(0);
		for (const period of sub.periods) {
			expect(Number.isInteger(period.coveredMs)).toBe(true);
			expect(period.startsAt).toBeLessThan(period.endsAt);
			expect(period.endsAt).toBeLessThanOrEqual(body.generatedAt);
		}
	});

	it("prorates an early-closed window by its closedAt, not its scheduled reset (planted negative)", async () => {
		// Closed after 3 of its 7 scheduled days; 2 of those 3 days fall in September.
		await insertWindow({
			id: "early",
			startedAt: t(-2),
			resetsAt: t(5),
			closedAt: t(1),
			value: 300,
			points: 1,
			counterResets: 0,
		});
		const body = await (await handler()).json();
		const [, , oct, sep] = body.subscriptions[0].periods;
		expect(sep.valueUsd).toBeCloseTo(200, 6); // 2/3 by closedAt; 2/7 by resetsAt is 85.71
		expect(oct.valueUsd).toBeCloseTo(100, 6); // 1/3 by closedAt; 1/7 by resetsAt is 42.86
		expect(sep.coveredMs).toBe(2 * DAY);
		expect(oct.coveredMs).toBe(1 * DAY);
	});

	it("sums counter resets of windows closed inside a period, and publishes the early reset count", async () => {
		await insertWindow({
			id: "x",
			startedAt: t(1),
			resetsAt: t(8),
			closedAt: t(8),
			value: 70,
			counterResets: 2,
		});
		await insertWindow({
			id: "y",
			startedAt: t(8),
			resetsAt: t(15),
			closedAt: t(15),
			grant: "early_reset",
			value: 70,
			counterResets: 3,
		});
		const body = await (await handler()).json();
		const [trailing, , oct] = body.subscriptions[0].periods;
		expect(oct.counterResets).toBe(5);
		expect(oct.earlyResets).toBe(1);
		expect(trailing.counterResets).toBe(5);
	});

	it("reads one bounded closed-window query per account and no more", async () => {
		const read = spyOn(db, "listUsageWindows");
		try {
			await handler();
			expect(read).toHaveBeenCalledTimes(1);
			expect(read.mock.calls[0]?.[0]).toMatchObject({
				closedOnly: true,
				limit: 200,
				startedAtOrAfter: mapping.accountCreatedAt,
			});
		} finally {
			read.mockRestore();
		}
	});

	it("keeps the generation filter: a window started before the account was created stays out", async () => {
		await insertWindow({
			id: "old-generation",
			startedAt: 50,
			resetsAt: 150,
			closedAt: 140,
			value: 5,
		});
		const body = await (await handler()).json();
		expect(body.subscriptions[0].completed).toEqual([]);
	});

	describe("selection", () => {
		it("publishes exactly 32 of 40 closed windows, newest resetsAt first", async () => {
			for (let i = 0; i < 40; i++)
				await insertWindow({
					id: `w${i}`,
					startedAt: AT - (i + 1) * DAY,
					resetsAt: AT - i * DAY,
					closedAt: AT - i * DAY - HOUR,
					value: 10,
				});
			const body = await (await handler()).json();
			const completed = body.subscriptions[0].completed;
			expect(completed).toHaveLength(32);
			const resets = completed.map((w: { resetsAt: number }) => w.resetsAt);
			expect(resets).toEqual(
				Array.from({ length: 32 }, (_, i) => AT - i * DAY),
			);
		});

		it("drops windows that closed over 35 days ago, keeping at least the 8 most recent", async () => {
			// Three recent windows; nine older than 35 days.
			for (let i = 0; i < 3; i++)
				await insertWindow({
					id: `recent${i}`,
					startedAt: AT - (i + 1) * 7 * DAY,
					resetsAt: AT - i * 7 * DAY,
					closedAt: AT - i * 7 * DAY - HOUR,
					value: 10,
				});
			for (let i = 0; i < 9; i++)
				await insertWindow({
					id: `old${i}`,
					startedAt: AT - (60 + (i + 1) * 7) * DAY,
					resetsAt: AT - (60 + i * 7) * DAY,
					closedAt: AT - (60 + i * 7) * DAY,
					value: 10,
				});
			const completed = (await (await handler()).json()).subscriptions[0]
				.completed;
			expect(completed).toHaveLength(8);
			expect(completed[7].resetsAt).toBe(AT - (60 + 4 * 7) * DAY);
		});

		it("keeps recent windows beyond 8 and drops the old ones", async () => {
			for (let i = 0; i < 10; i++)
				await insertWindow({
					id: `recent${i}`,
					startedAt: AT - (i + 1) * 3 * DAY,
					resetsAt: AT - i * 3 * DAY,
					closedAt: AT - i * 3 * DAY - HOUR,
					value: 10,
				});
			for (let i = 0; i < 5; i++)
				await insertWindow({
					id: `old${i}`,
					startedAt: AT - (60 + (i + 1) * 7) * DAY,
					resetsAt: AT - (60 + i * 7) * DAY,
					closedAt: AT - (60 + i * 7) * DAY,
					value: 10,
				});
			const completed = (await (await handler()).json()).subscriptions[0]
				.completed;
			// recent windows closed 0 to 27 days ago (all within 35 days).
			expect(completed).toHaveLength(10);
		});
	});

	it("maps codex to openai and passes other providers through", async () => {
		await db.getAdapter().run("UPDATE accounts SET provider = 'codex'");
		expect((await (await handler()).json()).subscriptions[0].provider).toBe(
			"openai",
		);
		await db.getAdapter().run("UPDATE accounts SET provider = 'zai'");
		now += MAX_AGE_MS;
		expect((await (await handler()).json()).subscriptions[0].provider).toBe(
			"zai",
		);
	});

	it("fails closed on a provider that breaks the public pattern", async () => {
		await db.getAdapter().run("UPDATE accounts SET provider = 'Bad Provider'");
		expect((await handler()).status).toBe(503);
		expect(JSON.stringify(warn.mock.calls)).toContain("bad_provider");
	});

	it("fails closed on an unknown grant type", async () => {
		await insertWindow({
			id: "odd",
			startedAt: t(1),
			resetsAt: t(8),
			closedAt: t(8),
			value: 1,
		});
		// The column's CHECK constraint refuses such a row, so a future or corrupt
		// value is injected on the read path.
		const original = db.listUsageWindows.bind(db);
		const read = spyOn(db, "listUsageWindows").mockImplementation(
			async (...args) =>
				(await original(...args)).map((window) => ({
					...window,
					grantType: "mystery" as never,
				})),
		);
		try {
			const response = await handler();
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: "Unavailable" });
			expect(JSON.stringify(warn.mock.calls)).toContain("invalid_window");
		} finally {
			read.mockRestore();
		}
	});

	it("publishes fractional limit points and fails closed past the page's bounds", async () => {
		await insertWindow({
			id: "fractional",
			startedAt: t(1),
			resetsAt: t(8),
			closedAt: t(8),
			value: 10,
			points: 37.5,
			counterResets: 0,
		});
		expect(
			(await (await handler()).json()).subscriptions[0].completed[0].pointsUsed,
		).toBe(37.5);
		await db
			.getAdapter()
			.run(
				"UPDATE usage_windows SET points_used = 100001 WHERE id = 'fractional'",
			);
		now += MAX_AGE_MS;
		expect((await handler()).status).toBe(503);
		expect(JSON.stringify(warn.mock.calls)).toContain("invalid_window");
	});

	it("serializes 16 subscriptions of 32 completed windows and 5 periods under 256 KiB", async () => {
		const mappings = [];
		for (let s = 0; s < 16; s++) {
			const accountId = `acct-size-${s}`;
			await db
				.getAdapter()
				.run(
					"INSERT INTO accounts (id,name,provider,created_at) VALUES (?, ?, 'anthropic', 100)",
					[accountId, `name-${s}`],
				);
			mappings.push({
				accountId,
				accountCreatedAt: 100,
				id: `pub-${s}-${"x".repeat(40)}`,
				label: `${"Subscription label ".repeat(4)}${s}`.slice(0, 80),
			});
			for (let i = 0; i < 32; i++)
				await insertWindow({
					accountId,
					id: `${accountId}-${i}`,
					startedAt: AT - (i + 1) * DAY,
					resetsAt: AT - i * DAY,
					closedAt: AT - i * DAY - HOUR,
					value: 123456.789012,
					points: 100,
					counterResets: 12,
				});
		}
		config = JSON.stringify(mappings);
		const response = await handler();
		expect(response.status).toBe(200);
		const text = await response.text();
		const body = JSON.parse(text);
		expect(body.subscriptions).toHaveLength(16);
		for (const sub of body.subscriptions) {
			expect(sub.completed).toHaveLength(32);
			expect(sub.periods).toHaveLength(5);
		}
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024);
	});
});

describe("public subscription value feed, plan", () => {
	const ULTRA = {
		key: "claude-ultra",
		name: "Claude Ultra",
		formerName: "Claude Max 20x",
		monthlyUsd: 200,
		priceSource: "https://claude.com/pricing",
		priceCheckedOn: "2026-11-23",
	};
	const setPlan = (plan: string | null) =>
		db
			.getAdapter()
			.run("UPDATE accounts SET public_value_plan = ? WHERE id = ?", [
				plan,
				mapping.accountId,
			]);
	const planWarnings = () =>
		warn.mock.calls.filter((call) =>
			String(call[0]).includes("plan not in the catalog"),
		);

	it("sends exactly the six-key catalog object for a stored plan", async () => {
		await setPlan("claude-ultra");
		const body = await (await handler()).json();
		const [sub] = body.subscriptions;
		expect(sub.plan).toEqual(ULTRA);
		expect(Object.keys(sub.plan)).toEqual([
			"key",
			"name",
			"formerName",
			"monthlyUsd",
			"priceSource",
			"priceCheckedOn",
		]);
		const example = JSON.parse(readFileSync(EXAMPLE_PATH, "utf8"));
		expect(sub.plan).toEqual(example.subscriptions[0].plan);
	});

	it("sends null when no plan is stored", async () => {
		const response = await handler();
		expect(response.status).toBe(200);
		expect((await response.json()).subscriptions[0].plan).toBeNull();
	});

	it("sends null, stays 200 and warns once for a stored key the catalog no longer holds", async () => {
		await setPlan("retired-plan");
		const second = { ...mapping, accountId: "second", id: "other", label: "B" };
		await db
			.getAdapter()
			.run(
				"INSERT INTO accounts (id,name,provider,created_at,public_value_plan) VALUES ('second','n2','anthropic',100,'retired-plan')",
			);
		config = JSON.stringify([mapping, second]);
		const response = await handler();
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.subscriptions.map((s: { plan: unknown }) => s.plan)).toEqual([
			null,
			null,
		]);
		expect(planWarnings()).toHaveLength(1);
		expect(JSON.stringify(planWarnings()[0])).toContain("retired-plan");
		// A rebuild after the cache expired, a minute on, may warn again.
		now += MAX_AGE_MS;
		expect((await handler()).status).toBe(200);
		expect(planWarnings()).toHaveLength(2);
	});

	it("does not log a warning for a catalog key", async () => {
		await setPlan("claude-max");
		expect((await handler()).status).toBe(200);
		expect(planWarnings()).toHaveLength(0);
	});
});
