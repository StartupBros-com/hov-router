import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { DatabaseOperations } from "@better-ccflare/database";
import { usageCache } from "@better-ccflare/providers";
import { startUsagePollingWithRefresh } from "./server";
import { UsagePollingLifecycle } from "./usage-polling-lifecycle";

/**
 * A usage poll for a Claude login with the extra-usage switch on stores the
 * holds its reading shows, through the server's snapshot callback and
 * DatabaseOperations.recordUsageSnapshot, against a real in-memory database.
 * `fetch` answers only the usage URL; any other call fails the test, so
 * nothing contacts Anthropic.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DAY = 24 * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The recorded live Anthropic usage shape (see the "live Anthropic payload
 * shape" fixture in packages/proxy/src/handlers/__tests__/usage-throttling.test.ts),
 * trimmed to the fields the normalizer reads, with one edit: a weekly Opus
 * limit spent and active. Nobody has recorded a spent per-model limit.
 */
function opusSpentPayload(weekReset: number) {
	return {
		limits: [
			{
				kind: "session",
				percent: 6,
				resets_at: iso(weekReset - 3 * DAY),
				scope: null,
				is_active: true,
			},
			{
				kind: "weekly_all",
				percent: 2,
				resets_at: iso(weekReset),
				scope: null,
				is_active: true,
			},
			{
				kind: "weekly_scoped",
				percent: 100,
				resets_at: iso(weekReset),
				scope: { model: { id: null, display_name: "Opus" }, surface: null },
				is_active: true,
			},
		],
		five_hour: { utilization: 6, resets_at: iso(weekReset - 3 * DAY) },
		seven_day: { utilization: 2, resets_at: iso(weekReset) },
		spend: { enabled: false },
	};
}

let dbOps: DatabaseOperations;
let lifecycle: UsagePollingLifecycle<number>;
let accountId: string;
let fetchStub: ReturnType<typeof spyOn> | null = null;
// The poller catches and logs fetch errors, so a throw alone could pass
// unnoticed; every unexpected URL is also recorded and asserted empty.
let unexpectedUrls: string[] = [];

async function seedClaudeLogin(id: string) {
	await dbOps.getAdapter().run(
		`INSERT INTO accounts (id, name, provider, access_token, expires_at, refresh_token, created_at, auto_pause_on_overage_enabled)
		 VALUES (?, ?, 'anthropic', 'at-fixture-valid', ?, 'rt-fixture', ?, 1)`,
		[id, id, Date.now() + 60 * 60 * 1000, 100],
	);
	const account = await dbOps.getAccount(id);
	if (!account) throw new Error("seeded account not found");
	return account;
}

function stubUsageFetch(respond: () => Response) {
	fetchStub = spyOn(globalThis, "fetch").mockImplementation((async (
		input: string | URL | Request,
	) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		if (url !== USAGE_URL) {
			unexpectedUrls.push(url);
			throw new Error(`unexpected network call: ${url}`);
		}
		return respond();
	}) as typeof fetch);
}

async function startPoll(account: Awaited<ReturnType<typeof seedClaudeLogin>>) {
	usageCache.stopPolling(account.id);
	await startUsagePollingWithRefresh(
		account,
		{ dbOps, refreshInFlight: new Map() } as never,
		{ evaluateUsageSnapshot: async () => {} } as never,
		{ observeSnapshot: async () => {} } as never,
		lifecycle as never,
	);
	await usageCache.refreshNow(account.id);
}

async function waitFor(check: () => Promise<boolean>) {
	for (let i = 0; i < 200; i++) {
		if (await check()) return true;
		await Bun.sleep(10);
	}
	return false;
}

beforeEach(() => {
	unexpectedUrls = [];
	dbOps = new DatabaseOperations(":memory:", { walMode: false });
	lifecycle = new UsagePollingLifecycle<number>({
		schedule: () => 1,
		cancel: () => {},
	});
});
afterEach(async () => {
	// Retire the lease and let any poll still in flight bail before the stub
	// is restored, so a failing run can never reach the real usage endpoint.
	lifecycle.retire(accountId);
	for (let i = 0; i < 20; i++) await Promise.resolve();
	usageCache.stopPolling(accountId);
	usageCache.delete(accountId);
	fetchStub?.mockRestore();
	fetchStub = null;
	await dbOps.dispose();
	expect(unexpectedUrls).toEqual([]);
});

describe("a usage poll updates the extra-usage holds", () => {
	it("a poll that reads weekly Opus spent stores the Opus hold", async () => {
		accountId = "acct-hold-poll";
		const account = await seedClaudeLogin(accountId);
		const weekReset = Date.now() + 4 * DAY;
		stubUsageFetch(
			() =>
				new Response(JSON.stringify(opusSpentPayload(weekReset)), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		await startPoll(account);
		const stored = await waitFor(
			async () =>
				((await dbOps.getExtraUsageHoldInputs(accountId))?.holds?.holds
					.length ?? 0) > 0,
		);
		expect(stored).toBe(true);
		const holds = (await dbOps.getExtraUsageHoldInputs(accountId))?.holds;
		expect(holds?.holds).toEqual([
			expect.objectContaining({
				windowKey: "seven_day_opus",
				scope: "family",
				modelFamily: "opus",
				resetsAtMs: Date.parse(iso(weekReset)),
			}),
		]);
	});

	it("with the switch on and the poll failing, no hold is stored", async () => {
		accountId = "acct-hold-poll-failing";
		const account = await seedClaudeLogin(accountId);
		let calls = 0;
		stubUsageFetch(() => {
			calls++;
			return new Response("upstream error", { status: 500 });
		});
		await startPoll(account);
		expect(await waitFor(async () => calls > 0)).toBe(true);
		// Give a mistaken write the same time a successful poll needs.
		await Bun.sleep(100);
		const after = await dbOps.getExtraUsageHoldInputs(accountId);
		expect(after?.switchOn).toBe(true);
		expect(after?.holds).toBeNull();
		expect(after?.paused).toBe(false);
	});
});
