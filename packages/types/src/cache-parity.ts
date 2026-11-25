/**
 * Response types for the cache parity endpoint (/api/insights/cache-parity).
 */

export type CacheParityVerdict =
	| "at_parity"
	| "below_parity"
	| "insufficient_evidence";

export interface CacheParityMetrics {
	totalRequests: number;
	successfulRequests: number;
	successRatePercent: number | null;
	fallbackRequests: number;
	fallbackRatePercent: number | null;
	contextOverflowRequests: number;
	contextOverflowRatePercent: number | null;
	measuredResponses: number;
	unavailableResponses: number;
	totalInputTokens: number;
	cacheReadInputTokens: number;
	weightedCacheReadPercent: number | null;
	medianCacheReadPercent: number | null;
	p25CacheReadPercent: number | null;
	p75CacheReadPercent: number | null;
	positiveHitResponses: number;
	positiveHitRatePercent: number | null;
	zeroHitResponses: number;
	zeroHitRatePercent: number | null;
}

export interface CacheParityProviderSummary {
	key: string;
	firstObserved: CacheParityMetrics;
	followUps: CacheParityMetrics;
}

export interface CacheParityDimensionSummary {
	key: string;
	metrics: CacheParityMetrics;
}

export interface CacheParityEvidence {
	minimumFollowUps: number;
	minimumInputTokens: number;
	codexQualified: boolean;
	anthropicQualified: boolean;
}

export interface CacheParityWindow {
	verdict: CacheParityVerdict;
	reasons: string[];
	evidence: CacheParityEvidence;
	providers: CacheParityProviderSummary[];
	codexByPhysicalModel: CacheParityDimensionSummary[];
	codexByAccount: CacheParityDimensionSummary[];
	codexByGapBand: CacheParityDimensionSummary[];
	codexByContextBand: CacheParityDimensionSummary[];
	codexByAccountContinuity: CacheParityDimensionSummary[];
}

export interface CacheParityPolicySnapshot {
	promptCacheKeyEnabled: boolean;
	cacheKeyMode: "conversation" | "session";
	cacheKeySessionPercent: number;
	cacheKeyContinuityPercent: number;
	cacheKeyPrefixShardPercent: number;
	pacingMs: number;
	codexSettleMs: number;
	pacingBypassPercent: number;
	explicitBreakpointPercent: number;
	explicitBreakpointSuppressedScopes: number;
	turnStatePercent: number;
	turnStateObserveOnly: boolean;
	webSocketPercent: number;
	globalKeepaliveTtlMinutes: number;
	xaiCacheKeepaliveTtlMinutes: number;
}

/**
 * Levers a live {@link CacheParityPolicySnapshot} is compared against a
 * declared default for. Deliberately excludes
 * `explicitBreakpointSuppressedScopes`, which is an observed suppression
 * counter, not a settable lever with a declared intent.
 */
export type CacheParityLeverKey = Exclude<
	keyof CacheParityPolicySnapshot,
	"explicitBreakpointSuppressedScopes"
>;

/** A GitHub issue that owns a knowingly-live deviation from declared policy. */
export interface CacheParityDeclaredAcknowledgement {
	issue: number;
	note: string;
}

/** One lever whose live value differs from its declared default. */
export interface CacheParityDriftEntry {
	lever: CacheParityLeverKey;
	declaredValue: CacheParityPolicySnapshot[CacheParityLeverKey];
	liveValue: CacheParityPolicySnapshot[CacheParityLeverKey];
	/** True when a CacheParityDeclaredAcknowledgement exists for this lever. */
	acknowledged: boolean;
	acknowledgement: CacheParityDeclaredAcknowledgement | null;
}

export interface CacheParityDriftReport {
	declaredDefaults: CacheParityPolicySnapshot;
	/** Levers whose live value differs from its declared default. */
	deviations: CacheParityDriftEntry[];
}

export interface CacheParityResponse {
	generatedAt: number;
	verdict: CacheParityVerdict;
	metricScopes: {
		durable: "logical_request_final_usage";
		trace: "physical_attempt_usage";
	};
	backendCapability: {
		endpoint: "chatgpt_subscription";
		explicitBreakpoint:
			| "not_requested"
			| "treatment_requested"
			| "unsupported_observed";
	};
	policy: CacheParityPolicySnapshot;
	driftReport: CacheParityDriftReport;
	windows: {
		advisory24h: CacheParityWindow;
		authoritative7d: CacheParityWindow;
	};
}
