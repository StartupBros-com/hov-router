/**
 * Response types for the cache parity endpoint (/api/insights/cache-parity)
 * and the anomaly detectors the alert service runs.
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

/**
 * Anomaly detector results. GET /api/insights/anomalies was removed in 7.0.0;
 * the alert service's anomaly sweep still builds this response internally.
 */

/** Which per-request token metric an outlier was detected on. */
export type TokenOutlierMetric = "total_tokens" | "output_tokens";

/** Effective detector thresholds echoed back with an anomalies response. */
export interface AnomalyInsightsMeta {
	range: string;
	/**
	 * Modified z-score threshold in log-space (median/MAD based), NOT a
	 * literal standard-deviation count.
	 */
	zScoreThreshold: number;
	minBaselineRequests: number;
	/** Minutes of trailing history the baseline was built from (decoupled from the scoring window). */
	baselineWindowMinutes: number;
	/** Row count the baseline statistics were computed over (>= scannedRequests when the baseline window exceeds the scoring window). */
	baselineWindowRequests: number;
	loopWindowMinutes: number;
	loopMinRequests: number;
	/** Max coefficient of variation of request-side tokens for a burst to count as a loop. */
	loopSimilarityTolerance: number;
	misroutingMaxTotalTokens: number;
	misroutingMinOutputRateUsd: number;
	misroutingMinRequests: number;
	maxEventsPerDetector: number;
	/** Number of request rows the detectors actually ran over. */
	scannedRequests: number;
	/** True when the window held more rows than the scan cap; only the most recent rows were analyzed. */
	truncated: boolean;
}

/**
 * Rolling token baseline for one (account, model) pair over the requested
 * window. Only computed from requests with at least one token; groups with
 * fewer than minBaselineRequests such requests have no baseline.
 */
export interface AnomalyBaseline {
	account: string;
	model: string;
	requests: number;
	/**
	 * Median of ln(total tokens) across the baseline population. `null` when
	 * the group has too few token-bearing rows to qualify for
	 * minBaselineRequests on the total-tokens side (independent metric
	 * qualification — see issue #410 follow-up). In practice this metric is
	 * very unlikely to be the one that's unavailable (computeBaselines only
	 * emits a baseline entry at all when at least one of the two metrics
	 * qualifies), but the field is nullable for symmetry with the
	 * output-tokens side, since the implementation treats both directions
	 * the same way.
	 */
	medianLogTotalTokens: number | null;
	/** Scaled (x1.4826) median absolute deviation of ln(total tokens). `null` under the same condition as medianLogTotalTokens. */
	madTotalTokens: number | null;
	/**
	 * Median of ln(output tokens) across the baseline population (rows with
	 * output_tokens > 0 only). `null` when the group has too few
	 * output-token-bearing rows to qualify for minBaselineRequests
	 * (independent metric qualification — see issue #410 follow-up).
	 */
	medianLogOutputTokens: number | null;
	/** Scaled (x1.4826) median absolute deviation of ln(output tokens). `null` under the same condition as medianLogOutputTokens. */
	madOutputTokens: number | null;
	/**
	 * Human-readable raw-scale approximation of central tendency, for display
	 * only: exp(medianLogTotalTokens). NOT used in any zScore computation —
	 * geometric mean of the baseline population's total tokens. `null` under
	 * the same condition as medianLogTotalTokens.
	 */
	approxMedianTotalTokens: number | null;
	/** exp(medianLogOutputTokens); display-only, see approxMedianTotalTokens. `null` under the same condition as medianLogOutputTokens. */
	approxMedianOutputTokens: number | null;
}

/**
 * A single request whose token usage sits at or above zScoreThreshold
 * standard deviations over its (account, model) baseline mean. Low-side
 * deviations are never reported.
 */
export interface TokenOutlierEvent {
	requestId: string;
	timestamp: number;
	account: string;
	model: string;
	/**
	 * Pre-normalization account, as stored on the request row: `null` when
	 * the request has no account attribution. Unlike `account` (which
	 * collapses a missing account to the literal display string
	 * "Unknown"), this preserves the null/non-null distinction so a
	 * consumer building a dedup or grouping key can tell "no account" apart
	 * from a real account that happens to be named "Unknown".
	 */
	accountRaw: string | null;
	/** Pre-normalization model — see `accountRaw`. */
	modelRaw: string | null;
	project: string | null;
	metric: TokenOutlierMetric;
	value: number;
	/** Log-space median of the baseline population (ln of tokens). */
	baselineMedianLog: number;
	/** Scaled (x1.4826) median absolute deviation of the baseline population, log-space. */
	baselineMad: number;
	/** Human-readable raw-scale approximation: exp(baselineMedianLog). Display only. */
	approxBaselineMedian: number;
	/** Modified z-score: (ln(value) - baselineMedianLog) / baselineMad. */
	zScore: number;
}

/**
 * A sustained burst of near-identical requests (same account/model/project/
 * agent, similar request-side token profile) dense enough to look like a
 * runaway agent loop.
 *
 * Keyed by BOTH per-agent identity AND per-project so many fleet workers
 * sharing one account+model+project — each on its own agent — do not
 * collapse into a single bucket that falsely reports as a loop, AND
 * unattributed traffic (no agent) still splits by project.
 */
export interface RunawayLoopGroup {
	account: string;
	model: string;
	project: string | null;
	agentUsed: string | null;
	windowStartMs: number;
	windowEndMs: number;
	requests: number;
	/** Request rate over the burst, floored at a one-minute span. */
	requestsPerMinute: number;
	/** Mean request-side tokens (input + cache read + cache creation). */
	meanRequestSideTokens: number;
	/** Coefficient of variation of request-side tokens (0 = identical). */
	requestSideTokenSpread: number;
}

/**
 * An (account, model) pair where an expensive model handled repeated
 * trivially small calls that a cheaper model could likely serve.
 */
export interface ModelMisroutingGroup {
	account: string;
	model: string;
	requests: number;
	meanTotalTokens: number;
	/** The model's output rate ($ per 1M tokens) that classified it as expensive. */
	outputRateUsd: number;
	/** Sum of logged cost_usd over the flagged calls. */
	totalCostUsd: number;
	/** Up to five request ids illustrating the pattern. */
	exampleRequestIds: string[];
}

/**
 * Pair of fields that lets the UI distinguish a list that genuinely has
 * nothing from one that is truncated at the response cap. `totalCount` is
 * the full count of detected events before any trimming; `truncated` is
 * true when totalCount exceeds the returned array length.
 */
export interface AnomalyDetectorSummary {
	totalCount: number;
	truncated: boolean;
}

/** Full anomaly detector result, as the alert service's sweep builds it. */
export interface AnomalyInsightsResponse {
	meta: AnomalyInsightsMeta;
	baselines: AnomalyBaseline[];
	/**
	 * Sorted by z-score descending (most extreme first). The list is the
	 * trimmed top-N sample (length <= meta.maxEventsPerDetector); see the
	 * matching `*Summary` for the full count and truncation status.
	 */
	tokenOutliers: TokenOutlierEvent[];
	tokenOutliersSummary: AnomalyDetectorSummary;
	outputBlowups: TokenOutlierEvent[];
	outputBlowupsSummary: AnomalyDetectorSummary;
	/** Sorted by request count descending. */
	runawayLoops: RunawayLoopGroup[];
	runawayLoopsSummary: AnomalyDetectorSummary;
	/** Sorted by total cost descending. */
	misrouting: ModelMisroutingGroup[];
	misroutingSummary: AnomalyDetectorSummary;
}
