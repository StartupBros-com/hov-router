import { describe, expect, it } from "bun:test";
import { queryKeys } from "../lib/query-keys";
import { OverviewTab } from "./OverviewTab";
import {
	renderPage,
	seedState,
	type TestState,
} from "./page-state-test-helpers";

const analyticsKey = queryKeys.analytics(
	"24h",
	{ accounts: [], models: [], status: "all" },
	"normal",
);

function render(state: TestState) {
	return renderPage(<OverviewTab />, (client) => {
		client.setQueryData(analyticsKey, {
			timeSeries: [],
			totals: { requests: 0 },
			modelDistribution: [],
		});
		client.setQueryData(queryKeys.storage(), { integrity_status: "unchecked" });
		client.setQueryData(queryKeys.recentErrors(24), []);
		seedState(client, queryKeys.accounts(), state, []);
	});
}

describe("Overview Pool capacity when accounts fail", () => {
	it("says Pool capacity could not load when accounts never loaded", () => {
		const html = render("error");
		expect(html).toContain(
			"Pool capacity could not load. Network error. Please check your connection and try again.",
		);
		expect(html).toContain('role="alert"');
		expect(html).not.toContain("Failed to fetch");
		expect(html).not.toContain("5h Pool");
	});

	for (const state of ["loading", "cached", "empty"] as const) {
		it(`keeps the pool rows while accounts are ${state}`, () => {
			const html = render(state);
			expect(html).toContain("5h Pool");
			expect(html).toContain("7d Pool");
			expect(html).not.toContain("Pool capacity could not load");
		});
	}
});
