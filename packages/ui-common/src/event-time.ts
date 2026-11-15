export interface EventTimeOptions {
	locale?: string;
	timeZone?: string;
}

type FormatterKind = "day" | "clock" | "datedClock" | "full";

const OPTIONS: Record<FormatterKind, Intl.DateTimeFormatOptions> = {
	day: { year: "numeric", month: "numeric", day: "numeric" },
	clock: {
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
		hour12: true,
	},
	datedClock: {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
		hour12: true,
	},
	full: {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
		hour12: true,
	},
};

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(
	kind: FormatterKind,
	opts: EventTimeOptions,
): Intl.DateTimeFormat {
	const key = `${kind}|${opts.locale ?? ""}|${opts.timeZone ?? ""}`;
	let format = cache.get(key);
	if (!format) {
		format = new Intl.DateTimeFormat(opts.locale, {
			...OPTIONS[kind],
			timeZone: opts.timeZone,
		});
		cache.set(key, format);
	}
	return format;
}

/**
 * Clock time of an event with seconds ("1:42:05 PM"), with the short date in
 * front ("Nov 14, 1:42:05 PM") when the event is not on now's local day.
 */
export function formatEventTime(
	ms: number,
	now: number,
	opts: EventTimeOptions = {},
): string {
	const day = formatter("day", opts);
	const sameDay = day.format(ms) === day.format(now);
	return formatter(sameDay ? "clock" : "datedClock", opts).format(ms);
}

/** Full date and clock time of an event ("Nov 14, 2026, 1:42:05 PM"). */
export function formatEventTimeFull(
	ms: number,
	opts: EventTimeOptions = {},
): string {
	return formatter("full", opts).format(ms);
}
