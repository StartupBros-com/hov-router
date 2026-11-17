/**
 * Selection with extra-usage holds. While a Claude login's extra-usage switch
 * is on, a stored hold keeps every request for a model it covers away from
 * that login until the hold's reset, in every routing mode, for forced routes
 * and for synthetic probes. With the switch off a stored hold is ignored.
 *
 * These run the real selector with stubbed accounts and cached readings, so
 * they catch a selection path that ignores a hold; they do not cover a send
 * that skips selection (the send-time check covers that).
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import type {
	Account,
	ExtraUsageHold,
	ExtraUsageHoldState,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";

const { usageCache } = await import("@better-ccflare/providers");
const { SessionStrategy } = await import("@better-ccflare/load-balancer");
const {
	ForceRouteUnavailableError,
	getRoutingCapacityContext,
	selectAccountsForRequest,
} = await import("../account-selector");
const { createRoutingTerminalResponse } = await import("../routing-terminal");

const HOUR = 3_600_000;
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "account-1",
		name: "account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + HOUR,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		...overrides,
	};
}

function makeRequestMeta(headers: HeadersInit = {}): RequestMeta {
	return {
		id: "request-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(headers),
	};
}

function makeCtx(
	accounts: Account[],
	mode?: "off" | "exhausted",
): ProxyContext {
	return {
		strategy: { select: mock((pool: Account[]) => pool) },
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
		config: {
			getCombosEnabled: () => true,
			...(mode === undefined
				? {}
				: { getModelScopedCapacityRouting: () => mode }),
		},
	} as unknown as ProxyContext;
}

function hold(
	windowKey: "five_hour" | "seven_day" | "seven_day_opus",
	resetsAtMs: number,
): ExtraUsageHold {
	const family = windowKey === "seven_day_opus";
	return {
		windowKey,
		scope: family ? "family" : "account",
		modelFamily: family ? "opus" : null,
		resetsAtMs,
		startedAt: Date.now() - 60_000,
	};
}

function holds(...entries: ExtraUsageHold[]): ExtraUsageHoldState {
	return { readingAt: Date.now() - 60_000, holds: entries };
}

/** A Claude login with the switch on and a stored Opus hold. */
function opusHeld(
	overrides: Partial<Account> = {},
	reset = Date.now() + 2 * HOUR,
): Account {
	return makeAccount({
		id: "held",
		name: "held",
		auto_pause_on_overage_enabled: true,
		extra_usage_holds: holds(hold("seven_day_opus", reset)),
		...overrides,
	});
}

const cachedAccountIds = new Set<string>();
function cacheUsage(accountId: string, data: unknown): void {
	usageCache.set(accountId, data as never);
	cachedAccountIds.add(accountId);
}

/** A reading in which nothing is spent, with the given extra-usage fields. */
function readingWith(extra: Record<string, unknown>): Record<string, unknown> {
	const reset = new Date(Date.now() + 3 * HOUR).toISOString();
	return {
		five_hour: { utilization: 10, resets_at: reset },
		seven_day: { utilization: 10, resets_at: reset },
		...extra,
	};
}

afterEach(() => {
	for (const accountId of cachedAccountIds) usageCache.delete(accountId);
	cachedAccountIds.clear();
});

const ids = (accounts: readonly Account[]) => accounts.map((a) => a.id);

