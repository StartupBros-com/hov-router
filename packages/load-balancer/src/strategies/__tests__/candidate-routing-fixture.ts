import type {
	Account,
	RequestMeta,
	RoutingCandidateMetadata,
	StrategyStore,
} from "@better-ccflare/types";

export function account(id: string, priority = 0): Account {
	return {
		id,
		name: id,
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh",
		access_token: "access",
		expires_at: Date.now() + 60_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		consecutive_rate_limits: 0,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
	};
}

export function candidate(
	candidateId: string,
	accountId: string,
	tier: number,
	ordinal: number,
	band?: "cold" | "critical",
	routeFallbackRung?: RoutingCandidateMetadata["routeFallbackRung"],
): RoutingCandidateMetadata {
	return {
		candidateId,
		accountId,
		tier,
		ordinal,
		comboSlotId: candidateId,
		modelOverride: `model-${candidateId}`,
		quotaPressure: band
			? { band, comparisonKey: "same-subscription-window" }
			: null,
		routeFallbackRung,
	};
}

export function meta(
	routingCandidates: RoutingCandidateMetadata[],
	lane = "lane",
): RequestMeta {
	return {
		id: crypto.randomUUID(),
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		clientSessionId: "client",
		affinityLaneKey: lane,
		routingCandidates,
		routingCandidateCatalog: routingCandidates,
		nativeAnthropicToolRequirement: null,
	};
}

export const store: StrategyStore = {
	resetAccountSession() {},
	async resumeAccount() {
		return { resumed: true, pauseReason: null };
	},
	getAccountUtilization() {
		return 0;
	},
};
