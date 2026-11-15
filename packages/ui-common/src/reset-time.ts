export const SAME_RESET_TOLERANCE_MS = 60_000;

/** For each reset, the index of the earlier adjacent reset it repeats, or null. */
export function sameResetKeepers(
	resets: ReadonlyArray<string | number | null | undefined>,
	toleranceMs = SAME_RESET_TOLERANCE_MS,
): Array<number | null> {
	let keeper: number | null = null;
	let keeperMs = NaN;
	return resets.map((reset, index) => {
		const ms =
			typeof reset === "number"
				? reset
				: typeof reset === "string"
					? Date.parse(reset)
					: NaN;
		if (!Number.isFinite(ms)) {
			keeper = null;
			return null;
		}
		if (keeper !== null && Math.abs(ms - keeperMs) <= toleranceMs)
			return keeper;
		keeper = index;
		keeperMs = ms;
		return null;
	});
}

/** Local clock time, with month and day when it differs from now's local day. */
export function formatClockTime(
	ms: number,
	now: number,
	opts: { locale?: string; timeZone?: string } = {},
): string {
	const day = new Intl.DateTimeFormat(opts.locale, {
		year: "numeric",
		month: "numeric",
		day: "numeric",
		timeZone: opts.timeZone,
	});
	const sameDay = day.format(ms) === day.format(now);
	return new Intl.DateTimeFormat(opts.locale, {
		...(sameDay ? {} : ({ month: "short", day: "numeric" } as const)),
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
		timeZone: opts.timeZone,
	}).format(ms);
}
