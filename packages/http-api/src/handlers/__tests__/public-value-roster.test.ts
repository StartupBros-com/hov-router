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

const scratch = mkdtempSync(join(tmpdir(), "ccflare-public-roster-"));
process.env.BETTER_CCFLARE_DB_PATH = join(scratch, "isolated.db");
process.env.BETTER_CCFLARE_CONFIG_PATH = join(scratch, "isolated-config.json");
process.env.DATABASE_URL = "";
const { VALUE_PRICING_VERSION } = await import("@hov-router/core");
const { DatabaseOperations } = await import("@hov-router/database");
const { createPublicSubscriptionValueHandler } = await import(
	"../public-subscription-value"
);
const { createAccountPublicValueHandler } = await import(
	"../account-public-value"
);
const { getPublicRosterGeneration } = await import(
	"../../services/public-subscription-roster"
);
const { isValidPublicId } = await import(
	"../../services/public-subscriptions-config"
);
const { APIRouter } = await import("../../router");
const { createAccountRenameHandler } = await import("../accounts");

const db = new DatabaseOperations(":memory:");
const context = { dbOps: db } as APIContext;
const write = createAccountPublicValueHandler(db);
let now = 1000;
let feed: ReturnType<typeof createPublicSubscriptionValueHandler>;
let warn: ReturnType<typeof spyOn<Logger, "warn">>;
let info: ReturnType<typeof spyOn<Logger, "info">>;
let error: ReturnType<typeof spyOn<Logger, "error">>;

