import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import {
	CODEX_CACHE_KEY_MODE_ENV,
	CODEX_PROMPT_CACHE_KEY_ENV,
	classifyCodexModelFamily,
} from "@better-ccflare/providers";
import { readCachePacingMs } from "@better-ccflare/proxy";
import {
	buildCacheParityResponse,
	type CacheParityAggregateRow,
	type CacheParityPolicy,
} from "../services/cache-parity";
import type { APIContext } from "../types";

const log = new Logger("CacheParityHandler");

interface CacheParitySqlRow {
	provider: string;
	physical_model: string;
	account_name: string;
	turn_kind: "first_observed" | "follow_up";
	gap_band: string;
	context_band: string;
	same_account: number | boolean;
	cache_share_bucket: number | null;
	requests: number;
	successful_requests: number;
	fallback_requests: number;
	context_overflow_requests: number;
	input_tokens: number;
	cache_read_input_tokens: number;
}

const CACHE_PARITY_WINDOW_SQL = `
	WITH sequenced AS (
		SELECT
			r.id,
			r.timestamp,
			r.account_used,
			r.success,
			r.failover_attempts,
			r.error_message,
			COALESCE(r.input_tokens, 0) +
				COALESCE(r.cache_read_input_tokens, 0) +
				COALESCE(r.cache_creation_input_tokens, 0) AS request_input_tokens,
			COALESCE(r.cache_read_input_tokens, 0) AS cache_read_input_tokens,
			COALESCE(a.provider, 'unknown') AS provider,
			COALESCE(NULLIF(r.applied_model, ''), NULLIF(r.model, ''), 'unknown') AS physical_model,
			COALESCE(a.name, 'Unknown') AS account_name,
			LAG(r.timestamp) OVER (
				PARTITION BY COALESCE(a.provider, 'unknown'), r.client_session_id
				ORDER BY r.timestamp, r.id
			) AS previous_timestamp,
			LAG(r.account_used) OVER (
				PARTITION BY COALESCE(a.provider, 'unknown'), r.client_session_id
				ORDER BY r.timestamp, r.id
			) AS previous_account
		FROM requests r
		LEFT JOIN accounts a ON a.id = r.account_used
		WHERE r.timestamp >= ?
			AND r.path = '/v1/messages'
			AND r.client_session_id IS NOT NULL
	), classified AS (
		SELECT
			*,
			CASE
				WHEN previous_timestamp IS NULL THEN 'first_observed'
				ELSE 'follow_up'
			END AS turn_kind,
			CASE
				WHEN previous_timestamp IS NULL THEN 'unknown'
				WHEN timestamp - previous_timestamp < 60000 THEN 'under_1m'
				WHEN timestamp - previous_timestamp < 300000 THEN 'from_1m_to_5m'
				WHEN timestamp - previous_timestamp < 900000 THEN 'from_5m_to_15m'
				WHEN timestamp - previous_timestamp < 3600000 THEN 'from_15m_to_60m'
				ELSE 'at_least_60m'
			END AS gap_band,
			CASE
				WHEN request_input_tokens < 50000 THEN 'under_50k'
				WHEN request_input_tokens < 100000 THEN 'from_50k_to_100k'
				WHEN request_input_tokens < 200000 THEN 'from_100k_to_200k'
				ELSE 'at_least_200k'
			END AS context_band,
			CASE
				WHEN previous_account IS NOT NULL AND previous_account = account_used THEN 1
				ELSE 0
			END AS same_account,
			CASE
				WHEN success = TRUE AND request_input_tokens > 0 THEN
					CASE
						WHEN cache_read_input_tokens >= request_input_tokens THEN 100
						ELSE (cache_read_input_tokens * 100) / request_input_tokens
					END
				ELSE NULL
			END AS cache_share_bucket
		FROM sequenced
	)
	SELECT
		provider,
		physical_model,
		account_name,
		turn_kind,
		gap_band,
		context_band,
		same_account,
		cache_share_bucket,
		COUNT(*) AS requests,
		SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) AS successful_requests,
		SUM(CASE WHEN COALESCE(failover_attempts, 0) > 0 THEN 1 ELSE 0 END) AS fallback_requests,
		SUM(CASE
			WHEN LOWER(COALESCE(error_message, '')) LIKE '%context%'
				AND (
					LOWER(COALESCE(error_message, '')) LIKE '%exceed%'
					OR LOWER(COALESCE(error_message, '')) LIKE '%overflow%'
					OR LOWER(COALESCE(error_message, '')) LIKE '%too long%'
				)
			THEN 1 ELSE 0
		END) AS context_overflow_requests,
		SUM(CASE WHEN cache_share_bucket IS NOT NULL THEN request_input_tokens ELSE 0 END) AS input_tokens,
		SUM(CASE WHEN cache_share_bucket IS NOT NULL THEN cache_read_input_tokens ELSE 0 END) AS cache_read_input_tokens
	FROM classified
	GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
`;

