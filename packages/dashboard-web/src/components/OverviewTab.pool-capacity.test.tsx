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

function render(state: TestState, accounts: unknown[] = []) {
	return renderPage(<OverviewTab />, (client) => {
		client.setQueryData(analyticsKey, {
			timeSeries: [],
			totals: { requests: 0 },
			modelDistribution: [],
		});
		client.setQueryData(queryKeys.storage(), { integrity_status: "unchecked" });
		client.setQueryData(queryKeys.recentErrors(24), []);
		seedState(client, queryKeys.accounts(), state, accounts);
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
		it(`keeps the shared pool state while accounts are ${state}`, () => {
			const html = render(state);
			expect(html).toContain("Pool capacity");
			expect(html).toContain(
				state === "loading" ? "Loading pool capacity" : "No pool capacity yet.",
			);
			expect(html).not.toContain("Pool capacity could not load");
		});
	}
	it("keeps cached provider pools and their shipped averages after a refresh error", () => {
		const reset = new Date(Date.now() + 3600000).toISOString();
		const html = render("cached", [
			{
				id: "a",
				name: "a",
				provider: "anthropic",
				isPrimary: true,
				usageData: {
					five_hour: { utilization: 40, resets_at: reset },
					seven_day: { utilization: 40, resets_at: reset },
				},
			},
			{
				id: "b",
				name: "b",
				provider: "codex",
				usageData: {
					five_hour: { utilization: 80, resets_at: reset },
					seven_day: { utilization: 80, resets_at: reset },
				},
			},
		]);
		expect(html).toContain('aria-label="Claude Max weekly"');
		expect(html).toContain('aria-label="Codex Pro weekly"');
		expect(html).toContain("40% used across the pool");
		expect(html).toContain("80% used across the pool");
		expect(html).toContain(">next</span>");
		expect(html).not.toContain("Pool capacity could not load");
	});
});