async function addAccount(id: string, name: string, createdAt = 100) {
	await db
		.getAdapter()
		.run(
			"INSERT INTO accounts (id,name,provider,created_at) VALUES (?, ?, 'anthropic', ?)",
			[id, name, createdAt],
		);
}
function post(accountId: string, body: unknown) {
	return write(
		new Request(`http://localhost/api/accounts/${accountId}/public-value`, {
			method: "POST",
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
		accountId,
	);
}
interface PublicRow {
	public_value_enabled: number;
	public_value_label: string | null;
	public_value_id: string | null;
}
async function row(id: string): Promise<PublicRow> {
	return (await db
		.getAdapter()
		.getMain<PublicRow>(
			"SELECT public_value_enabled, public_value_label, public_value_id FROM accounts WHERE id = ?",
			[id],
		)) as PublicRow;
}
async function snapshot(): Promise<string> {
	return JSON.stringify(
		await db
			.getAdapter()
			.queryMain(
				"SELECT id, public_value_enabled, public_value_label, public_value_id FROM accounts ORDER BY id",
			),
	);
}
async function feedBody() {
	now++;
	const response = await feed();
	return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
	await db.getAdapter().run("DELETE FROM usage_windows");
	await db.getAdapter().run("DELETE FROM usage_snapshots");
	await db.getAdapter().run("DELETE FROM accounts");
	now = 1000;
	feed = createPublicSubscriptionValueHandler(context, {
		getConfig: () => "accounts",
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

describe("public-value write endpoint", () => {
	it("publishes with a label, generates an opaque id and reports the state", async () => {
		await addAccount("acct-1", "private-name");
		const response = await post("acct-1", { enabled: true, label: "Weekly A" });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			publicValueEnabled: true,
			publicValueLabel: "Weekly A",
		});
		const stored = await row("acct-1");
		expect(stored.public_value_enabled).toBe(1);
		expect(stored.public_value_label).toBe("Weekly A");
		expect(isValidPublicId(stored.public_value_id)).toBe(true);
		expect(stored.public_value_id).toMatch(/^sub-[0-9a-f]{16}$/);
		expect(stored.public_value_id).not.toContain("acct-1");
	});

	it("returns 404 for an unknown account and 400 for malformed bodies, writing nothing", async () => {
		await addAccount("acct-1", "private-name");
		const before = await snapshot();
		expect((await post("nope", { enabled: false })).status).toBe(404);
		for (const body of [
			"{not json",
			"[]",
			"null",
			{},
			{ enabled: 1 },
			{ enabled: "true" },
			{ enabled: true, label: 5 },
			{ enabled: true, label: null },
		]) {
			expect((await post("acct-1", body)).status).toBe(400);
		}
		expect(await snapshot()).toBe(before);
	});

	it("refuses (400, nothing written) a missing, untrimmed, name- or id-bearing or invalid label", async () => {
		await addAccount("acct-1", "Private Name");
		const before = await snapshot();
		const bad = [
			{ enabled: true },
			{ enabled: true, label: " padded" },
			{ enabled: true, label: "padded " },
			{ enabled: true, label: "" },
			{ enabled: true, label: "has <tag>" },
			{ enabled: true, label: "tab\tchar" },
			{ enabled: true, label: "x".repeat(81) },
			{ enabled: true, label: "My private name sub" },
			{ enabled: true, label: "ACCT-1 plan" },
			{ enabled: false, label: " padded" },
			{ enabled: false, label: "contains PRIVATE NAME" },
		];
		for (const body of bad) {
			expect((await post("acct-1", body)).status).toBe(400);
		}
		expect(await snapshot()).toBe(before);
	});

	it("refuses a duplicate label case-insensitively but allows re-labelling itself", async () => {
		await addAccount("zq-1", "name-one");
		await addAccount("zq-2", "name-two");
		expect(
			(await post("zq-1", { enabled: true, label: "Plan X" })).status,
		).toBe(200);
		const before = await snapshot();
		expect(
			(await post("zq-2", { enabled: true, label: "plan x" })).status,
		).toBe(400);
		expect(await snapshot()).toBe(before);
		expect(
			(await post("zq-1", { enabled: true, label: "PLAN X" })).status,
		).toBe(200);
		// An unpublished account's label does not reserve the name.
		expect((await post("zq-1", { enabled: false })).status).toBe(200);
		expect(
			(await post("zq-2", { enabled: true, label: "Plan X" })).status,
		).toBe(200);
		// ...but it cannot be re-published into a collision.
		expect((await post("zq-1", { enabled: true })).status).toBe(400);
	});

	it("refuses the 17th published account and writes nothing", async () => {
		for (let i = 0; i < 17; i++) await addAccount(`a${i}`, `name-${i}`);
		for (let i = 0; i < 16; i++)
			expect(
				(await post(`a${i}`, { enabled: true, label: `Sub ${i}` })).status,
			).toBe(200);
		const before = await snapshot();
		expect((await post("a16", { enabled: true, label: "Sub 16" })).status).toBe(
			400,
		);
		expect(await snapshot()).toBe(before);
		// An already-published account can still be edited at the cap.
		expect((await post("a0", { enabled: true, label: "Renamed" })).status).toBe(
			200,
		);
	});

	it("keeps the public id across relabel, unpublish and republish; unpublish keeps the label", async () => {
		await addAccount("acct-1", "private-name");
		await post("acct-1", { enabled: true, label: "First" });
		const id = (await row("acct-1")).public_value_id;
		await post("acct-1", { enabled: true, label: "Second" });
		expect((await row("acct-1")).public_value_id).toBe(id);
		const off = await post("acct-1", { enabled: false });
		expect(await off.json()).toMatchObject({
			publicValueEnabled: false,
			publicValueLabel: "Second",
		});
		expect(await row("acct-1")).toMatchObject({
			public_value_enabled: 0,
			public_value_label: "Second",
			public_value_id: id,
		});
		await post("acct-1", { enabled: true });
		expect(await row("acct-1")).toMatchObject({
			public_value_enabled: 1,
			public_value_label: "Second",
			public_value_id: id,
		});
	});

	it("stores a valid label for an unpublished account and generates distinct ids", async () => {
		await addAccount("zq-1", "name-one");
		await addAccount("zq-2", "name-two");
		await post("zq-1", { enabled: false, label: "Stored only" });
		expect(await row("zq-1")).toMatchObject({
			public_value_enabled: 0,
			public_value_label: "Stored only",
			public_value_id: null,
		});
		await post("zq-1", { enabled: true });
		await post("zq-2", { enabled: true, label: "Other" });
		expect((await row("zq-1")).public_value_id).not.toBe(
			(await row("zq-2")).public_value_id,
		);
	});

	it("bumps the roster generation on a successful write only", async () => {
		await addAccount("acct-1", "private-name");
		const start = getPublicRosterGeneration();
		await post("acct-1", { enabled: true });
		expect(getPublicRosterGeneration()).toBe(start);
		await post("acct-1", { enabled: true, label: "Ok" });
		expect(getPublicRosterGeneration()).toBeGreaterThan(start);
	});
});

describe("public-value write authorization", () => {
	it("answers 401 to an unauthenticated write while an API key is active", async () => {
		const router = new APIRouter({
			dbOps: {
				getAdapter: () => ({}),
				countActiveApiKeys: async () => 1,
				getActiveApiKeys: async () => [],
			},
			config: {},
		} as unknown as APIContext);
		const url = new URL("http://localhost/api/accounts/acct-1/public-value");
		const response = await router.handleRequest(
			url,
			new Request(url, {
				method: "POST",
				body: JSON.stringify({ enabled: true, label: "X" }),
			}),
		);
		expect(response?.status).toBe(401);
	});
});

describe("public-value route dispatch", () => {
	it("routes an authorized POST to the handler instead of falling through", async () => {
		const router = new APIRouter({
			dbOps: {
				getAdapter: () => ({}),
				countActiveApiKeys: async () => 0,
				getActiveApiKeys: async () => [],
			},
			config: {},
		} as unknown as APIContext);
		const url = new URL("http://localhost/api/accounts/acct-1/public-value");
		const response = await router.handleRequest(
			url,
			new Request(url, { method: "POST", body: "{}" }),
		);
		expect(response?.status).toBe(400);
	});
});

describe("public subscription value feed, accounts mode", () => {
	it("serves an empty roster with 200 and exact schema keys", async () => {
		const { status, body } = await feedBody();
		expect(status).toBe(200);
		expect(body).toEqual({
			schemaVersion: 2,
			valueBasis: "api_equivalent_usd",
			windowKey: "seven_day",
			pricingVersion: VALUE_PRICING_VERSION,
			generatedAt: now,
			subscriptions: [],
		});
	});

	it("publishes only enabled accounts, ordered by label then created_at, with public ids only", async () => {
		await addAccount("zq-1", "name-one", 300);
		await addAccount("zq-2", "name-two", 200);
		await addAccount("zq-3", "name-three", 100);
		await addAccount("zq-4", "name-four", 50);
		await post("zq-1", { enabled: true, label: "beta" });
		await post("zq-2", { enabled: true, label: "Alpha" });
		await post("zq-3", { enabled: true, label: "Gamma" });
		const { status, body } = await feedBody();
		expect(status).toBe(200);
		expect(body.subscriptions.map((s: { label: string }) => s.label)).toEqual([
			"Alpha",
			"beta",
			"Gamma",
		]);
		const text = JSON.stringify(body);
		for (const secret of ["zq-", "name-"]) expect(text).not.toContain(secret);
		expect(body.subscriptions[0].id).toBe((await row("zq-2")).public_value_id);
	});

	it("fails closed on labels that differ only by case", async () => {
		await addAccount("late", "name-late", 500);
		await addAccount("early", "name-early", 100);
		await post("late", { enabled: true, label: "Same" });
		// The unique index now makes this state unreachable; drop it to model a
		// legacy database that still holds the duplicate, then restore it.
		await db
			.getAdapter()
			.run("DROP INDEX idx_accounts_public_value_label_unique");
		try {
			await db
				.getAdapter()
				.run(
					"UPDATE accounts SET public_value_enabled = 1, public_value_label = 'SAME', public_value_id = 'sub-dup0000000000001' WHERE id = 'early'",
				);
			// Duplicate labels (case-insensitive) fail the whole feed closed.
			expect((await feedBody()).status).toBe(503);
		} finally {
			await db.getAdapter().run("DELETE FROM accounts");
			await db
				.getAdapter()
				.run(
					"CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_public_value_label_unique ON accounts(lower(public_value_label)) WHERE public_value_enabled = 1",
				);
		}
	});

	it("keeps the public id stable across relabel and republish in the feed", async () => {
		await addAccount("zq-1", "name-one");
		await post("zq-1", { enabled: true, label: "One" });
		const first = (await feedBody()).body.subscriptions[0].id;
		await post("zq-1", { enabled: true, label: "Uno" });
		await post("zq-1", { enabled: false });
		await post("zq-1", { enabled: true });
		const again = (await feedBody()).body.subscriptions[0];
		expect(again.id).toBe(first);
		expect(again.label).toBe("Uno");
	});

	it("never serves an unpublished account, even inside the cache window", async () => {
		await addAccount("zq-1", "name-one");
		await post("zq-1", { enabled: true, label: "Visible" });
		expect((await feedBody()).body.subscriptions).toHaveLength(1);
		// Still well inside the 60 s window.
		await post("zq-1", { enabled: false });
		const after = await feedBody();
		expect(after.status).toBe(200);
		expect(after.body.subscriptions).toEqual([]);
		expect(JSON.stringify(after.body)).not.toContain("Visible");
	});

	it("serves a label change on the next request", async () => {
		await addAccount("zq-1", "name-one");
		await post("zq-1", { enabled: true, label: "Before" });
		await feedBody();
		await post("zq-1", { enabled: true, label: "After" });
		expect((await feedBody()).body.subscriptions[0].label).toBe("After");
	});

	it("reads the roster only on a cache miss", async () => {
		await addAccount("zq-1", "name-one");
		await post("zq-1", { enabled: true, label: "One" });
		const read = spyOn(db, "listPublishedPublicValue");
		try {
			expect((await feedBody()).status).toBe(200);
			expect(read).toHaveBeenCalledTimes(1);
			expect((await feedBody()).status).toBe(200);
			expect(read).toHaveBeenCalledTimes(1);
		} finally {
			read.mockRestore();
		}
	});

	it("omits an account deleted and recreated under the same name until republished", async () => {
		await addAccount("old-id", "same-name", 100);
		await post("old-id", { enabled: true, label: "Mine" });
		expect((await feedBody()).body.subscriptions).toHaveLength(1);
		await db.getAdapter().run("DELETE FROM accounts WHERE id = 'old-id'");
		await addAccount("new-id", "same-name", 900);
		// A direct DB delete does not bump; the TTL bound applies, then it is gone.
		now += 61_000;
		const gone = await feedBody();
		expect(gone.status).toBe(200);
		expect(gone.body.subscriptions).toEqual([]);
		await post("new-id", { enabled: true, label: "Mine" });
		const back = await feedBody();
		expect(back.body.subscriptions).toHaveLength(1);
		expect(back.body.subscriptions[0].id).not.toBe("old-id");
	});

	it("fails closed (generic 503) on invalid stored values, more than 16 rows, and duplicate ids", async () => {
		const adapter = db.getAdapter();
		await addAccount("zq-1", "name-one");
		await adapter.run(
			"UPDATE accounts SET public_value_enabled = 1, public_value_label = ' bad', public_value_id = 'sub-ok00000000000001' WHERE id = 'zq-1'",
		);
		let result = await feedBody();
		expect(result.status).toBe(503);
		expect(result.body).toEqual({ error: "Unavailable" });

		await adapter.run(
			"UPDATE accounts SET public_value_label = 'Fine', public_value_id = 'bad id!' WHERE id = 'zq-1'",
		);
		expect((await feedBody()).status).toBe(503);

		await adapter.run(
			"UPDATE accounts SET public_value_id = 'sub-ok00000000000001' WHERE id = 'zq-1'",
		);
		await addAccount("zq-2", "name-two");
		await adapter.run(
			"UPDATE accounts SET public_value_enabled = 1, public_value_label = 'Fine 2', public_value_id = 'sub-ok00000000000001' WHERE id = 'zq-2'",
		);
		expect((await feedBody()).status).toBe(503);

		await adapter.run("DELETE FROM accounts");
		for (let i = 0; i < 17; i++) {
			await addAccount(`m${i}`, `n${i}`);
			await adapter.run(
				"UPDATE accounts SET public_value_enabled = 1, public_value_label = ?, public_value_id = ? WHERE id = ?",
				[`L${i}`, `sub-${String(i).padStart(16, "0")}`, `m${i}`],
			);
		}
		result = await feedBody();
		expect(result.status).toBe(503);
		expect(result.body).toEqual({ error: "Unavailable" });
	});

	it("does not cache or serve a refresh that straddles a roster write", async () => {
		await addAccount("zq-1", "name-one");
		await post("zq-1", { enabled: true, label: "One" });
		// Gate a feed-only read so the concurrent admin write is not blocked.
		const original = db.getLatestUsageSnapshot.bind(db);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const spy = spyOn(db, "getLatestUsageSnapshot").mockImplementation(
			async (...args) => {
				await gate;
				return original(...args);
			},
		);
		try {
			now++;
			const pending = feed();
			await new Promise((resolve) => setTimeout(resolve, 10));
			await post("zq-1", { enabled: false });
			release();
			expect((await pending).status).toBe(503);
		} finally {
			spy.mockRestore();
		}
		const next = await feedBody();
		expect(next.status).toBe(200);
		expect(next.body.subscriptions).toEqual([]);
	});

	it("rejects a row whose published state changed between roster read and re-fetch", async () => {
		await addAccount("zq-1", "name-one");
		await post("zq-1", { enabled: true, label: "One" });
		const original = db.getAccount.bind(db);
		const spy = spyOn(db, "getAccount").mockImplementation(async (id) => {
			const account = await original(id);
			return account && { ...account, public_value_label: "Changed" };
		});
		try {
			expect((await feedBody()).status).toBe(503);
		} finally {
			spy.mockRestore();
		}
	});

	it("uses an injected roster generation and a key distinct from env raw values", async () => {
		await addAccount("zq-1", "name-one");
		await post("zq-1", { enabled: true, label: "One" });
		let generation = 1;
		const injected = createPublicSubscriptionValueHandler(context, {
			getConfig: () => "accounts",
			now: () => now,
			getRosterGeneration: () => generation,
		});
		expect((await injected()).status).toBe(200);
		await db
			.getAdapter()
			.run("UPDATE accounts SET public_value_enabled = 0 WHERE id = 'zq-1'");
		now++;
		expect((await (await injected()).json()).subscriptions).toHaveLength(1);
		generation = 2;
		now++;
		expect((await (await injected()).json()).subscriptions).toEqual([]);
	});

	it("keeps env-array mode and the disabled state unchanged", async () => {
		const env = createPublicSubscriptionValueHandler(context, {
			getConfig: () => undefined,
			now: () => now,
		});
		expect((await env()).status).toBe(404);
		const spyRead = spyOn(db, "listPublishedPublicValue");
		try {
			const array = createPublicSubscriptionValueHandler(context, {
				getConfig: () => "[]",
				now: () => now,
			});
			const response = await array();
			expect(response.status).toBe(200);
			expect((await response.json()).subscriptions).toEqual([]);
			expect(spyRead).not.toHaveBeenCalled();
		} finally {
			spyRead.mockRestore();
		}
	});
});

describe("renaming a published account", () => {
	function rename(accountId: string, name: string) {
		return createAccountRenameHandler(db)(
			new Request(`http://localhost/api/accounts/${accountId}/rename`, {
				method: "POST",
				body: JSON.stringify({ name }),
			}),
			accountId,
		);
	}

	it("refuses a rename into a name its public label contains, writing nothing", async () => {
		await addAccount("rn-1", "work");
		expect(
			(await post("rn-1", { enabled: true, label: "Team Alpha" })).status,
		).toBe(200);
		const before = await snapshot();
		const generation = getPublicRosterGeneration();
		const response = await rename("rn-1", "alpha");
		expect(response.status).toBe(400);
		expect(await snapshot()).toBe(before);
		const name = await db
			.getAdapter()
			.getMain<{ name: string }>("SELECT name FROM accounts WHERE id = ?", [
				"rn-1",
			]);
		expect(name?.name).toBe("work");
		expect(getPublicRosterGeneration()).toBe(generation);
	});

	it("allows a harmless rename of a published account and invalidates the feed", async () => {
		await addAccount("rn-2", "work");
		await post("rn-2", { enabled: true, label: "Team Alpha" });
		const generation = getPublicRosterGeneration();
		expect((await rename("rn-2", "other")).status).toBe(200);
		expect(getPublicRosterGeneration()).toBeGreaterThan(generation);
	});

	it("allows any rename of an unpublished account", async () => {
		await addAccount("rn-3", "work");
		await post("rn-3", { enabled: true, label: "Team Alpha" });
		await post("rn-3", { enabled: false });
		expect((await rename("rn-3", "alpha")).status).toBe(200);
	});

	it("fails the feed closed when a stored label comes to contain the account name", async () => {
		await addAccount("rn-4", "work");
		await post("rn-4", { enabled: true, label: "Team Alpha" });
		expect((await feedBody()).status).toBe(200);
		await db
			.getAdapter()
			.run("UPDATE accounts SET name = 'alpha' WHERE id = 'rn-4'");
		now += 10 * 60 * 1000;
		expect((await feedBody()).status).toBe(503);
	});
});

describe("cross-process roster revalidation", () => {
	const { ROSTER_RECHECK_MS } = require("../public-subscription-value");
	function instance(clock: { t: number }) {
		return createPublicSubscriptionValueHandler(context, {
			getConfig: () => "accounts",
			now: () => clock.t,
			getRosterGeneration: () => 0,
		});
	}
	async function labels(handler: () => Promise<Response>) {
		const response = await handler();
		return {
			status: response.status,
			labels: ((await response.json()).subscriptions ?? []).map(
				(s: { label: string }) => s.label,
			),
		};
	}

	it("a second process notices an unpublish within ROSTER_RECHECK_MS, querying at most once per window", async () => {
		expect(ROSTER_RECHECK_MS).toBe(5000);
		await addAccount("xp-1", "name-one");
		expect((await post("xp-1", { enabled: true, label: "Alpha" })).status).toBe(
			200,
		);
		const a = { t: 10_000 };
		const b = { t: 10_000 };
		const first = instance(a);
		const second = instance(b);
		expect((await labels(first)).labels).toEqual(["Alpha"]);
		expect((await labels(second)).labels).toEqual(["Alpha"]);
		// Another process unpublishes: direct write, no generation bump here.
		await db
			.getAdapter()
			.run("UPDATE accounts SET public_value_enabled = 0 WHERE id = 'xp-1'");
		const read = spyOn(db, "listPublishedPublicValue");
		try {
			b.t += 4000;
			// Documents the bound: inside the window the cache may still be served.
			expect((await labels(second)).labels).toEqual(["Alpha"]);
			expect(read).toHaveBeenCalledTimes(0);
			b.t += 1000;
			const results = await Promise.all([
				labels(second),
				labels(second),
				labels(second),
			]);
			for (const r of results) expect(r.labels).toEqual([]);
			// One shared recheck, then the refresh's own roster read.
			expect(read.mock.calls.length).toBeLessThanOrEqual(2);
			const afterRecheck = read.mock.calls.length;
			for (let i = 0; i < 5; i++) {
				b.t += 500;
				await labels(second);
			}
			expect(read.mock.calls.length).toBe(afterRecheck);
		} finally {
			read.mockRestore();
		}
	});

	it("rechecks an unchanged roster at most once per window and keeps serving", async () => {
		await addAccount("xp-1", "name-one");
		await post("xp-1", { enabled: true, label: "Alpha" });
		const clock = { t: 20_000 };
		const handler = instance(clock);
		await labels(handler);
		const read = spyOn(db, "listPublishedPublicValue");
		try {
			for (let i = 0; i < 20; i++) {
				clock.t += 1000;
				expect((await labels(handler)).labels).toEqual(["Alpha"]);
			}
			// 20 s of requests, one recheck per 5 s window.
			expect(read.mock.calls.length).toBe(4);
		} finally {
			read.mockRestore();
		}
	});

	it("fails closed with 503 when the recheck query throws, never serving the cached body", async () => {
		await addAccount("xp-1", "name-one");
		await post("xp-1", { enabled: true, label: "Alpha" });
		const clock = { t: 30_000 };
		const handler = instance(clock);
		expect((await labels(handler)).labels).toEqual(["Alpha"]);
		const read = spyOn(db, "listPublishedPublicValue").mockRejectedValue(
			new Error("db down"),
		);
		try {
			clock.t += ROSTER_RECHECK_MS;
			const response = await handler();
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: "Unavailable" });
		} finally {
			read.mockRestore();
		}
	});
});

describe("rebuild ahead of expiry", () => {
	const {
		MAX_AGE_MS,
		REBUILD_LEAD_MS,
		REBUILD_MIN_DELAY_MS,
		REBUILD_RETRY_MS,
		REQUEST_WAIT_MS,
	} = require("../public-subscription-value");
	const perAccountReads = [
		"getLatestUsageSnapshot",
		"getOpenUsageWindow",
		"listUsageWindows",
		"getAccount",
		"aggregateTokensByModel",
	] as const;

	/** A scheduler the test fires by hand, as if each delay had passed. */
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
			live() {
				return timers.filter((timer) => !timer.cancelled);
			},
			/** Starts the one live timer; resolves when its rebuild has finished. */
			fire() {
				const live = timers.filter((timer) => !timer.cancelled);
				expect(live.length).toBe(1);
				const [timer] = live;
				timer.cancelled = true;
				return timer.run();
			},
		};
	}

	async function publishWithOpenWindow(resetsAt = 10_000_000) {
		await addAccount("rb-1", "private-name");
		expect((await post("rb-1", { enabled: true, label: "Alpha" })).status).toBe(
			200,
		);
		await db.openUsageWindow({
			accountId: "rb-1",
			windowKey: "seven_day",
			startedAt: 200,
			resetsAt,
			grantType: "natural",
		});
	}

	function instance(
		clock: { t: number },
		timers: ReturnType<typeof manualScheduler>,
	) {
		return createPublicSubscriptionValueHandler(context, {
			getConfig: () => "accounts",
			now: () => clock.t,
			schedule: timers.schedule,
		});
	}

	async function generatedAt(handler: () => Promise<Response>) {
		const response = await handler();
		expect(response.status).toBe(200);
		return (await response.json()).generatedAt as number;
	}

	it("answers a request after the first body's expiry from a body the timer built, with no per-account reads", async () => {
		await publishWithOpenWindow();
		const clock = { t: 10_000 };
		const timers = manualScheduler();
		const handler = instance(clock, timers);
		expect(await generatedAt(handler)).toBe(10_000);
		expect(timers.live().map((timer) => timer.delayMs)).toEqual([
			60_000 - REBUILD_LEAD_MS,
		]);
		clock.t = 10_000 + 60_000 - REBUILD_LEAD_MS;
		await timers.fire();
		const reads = perAccountReads.map((method) => spyOn(db, method));
		try {
			// The first body expired at 70_000.
			clock.t = 71_000;
			expect(await generatedAt(handler)).toBe(55_000);
			for (const read of reads) expect(read).toHaveBeenCalledTimes(0);
		} finally {
			for (const read of reads) read.mockRestore();
		}
		// The timer re-armed from the body it built.
		expect(timers.live().map((timer) => timer.delayMs)).toEqual([
			60_000 - REBUILD_LEAD_MS,
		]);
	});

	for (const variant of [
		"captured-expired",
		"captured-still-servable",
		"warmed-plan-changed",
		"raw-changed",
		"generation-changed",
		"roster-rejected",
		"roster-deadline",
	] as const) {
		it(`preserves the warmed timer across a held roster read: ${variant}`, async () => {
			await publishWithOpenWindow();
			expect(
				(await post("rb-1", { enabled: true, plan: "claude-pro" })).status,
			).toBe(200);
			const originalAt = 10_000;
			const warmedAt = originalAt + 60_000 - REBUILD_LEAD_MS;
			const expiresAt = originalAt + MAX_AGE_MS;
			const clock = { t: originalAt };
			const timers = manualScheduler();
			let raw: string | undefined = "accounts";
			let generation = getPublicRosterGeneration();
			const handler = createPublicSubscriptionValueHandler(context, {
				getConfig: () => raw,
				getRosterGeneration: () => generation,
				now: () => clock.t,
				schedule: timers.schedule,
			});
			expect(await generatedAt(handler)).toBe(originalAt);
			const roster = db.listPublishedPublicValue.bind(db);
			const rosterBefore = await roster(17);
			if (variant === "warmed-plan-changed")
				await db
					.getAdapter()
					.run(
						"UPDATE accounts SET public_value_plan = 'claude-max' WHERE id = 'rb-1'",
					);

			const building = Promise.withResolvers<void>();
			const finishBuild = Promise.withResolvers<void>();
			const heldRoster = Promise.withResolvers<typeof rosterBefore>();
			const snapshot = db.getLatestUsageSnapshot.bind(db);
			const delayBuild = spyOn(
				db,
				"getLatestUsageSnapshot",
			).mockImplementationOnce(async (...args) => {
				building.resolve();
				await finishBuild.promise;
				return snapshot(...args);
			});
			clock.t = warmedAt;
			const rebuilding = timers.fire();
			try {
				await building.promise;
				const read = spyOn(
					db,
					"listPublishedPublicValue",
				).mockImplementationOnce(() => heldRoster.promise);
				try {
					clock.t = expiresAt - 1_000;
					const checking = handler();
					expect(read).toHaveBeenCalledTimes(1);
					const [deadline] = timers.live();
					expect(deadline.delayMs).toBe(REQUEST_WAIT_MS);
					clock.t = expiresAt - 500;
					finishBuild.resolve();
					await rebuilding;
					const warmed = timers.live().find((timer) => timer !== deadline);
					expect(warmed?.delayMs).toBe(60_000 - REBUILD_LEAD_MS);
					const reads = perAccountReads
						.filter((method) => method !== "getLatestUsageSnapshot")
						.map((method) => spyOn(db, method));
					try {
						if (variant === "raw-changed") raw = undefined;
						if (variant === "generation-changed") generation++;
						clock.t =
							variant === "captured-still-servable"
								? expiresAt - 100
								: expiresAt + 1_000;
						if (variant === "roster-deadline") {
							clock.t = expiresAt - 1_000 + REQUEST_WAIT_MS;
							await deadline.run();
						} else if (variant === "roster-rejected") {
							heldRoster.reject(new Error("fixture roster error"));
						} else {
							heldRoster.resolve(rosterBefore);
						}
						const served = await checking;
						expect(served.headers.get("Cache-Control")).toBe("no-store");
						if (
							variant === "captured-expired" ||
							variant === "captured-still-servable"
						) {
							expect(served.status).toBe(200);
							expect(await served.json()).toMatchObject({
								schemaVersion: 2,
								generatedAt:
									variant === "captured-expired" ? warmedAt : originalAt,
							});
						} else {
							expect(served.status).toBe(503);
							expect(await served.json()).toEqual({ error: "Unavailable" });
						}
						expect(timers.live()).toEqual([warmed]);
						expect(timers.live()[0]).toBe(warmed);
						expect(delayBuild).toHaveBeenCalledTimes(1);
						for (const accountRead of reads)
							expect(accountRead).toHaveBeenCalledTimes(0);
					} finally {
						for (const accountRead of reads) accountRead.mockRestore();
					}
				} finally {
					heldRoster.resolve(rosterBefore);
					read.mockRestore();
				}
			} finally {
				finishBuild.resolve();
				await rebuilding;
				delayBuild.mockRestore();
			}
		});
	}

	it("lets a request that arrives during the timer's rebuild join it instead of starting another", async () => {
		await publishWithOpenWindow();
		const clock = { t: 10_000 };
		const timers = manualScheduler();
		const handler = instance(clock, timers);
		await generatedAt(handler);
		clock.t = 55_000;
		const aggregate = spyOn(db, "aggregateTokensByModel");
		try {
			const rebuilding = timers.fire();
			clock.t = 71_000;
			// The first body is still servable, so the request answers from it at
			// once and joins the timer's running build instead of starting another.
			const [served] = await Promise.all([generatedAt(handler), rebuilding]);
			expect(served).toBe(10_000);
			expect(aggregate).toHaveBeenCalledTimes(1);
		} finally {
			aggregate.mockRestore();
		}
		expect(timers.live().length).toBe(1);
	});

	it("still rebuilds in the request after a roster change, and the timer follows the new roster", async () => {
		await publishWithOpenWindow();
		const clock = { t: 10_000 };
		const timers = manualScheduler();
		const handler = instance(clock, timers);
		await generatedAt(handler);
		expect((await post("rb-1", { enabled: true, label: "Beta" })).status).toBe(
			200,
		);
		clock.t = 11_000;
		const response = await handler();
		const body = await response.json();
		expect(body.generatedAt).toBe(11_000);
		expect(body.subscriptions.map((s: { label: string }) => s.label)).toEqual([
			"Beta",
		]);
		// The request's rebuild replaced the first timer with its own.
		expect(timers.live().length).toBe(1);
		expect((await post("rb-1", { enabled: true, label: "Gamma" })).status).toBe(
			200,
		);
		clock.t = 56_000;
		await timers.fire();
		clock.t = 57_000;
		const after = await (await handler()).json();
		expect(after.generatedAt).toBe(56_000);
		expect(after.subscriptions.map((s: { label: string }) => s.label)).toEqual([
			"Gamma",
		]);
	});

	it("keeps the request path working after a failed timer rebuild, and retries", async () => {
		await publishWithOpenWindow();
		const clock = { t: 10_000 };
		const timers = manualScheduler();
		const handler = instance(clock, timers);
		await generatedAt(handler);
		const roster = spyOn(db, "listPublishedPublicValue").mockRejectedValueOnce(
			new Error("db busy"),
		);
		try {
			clock.t = 55_000;
			await timers.fire();
		} finally {
			roster.mockRestore();
		}
		expect(timers.live().map((timer) => timer.delayMs)).toEqual([
			REBUILD_RETRY_MS,
		]);
		// Still inside the first body's lifetime: served as before.
		clock.t = 60_000;
		expect(await generatedAt(handler)).toBe(10_000);
		// At MAX_AGE_MS it is never served, and the request rebuilds.
		clock.t = 10_000 + MAX_AGE_MS;
		expect(await generatedAt(handler)).toBe(10_000 + MAX_AGE_MS);
		expect(timers.live().length).toBe(1);
	});

	it("rebuilds a body clamped to a window reset at the reset, never in a loop", async () => {
		await publishWithOpenWindow(30_000);
		const clock = { t: 10_000 };
		const timers = manualScheduler();
		const handler = instance(clock, timers);
		await generatedAt(handler);
		// Expiry is the reset at 30_000, not 70_000; rebuilding earlier cannot move it.
		expect(timers.live().map((timer) => timer.delayMs)).toEqual([20_000]);
		clock.t = 28_000;
		const near = manualScheduler();
		const late = instance(clock, near);
		await generatedAt(late);
		expect(near.live().map((timer) => timer.delayMs)).toEqual([
			REBUILD_MIN_DELAY_MS,
		]);
	});

	it("stops when the feed is disabled", async () => {
		await publishWithOpenWindow();
		const clock = { t: 10_000 };
		const timers = manualScheduler();
		let config = "accounts";
		const handler = createPublicSubscriptionValueHandler(context, {
			getConfig: () => config,
			now: () => clock.t,
			schedule: timers.schedule,
		});
		await generatedAt(handler);
		config = "";
		const roster = spyOn(db, "listPublishedPublicValue");
		try {
			clock.t = 55_000;
			await timers.fire();
			expect(roster).toHaveBeenCalledTimes(0);
		} finally {
			roster.mockRestore();
		}
		expect(timers.live().length).toBe(0);
	});

	it("schedules the default timer so it never keeps the process alive", async () => {
		await publishWithOpenWindow();
		const timeouts = spyOn(globalThis, "setTimeout");
		try {
			const handler = createPublicSubscriptionValueHandler(context, {
				getConfig: () => "accounts",
			});
			const before = timeouts.mock.results.length;
			expect((await handler()).status).toBe(200);
			const scheduled = timeouts.mock.results
				.slice(before)
				.map((result) => result.value as ReturnType<typeof setTimeout>);
			// The request deadline and the rebuild timer.
			expect(scheduled.length).toBe(2);
			for (const timer of scheduled) expect(timer.hasRef()).toBe(false);
			for (const timer of scheduled) clearTimeout(timer);
		} finally {
			timeouts.mockRestore();
		}
	});
});

