import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";

// This focused unit test does not need DatabaseOperations' worker-backed runtime.
// Mock the package before loading the handler so a source checkout can run it
// without generating any inline worker artifacts.
mock.module("@better-ccflare/database", () => ({
	DatabaseOperations: class DatabaseOperations {},
	DatabaseFactory: class DatabaseFactory {},
	ModelTranslationRepository: class ModelTranslationRepository {},
}));

mock.module("@better-ccflare/cli-commands", () => ({
	pauseAccount: mock(async () => ({ success: true })),
	removeAccount: mock(async () => ({ success: true })),
	resumeAccount: mock(async () => ({ success: true })),
}));

// Must cover every symbol ../accounts imports from this module: a partial mock
// makes the missing name a hard SyntaxError at import time, not a runtime
// undefined, so omitting one fails the whole file rather than one assertion.
// Only visible when this file runs ALONE — a batch run may already have loaded
// the real module — which is exactly what CI's isolated-file pass is for.
mock.module("@better-ccflare/proxy", () => ({
	clearAccountRefreshCache: mock(() => {}),
	clearAccountRemovalTrackingForAccount: mock(() => {}),
	clearCodexModelCacheForAccount: mock(() => {}),
	clearOpenAICompatibleModelCacheForAccount: mock(() => {}),
	clearPendingRotationForDeletedAccount: mock(() => {}),
	getBindingConstraint: mock(() => null),
	getUsageThrottleStatus: mock(() => ({ throttled: false })),
	refreshCodexUsageForAccount: mock(async () => false),
	restartUsagePollingForAccount: mock(() => {}),
}));

const { usageCache } = await import("@better-ccflare/providers");
const { createAccountForceResetRateLimitHandler } = await import("../accounts");

function handledRejectedPromise<T>(error: Error): Promise<T> {
	const promise = Promise.reject<T>(error);
	void promise.catch(() => {});
	return promise;
}

function makeDbOps(reset: () => Promise<boolean>): DatabaseOperations {
	return {
		getAdapter: () => ({
			getMain: mock(async () => ({
				id: "account-id",
				name: "account-name",
				provider: "anthropic",
				access_token: "test-token",
			})),
		}),
		forceResetAccountRateLimit: mock(reset),
	} as unknown as DatabaseOperations;
}

describe("account force-reset rate-limit handler", () => {
	afterEach(() => {
		mock.restore();
	});

	it("awaits the persisted reset before refreshing usage or returning success", async () => {
		const events: string[] = [];
		let resolveReset: (value: boolean) => void = () => {};
		const resetPromise = new Promise<boolean>((resolve) => {
			resolveReset = resolve;
		});
		const dbOps = makeDbOps(() => resetPromise);
		const clearScopedDepletions = spyOn(
			usageCache,
			"clearReactiveScopedDepletions",
		).mockImplementation(() => {
			events.push("clear-scoped-depletions");
		});
		const refreshNow = spyOn(usageCache, "refreshNow").mockImplementation(
			async () => {
				events.push("refresh-usage");
				return true;
			},
		);
		const handler = createAccountForceResetRateLimitHandler(dbOps);

		let settled = false;
		const responsePromise = handler(
			new Request(
				"http://localhost/api/accounts/account-id/force-reset-rate-limit",
				{
					method: "POST",
				},
			),
			"account-id",
		).then((response) => {
			settled = true;
			return response;
		});

		await Promise.resolve();
		await Promise.resolve();
		expect(refreshNow).not.toHaveBeenCalled();
		expect(clearScopedDepletions).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		expect(settled).toBe(false);

		resolveReset(true);
		const response = await responsePromise;
		expect(response.ok).toBe(true);
		expect(clearScopedDepletions).toHaveBeenCalledWith("account-id");
		expect(refreshNow).toHaveBeenCalledWith("account-id");
		expect(events).toEqual(["clear-scoped-depletions", "refresh-usage"]);
	});

	it("surfaces an asynchronous reset rejection without refreshing usage", async () => {
		spyOn(console, "error").mockImplementation(() => {});
		const dbOps = makeDbOps(() =>
			handledRejectedPromise(new Error("persisted reset failed")),
		);
		const refreshNow = spyOn(usageCache, "refreshNow").mockResolvedValue(true);
		const clearScopedDepletions = spyOn(
			usageCache,
			"clearReactiveScopedDepletions",
		);
		const handler = createAccountForceResetRateLimitHandler(dbOps);

		const response = await handler(
			new Request(
				"http://localhost/api/accounts/account-id/force-reset-rate-limit",
				{
					method: "POST",
				},
			),
			"account-id",
		);

		expect(response.ok).toBe(false);
		expect(await response.text()).toContain("persisted reset failed");
		expect(refreshNow).not.toHaveBeenCalled();
		expect(clearScopedDepletions).not.toHaveBeenCalled();
	});
});

