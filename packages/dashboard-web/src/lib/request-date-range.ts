import { formatClockTime } from "@hov-router/ui-common";

/**
 * How the Requests page reads its From and To inputs. They are
 * `datetime-local` values ("2026-11-15T17:05"): local wall time with no zone,
 * naming a minute. The presets, the filter and the active-filter chip all read
 * them here, so the range the chip names is the range the filter applies.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const DATE_PRESET_SPAN_MS = {
	"1h": HOUR_MS,
	"24h": DAY_MS,
	"7d": 7 * DAY_MS,
	"30d": 30 * DAY_MS,
} as const;

export type DatePreset = keyof typeof DATE_PRESET_SPAN_MS;

const pad = (n: number) => String(n).padStart(2, "0");

/** A `datetime-local` value for `date` in local wall time. */
export function toDateTimeLocalValue(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The From value a preset writes: its span back from now. Presets leave To
 * empty, so requests that arrive after the click still show.
 */
export function datePresetFrom(preset: DatePreset, nowMs: number): string {
	return toDateTimeLocalValue(new Date(nowMs - DATE_PRESET_SPAN_MS[preset]));
}

export interface RequestDateBounds {
	/** First kept instant, or null for no lower bound. */
	fromMs: number | null;
	/** Last kept instant, or null for no upper bound. */
	toMs: number | null;
}

/** Start of the minute a `datetime-local` value names, or null if unreadable. */
function minuteStart(value: string): number | null {
	if (!value) return null;
	const ms = new Date(value).getTime();
	return Number.isNaN(ms) ? null : Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * The instants the date filter keeps, inclusive: from the start of From's
 * minute to the end of To's. An empty or unreadable input leaves its side open.
 */
export function requestDateBounds(
	dateFrom: string,
	dateTo: string,
): RequestDateBounds {
	const from = minuteStart(dateFrom);
	const to = minuteStart(dateTo);
	return { fromMs: from, toMs: to === null ? null : to + MINUTE_MS - 1 };
}

export function inRequestDateRange(
	timestampMs: number,
	{ fromMs, toMs }: RequestDateBounds,
): boolean {
	if (fromMs !== null && timestampMs < fromMs) return false;
	if (toMs !== null && timestampMs > toMs) return false;
	return true;
}

/**
 * The range the date filter applies, in the dashboard's clock format
 * ("4:05 PM" today, "Nov 14, 8:00 PM" on another day).
 */
export function appliedDateRangeLabel(
	dateFrom: string,
	dateTo: string,
	opts: { locale?: string; now?: number } = {},
): string {
	const now = opts.now ?? Date.now();
	const clock = (ms: number) =>
		formatClockTime(ms, now, { locale: opts.locale });
	const from = minuteStart(dateFrom);
	const to = minuteStart(dateTo);
	if (from !== null && to !== null) {
		const start = clock(from);
		const end = clock(to);
		return start === end ? start : `${start} – ${end}`;
	}
	if (from !== null) return `from ${clock(from)}`;
	if (to !== null) return `until ${clock(to)}`;
	return "any time";
}
