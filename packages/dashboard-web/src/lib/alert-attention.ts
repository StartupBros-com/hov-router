import type { AlertEvent } from "@hov-router/types";

/** How many alerts the dashboard fetches, newest first. */
export const ALERTS_LIST_LIMIT = 200;

/** How far back the nav badge looks. Older alerts stay listed on the Alerts page. */
export const ALERT_ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AlertAttention {
	count: number;
	/** True when more qualifying alerts may exist beyond the fetched page. */
	truncated: boolean;
}

/**
 * Count the unacknowledged warning and critical alerts raised in the last day,
 * from a newest-first page of at most `limit` alerts.
 *
 * Info alerts (recoveries and notices) never count, and neither does an alert
 * older than a day; both stay listed on the Alerts page. Without these limits
 * the badge counted every unacknowledged alert ever stored, so it only grew.
 */
export function alertsNeedingAttention(
	alerts: readonly AlertEvent[],
	now: number,
	limit: number,
): AlertAttention {
	const since = now - ALERT_ATTENTION_WINDOW_MS;
	let count = 0;
	for (const alert of alerts) {
		if (alert.acknowledged || alert.severity === "info") continue;
		if (alert.timestamp >= since) count += 1;
	}
	const oldest = alerts.at(-1);
	const truncated =
		alerts.length >= limit && oldest !== undefined && oldest.timestamp >= since;
	return { count, truncated };
}

/** The nav badge text, or undefined to hide the badge. */
export function alertBadgeLabel(attention: AlertAttention): string | undefined {
	if (attention.count === 0) return undefined;
	return attention.truncated ? `${attention.count}+` : String(attention.count);
}