describe("atomic publish write", () => {
	async function publishDirect(
		id: string,
		label: string,
		publicId = `sub-${id.padEnd(16, "0")}`,
	) {
		return db.setPublicValue(id, { enabled: true, label, publicId });
	}

	it("refuses a 17th published row and writes nothing", async () => {
		for (let i = 0; i < 17; i++) await addAccount(`cap-${i}`, `n${i}`);
		for (let i = 0; i < 16; i++)
			expect(await publishDirect(`cap-${i}`, `Label ${i}`)).toBe(true);
		const before = await snapshot();
		expect(await publishDirect("cap-16", "Label 16")).toBe(false);
		expect(await snapshot()).toBe(before);
		// Republishing an already published row is not blocked by the cap.
		expect(await publishDirect("cap-3", "Relabelled")).toBe(true);
	});

	it("refuses a case-insensitively duplicate published label and writes nothing", async () => {
		await addAccount("dup-1", "n1");
		await addAccount("dup-2", "n2");
		expect(await publishDirect("dup-1", "Team Alpha")).toBe(true);
		const before = await snapshot();
		let outcome: boolean | "threw";
		try {
			outcome = await publishDirect("dup-2", "team ALPHA");
		} catch {
			outcome = "threw";
		}
		expect(outcome === false || outcome === "threw").toBe(true);
		expect(await snapshot()).toBe(before);
	});

	it("the database unique index rejects a raw duplicate published label", async () => {
		await addAccount("dup-1", "n1");
		await addAccount("dup-2", "n2");
		const adapter = db.getAdapter();
		await adapter.run(
			"UPDATE accounts SET public_value_enabled = 1, public_value_label = 'Same' WHERE id = 'dup-1'",
		);
		let threw = false;
		try {
			await adapter.run(
				"UPDATE accounts SET public_value_enabled = 1, public_value_label = 'SAME' WHERE id = 'dup-2'",
			);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	it("returns 400 with nothing written when the pre-check passes but the conditional write refuses", async () => {
		await addAccount("race-1", "n1");
		await addAccount("race-2", "n2");
		expect(
			(await post("race-1", { enabled: true, label: "Taken" })).status,
		).toBe(200);
		const before = await snapshot();
		// Simulate another process: the pre-check sees an empty roster.
		const stub = spyOn(db, "listPublishedPublicValue").mockResolvedValue([]);
		try {
			const response = await post("race-2", { enabled: true, label: "taken" });
			expect(response.status).toBe(400);
			expect(JSON.stringify(await response.json())).toContain(
				"Another published account already uses this label, or the published-account limit was reached",
			);
		} finally {
			stub.mockRestore();
		}
		expect(await snapshot()).toBe(before);
	});

	it("maps a unique-constraint violation on the write to the same 400", async () => {
		await addAccount("uv-1", "n1");
		const stub = spyOn(db, "setPublicValue").mockRejectedValue(
			Object.assign(new Error("UNIQUE constraint failed: index"), {
				code: "SQLITE_CONSTRAINT_UNIQUE",
			}),
		);
		try {
			const response = await post("uv-1", { enabled: true, label: "Any" });
			expect(response.status).toBe(400);
		} finally {
			stub.mockRestore();
		}
	});

	// isUniqueViolation (KTD9): the write itself throws a REAL bun:sqlite error
	// from the published-label unique index, not a hand-built error object.
	it("maps a real SQLite UNIQUE index violation on the write to the same 400", async () => {
		await addAccount("rv-1", "n1");
		await addAccount("rv-2", "n2");
		expect((await post("rv-1", { enabled: true, label: "Taken" })).status).toBe(
			200,
		);
		const before = await snapshot();
		const adapter = db.getAdapter();
		const stub = spyOn(db, "setPublicValue").mockImplementation(async () => {
			await adapter.run(
				"UPDATE accounts SET public_value_enabled = 1, public_value_label = 'TAKEN' WHERE id = 'rv-2'",
			);
			return true;
		});
		try {
			const response = await post("rv-2", { enabled: true, label: "Other" });
			expect(response.status).toBe(400);
			expect(JSON.stringify(await response.json())).toContain(
				"Another published account already uses this label, or the published-account limit was reached",
			);
		} finally {
			stub.mockRestore();
		}
		expect(await snapshot()).toBe(before);
	});
});

describe("public-value plan", () => {
	async function addProviderAccount(id: string, provider: string) {
		await db
			.getAdapter()
			.run(
				"INSERT INTO accounts (id,name,provider,created_at) VALUES (?, ?, ?, 100)",
				[id, `name-${id}`, provider],
			);
	}
	async function stored(id: string) {
		return (await db
			.getAdapter()
			.getMain(
				"SELECT public_value_enabled, public_value_label, public_value_id, public_value_plan FROM accounts WHERE id = ?",
				[id],
			)) as {
			public_value_enabled: number;
			public_value_label: string | null;
			public_value_id: string | null;
			public_value_plan: string | null;
		};
	}
	async function planSnapshot(): Promise<string> {
		return JSON.stringify(
			await db
				.getAdapter()
				.queryMain(
					"SELECT id, public_value_enabled, public_value_label, public_value_id, public_value_plan FROM accounts ORDER BY id",
				),
		);
	}

	it("refuses a plan that is not a string or null, writing nothing", async () => {
		await addAccount("p-1", "n1");
		const before = await planSnapshot();
		for (const plan of [5, true, {}, [], ["claude-pro"]]) {
			const response = await post("p-1", { enabled: true, label: "L", plan });
			expect(response.status).toBe(400);
		}
		expect(await planSnapshot()).toBe(before);
	});

	it("refuses an unknown plan key, writing nothing", async () => {
		await addAccount("p-1", "n1");
		const before = await planSnapshot();
		for (const plan of ["nope", "", "CLAUDE-PRO", "claude-pro "]) {
			const response = await post("p-1", { enabled: true, label: "L", plan });
			expect(response.status).toBe(400);
		}
		expect(await planSnapshot()).toBe(before);
	});

	it("refuses a claude plan on a codex account, writing nothing", async () => {
		await addProviderAccount("p-codex", "codex");
		const before = await planSnapshot();
		const response = await post("p-codex", {
			enabled: true,
			label: "L",
			plan: "claude-max",
		});
		expect(response.status).toBe(400);
		expect(await planSnapshot()).toBe(before);
	});

	it("refuses a chatgpt plan on an anthropic account, writing nothing", async () => {
		await addAccount("p-1", "n1");
		const before = await planSnapshot();
		const response = await post("p-1", {
			enabled: true,
			label: "L",
			plan: "chatgpt-pro-200",
		});
		expect(response.status).toBe(400);
		expect(await planSnapshot()).toBe(before);
	});

	it("sets the plan with the label in one write and reports it", async () => {
		await addAccount("p-1", "n1");
		await addProviderAccount("p-codex", "codex");
		const response = await post("p-1", {
			enabled: true,
			label: "Weekly A",
			plan: "claude-ultra",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			publicValueEnabled: true,
			publicValueLabel: "Weekly A",
			publicValuePlan: "claude-ultra",
		});
		expect(await stored("p-1")).toMatchObject({
			public_value_label: "Weekly A",
			public_value_plan: "claude-ultra",
		});
		const codex = await post("p-codex", {
			enabled: true,
			label: "Codex A",
			plan: "chatgpt-pro-200",
		});
		expect(codex.status).toBe(200);
		expect((await stored("p-codex")).public_value_plan).toBe("chatgpt-pro-200");
	});

	it("keeps the stored plan when plan is absent, and reports it", async () => {
		await addAccount("p-1", "n1");
		await post("p-1", { enabled: true, label: "One", plan: "claude-max" });
		const response = await post("p-1", { enabled: true, label: "Two" });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			publicValueLabel: "Two",
			publicValuePlan: "claude-max",
		});
		expect((await stored("p-1")).public_value_plan).toBe("claude-max");
	});

	it("clears the plan on null", async () => {
		await addAccount("p-1", "n1");
		await post("p-1", { enabled: true, label: "One", plan: "claude-max" });
		const response = await post("p-1", { enabled: true, plan: null });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ publicValuePlan: null });
		expect((await stored("p-1")).public_value_plan).toBeNull();
	});

	it("keeps the plan when the account is unpublished", async () => {
		await addAccount("p-1", "n1");
		await post("p-1", { enabled: true, label: "One", plan: "claude-pro" });
		const response = await post("p-1", { enabled: false });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			publicValueEnabled: false,
			publicValuePlan: "claude-pro",
		});
		expect(await stored("p-1")).toMatchObject({
			public_value_enabled: 0,
			public_value_plan: "claude-pro",
		});
	});

	it("leaves the plan unchanged when a label problem refuses the request", async () => {
		await addAccount("p-1", "n1");
		await post("p-1", { enabled: true, label: "One", plan: "claude-pro" });
		const before = await planSnapshot();
		const response = await post("p-1", {
			enabled: true,
			label: " padded",
			plan: "claude-max",
		});
		expect(response.status).toBe(400);
		expect(await planSnapshot()).toBe(before);
	});

	it("bumps the roster generation on a plan write, and the feed sends the new plan", async () => {
		await addAccount("p-1", "n1");
		await post("p-1", { enabled: true, label: "One" });
		expect((await feedBody()).body.subscriptions[0].plan).toBeNull();
		const start = getPublicRosterGeneration();
		await post("p-1", { enabled: true, plan: "claude-ultra" });
		expect(getPublicRosterGeneration()).toBeGreaterThan(start);
		expect((await feedBody()).body.subscriptions[0].plan).toEqual({
			key: "claude-ultra",
			name: "Claude Ultra",
			formerName: "Claude Max 20x",
			monthlyUsd: 200,
			priceSource: "https://claude.com/pricing",
			priceCheckedOn: "2026-11-23",
		});
	});

	it("picks up a plan changed by another process within the roster recheck interval", async () => {
		await addAccount("p-1", "n1");
		await post("p-1", { enabled: true, label: "One", plan: "claude-pro" });
		expect((await feedBody()).body.subscriptions[0].plan.key).toBe(
			"claude-pro",
		);
		await db
			.getAdapter()
			.run(
				"UPDATE accounts SET public_value_plan = 'claude-max' WHERE id = 'p-1'",
			);
		now += 6_000;
		expect((await feedBody()).body.subscriptions[0].plan.key).toBe(
			"claude-max",
		);
	});
});
