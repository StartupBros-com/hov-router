/** Window shape the public feed publishes (v2). */
export interface PublicValueWindow {
	startedAt: number;
	resetsAt: number;
	closedAt: number | null;
	valueUsd: number | null;
	pricingCoverage: "complete" | "partial" | "unknown";
	grantType: "natural" | "early_reset" | "first_observed";
	pointsUsed: number | null;
	counterResets: number | null;
}

export interface PublicValuePeriod {
	kind: "trailing_30_days" | "calendar_month";
	startsAt: number;
	endsAt: number;
	valueUsd: number | null;
	coveredMs: number;
	lowerBound: boolean;
	earlyResets: number;
	counterResets: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const COMPLETED_RECENT_DAYS = 35;
export const COMPLETED_MIN = 8;
export const COMPLETED_MAX = 32;
/** Previous complete calendar months published after the month to date. */
const PREVIOUS_MONTHS = 3;

/** Start of the UTC month `monthsBack` months before the month containing `at`. */
function utcMonthStart(at: number, monthsBack = 0): number {
	const d = new Date(at);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsBack, 1);
}

/**
 * Closed windows that closed within 35 days of `at`, or the 8 most recent when
 * fewer qualify, at most 32, newest `resetsAt` first.
 */
export function selectCompleted(
	closed: PublicValueWindow[],
	at: number,
): PublicValueWindow[] {
	const cutoff = at - COMPLETED_RECENT_DAYS * DAY_MS;
	return [...closed]
		.sort((a, b) => b.resetsAt - a.resetsAt)
		.filter(
			(window, index) =>
				index < COMPLETED_MIN ||
				(window.closedAt !== null && window.closedAt >= cutoff),
		)
		.slice(0, COMPLETED_MAX);
}

function buildPeriod(
	kind: PublicValuePeriod["kind"],
	startsAt: number,
	endsAt: number,
	closed: PublicValueWindow[],
	open: PublicValueWindow | null,
	at: number,
): PublicValuePeriod {
	let valueUsd: number | null = null;
	let lowerBound = false;
	let earlyResets = 0;
	const overlaps: Array<[number, number]> = [];
	for (const window of open ? [...closed, open] : closed) {
		const spanEnd = window.closedAt ?? at;
		const from = Math.max(window.startedAt, startsAt);
		const to = Math.min(spanEnd, endsAt);
		if (
			window.grantType === "early_reset" &&
			window.startedAt >= startsAt &&
			window.startedAt < endsAt
		)
			earlyResets++;
		if (to <= from) continue;
		overlaps.push([from, to]);
		if (
			window.valueUsd === null ||
			window.pricingCoverage !== "complete" ||
			window.grantType === "first_observed"
		)
			lowerBound = true;
		if (window.valueUsd !== null)
			valueUsd =
				(valueUsd ?? 0) +
				(window.valueUsd * (to - from)) / (spanEnd - window.startedAt);
	}
	overlaps.sort((a, b) => a[0] - b[0]);
	let coveredMs = 0;
	let runEnd = Number.NEGATIVE_INFINITY;
	for (const [from, to] of overlaps) {
		const clipped = Math.max(from, runEnd);
		if (to > clipped) coveredMs += to - clipped;
		runEnd = Math.max(runEnd, to);
	}
	if (coveredMs < endsAt - startsAt) lowerBound = true;
	let counterResets: number | null = 0;
	for (const window of closed) {
		if (window.closedAt === null) continue;
		if (window.closedAt <= startsAt || window.closedAt > endsAt) continue;
		if (window.counterResets === null) counterResets = null;
		else if (counterResets !== null) counterResets += window.counterResets;
	}
	return {
		kind,
		startsAt,
		endsAt,
		valueUsd,
		coveredMs,
		lowerBound,
		earlyResets,
		counterResets,
	};
}

/**
 * The five published periods, all UTC: trailing 30 days, the month to date,
 * then the 3 previous complete months newest first. A window's span is
 * [startedAt, closedAt) when closed and [startedAt, at) when open, so an early
 * close prorates by when it really ended, not its scheduled reset. A period
 * that would be empty (`at` exactly on a month start) is omitted.
 */
export function buildPeriods(
	closed: PublicValueWindow[],
	open: PublicValueWindow | null,
	at: number,
): PublicValuePeriod[] {
	const bounds: Array<[PublicValuePeriod["kind"], number, number]> = [
		["trailing_30_days", at - 30 * DAY_MS, at],
		["calendar_month", utcMonthStart(at), at],
	];
	for (let back = 1; back <= PREVIOUS_MONTHS; back++)
		bounds.push([
			"calendar_month",
			utcMonthStart(at, back),
			utcMonthStart(at, back - 1),
		]);
	return bounds
		.filter(([, startsAt, endsAt]) => startsAt < endsAt)
		.map(([kind, startsAt, endsAt]) =>
			buildPeriod(kind, startsAt, endsAt, closed, open, at),
		);
}
