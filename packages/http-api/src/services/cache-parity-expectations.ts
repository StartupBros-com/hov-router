/**
 * Declared cache-parity policy — the expected default for every lever
 * CacheParityPolicySnapshot reports.
 *
 * This exists so a nonzero lever in the live snapshot never has to be
 * re-investigated from scratch: either it matches this file, or it shows up
 * in the drift report as a deviation that is either acknowledged (owned, by
 * issue number) or not (a real anomaly). See docs/configuration.md "Codex
 * cache parity ownership" for the KEEP/DEFER/RETIRE/REMOVED contract each
 * default below is drawn from.
 */

import type {
	CacheParityDeclaredAcknowledgement,
	CacheParityDriftEntry,
	CacheParityDriftReport,
	CacheParityLeverKey,
	CacheParityPolicySnapshot,
} from "@better-ccflare/types";

/**
 * Declared default for every lever in CacheParityPolicySnapshot. Values
 * mirror docs/configuration.md:
 *
 * - promptCacheKeyEnabled / cacheKeyMode / pacingMs (60s): KEEP — the proven
 *   production controls. pacingMs is recorded as its deployed value
 *   (2026-08-20 plan doc Sources block: `CCFLARE_CACHE_PACING_MS=60000`), not
 *   the env-unset code default, because the ownership table declares it
 *   KEPT ON.
 * - globalKeepaliveTtlMinutes, xaiCacheKeepaliveTtlMinutes: default-off
 *   diagnostic/compatibility surfaces with no parity claim, declared default 0.
 *
 * The REMOVED levers have no default here: 7.0.0 dropped them from the
 * snapshot, which had reported them at fixed values since 5.0.0.
 */
export const CACHE_PARITY_DECLARED_DEFAULTS: CacheParityPolicySnapshot = {
	promptCacheKeyEnabled: true,
	cacheKeyMode: "conversation",
	pacingMs: 60_000,
	globalKeepaliveTtlMinutes: 0,
	xaiCacheKeepaliveTtlMinutes: 0,
};

/**
 * Known, owned deviations from CACHE_PARITY_DECLARED_DEFAULTS. A lever
 * listed here reports as an acknowledged deviation in the drift report
 * rather than an unacknowledged anomaly.
 */
export const CACHE_PARITY_ACKNOWLEDGED_DEVIATIONS: Partial<
	Record<CacheParityLeverKey, CacheParityDeclaredAcknowledgement>
> = {};

// Every snapshot field is a lever, and the object literal above cannot carry
// a key the snapshot type lacks, so its keys are exactly the levers.
const DECLARED_LEVER_KEYS = Object.keys(
	CACHE_PARITY_DECLARED_DEFAULTS,
) as CacheParityLeverKey[];

/** Diff a live cache-parity policy snapshot against the declared defaults. */
export function buildCacheParityDriftReport(
	policy: CacheParityPolicySnapshot,
): CacheParityDriftReport {
	const deviations: CacheParityDriftEntry[] = [];
	for (const lever of DECLARED_LEVER_KEYS) {
		const declaredValue = CACHE_PARITY_DECLARED_DEFAULTS[lever];
		const liveValue = policy[lever];
		if (declaredValue === liveValue) continue;
		const acknowledgement = CACHE_PARITY_ACKNOWLEDGED_DEVIATIONS[lever] ?? null;
		deviations.push({
			lever,
			declaredValue,
			liveValue,
			acknowledged: acknowledgement !== null,
			acknowledgement,
		});
	}

	return {
		declaredDefaults: CACHE_PARITY_DECLARED_DEFAULTS,
		deviations,
	};
}
