/**
 * The check just before each send. A hold can be written after a login was
 * selected (a usage reading, or a response billed to extra usage on another
 * request), so every send on a Claude login whose switch is on rereads the
 * hold columns and refuses to send a model they cover.
 *
 * The stand-in for Anthropic is a fetch mock that records every request that
 * reaches it, so these prove a veto sends nothing. They run proxyWithAccount
 * with an already-selected account and do not cover selection.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type {
	Account,
	ExtraUsageHold,
	ExtraUsageHoldInputs,
	RequestMeta,
} from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";

const { usageCache } = await import("@better-ccflare/providers");
const { proxyWithAccount } = await import("../proxy-operations");
const { ForceRouteUnavailableError } = await import("../account-selector");
const { RoutingAttemptLedger } = await import("../routing-attempt-ledger");

const HOUR = 3_600_000;
const ACCOUNT_ID = "acc-claude-held";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: ACCOUNT_ID,
		name: "claude-max",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 3 * HOUR,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 1_700_000_000_000,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: true,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function hold(windowKey: "five_hour" | "seven_day_opus"): ExtraUsageHold {
	const family = windowKey === "seven_day_opus";
	return {
		windowKey,
		scope: family ? "family" : "account",
		modelFamily: family ? "opus" : null,
		resetsAtMs: Date.now() + HOUR,
		startedAt: Date.now() - 60_000,
	};
}

/** The hold columns as the fresh read returns them after selection. */
function stored(
	overrides: Partial<ExtraUsageHoldInputs> = {},
): ExtraUsageHoldInputs {
	return {
		provider: "anthropic",
		createdAt: 1_700_000_000_000,
		switchOn: true,
		holds: null,
		paused: false,
		pauseReason: null,
		overageBilledAt: null,
		overageBilledFamily: null,
		...overrides,
	};
}

const opusHeld = () =>
	stored({
		holds: { readingAt: Date.now() - 60_000, holds: [hold("seven_day_opus")] },
	});
const heldEverywhere = () =>
	stored({
		holds: { readingAt: Date.now() - 60_000, holds: [hold("five_hour")] },
	});
const billed = () =>
	stored({
		paused: true,
		pauseReason: "overage",
		overageBilledAt: Date.now() - 1_000,
		overageBilledFamily: "opus",
	});

function makeCtx(inputs: ExtraUsageHoldInputs | null) {
	const getExtraUsageHoldInputs = mock(async (_accountId: string) => inputs);
	const ctx = {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			getExtraUsageHoldInputs,
			markAccountRateLimited: mock(() =>
				Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock(() => Promise.resolve()),
			saveRoutingAttempt: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			updateAccountRateLimitMeta: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
		config: { getStorePayloads: () => true } as never,
		internalProbeSecret: "test-secret",
	} as ProxyContext;
	return { ctx, getExtraUsageHoldInputs };
}

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-hold",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
	};
}

function makeBody(model: string): ArrayBuffer {
	return new TextEncoder().encode(
		JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	).buffer as ArrayBuffer;
}

function success(model: string): Response {
	return Response.json({
		id: "msg-1",
		type: "message",
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		model,
		stop_reason: "end_turn",
		usage: { input_tokens: 1, output_tokens: 1 },
	});
}

function rateLimited(): Response {
	return Response.json(
		{
			type: "error",
			error: { type: "rate_limit_error", message: "An error occurred" },
		},
		{ status: 429 },
	);
}

let sent: string[] = [];
let originalFetch: typeof globalThis.fetch;

/** The stand-in: records the model of every request that reaches it. */
function standIn(respond: (model: string, index: number) => Response) {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const request = input instanceof Request ? input : new Request(input);
		const body = (await request.clone().json()) as { model?: string };
		const model = body.model ?? "missing";
		sent.push(model);
		return respond(model, sent.length - 1);
	}) as unknown as typeof fetch;
}

/** proxyWithAccount, tolerating the uninitialized collector a real send reaches. */
async function send(
	account: Account,
	ctx: ProxyContext,
	model: string,
	meta: RequestMeta = makeRequestMeta(),
	ledger?: InstanceType<typeof RoutingAttemptLedger>,
): Promise<Response | null | "sent"> {
	const body = makeBody(model);
	const req = new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "content-type": "application/json" },
	});
	try {
		return await proxyWithAccount(
			req,
			new URL(req.url),
			account,
			meta,
			body,
			() => undefined,
			0,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			false,
			undefined,
			ledger,
		);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes("UsageCollector not initialized")
		) {
			return "sent";
		}
		throw error;
	}
}

/**
 * Edited from the out-of-credits suite's incident usage: the Fable limit is
 * spent, so a Fable 429 narrows to the family and the login moves on to its
 * next mapped model.
 */
