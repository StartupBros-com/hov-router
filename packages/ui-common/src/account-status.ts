/** Presentation only: observations are not routing eligibility guarantees. */
export interface AccountStatusInput {
	rateLimitStatus?: string | null;
	paused?: boolean;
	requiresReauth?: boolean;
	pauseReason?: string | null;
	rateLimitedUntil?: number | null;
	usageRateLimitedUntil?: number | null;
	usageThrottledUntil?: number | null;
	/** Why the router benched the account; read only while the bench is live. */
	rateLimitedReason?: string | null;
	/**
	 * When the account's latest usage check was refused by Anthropic for its
	 * organization (#941); null once a check returns usage again.
	 */
	usageOrgRefusedAt?: number | null;
	provider?: string | null;
	/** The account's latest usage poll, as the accounts API returns it. */
	usageData?: unknown;
}

/**
 * Anthropic's unified status turns allowed_warning at 75% of a weekly window:
 * all 4,454 stored warnings fired at 75% or more (#917).
 */
export const WEEKLY_WARNING_PERCENT = 75;

export interface WeeklyLimitNotice {
	/** Utilization of the fullest current weekly window, 0-100. */
	percent: number;
	/** That window, e.g. "Weekly" or "Fable weekly". */
	window: string;
}

const LEGACY_WEEKLY_WINDOWS: ReadonlyArray<readonly [string, string]> = [
	["seven_day", "Weekly"],
	["seven_day_fable", "Fable weekly"],
	["seven_day_opus", "Opus weekly"],
	["seven_day_sonnet", "Sonnet weekly"],
	["seven_day_haiku", "Haiku weekly"],
];

function currentPercent(
	percent: unknown,
	resetsAt: unknown,
	now: number,
): number | null {
	if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
	// A window whose reset has passed is a stale reading, never current use.
	// One with no reset time is read as reported, as the usage bars do.
	if (typeof resetsAt !== "string") return percent;
	const reset = Date.parse(resetsAt);
	return Number.isFinite(reset) && reset <= now ? null : percent;
}

/**
 * The current weekly windows in an Anthropic usage poll: limits[] (weekly_all
 * and every weekly_scoped model cap, whatever its is_active flag), else the
 * legacy flat windows when limits[] has no usable row, as the usage bars choose.
 */
function currentWeeklyWindows(
	usageData: unknown,
	now: number,
): WeeklyLimitNotice[] {
	if (!usageData || typeof usageData !== "object") return [];
	const data = usageData as Record<string, unknown>;
	const windows: WeeklyLimitNotice[] = [];
	let usableLimitRows = 0;
	for (const raw of Array.isArray(data.limits) ? data.limits : []) {
		if (!raw || typeof raw !== "object") continue;
		const limit = raw as {
			kind?: unknown;
			percent?: unknown;
			resets_at?: unknown;
			scope?: { model?: { display_name?: unknown } | null } | null;
		};
		if (limit.percent == null) continue;
		const scopedName =
			typeof limit.scope?.model?.display_name === "string"
				? limit.scope.model.display_name.trim()
				: "";
		const window =
			limit.kind === "weekly_all"
				? "Weekly"
				: limit.kind === "weekly_scoped" && scopedName
					? `${scopedName} weekly`
					: null;
		if (limit.kind === "session" || window) usableLimitRows += 1;
		const percent = currentPercent(limit.percent, limit.resets_at, now);
		if (window && percent !== null) windows.push({ percent, window });
	}
	if (usableLimitRows === 0) {
		for (const [key, window] of LEGACY_WEEKLY_WINDOWS) {
			const entry = data[key] as
				| { utilization?: unknown; resets_at?: unknown }
				| null
				| undefined;
			const percent = currentPercent(entry?.utilization, entry?.resets_at, now);
			if (percent !== null) windows.push({ percent, window });
		}
	}
	return windows;
}

/**
 * The fullest weekly window from 75% up to, not including, 100%. A window at
 * 100% is not near its limit: the account row already names it "at limit", or
 * shows the router's hold on it.
 */
export function getWeeklyLimitNotice(
	usageData: unknown,
	now: number,
): WeeklyLimitNotice | null {
	let notice: WeeklyLimitNotice | null = null;
	for (const window of currentWeeklyWindows(usageData, now)) {
		if (window.percent < WEEKLY_WARNING_PERCENT || window.percent >= 100)
			continue;
		if (!notice || window.percent > notice.percent) notice = window;
	}
	return notice;
}
export type AccountStatusReason =
	| "reauth"
	| "paused"
	| "refused"
	| "cooldown"
	| "exhausted"
	| "hard-limit"
	| "pacing"
	| "unknown"
	| "normal";
