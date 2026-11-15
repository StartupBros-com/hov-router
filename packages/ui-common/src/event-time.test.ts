import { describe, expect, it } from "bun:test";
import { formatEventTime, formatEventTimeFull } from "./event-time";

const utc = { locale: "en-US", timeZone: "UTC" };
const now = Date.UTC(2026, 10, 15, 18);
const event = Date.UTC(2026, 10, 15, 13, 42, 5);

describe("formatEventTime", () => {
	it("shows the clock with seconds on the same local day", () => {
		expect(formatEventTime(event, now, utc)).toBe("1:42:05 PM");
	});

	it("adds the month and day for an event on another local day", () => {
		expect(formatEventTime(event - 24 * 3_600_000, now, utc)).toBe(
			"Nov 14, 1:42:05 PM",
		);
	});

	it("judges the day in the formatter's time zone, not the machine's", () => {
		const midnight = Date.UTC(2026, 10, 15);
		expect(formatEventTime(midnight - 60_000, midnight + 60_000, utc)).toBe(
			"Nov 14, 11:59:00 PM",
		);
		expect(formatEventTime(midnight + 60_000, midnight + 120_000, utc)).toBe(
			"12:01:00 AM",
		);
		const pacific = { locale: "en-US", timeZone: "America/Los_Angeles" };
		// 07:59 UTC on Nov 15 is 11:59 PM Nov 14 in Los Angeles; now is 08:01 UTC.
		expect(
			formatEventTime(
				Date.UTC(2026, 10, 15, 7, 59),
				Date.UTC(2026, 10, 15, 8, 1),
				pacific,
			),
		).toBe("Nov 14, 11:59:00 PM");
	});
});

describe("formatEventTimeFull", () => {
	it("gives the date, year and clock with seconds", () => {
		expect(formatEventTimeFull(event, utc)).toBe("Nov 15, 2026, 1:42:05 PM");
	});
});