function cacheFableSpent(accountId: string): void {
	usageCache.set(accountId, {
		limits: [
			{
				kind: "session",
				percent: 0,
				resets_at: new Date(Date.now() + HOUR).toISOString(),
				is_active: true,
			},
			{
				kind: "weekly_all",
				percent: 72,
				resets_at: new Date(Date.now() + 6 * 24 * HOUR).toISOString(),
				is_active: true,
			},
			{
				kind: "weekly_scoped",
				percent: 100,
				resets_at: new Date(Date.now() + 2 * 24 * HOUR).toISOString(),
				scope: { model: { id: null, display_name: "Fable" } },
				is_active: true,
			},
		],
	} as never);
}

beforeEach(() => {
	sent = [];
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	usageCache.delete(ACCOUNT_ID);
});

describe("the check just before each send", () => {
	it("a hold stored after selection stops the send, and the next login still sends", async () => {
		standIn((model) => success(model));
		const { ctx } = makeCtx(opusHeld());
		// Selected with no hold on the row: the hold arrived afterwards.
		const selected = makeAccount({ extra_usage_holds: null });
		expect(await send(selected, ctx, "claude-opus-4-8")).toBeNull();
		expect(sent).toEqual([]);

		const { ctx: otherCtx } = makeCtx(stored());
		const other = makeAccount({ id: "acc-claude-free", name: "free" });
		expect(await send(other, otherCtx, "claude-opus-4-8")).toBe("sent");
		expect(sent).toEqual(["claude-opus-4-8"]);
	});

	it("a fallback within one login skips the held Opus and sends only Sonnet", async () => {
		cacheFableSpent(ACCOUNT_ID);
		standIn((model, index) => (index === 0 ? rateLimited() : success(model)));
		const { ctx } = makeCtx(opusHeld());
		const account = makeAccount({
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-5"],
			}),
		});
		expect(await send(account, ctx, "claude-fable-5")).toBe("sent");
		expect(sent).toEqual(["claude-fable-5", "claude-sonnet-4-5"]);
	});

	it("a hold on every model skips each model on the login", async () => {
		standIn((model) => success(model));
		const { ctx } = makeCtx(heldEverywhere());
		for (const model of ["claude-opus-4-8", "claude-sonnet-4-5"]) {
			expect(await send(makeAccount(), ctx, model)).toBeNull();
		}
		expect(sent).toEqual([]);
	});

	it("a request selected before a billed response held the login is not sent once it is", async () => {
		standIn((model) => success(model));
		const { ctx } = makeCtx(billed());
		const selected = makeAccount({ paused: false, pause_reason: null });
		expect(await send(selected, ctx, "claude-sonnet-4-5")).toBeNull();
		expect(sent).toEqual([]);
	});

	/** A ledger that records the cause of every physical outcome. */
	function observedLedger() {
		const ledger = new RoutingAttemptLedger();
		const outcomes: unknown[] = [];
		const record = ledger.recordPhysicalOutcome.bind(ledger);
		ledger.recordPhysicalOutcome = ((cause: unknown, ...rest: never[]) => {
			outcomes.push(cause);
			return record(cause, ...rest);
		}) as typeof ledger.recordPhysicalOutcome;
		return { ledger, outcomes };
	}

	it("a veto is not recorded as a transport error", async () => {
		standIn((model) => success(model));
		const { ctx } = makeCtx(opusHeld());
		const { ledger, outcomes } = observedLedger();
		expect(
			await send(
				makeAccount(),
				ctx,
				"claude-opus-4-8",
				makeRequestMeta(),
				ledger,
			),
		).toBeNull();
		expect(outcomes).not.toContain("transport_error");
		expect(sent).toEqual([]);
	});

	it("a refusal on a route naming the login is not recorded as a transport error", async () => {
		standIn((model) => success(model));
		const { ctx } = makeCtx(opusHeld());
		const { ledger, outcomes } = observedLedger();
		const meta = makeRequestMeta({ forcedAccountId: ACCOUNT_ID });
		await expect(
			send(makeAccount(), ctx, "claude-opus-4-8", meta, ledger),
		).rejects.toBeInstanceOf(ForceRouteUnavailableError);
		expect(outcomes).not.toContain("transport_error");
		expect(sent).toEqual([]);
	});

	describe("on a route naming the login", () => {
		const cases: Array<[string, () => ExtraUsageHoldInputs, string, string]> = [
			[
				"a hold on the model",
				opusHeld,
				"claude-opus-4-8",
				"model_capacity_exhausted",
			],
			[
				"a hold on every model",
				heldEverywhere,
				"claude-sonnet-4-5",
				"account_capacity_exhausted",
			],
			["a billed response", billed, "claude-sonnet-4-5", "paused"],
		];
		for (const [label, inputs, model, reason] of cases) {
			it(`${label} refuses with ${reason} when the server named the login`, async () => {
				standIn((m) => success(m));
				const { ctx } = makeCtx(inputs());
				await expect(
					send(
						makeAccount(),
						ctx,
						model,
						makeRequestMeta({ forcedAccountId: ACCOUNT_ID }),
					),
				).rejects.toMatchObject({ accountId: ACCOUNT_ID, reason });
				expect(sent).toEqual([]);
			});

			it(`${label} refuses with ${reason} when only the public header names the login`, async () => {
				standIn((m) => success(m));
				const { ctx } = makeCtx(inputs());
				const meta = makeRequestMeta({
					headers: new Headers({ "x-better-ccflare-account-id": ACCOUNT_ID }),
				});
				const refusal = send(makeAccount(), ctx, model, meta);
				await expect(refusal).rejects.toBeInstanceOf(
					ForceRouteUnavailableError,
				);
				await expect(refusal).rejects.toMatchObject({ reason });
				expect(sent).toEqual([]);
			});
		}
	});

	it("on a route naming the login, a fallback within it skips the held Opus and sends Sonnet", async () => {
		cacheFableSpent(ACCOUNT_ID);
		standIn((model, index) => (index === 0 ? rateLimited() : success(model)));
		const { ctx } = makeCtx(opusHeld());
		const account = makeAccount({
			model_mappings: JSON.stringify({
				fable: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-5"],
			}),
		});
		const meta = makeRequestMeta({ forcedAccountId: ACCOUNT_ID });
		expect(await send(account, ctx, "claude-fable-5", meta)).toBe("sent");
		expect(sent).toEqual(["claude-fable-5", "claude-sonnet-4-5"]);
	});

	describe("when the hold read fails", () => {
		function failingCtx() {
			const { ctx, getExtraUsageHoldInputs } = makeCtx(null);
			getExtraUsageHoldInputs.mockImplementation(async () => {
				throw new Error("database is locked");
			});
			return ctx;
		}

		it("uses the hold the login was selected with, without a transport error", async () => {
			standIn((model) => success(model));
			const { ledger, outcomes } = observedLedger();
			const selected = makeAccount({ extra_usage_holds: opusHeld().holds });
			expect(
				await send(
					selected,
					failingCtx(),
					"claude-opus-4-8",
					makeRequestMeta(),
					ledger,
				),
			).toBeNull();
			expect(outcomes).not.toContain("transport_error");
			expect(sent).toEqual([]);
		});

		it("keeps a billed pause the login was selected with", async () => {
			standIn((model) => success(model));
			const selected = makeAccount({ paused: true, pause_reason: "overage" });
			expect(
				await send(selected, failingCtx(), "claude-sonnet-4-5"),
			).toBeNull();
			expect(sent).toEqual([]);
		});

		it("sends a model the selected state does not hold", async () => {
			standIn((model) => success(model));
			expect(await send(makeAccount(), failingCtx(), "claude-opus-4-8")).toBe(
				"sent",
			);
			expect(sent).toEqual(["claude-opus-4-8"]);
		});
	});

	it("a route naming a different login is skipped, not refused", async () => {
		standIn((model) => success(model));
		const { ctx } = makeCtx(opusHeld());
		const meta = makeRequestMeta({ forcedAccountId: "some-other-login" });
		expect(await send(makeAccount(), ctx, "claude-opus-4-8", meta)).toBeNull();
		expect(sent).toEqual([]);
	});

	it("with the switch off, no hold read happens and the request is sent as today", async () => {
		standIn((model) => success(model));
		const { ctx, getExtraUsageHoldInputs } = makeCtx(opusHeld());
		const account = makeAccount({ auto_pause_on_overage_enabled: false });
		expect(await send(account, ctx, "claude-opus-4-8")).toBe("sent");
		expect(getExtraUsageHoldInputs).not.toHaveBeenCalled();
		expect(sent).toEqual(["claude-opus-4-8"]);
	});

	it("when the switch was turned off after selection, the stored hold is ignored", async () => {
		standIn((model) => success(model));
		const { ctx } = makeCtx({ ...opusHeld(), switchOn: false });
		expect(await send(makeAccount(), ctx, "claude-opus-4-8")).toBe("sent");
		expect(sent).toEqual(["claude-opus-4-8"]);
	});

	it("when the switch was turned off after selection, a billed hold no longer stops the send", async () => {
		standIn((model) => success(model));
		const { ctx } = makeCtx({ ...billed(), switchOn: false });
		expect(await send(makeAccount(), ctx, "claude-sonnet-4-5")).toBe("sent");
		expect(sent).toEqual(["claude-sonnet-4-5"]);
	});

	it("a model the hold does not cover is sent", async () => {
		standIn((model) => success(model));
		const { ctx } = makeCtx(opusHeld());
		expect(await send(makeAccount(), ctx, "claude-sonnet-4-5")).toBe("sent");
		expect(sent).toEqual(["claude-sonnet-4-5"]);
	});
});
