import { describe, expect, it } from "bun:test";
import { activeRequestFilters } from "../request-filters";

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
				{ locale: "en-US" },
			),
		).toEqual([
			{ key: "account", label: "Account", value: "max-primary" },
			{ key: "agent", label: "Agent", value: "Session abc" },
			{ key: "apiKey", label: "API key", value: "none" },
			{ key: "status", label: "Status", value: "429, 500" },
			{ key: "date", label: "Date", value: "Nov 14 – Nov 15" },
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

	it("shows the whole days an open-ended date filter applies", () => {
		const from = activeRequestFilters(
			{ ...NONE, dateFrom: "2026-11-14T23:30" },
			{ locale: "en-US" },
		);
		expect(from).toEqual([
			{ key: "date", label: "Date", value: "from Nov 14" },
		]);
		const until = activeRequestFilters(
			{ ...NONE, dateTo: "2026-11-15T00:10" },
			{ locale: "en-US" },
		);
		expect(until[0]?.value).toBe("until Nov 15");
	});
});
