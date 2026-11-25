import { expect, test } from "bun:test";
import type { Account } from "../../api";
import {
	ACCOUNT_SORTS,
	accountListView,
	accountNextReset,
	needsAccountAttention,
} from "./account-list-view";

const account = (id: string, patch: Partial<Account> = {}) =>
	({
		id,
		name: id,
		provider: "codex",
		paused: false,
		rateLimitStatus: "OK",
		priority: 0,
		...patch,
	}) as Account;

test("the list offers routing order and next reset, nothing else", () => {
	expect(ACCOUNT_SORTS.map(([value]) => value)).toEqual([
		"priority",
		"next-reset",
	]);
});

test("provider epoch windows share display normalization and generic resets include daily/monthly", () => {
	const now = Date.now();
	const reset = now + 3600000;
	const cases: [string, unknown][] = [
		[
			"minimax",
			{
				five_hour: { utilization: 20, resetAt: reset + 1 },
				seven_day: { utilization: 30, resetAt: reset },
			},
		],
		[
			"zai",
			{
				tokens_limit: { percentage: 20, resetAt: reset + 1 },
				tokens_limit_weekly: { percentage: 30, resetAt: reset },
				time_limit: { percentage: 90, resetAt: reset + 2 },
			},
		],
		[
			"alibaba-coding-plan",
			{
				five_hour: { percentUsed: 20, resetAt: reset + 1 },
				weekly: { percentUsed: 30, resetAt: reset },
				monthly: { percentUsed: 40, resetAt: reset + 2 },
			},
		],
		[
			"nanogpt",
			{
				active: true,
				daily: { percentUsed: 0.2, resetAt: reset },
				monthly: { percentUsed: 0.4, resetAt: reset + 2 },
			},
		],
		[
			"xai",
			{
				credits: { utilization: 30, resets_at: new Date(reset).toISOString() },
			},
		],
	];
	for (const [provider, usageData] of cases) {
		const a = account(provider, {
			provider,
			usageData: usageData as Account["usageData"],
		});
		expect(accountNextReset(a, now)?.resetTime).toBe(
			new Date(reset).toISOString(),
		);
	}
});

test("the next reset names scoped weekly and code-review windows by their own labels", () => {
	const now = Date.now();
	const iso = (delta: number) => new Date(now + delta).toISOString();
	const a = account("a", {
		provider: "anthropic",
		usageData: {
			five_hour: { utilization: 0, resets_at: iso(1) },
			seven_day: { utilization: 0, resets_at: iso(1) },
			limits: [
				{ kind: "session", percent: 50, resets_at: iso(2000) },
				{ kind: "weekly_all", percent: 60, resets_at: iso(3000) },
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: iso(1000),
					scope: { model: { display_name: "Fable" } },
				},
			],
		} as unknown as Account["usageData"],
	});
	expect(accountNextReset(a, now)?.label).toBe("Fable (Weekly)");
	const codex = account("codex", {
		usageData: {
			...a.usageData,
			code_review_used_percent: 10,
			code_review_resets_at: iso(500),
		} as unknown as Account["usageData"],
	});
	expect(accountNextReset(codex, now)?.label).toBe("Code Review");
});

test("a window with unknown utilization still sorts by its reset, and a retry time alone is no reset", () => {
	const now = Date.now();
	const reset = new Date(now + 3600000).toISOString();
	for (const utilization of [null, undefined, NaN, Infinity, -1]) {
		const a = account("a", {
			provider: "anthropic",
			usageData: {
				seven_day: { utilization, resets_at: reset },
			} as unknown as Account["usageData"],
		});
		expect(accountNextReset(a, now)?.resetTime).toBe(reset);
	}
	expect(
		accountNextReset(
			account("retry-only", { provider: "anthropic", rateLimitReset: reset }),
			now,
		),
	).toBeNull();
	const equal = [
		account("first", { name: "Same" }),
		account("second", { name: "same" }),
	];
	expect(accountListView(equal, { sort: "next-reset" }).accounts).toEqual(
		equal,
	);
});

