import { describe, expect, it } from "bun:test";
import type { UsageHistoryWindowSeries } from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelAnalytics, ModelDetailTiles } from "./analytics/ModelAnalytics";
import { TokenSpeedAnalytics } from "./analytics/TokenSpeedAnalytics";
import { UsageInsightCards } from "./UsageInsightCards";

// StatTile's own markup: the label paragraph and the tabular value.
const tileLabel = (label: string) =>
	`<p class="text-sm text-muted-foreground">${label}</p>`;
const TILE_VALUE = '<p class="text-2xl font-bold tabular-nums';
// The hand-built tiles these pages had before.
const OLD_VALUE = 'class="text-2xl font-bold"';

function expectTiles(html: string, labels: string[]) {
	for (const label of labels) expect(html).toContain(tileLabel(label));
	expect(html.split(TILE_VALUE).length - 1).toBeGreaterThanOrEqual(
		labels.length,
	);
	expect(html).not.toContain(OLD_VALUE);
}

const performance = [
	{
		model: "fast-model",
		avgResponseTime: 820,
		p95ResponseTime: 1900,
		errorRate: 2.5,
		avgTokensPerSecond: 95.2,
		minTokensPerSecond: 40,
		maxTokensPerSecond: 140,
	},
	{
		model: "steady-model",
		avgResponseTime: 1200,
		p95ResponseTime: 2400,
		errorRate: 0.5,
		avgTokensPerSecond: 60,
		minTokensPerSecond: 30,
		maxTokensPerSecond: 80,
	},
];

const comparison = performance.map((perf) => ({
	model: perf.model,
	avgTokensPerSecond: perf.avgTokensPerSecond,
	costPer1kTokens: perf.model === "fast-model" ? 0.02 : 0.01,
	avgResponseTime: perf.avgResponseTime,
	errorRate: perf.errorRate,
	totalRequests: 10,
}));

describe("Analytics tiles on StatTile", () => {
	it("draws the three token-speed tiles as StatTiles with their hints", () => {
		const html = renderToStaticMarkup(
			<TokenSpeedAnalytics
				timeSeriesData={[{ time: "10:00", avgTokensPerSecond: 50 }]}
				modelPerformance={performance}
				timeRange="24h"
			/>,
		);
		expectTiles(html, ["Average Output Speed", "Peak Speed", "Fastest Model"]);
		expect(html).toContain("Across all models and requests");
		expect(html).toContain("Maximum observed in the selected time range");
		expect(html).toContain("fast-model");
		expect(html).toContain("Peak: ");
	});

	it("keeps N/A and No data on the fastest-model tile without data", () => {
		const html = renderToStaticMarkup(
			<TokenSpeedAnalytics
				timeSeriesData={[]}
				modelPerformance={[]}
				timeRange="24h"
			/>,
		);
		expect(html).toContain("N/A");
		expect(html).toContain("No data");
	});

	it("draws the detailed model tiles as StatTiles with a neutral error rate", () => {
		const html = renderToStaticMarkup(
			<ModelDetailTiles
				modelPerformance={performance.map((perf) => ({ ...perf }))}
				comparisonData={comparison}
			/>,
		);
		expectTiles(html, [
			"Fastest Model",
			"Most Reliable Model",
			"Most Cost-Effective",
		]);
		expect(html).toContain("95.2 tok/s");
		expect(html).toContain("820ms");
		expect(html).toContain("0.50%");
		expect(html).toContain("2400ms");
		expect(html).toContain("tok/s/$");
		expect(html).toContain("$0.010");
		for (const label of ["Speed", "Response", "Error Rate", "p95 Response"])
			expect(html).toContain(`>${label}</span>`);
		expect(html).not.toContain("Error Rate:");
		expect(html).not.toContain("green");
	});

	it("says No data on each detailed tile without models", () => {
		const html = renderToStaticMarkup(
			<ModelDetailTiles modelPerformance={[]} comparisonData={[]} />,
		);
		expect(html.split("No data").length - 1).toBe(3);
	});

	it("colours the comparison heading icon from the chart token", () => {
		const html = renderToStaticMarkup(
			<ModelAnalytics modelPerformance={[]} costByModel={[]} timeRange="24h" />,
		);
		expect(html).toContain("text-chart-purple");
		expect(html).not.toContain("text-purple-500");
	});
});

describe("Usage insight cards on StatTile", () => {
	it("draws each usage insight card as a StatTile", () => {
		const windows: UsageHistoryWindowSeries[] = [
			{
				window: "five_hour",
				points: [{ t: 0, utilization: 40, resetsAt: null }],
				prediction: {
					slopePerHour: 2,
					etaExhaustMs: null,
					predictedAtReset: null,
					resetsAtMs: null,
					willExhaustBeforeReset: false,
					state: "rising",
					lowConfidence: false,
				},
			},
		];
		const html = renderToStaticMarkup(
			<UsageInsightCards windows={windows} now={0} />,
		);
		expect(html).toContain(TILE_VALUE);
		expect(html).toContain("+2.0%/hr");
		expect(html).toContain("Exhaustion vs reset");
	});
});
