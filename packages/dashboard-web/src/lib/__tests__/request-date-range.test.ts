import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	appliedDateRangeLabel,
	type DatePreset,
	datePresetFrom,
	inRequestDateRange,
	requestDateBounds,
	toDateTimeLocalValue,
} from "../request-date-range";

// Pacific time is behind UTC, so from 4 pm (PST) its date is already tomorrow
// in UTC. Pin it here so the tests do not depend on where they run.
let savedTimeZone: string | undefined;
beforeAll(() => {
	savedTimeZone = process.env.TZ;
	process.env.TZ = "America/Los_Angeles";
});
afterAll(() => {
	if (savedTimeZone === undefined) delete process.env.TZ;
	else process.env.TZ = savedTimeZone;
});

const MINUTE_MS = 60_000;
const at = (iso: string) => Date.parse(iso);

/** 3:30 PM PST on Nov 15; UTC is still on Nov 15. */
const BEFORE_UTC_MIDNIGHT = at("2026-11-15T23:30:00Z");
/** 5:05 PM PST on Nov 15; UTC is already on Nov 16. */
const AFTER_UTC_MIDNIGHT = at("2026-11-16T01:05:00Z");

function keeps(dateFrom: string, dateTo: string, timestampMs: number) {
	return inRequestDateRange(timestampMs, requestDateBounds(dateFrom, dateTo));
}

describe("toDateTimeLocalValue", () => {
	it("writes local wall time, the way a datetime-local input reads it", () => {
		expect(toDateTimeLocalValue(new Date(AFTER_UTC_MIDNIGHT))).toBe(
			"2026-11-15T17:05",
		);
		expect(toDateTimeLocalValue(new Date(BEFORE_UTC_MIDNIGHT))).toBe(
			"2026-11-15T15:30",
		);
	});
});

describe("date presets", () => {
	const sides: Array<[string, number, string]> = [
		["before UTC midnight", BEFORE_UTC_MIDNIGHT, "2026-11-15T14:30"],
		["after UTC midnight", AFTER_UTC_MIDNIGHT, "2026-11-15T16:05"],
	];

	for (const [side, now, hourAgo] of sides) {
		it(`Last hour ${side} starts one local hour ago`, () => {
			expect(datePresetFrom("1h", now)).toBe(hourAgo);
		});

		it(`Last hour ${side} keeps the last hour and nothing older`, () => {
			const from = datePresetFrom("1h", now);
			expect(keeps(from, "", now - 30 * MINUTE_MS)).toBe(true);
			expect(keeps(from, "", now - 61 * MINUTE_MS)).toBe(false);
			expect(keeps(from, "", now - 20 * 60 * MINUTE_MS)).toBe(false);
		});

		it(`Last hour ${side} still keeps requests that arrive later`, () => {
			const from = datePresetFrom("1h", now);
			expect(keeps(from, "", now + 10 * MINUTE_MS)).toBe(true);
		});
	}

	it("Last 24 hours keeps yesterday afternoon but not yesterday morning", () => {
		const from = datePresetFrom("24h", AFTER_UTC_MIDNIGHT);
		expect(from).toBe("2026-11-14T17:05");
		// 6 PM and 9 AM PST on Nov 14.
		expect(keeps(from, "", at("2026-11-15T02:00:00Z"))).toBe(true);
		expect(keeps(from, "", at("2026-11-14T17:00:00Z"))).toBe(false);
	});

	it("each preset spans its length back from now", () => {
		const spans: Array<[DatePreset, string]> = [
			["1h", "2026-11-15T16:05"],
			["24h", "2026-11-14T17:05"],
			["7d", "2026-11-08T17:05"],
			["30d", "2026-10-16T18:05"],
		];
		for (const [preset, from] of spans) {
			expect(datePresetFrom(preset, AFTER_UTC_MIDNIGHT)).toBe(from);
		}
	});
});

describe("requestDateBounds", () => {
	it("keeps the times a custom range names, not whole days", () => {
		const from = "2026-11-15T09:00";
		const to = "2026-11-15T10:00";
		// 8:59 AM, 9:30 AM and 10:01 AM PST.
		expect(keeps(from, to, at("2026-11-15T16:59:00Z"))).toBe(false);
		expect(keeps(from, to, at("2026-11-15T17:30:00Z"))).toBe(true);
		expect(keeps(from, to, at("2026-11-15T18:01:00Z"))).toBe(false);
	});

	it("starts From at the start of its minute", () => {
		expect(keeps("2026-11-15T16:05", "", at("2026-11-16T00:04:59.999Z"))).toBe(
			false,
		);
		expect(keeps("2026-11-15T16:05", "", at("2026-11-16T00:05:00.000Z"))).toBe(
			true,
		);
	});

	it("keeps To's whole minute, since the input cannot name seconds", () => {
		expect(keeps("", "2026-11-15T17:05", at("2026-11-16T01:05:59.999Z"))).toBe(
			true,
		);
		expect(keeps("", "2026-11-15T17:05", at("2026-11-16T01:06:00.000Z"))).toBe(
			false,
		);
	});

	it("leaves a side unbounded when its input is empty or unreadable", () => {
		expect(requestDateBounds("", "")).toEqual({ fromMs: null, toMs: null });
		expect(requestDateBounds("not a date", "")).toEqual({
			fromMs: null,
			toMs: null,
		});
		expect(keeps("not a date", "", at("2020-01-01T00:00:00Z"))).toBe(true);
	});
});

describe("appliedDateRangeLabel", () => {
	const opts = { locale: "en-US", now: AFTER_UTC_MIDNIGHT };

	it("shows the times the filter applies, clock only for today", () => {
		expect(
			appliedDateRangeLabel("2026-11-15T16:05", "2026-11-15T17:05", opts),
		).toBe("4:05 PM – 5:05 PM");
	});

	it("adds the date for another day", () => {
		expect(
			appliedDateRangeLabel("2026-11-14T20:00", "2026-11-15T08:30", opts),
		).toBe("Nov 14, 8:00 PM – 8:30 AM");
	});

	it("names a single bound", () => {
		expect(appliedDateRangeLabel("2026-11-14T20:00", "", opts)).toBe(
			"from Nov 14, 8:00 PM",
		);
		expect(appliedDateRangeLabel("", "2026-11-15T08:30", opts)).toBe(
			"until 8:30 AM",
		);
	});

	it("shows one time when both bounds name the same minute", () => {
		expect(
			appliedDateRangeLabel("2026-11-15T16:05", "2026-11-15T16:05", opts),
		).toBe("4:05 PM");
	});

	it("ignores a value the filter cannot read, as the filter does", () => {
		expect(appliedDateRangeLabel("not a date", "2026-11-15T08:30", opts)).toBe(
			"until 8:30 AM",
		);
		expect(appliedDateRangeLabel("not a date", "", opts)).toBe("any time");
	});
});