test("search trims and matches name/provider without mutating the input", () => {
	const accounts = [
		account("Beta"),
		account("alpha"),
		account("Other", { provider: "anthropic" }),
	];
	// Equal priorities list by name in the default routing order.
	expect(
		accountListView(accounts, { search: " CODEX " }).accounts.map((a) => a.id),
	).toEqual(["alpha", "Beta"]);
	expect(
		accountListView(accounts, { search: " ALP " }).accounts.map((a) => a.id),
	).toEqual(["alpha"]);
	expect(accounts.map((a) => a.id)).toEqual(["Beta", "alpha", "Other"]);
});

test("search and the attention view intersect, and counts always cover all accounts", () => {
	const accounts = [
		account("paused", { paused: true }),
		account("auth", { requiresReauth: true }),
		account("auth-other", { requiresReauth: true, provider: "anthropic" }),
		account("other", { provider: "anthropic" }),
	];
	const view = accountListView(accounts, {
		attentionOnly: true,
		search: "codex",
	});
	expect(view.accounts.map((a) => a.id)).toEqual(["auth"]);
	expect(view.attentionOnly).toBe(true);
	expect(view.counts).toEqual({ all: 4, attention: 2 });
	expect(accountListView(accounts, { search: "missing" }).accounts).toEqual([]);
});

test("the attention view lists only accounts that need the operator, in routing order", () => {
	const accounts = [
		account("auth", { paused: true, requiresReauth: true }),
		account("lock", { provider: "anthropic", rateLimitStatus: "blocked" }),
		account("refused", { provider: "anthropic", usageOrgRefusedAt: 50 }),
		account("manual", { paused: true }),
	];
	expect(
		accountListView(accounts, { attentionOnly: true }, {}, 100).accounts.map(
			(a) => a.id,
		),
		// Routing order lists the active account before the paused one.
	).toEqual(["refused", "auth"]);
});

test("an attention view with nothing left to attend to lists every account", () => {
	const accounts = [account("a"), account("b", { rateLimitedUntil: 200 })];
	const view = accountListView(accounts, { attentionOnly: true }, {}, 100);
	expect(view.attentionOnly).toBe(false);
	expect(view.accounts.map((a) => a.id)).toEqual(["a", "b"]);
});

test("attention reasons count each account once and ignore view filters", () => {
	const view = accountListView(
		[
			account("auth", { requiresReauth: true, rateLimitStatus: "blocked" }),
			account("legacy-auth", {
				pauseReason: "oauth_invalid_grant",
				paused: true,
			}),
			account("refused", { provider: "anthropic", usageOrgRefusedAt: 50 }),
			account("billing", {
				rateLimitedUntil: 101,
				rateLimitedReason: "upstream_402_payment_required",
			}),
			account("throttle", { usageThrottledUntil: 101 }),
			account("family-spent"),
			account("routing"),
			account("manual", { paused: true }),
		],
		{ search: "missing" },
		{
			// A spent family is a limit, which the row names on its at-limit line;
			// only a decision for Combos counts.
			"family-spent": [{ availability: "model_exhausted" } as never],
			routing: [{ reason: "ambiguous" } as never],
		},
		100,
	);
	expect(view.accounts).toEqual([]);
	expect(view.counts.attention).toBe(5);
	expect(view.attentionReasons).toEqual({
		reconnect: 2,
		refused: 1,
		payment: 1,
		routing: 1,
	});
});

