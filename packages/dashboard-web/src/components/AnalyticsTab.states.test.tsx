import { describe, expect, it } from "bun:test";
import { MemoryRouter } from "react-router-dom";
import { queryKeys } from "../lib/query-keys";
import { AnalyticsTab } from "./AnalyticsTab";
import { ChartContainer } from "./charts/ChartContainer";
import { ModelTokenSpeedChart } from "./charts/ModelTokenSpeedChart";
import { expectHeader, renderPage, seedState } from "./page-state-test-helpers";

describe("Analytics states", () => {
	it("uses a chart-height skeleton in ChartContainer", () => {
		const html = renderPage(
			<ChartContainer loading height={241}>
				<div>Chart content</div>
			</ChartContainer>,
		);
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-label="Loading chart"');
		expect(html).toContain("height:241px");
		expect(html).toContain("animate-pulse");
		expect(html).not.toContain("animate-spin");
		expect(html).not.toContain("Chart content");
	});
	it("uses a chart-height skeleton for model token speeds", () => {
		const html = renderPage(
			<ModelTokenSpeedChart loading height={287} data={[]} />,
		);
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-label="Loading model token speeds"');
		expect(html).toContain("height:287px");
		expect(html).toContain("animate-pulse");
		expect(html).not.toContain("animate-spin");
	});
	for (const state of ["loading", "error", "cached", "empty"] as const)
		it(state, () => {
			const html = renderPage(
				<MemoryRouter>
					<AnalyticsTab />
				</MemoryRouter>,
				(client) =>
					seedState(
						client,
						queryKeys.analytics(
							"1h",
							{ accounts: [], models: [], apiKeys: [], status: "all" },
							"normal",
							false,
						),
						state,
						{
							timeSeries: [],
							totals: { totalTokens: 0 },
							modelDistribution: [],
							accountPerformance: [],
							apiKeyPerformance: [],
						},
					),
			);
			expectHeader(html, "analytics");
			expect(html).toContain("Filters");
			if (state === "loading") expect(html).toContain('role="status"');
			if (state === "error") {
				expect(html).toContain('role="alert"');
				expect(html).toContain("Retry");
			}
			if (state === "cached" || state === "empty")
				expect(html).not.toContain('role="alert"');
			if (state === "cached")
				expect(html).not.toContain('aria-label="Loading analytics"');
		});
});
