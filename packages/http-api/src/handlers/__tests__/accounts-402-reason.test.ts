import { describe, expect, it, mock } from "bun:test";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { usageCache } from "@better-ccflare/providers";
import { createAccountsListHandler } from "../accounts";

describe("accounts API 402 cooldown reason", () => {
	it("exposes upstream_402_payment_required from persisted account state", async () => {
		const now = Date.now();
		const query = mock(async () => [
			{
				id: "payment-required-account",
				name: "Payment Required Account",
				provider: "openai-compatible",
				request_count: 1,
				total_requests: 2,
				last_used: null,
				created_at: now - 60_000,
				expires_at: null,
				rate_limited_until: now + 120_000,
				rate_limited_reason: "upstream_402_payment_required",
				rate_limited_at: now,
				rate_limit_reset: null,
				rate_limit_status: null,
				rate_limit_remaining: null,
				session_start: null,
				session_request_count: 0,
				refresh_token: "test-key",
				access_token: "test-key",
				paused: 0,
				priority: 0,
				token_valid: 0,
				rate_limited: 1,
				session_info: "-",
				auto_fallback_enabled: 0,
				auto_refresh_enabled: 0,
				auto_pause_on_overage_enabled: 0,
				peak_hours_pause_enabled: 0,
				custom_endpoint: "https://provider.test/v1",
				model_mappings: null,
				cross_region_mode: null,
				model_fallbacks: null,
				billing_type: null,
				pause_reason: null,
			},
		]);
		const dbOps = {
			getAdapter: () => ({ queryMain: query }),
			getStatsRepository: () => ({
				getSessionStats: mock(async () => new Map()),
			}),
		} as unknown as DatabaseOperations;
		const config = {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config;

		const response = await createAccountsListHandler(dbOps, config)();
		const payload = (await response.json()) as Array<{
			rateLimitedReason: string | null;
		}>;

		expect(response.status).toBe(200);
		expect(query).toHaveBeenCalledTimes(1);
		expect(payload[0]?.rateLimitedReason).toBe("upstream_402_payment_required");
	});

	it("exposes org_permission_denied from persisted account state (GAP 3)", async () => {
		// proxy-operations.ts benches an account with this reason on a 403
		// permission_error and writes it to accounts.rate_limited_reason; it
		// must round-trip through the API's toRateLimitReason allowlist
		// instead of being silently nulled.
		const now = Date.now();
		const query = mock(async () => [
			{
				id: "org-permission-denied-account",
				name: "Org Permission Denied Account",
				provider: "anthropic",
				request_count: 1,
				total_requests: 2,
				last_used: null,
				created_at: now - 60_000,
				expires_at: null,
				rate_limited_until: now + 120_000,
				rate_limited_reason: "org_permission_denied",
				rate_limited_at: now,
				rate_limit_reset: null,
				rate_limit_status: null,
				rate_limit_remaining: null,
				session_start: null,
				session_request_count: 0,
				refresh_token: "test-key",
				access_token: "test-key",
				paused: 0,
				priority: 0,
				token_valid: 0,
				rate_limited: 1,
				session_info: "-",
				auto_fallback_enabled: 0,
				auto_refresh_enabled: 0,
				auto_pause_on_overage_enabled: 0,
				peak_hours_pause_enabled: 0,
				custom_endpoint: null,
				model_mappings: null,
				cross_region_mode: null,
				model_fallbacks: null,
				billing_type: null,
				pause_reason: null,
			},
		]);
		const dbOps = {
			getAdapter: () => ({ queryMain: query }),
			getStatsRepository: () => ({
				getSessionStats: mock(async () => new Map()),
			}),
		} as unknown as DatabaseOperations;
		const config = {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config;

		const response = await createAccountsListHandler(dbOps, config)();
		const payload = (await response.json()) as Array<{
			rateLimitedReason: string | null;
		}>;

		expect(response.status).toBe(200);
		expect(query).toHaveBeenCalledTimes(1);
		expect(payload[0]?.rateLimitedReason).toBe("org_permission_denied");
	});

	it("sends when the usage check was refused, after the bench has lapsed (#941)", async () => {
		// The card reads Anthropic refused from this field alone once the
		// router's short bench is over.
		const now = Date.now();
		const row = (id: string) => ({
			id,
			name: id,
			provider: "anthropic",
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: now - 60_000,
			expires_at: null,
			rate_limited_until: null,
			rate_limited_reason: "org_permission_denied",
			rate_limited_at: now - 3_600_000,
			rate_limit_reset: null,
			rate_limit_status: null,
			rate_limit_remaining: null,
			session_start: null,
			session_request_count: 0,
			refresh_token: "test-refresh",
			access_token: "test-access",
			paused: 0,
			priority: 0,
			token_valid: 1,
			rate_limited: 0,
			session_info: "-",
			auto_fallback_enabled: 0,
			auto_refresh_enabled: 0,
			auto_pause_on_overage_enabled: 0,
			peak_hours_pause_enabled: 0,
			custom_endpoint: null,
			model_mappings: null,
			cross_region_mode: null,
			model_fallbacks: null,
			billing_type: null,
			pause_reason: null,
		});
		const refusedId = "usage-refused-account";
		const acceptedId = "usage-accepted-account";
		const startedAt = now - 2_000;
		usageCache.noteOrgUsageCheck(
			refusedId,
			{ data: null, retryAfterMs: null, orgRefused: true },
			startedAt,
		);
		const refusedAt = usageCache.getOrgRefusedAt(refusedId);
		try {
			const query = mock(async () => [row(refusedId), row(acceptedId)]);
			const dbOps = {
				getAdapter: () => ({ queryMain: query }),
				getStatsRepository: () => ({
					getSessionStats: mock(async () => new Map()),
				}),
			} as unknown as DatabaseOperations;
			const config = {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
			} as unknown as Config;

			const response = await createAccountsListHandler(dbOps, config)();
			const payload = (await response.json()) as Array<{
				id: string;
				usageOrgRefusedAt: number | null;
			}>;

			expect(refusedAt).toBeGreaterThanOrEqual(startedAt);
			const byId = new Map(payload.map((account) => [account.id, account]));
			expect(byId.get(refusedId)?.usageOrgRefusedAt).toBe(refusedAt);
			expect(byId.get(acceptedId)?.usageOrgRefusedAt).toBeNull();
		} finally {
			usageCache.noteOrgUsageCheck(
				refusedId,
				{ data: { five_hour: null } as never, retryAfterMs: null },
				Date.now(),
			);
		}
	});
});