test("attention means operator action: a limit that clears on its own never counts", () => {
	const now = 100;
	const operatorAction: Partial<Account>[] = [
		{ requiresReauth: true },
		{ pauseReason: "oauth_invalid_grant" },
		{ provider: "anthropic", usageOrgRefusedAt: 50 },
		{
			provider: "anthropic",
			rateLimitedUntil: 101,
			rateLimitedReason: "org_permission_denied",
		},
		// A 402 bench waits on billing or credits (#1025). Both shapes the API
		// can send: its own retry label, and a provider-reported payment status.
		{
			rateLimitStatus: "Rate limited (5m)",
			rateLimitedUntil: 101,
			rateLimitedReason: "upstream_402_payment_required",
		},
		{
			rateLimitStatus: "payment_required (5m)",
			rateLimitedUntil: 101,
			rateLimitedReason: "upstream_402_payment_required",
		},
		// The expiry sweep lifted the bench, and nothing has served since.
		{
			rateLimitedUntil: null,
			rateLimitedAt: 40,
			rateLimitedReason: "upstream_402_payment_required",
		},
	];
	for (const patch of operatorAction)
		expect(needsAccountAttention(account("a", patch), [], now)).toBe(true);
	const clearsOnItsOwn: Partial<Account>[] = [
		{},
		{ priority: 0 },
		{ paused: true },
		{ paused: true, provider: "anthropic", usageOrgRefusedAt: 50 },
		// Usage limits, router cooldowns and pacing all clear by themselves.
		{ rateLimitStatus: "rate_limited" },
		{ rateLimitStatus: "blocked" },
		{ rateLimitStatus: "usage_exhausted (20m)" },
		{ rateLimitStatus: "allowed_warning" },
		{ rateLimitStatus: "queueing_soft" },
		{ rateLimitStatus: "unknown future" },
		{ rateLimitedUntil: 101 },
		{ rateLimitedUntil: 99 },
		{ usageThrottledUntil: 101 },
		// A delayed usage poll is the router's to retry.
		{ usageRateLimitedUntil: 101 },
		// After a request is served past the 402 (rate_limited_at cleared), the
		// stored reason stays behind and no longer counts. xAI's 402 is a
		// capacity signal.
		{
			rateLimitedUntil: 99,
			rateLimitedReason: "upstream_402_payment_required",
		},
		{ rateLimitedUntil: 101, rateLimitedReason: "xai_capacity_402" },
	];
	for (const patch of clearsOnItsOwn)
		expect(needsAccountAttention(account("a", patch), [], now)).toBe(false);
	for (const state of [
		{ reason: "ambiguous" },
		{ reason: "new_billing_class" },
		{ managedRouteAvailable: true },
	])
		expect(needsAccountAttention(account("a"), [state as never], now)).toBe(
			true,
		);
	for (const state of [
		{ availability: "model_exhausted" },
		{ availability: "rate_limited" },
		{ availability: null },
	])
		expect(needsAccountAttention(account("a"), [state as never], now)).toBe(
			false,
		);
});

test("view sorts are stable, filtered, immutable and default to routing order", () => {
	const input = [account("Zulu"), account("alpha"), account("Alpha")];
	// Equal priorities fall back to the name, not to the API's request-count order.
	expect(accountListView(input).accounts.map((a) => a.id)).toEqual([
		"alpha",
		"Alpha",
		"Zulu",
	]);
	expect(accountListView(input, { search: "alpha" }).counts.all).toBe(3);
	expect(input.map((a) => a.id)).toEqual(["Zulu", "alpha", "Alpha"]);
});

test("the next-reset sort puts stale and invalid resets last", () => {
	const now = Date.now();
	const make = (id: string, reset: string, utilization: number) =>
		account(id, {
			provider: "anthropic",
			usageData: {
				five_hour: { utilization, resets_at: reset },
				seven_day: { utilization, resets_at: reset },
			},
		});
	const input = [
		make("expired", new Date(now - 1).toISOString(), 0),
		make("later", new Date(now + 7200000).toISOString(), 20),
		make("soon", new Date(now + 3600000).toISOString(), 80),
		make("invalid", "bad", NaN),
	];
	expect(
		accountListView(input, { sort: "next-reset" }, {}, now).accounts.map(
			(a) => a.id,
		),
	).toEqual(["soon", "later", "expired", "invalid"]);
});

test("routing priority lists active accounts first, then lower priority numbers, then names", () => {
	// Primary and request counts change with every poll; ordering never reads them.
	const input = [
		account("gateway", { priority: 100, requestCount: 900 }),
		account("paused-low", { priority: 30, paused: true }),
		account("beta", { priority: 30, isPrimary: true }),
		account("Alpha", { priority: 30, requestCount: 1 }),
		account("grok", { priority: 50 }),
		account("paused-high", { priority: 100, paused: true }),
	];
	const expected = [
		"Alpha",
		"beta",
		"grok",
		"gateway",
		"paused-low",
		"paused-high",
	];
	expect(accountListView(input).accounts.map((a) => a.id)).toEqual(expected);
	expect(
		accountListView(input, { sort: "priority" }).accounts.map((a) => a.id),
	).toEqual(expected);
});
