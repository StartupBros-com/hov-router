/**
 * Display-string computation for an account's rate-limit state.
 *
 * Extracted from the accounts list handler so the precedence rules are
 * testable in isolation. Precedence (highest first):
 *
 *   1. usage exhaustion — the representative usage window is at 100% and its
 *      reset (when known) lies in the future. This outranks unified-header
 *      snapshots because those go stale on idle accounts: during the
 *      2026-07-09 incident an account at 100% weekly utilization kept showing
 *      "OK" (no snapshot stored) while every upstream request 429'd.
 *   2. the last unified rate-limit header snapshot (`rate_limit_status`),
 *      with minutes until `rate_limit_reset` when that is in the future. A
 *      soft notice (`allowed_warning`, `queueing_soft`) is skipped once its
 *      stored reset has passed; see `isExpiredSoftNotice`.
 *   3. the legacy cooldown lock (`rate_limited_until`).
 *   4. "OK".
 */

import { isUsageExhausted } from "@better-ccflare/core";

// Re-exported for backward compatibility — canonical definition now lives in
// @better-ccflare/core so packages that can't depend on http-api (e.g. proxy's
// account-selector) can use the same predicate.
export { isUsageExhausted } from "@better-ccflare/core";

// Re-exported for backward compatibility — canonical definition now lives in
// @better-ccflare/providers so packages that can't depend on http-api (e.g.
// proxy's account-selector) can use the same reset-time extraction.
export {
	extractUsageResetMs,
	getRepresentativeUsageResetMs,
} from "@better-ccflare/providers";

export interface RateLimitStatusInput {
	/** Last `anthropic-ratelimit-unified-status` snapshot, if any. */
	rate_limit_status: string | null;
	/** Reset time (ms epoch) accompanying the unified snapshot. */
	rate_limit_reset: number | null;
	/** Local cooldown lock (ms epoch), set by 429-driven backoff. */
	rate_limited_until: number | null;
	/** Representative usage-window utilization in percent (0-100), or null. */
	usageUtilization: number | null;
	/** Reset time (ms epoch) of the representative usage window, if known. */
	usageResetMs?: number | null;
	/**
	 * Codex credit drain is in effect (see isCodexCreditDrainActive): the spent
	 * subscription window does not block routing, so it must not be reported as
	 * usage exhaustion. Defaults to off.
	 */
	creditDrainActive?: boolean;
}

function minutesLeft(untilMs: number, now: number): number {
	return Math.ceil((untilMs - now) / 60000);
}

/** Header statuses that do not block routing (anthropic provider HARD_LIMIT_STATUSES excludes them). */
const SOFT_NOTICE_STATUSES = new Set(["allowed_warning", "queueing_soft"]);

/**
 * True when a soft notice's stored reset has passed. The column is rewritten
 * only by a response that carries a unified status header, and the stored
 * reset is clamped to that response time + 24h, so in practice this hides the
 * notice once a day has gone by without such a response. An idle account
 * would otherwise keep "Provider warning" across its weekly rollover. Hard
 * statuses are left alone: the card gives a past-reset hard status its own
 * label and Clear cooldown action.
 */
function isExpiredSoftNotice(
	status: string,
	resetMs: number | null,
	now: number,
): boolean {
	return (
		SOFT_NOTICE_STATUSES.has(status.trim().toLowerCase()) &&
		resetMs != null &&
		resetMs <= now
	);
}

export function computeRateLimitStatusDisplay(
	input: RateLimitStatusInput,
	now: number,
): string {
	const { usageUtilization, usageResetMs } = input;

	if (
		!input.creditDrainActive &&
		isUsageExhausted(usageUtilization, usageResetMs, now)
	) {
		if (usageResetMs != null && usageResetMs > now) {
			return `usage_exhausted (${minutesLeft(usageResetMs, now)}m)`;
		}
		return "usage_exhausted";
	}

	if (
		input.rate_limit_status &&
		!isExpiredSoftNotice(input.rate_limit_status, input.rate_limit_reset, now)
	) {
		if (input.rate_limit_reset && input.rate_limit_reset > now) {
			return `${input.rate_limit_status} (${minutesLeft(input.rate_limit_reset, now)}m)`;
		}
		return input.rate_limit_status;
	}

	if (input.rate_limited_until && input.rate_limited_until > now) {
		return `Rate limited (${minutesLeft(input.rate_limited_until, now)}m)`;
	}

	return "OK";
}