export function isFutureDeadline(
	value: number | null | undefined,
	now: number,
): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > now;
}
export function classifyAccountStatus(input: AccountStatusInput, now: number) {
	const reportedStatus = input.rateLimitStatus ?? "OK";
	const base = reportedStatus
		.trim()
		.replace(/\s*\(\d+m\)$/, " ")
		.trim()
		.toLowerCase();
	const reauth =
		!!input.requiresReauth || input.pauseReason === "oauth_invalid_grant";
	const cooldown = isFutureDeadline(input.rateLimitedUntil, now);
	// Anthropic 403 permission_error: no local action clears it (#869). The
	// stored reason outlives recovery, so it counts only while the bench is
	// live. A refused usage check counts on its own (#941), unless a live
	// bench for another cause is fresher: a served request does not clear the
	// usage record, and that bench is one the operator can clear.
	const orgBench =
		cooldown && input.rateLimitedReason === "org_permission_denied";
	const usageRefused =
		typeof input.usageOrgRefusedAt === "number" &&
		Number.isFinite(input.usageOrgRefusedAt);
	const refused = orgBench || (usageRefused && !cooldown);
	const pacing = isFutureDeadline(input.usageThrottledUntil, now);
	const refreshDelayed = isFutureDeadline(input.usageRateLimitedUntil, now);
	const exhausted = /^(usage_exhausted|usage exhausted)(?:$|\s)/.test(base);
	const clearableHard = [
		"rate_limited",
		"blocked",
		"queueing_hard",
		"payment_required",
	].some((p) => reportedStatus.toLowerCase().startsWith(p));
	// The API synthesizes this label from the local deadline, not a provider header.
	const generatedCooldown =
		/^Rate limited \(\d+m\)$/.test(reportedStatus) &&
		typeof input.rateLimitedUntil === "number" &&
		Number.isFinite(input.rateLimitedUntil);
	const hard =
		clearableHard ||
		(!generatedCooldown &&
			/^(rate limited|rate limited until|queueing hard|payment required)(?:$|\s)/.test(
				base,
			));
	const headerSoft = base === "allowed_warning" || base === "queueing_soft";
	const normal =
		["ok", "allowed", "paused", ""].includes(base) ||
		headerSoft ||
		generatedCooldown;
	let reason: AccountStatusReason;
	if (reauth) reason = "reauth";
	else if (input.paused) reason = "paused";
	else if (refused) reason = "refused";
	else if (cooldown) reason = "cooldown";
	else if (exhausted) reason = "exhausted";
	else if (hard) reason = "hard-limit";
	else if (pacing) reason = "pacing";
	else if (!normal) reason = "unknown";
	else reason = "normal";
	// An Anthropic account's soft status is the last unified header it sent,
	// which an idle account never refreshes and a weekly reset never clears.
	// The usage poll is fresh and carries the same windows (header 7d and 7d_oi
	// matched the polled weekly windows in 1,500 of 1,500 rows, #917).
	const isAnthropic = input.provider === "anthropic";
	const weeklyLimitNotice =
		isAnthropic && reason === "normal"
			? getWeeklyLimitNotice(input.usageData, now)
			: null;
	const soft = isAnthropic ? weeklyLimitNotice !== null : headerSoft;
	const labels: Record<AccountStatusReason, string> = {
		reauth: "Reconnect required",
		paused: "Paused",
		refused: "Anthropic refused",
		cooldown: "Cooling down",
		exhausted: "Usage exhausted",
		"hard-limit": "Reported hard limit",
		pacing: "Pacing active",
		unknown: "Status unknown",
		normal: weeklyLimitNotice
			? "Near weekly limit"
			: soft
				? "Provider warning"
				: "Ready",
	};
	const notices: ("soft-warning" | "usage-refresh" | "pacing")[] = [];
	if (soft) notices.push("soft-warning");
	if (refreshDelayed) notices.push("usage-refresh");
	if (pacing) notices.push("pacing");
	let tone: "ok" | "warning" | "bad" | "muted";
	if (reason === "paused") tone = "muted";
	else if (
		["reauth", "refused", "cooldown", "exhausted", "hard-limit"].includes(
			reason,
		)
	)
		tone = "bad";
	else if (reason === "normal" && notices.length === 0) tone = "ok";
	else tone = "warning";
	return {
		reason,
		label: labels[reason],
		tone,
		reportedStatus,
		notices,
		/** Set when an Anthropic account's poll has a weekly window at 75-99%. */
		weeklyLimitNotice,
		refreshDelayed,
		pacing,
		reauth,
		cooldown,
		// A refusal the card shows needs attention even with no bench; a paused
		// account is the operator's to leave alone.
		capacityAttention:
			cooldown || exhausted || hard || pacing || reason === "refused",
		overview: cooldown || exhausted || hard || pacing || reason === "refused",
		clearCooldown:
			(clearableHard || cooldown) && !input.paused && reason !== "refused",
		canResume: !reauth,
		routerRetryAt: cooldown ? input.rateLimitedUntil : null,
		/** One visible line naming what the operator can do, when one applies. */
		hint:
			reason === "refused"
				? "Anthropic is refusing this account's organization. Check billing and Claude Code access on claude.ai; the router keeps retrying."
				: null,
	};
}
