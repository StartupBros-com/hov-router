import { describe, expect, it } from "bun:test";
import { activeRequestFilters } from "../request-filters";

// Local noon on Nov 15, so Nov 15 times read as today in any zone.
const NOW = new Date("2026-11-15T12:00").getTime();

const NONE = {
	account: "all",
	agent: "all",
	apiKey: "all",
	statusCodes: new Set<string>(),
	dateFrom: "",
	dateTo: "",
};

describe("activeRequestFilters", () => {
	it("is empty when nothing is filtered", () => {
		expect(activeRequestFilters(NONE)).toEqual([]);
	});

	it("labels every active filter", () => {
		expect(
			activeRequestFilters(
				{
					account: "max-primary",
					agent: "session-abc",
					agentLabel: "Session abc",
					apiKey: "no-api-key",
					statusCodes: new Set(["500", "429"]),
					dateFrom: "2026-11-14T20:00",
					dateTo: "2026-11-15T09:30",
				},
				{ locale: "en-US", now: NOW },
			),
		).toEqual([
			{ key: "account", label: "Account", value: "max-primary" },
			{ key: "agent", label: "Agent", value: "Session abc" },
			{ key: "apiKey", label: "API key", value: "none" },
			{ key: "status", label: "Status", value: "429, 500" },
			{ key: "date", label: "Date", value: "Nov 14, 8:00 PM – 9:30 AM" },
		]);
	});

	it("shows the agent name and a named API key as they are", () => {
		const filters = activeRequestFilters({
			...NONE,
			agent: "code-reviewer",
			apiKey: "ci-key",
		});
		expect(filters.map((f) => f.value)).toEqual(["code-reviewer", "ci-key"]);
	});

	it("names the one bound of an open-ended date filter", () => {
		const from = activeRequestFilters(
			{ ...NONE, dateFrom: "2026-11-14T23:30" },
			{ locale: "en-US", now: NOW },
		);
		expect(from).toEqual([
			{ key: "date", label: "Date", value: "from Nov 14, 11:30 PM" },
		]);
		const until = activeRequestFilters(
			{ ...NONE, dateTo: "2026-11-15T00:10" },
			{ locale: "en-US", now: NOW },
		);
		expect(until[0]?.value).toBe("until 12:10 AM");
	});
});