// Issue #869: one Clear cooldown click inside Anthropic's usage lockout sent
// two usage requests (refreshNow, then the fallback), each restarting the hour.
// These run the real usage cache against a stubbed endpoint; nothing leaves.
describe.serial("force-reset usage fetches under a usage retry-after", () => {
	const originalFetch = globalThis.fetch;
	let usageRequests = 0;
	let answer: () => Response = () => Response.json({});
	let nextId = 0;
	const started: string[] = [];

	const rateLimited = () =>
		new Response("{}", { status: 429, headers: { "retry-after": "3600" } });
	const usage = () =>
		Response.json({
			five_hour: {
				utilization: 10,
				resets_at: new Date(Date.now() + 3_600_000).toISOString(),
			},
		});

	function lockoutDbOps(id: string): DatabaseOperations {
		return {
			getAdapter: () => ({
				getMain: mock(async () => ({
					id,
					name: id,
					provider: "anthropic",
					access_token: "test-token",
				})),
			}),
			forceResetAccountRateLimit: mock(async () => true),
			recordUsageSnapshot: mock(async () => {}),
		} as unknown as DatabaseOperations;
	}

	function newAccount(): string {
		const id = `force-reset-usage-lockout-${++nextId}`;
		started.push(id);
		return id;
	}

	async function clearCooldown(id: string) {
		const response = await createAccountForceResetRateLimitHandler(
			lockoutDbOps(id),
		)(
			new Request(
				`http://localhost/api/accounts/${id}/force-reset-rate-limit`,
				{
					method: "POST",
				},
			),
			id,
		);
		expect(response.ok).toBe(true);
		return (await response.json()) as { usagePollTriggered: boolean };
	}

	async function settle() {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}

	beforeEach(() => {
		usageRequests = 0;
		globalThis.fetch = (async () => {
			usageRequests++;
			return answer();
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		for (const id of started.splice(0)) {
			usageCache.stopPolling(id);
			usageCache.delete(id);
		}
		globalThis.fetch = originalFetch;
	});

	it.serial("sends nothing while a recorded deadline is live", async () => {
		const id = newAccount();
		answer = rateLimited;
		usageCache.startPolling(id, "test-token", "anthropic", 60_000);
		await settle();
		expect(usageRequests).toBe(1);
		expect(usageCache.getRateLimitedUntil(id)).not.toBeNull();

		const body = await clearCooldown(id);
		expect(body.usagePollTriggered).toBe(false);
		expect(usageRequests).toBe(1);
	});

	it.serial(
		"skips the fallback after the refresh itself draws a 429",
		async () => {
			const id = newAccount();
			answer = usage;
			usageCache.startPolling(id, "test-token", "anthropic", 60_000);
			await settle();
			expect(usageRequests).toBe(1);

			answer = rateLimited;
			await clearCooldown(id);
			expect(usageRequests).toBe(2);
		},
	);

	it.serial(
		"records the fallback's org refusal, and clears it when usage returns (#941)",
		async () => {
			const id = newAccount();
			answer = () =>
				new Response(
					'{"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization.","details":{"error_visibility":"user_facing","error_code":"oauth_not_allowed_for_organization"}}}',
					{ status: 403, headers: { "content-type": "application/json" } },
				);
			await clearCooldown(id);
			expect(usageRequests).toBe(1);
			expect(usageCache.getOrgRefusedAt(id)).not.toBeNull();

			answer = usage;
			const body = await clearCooldown(id);
			expect(body.usagePollTriggered).toBe(true);
			expect(usageRequests).toBe(2);
			expect(usageCache.getOrgRefusedAt(id)).toBeNull();
		},
	);

	it.serial(
		"records a 429 from the fallback so the next click sends nothing",
		async () => {
			const id = newAccount();
			answer = rateLimited;
			await clearCooldown(id);
			expect(usageRequests).toBe(1);
			expect(usageCache.getRateLimitedUntil(id)).not.toBeNull();

			await clearCooldown(id);
			expect(usageRequests).toBe(1);
		},
	);
});