function toCacheParityAggregateRow(
	row: CacheParitySqlRow,
): CacheParityAggregateRow {
	return {
		provider: row.provider,
		physicalModel:
			row.provider === "codex"
				? classifyCodexModelFamily(row.physical_model)
				: row.physical_model,
		accountName: row.account_name,
		turnKind: row.turn_kind,
		gapBand: row.gap_band,
		contextBand: row.context_band,
		sameAccount: row.same_account === true || Number(row.same_account) === 1,
		cacheShareBucket:
			row.cache_share_bucket === null ? null : Number(row.cache_share_bucket),
		requests: Number(row.requests) || 0,
		successfulRequests: Number(row.successful_requests) || 0,
		fallbackRequests: Number(row.fallback_requests) || 0,
		contextOverflowRequests: Number(row.context_overflow_requests) || 0,
		inputTokens: Number(row.input_tokens) || 0,
		cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
	};
}

function readCacheParityPolicy(context: APIContext): CacheParityPolicy {
	return {
		promptCacheKeyEnabled: process.env[CODEX_PROMPT_CACHE_KEY_ENV] !== "0",
		cacheKeyMode:
			process.env[CODEX_CACHE_KEY_MODE_ENV] === "session"
				? "session"
				: "conversation",
		// The cache-key canaries were removed: session keys and prefix sharding
		// are always off and continuity is always on. The levers stay in the
		// declared policy for one release at their fixed values.
		cacheKeySessionPercent: 0,
		cacheKeyContinuityPercent: 100,
		cacheKeyPrefixShardPercent: 0,
		pacingMs: readCachePacingMs(),
		// The Codex settle window and pacing bypass were removed; always 0.
		codexSettleMs: 0,
		pacingBypassPercent: 0,
		// GPT-5.6 explicit breakpoints were removed; always off.
		explicitBreakpointPercent: 0,
		explicitBreakpointSuppressedScopes: 0,
		// Removed lever; keep these compatibility fields for one release.
		turnStatePercent: 0,
		turnStateObserveOnly: false,
		// The Codex WebSocket transport was removed; the lever stays in the
		// declared levers for one release and always reads as off.
		webSocketPercent: 0,
		// Read directly: this feeds the R18 fail-closed guard, so a missing or
		// renamed accessor must break loudly rather than resolve to 0, which
		// would read as "no synthetic traffic" and let parity pass.
		globalKeepaliveTtlMinutes: context.config.getCacheKeepaliveTtlMinutes(),
		xaiCacheKeepaliveTtlMinutes:
			context.config.getXaiCacheKeepaliveTtlMinutes(),
	};
}

/** GET /api/insights/cache-parity — sustained cache parity and live policy. */
export function createCacheParityHandler(context: APIContext) {
	return async (): Promise<Response> => {
		const db = context.dbOps.getAdapter();
		const generatedAt = Date.now();
		try {
			const [rows24h, rows7d] = await Promise.all([
				db.query<CacheParitySqlRow>(CACHE_PARITY_WINDOW_SQL, [
					generatedAt - 24 * 60 * 60 * 1000,
				]),
				db.query<CacheParitySqlRow>(CACHE_PARITY_WINDOW_SQL, [
					generatedAt - 7 * 24 * 60 * 60 * 1000,
				]),
			]);
			return jsonResponse(
				buildCacheParityResponse({
					rows24h: rows24h.map(toCacheParityAggregateRow),
					rows7d: rows7d.map(toCacheParityAggregateRow),
					policy: readCacheParityPolicy(context),
					generatedAt,
				}),
			);
		} catch (error) {
			log.error("Cache parity error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch cache parity data"),
			);
		}
	};
}