describe("selection with extra-usage holds", () => {
	it("in a default install, an Opus request skips a login with an Opus hold, the refusal is model_pool_exhausted with the hold's reset as its retry hint, and a Sonnet request still picks it", async () => {
		const reset = Date.now() + 2 * HOUR;
		const login = opusHeld({}, reset);
		const meta = makeRequestMeta();

		expect(
			await selectAccountsForRequest(meta, makeCtx([login]), OPUS),
		).toEqual([]);
		const capacityContext = getRoutingCapacityContext(meta);
		expect(capacityContext?.exclusions).toMatchObject([
			{
				accountId: "held",
				blockedUntil: reset,
				exclusions: [
					{
						source: "extra_usage_hold",
						scope: "family",
						window: "seven_day_opus",
						windowKind: "weekly_scoped",
						modelFamily: "opus",
						resetAtMs: reset,
					},
				],
			},
		]);

		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [login],
			capacityContext,
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
		});
		expect(terminal.kind).toBe("model_pool_exhausted");
		const body = (await terminal.response.json()) as {
			error: { next_available_at?: string };
		};
		expect(body.error.next_available_at).toBe(new Date(reset).toISOString());
		expect(
			Number(terminal.response.headers.get("retry-after")),
		).toBeGreaterThan(0);

		expect(
			ids(
				await selectAccountsForRequest(
					makeRequestMeta(),
					makeCtx([login]),
					SONNET,
				),
			),
		).toEqual(["held"]);
	});

	it("excludes the held model in both model-scoped routing modes", async () => {
		for (const mode of ["off", "exhausted"] as const) {
			expect(
				await selectAccountsForRequest(
					makeRequestMeta(),
					makeCtx([opusHeld()], mode),
					OPUS,
				),
			).toEqual([]);
		}
	});

	it("excludes the held model whatever the extra-usage state reads", async () => {
		const readings: Array<[string, Record<string, unknown> | null]> = [
			["on", readingWith({ spend: { enabled: true } })],
			[
				"off",
				readingWith({
					spend: { enabled: false },
					extra_usage: { is_enabled: false },
				}),
			],
			[
				"not known",
				readingWith({
					extra_usage: { is_enabled: false, disabled_reason: "unplaced" },
				}),
			],
			["no reading", null],
		];
		for (const [label, reading] of readings) {
			const login = opusHeld({ id: `held-${label}` });
			if (reading) cacheUsage(login.id, reading);
			expect({
				label,
				selected: ids(
					await selectAccountsForRequest(
						makeRequestMeta(),
						makeCtx([login]),
						OPUS,
					),
				),
			}).toEqual({ label, selected: [] });
		}
	});

	it("after the reset an Opus request picks the login, with Return after reset off", async () => {
		const login = opusHeld(
			{ auto_fallback_enabled: false },
			Date.now() - 1_000,
		);
		expect(
			ids(
				await selectAccountsForRequest(
					makeRequestMeta(),
					makeCtx([login]),
					OPUS,
				),
			),
		).toEqual(["held"]);
	});

	it("a stored hold with no cached reading still excludes the login", async () => {
		const login = opusHeld();
		expect(usageCache.getSnapshot(login.id)).toBeNull();
		expect(
			await selectAccountsForRequest(makeRequestMeta(), makeCtx([login]), OPUS),
		).toEqual([]);
	});

	it("with two logins, Opus goes to the unheld one and the held one still takes Sonnet", async () => {
		const held = opusHeld();
		const free = makeAccount({
			id: "free",
			name: "free",
			priority: 1,
			auto_pause_on_overage_enabled: true,
		});
		expect(
			ids(
				await selectAccountsForRequest(
					makeRequestMeta(),
					makeCtx([held, free]),
					OPUS,
				),
			),
		).toEqual(["free"]);
		expect(
			ids(
				await selectAccountsForRequest(
					makeRequestMeta(),
					makeCtx([held, free]),
					SONNET,
				),
			),
		).toEqual(["held", "free"]);
	});

	it("a route naming a held login for a held model refuses with model_capacity_exhausted and goes nowhere else", async () => {
		const held = opusHeld();
		const free = makeAccount({ id: "free", name: "free", priority: 1 });
		const meta = makeRequestMeta({ "x-better-ccflare-account-id": held.id });
		const refusal = selectAccountsForRequest(meta, makeCtx([held, free]), OPUS);
		await expect(refusal).rejects.toBeInstanceOf(ForceRouteUnavailableError);
		await expect(refusal).rejects.toMatchObject({
			accountId: held.id,
			reason: "model_capacity_exhausted",
		});
	});

	it("a route naming a login held on every model refuses with account_capacity_exhausted", async () => {
		const held = makeAccount({
			id: "held",
			auto_pause_on_overage_enabled: true,
			extra_usage_holds: holds(hold("five_hour", Date.now() + HOUR)),
		});
		const meta = makeRequestMeta({ "x-better-ccflare-account-id": held.id });
		await expect(
			selectAccountsForRequest(meta, makeCtx([held]), SONNET),
		).rejects.toMatchObject({ reason: "account_capacity_exhausted" });
	});

	it("a login held on every model is a finite wait: the refusal carries the hold's reset", async () => {
		const reset = Date.now() + HOUR;
		const held = makeAccount({
			id: "held",
			auto_pause_on_overage_enabled: true,
			extra_usage_holds: holds(hold("five_hour", reset)),
		});
		const meta = makeRequestMeta();
		expect(
			await selectAccountsForRequest(meta, makeCtx([held]), SONNET),
		).toEqual([]);
		const terminal = createRoutingTerminalResponse({
			source: "selection",
			accounts: [held],
			capacityContext: getRoutingCapacityContext(meta),
			rateLimitOutcomes: [],
			upstreamAttempts: 0,
		});
		expect(terminal.kind).toBe("pool_exhausted");
		expect(
			Number(terminal.response.headers.get("retry-after")),
		).toBeGreaterThan(0);
	});

	it("with the switch off, a stored hold is ignored and the Opus request picks the login", async () => {
		const login = opusHeld({ auto_pause_on_overage_enabled: false });
		expect(
			ids(
				await selectAccountsForRequest(
					makeRequestMeta(),
					makeCtx([login]),
					OPUS,
				),
			),
		).toEqual(["held"]);
	});

	it("after the member resumes a login whose Opus limit is spent but shown by no reading, an Opus request picks it", async () => {
		const login = opusHeld({ extra_usage_holds: null, paused: false });
		expect(
			ids(
				await selectAccountsForRequest(
					makeRequestMeta(),
					makeCtx([login]),
					OPUS,
				),
			),
		).toEqual(["held"]);
	});

	it("a login with an Opus hold and an overage pause takes nothing; after resume it takes Sonnet and still refuses Opus until the reset", async () => {
		// The real strategy, not the pass-through stub: it is the strategy that
		// leaves a paused login out of ordinary selection.
		const withStrategy = (accounts: Account[]) => {
			const ctx = makeCtx(accounts);
			const strategy = new SessionStrategy();
			strategy.initialize({
				resetAccountSession: mock(() => {}),
				resumeAccount: mock(async () => ({ resumed: true, pauseReason: null })),
			} as unknown as StrategyStore);
			ctx.strategy = strategy;
			return ctx;
		};
		const paused = opusHeld({ paused: true, pause_reason: "overage" });
		for (const model of [OPUS, SONNET]) {
			expect(
				await selectAccountsForRequest(
					makeRequestMeta(),
					withStrategy([paused]),
					model,
				),
			).toEqual([]);
		}

		const resumed = { ...paused, paused: false, pause_reason: null };
		expect(
			ids(
				await selectAccountsForRequest(
					makeRequestMeta(),
					withStrategy([resumed]),
					SONNET,
				),
			),
		).toEqual(["held"]);
		expect(
			await selectAccountsForRequest(
				makeRequestMeta(),
				withStrategy([resumed]),
				OPUS,
			),
		).toEqual([]);
	});

	it("a spent 5-hour reading still excludes the login with the switch off, as before", async () => {
		const login = makeAccount({ id: "spent" });
		cacheUsage(login.id, {
			five_hour: {
				utilization: 100,
				resets_at: new Date(Date.now() + HOUR).toISOString(),
			},
			seven_day: {
				utilization: 10,
				resets_at: new Date(Date.now() + 3 * HOUR).toISOString(),
			},
		});
		expect(
			await selectAccountsForRequest(makeRequestMeta(), makeCtx([login]), OPUS),
		).toEqual([]);
	});

	it("a synthetic probe to a held login is excluded", async () => {
		expect(
			await selectAccountsForRequest(
				makeRequestMeta(),
				makeCtx([opusHeld()]),
				OPUS,
				{ syntheticProbe: true },
			),
		).toEqual([]);
	});
});
