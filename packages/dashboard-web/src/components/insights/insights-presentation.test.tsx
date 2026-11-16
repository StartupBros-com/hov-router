import { describe, expect, it } from "bun:test";
import type {
	AnomalyInsightsResponse,
	CacheInsightsResponse,
} from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import { queryKeys } from "../../lib/query-keys";
import { renderPage } from "../page-state-test-helpers";
import { AlertsView } from "./AlertsView";
import { AnomaliesView } from "./AnomaliesView";
import { CacheEfficiencyView } from "./CacheEfficiencyView";

const anomalies = {
	meta: {
		scannedRequests: 0,
		baselineWindowMinutes: 60,
		zScoreThreshold: 3,
		baselineWindowRequests: 0,
		misroutingMaxTotalTokens: 100,
		misroutingMinOutputRateUsd: 1,
		misroutingMinRequests: 2,
		loopWindowMinutes: 5,
		loopMinRequests: 2,
	},
	tokenOutliers: [],
	outputBlowups: [],
	runawayLoops: [],
	misrouting: [],
	tokenOutliersSummary: { totalCount: 0 },
	outputBlowupsSummary: { totalCount: 0 },
	runawayLoopsSummary: { totalCount: 0 },
	misroutingSummary: { totalCount: 0 },
} as unknown as AnomalyInsightsResponse;

const flaggedRow = {
	key: "Unknown",
	requests: 140,
	uncachedInputTokens: 610_000,
	cacheReadInputTokens: 90_000,
	cacheCreationInputTokens: 20_000,
	cacheHitRate: 12.5,
	actualCacheCostUsd: 3.1,
	counterfactualCostUsd: 3.6,
	savingsUsd: 0.5,
	pricingKnown: true,
	flagged: true,
};

function cacheData(): CacheInsightsResponse {
	return {
		totals: {
			savingsUsd: 0.5,
			cacheHitRate: 12.5,
			requests: 140,
			actualCacheCostUsd: 3.1,
			counterfactualCostUsd: 3.6,
			uncachedInputTokens: 610_000,
			cacheReadInputTokens: 90_000,
			cacheCreationInputTokens: 20_000,
			unknownPricingModels: [],
		},
		byModel: [flaggedRow],
		byAccount: [flaggedRow],
		byProject: [flaggedRow],
		timeSeries: [],
	} as unknown as CacheInsightsResponse;
}

function alertsHtml() {
	return renderPage(<AlertsView />, (client) =>
		client.setQueryData(queryKeys.insightsAlerts(), {
			alerts: [
				{
					id: "synthetic-alert",
					title: "Synthetic alert",
					message: "Made up for a presentation check.",
					timestamp: 1,
					acknowledged: false,
				},
			],
			unacknowledgedCount: 1,
		}),
	);
}

describe("Insights warning icons", () => {
	it("colours the alert icon with the warning token", () => {
		const html = alertsHtml();
		expect(html).toContain("text-(--warning)");
		expect(html).not.toMatch(/\bamber-\d/);
	});

	it("colours the runaway-loops icon with the warning token", () => {
		const html = renderToStaticMarkup(
			<AnomaliesView data={anomalies} timeRange="24h" />,
		);
		expect(html).toContain("Runaway loops");
		expect(html).toContain("text-(--warning)");
		expect(html).not.toMatch(/\bamber-\d/);
	});
});

describe("Insights narrow layouts", () => {
	it("lets the alerts header wrap Acknowledge all under the count", () => {
		const html = alertsHtml();
		const header = html.slice(0, html.indexOf("Unacknowledged: "));
		expect(header.slice(header.lastIndexOf("<div"))).toContain(
			'class="flex flex-wrap items-center justify-between gap-2"',
		);
	});

	it("wraps a flagged row's name at word boundaries and moves the badge below it", () => {
		const html = renderToStaticMarkup(
			<CacheEfficiencyView data={cacheData()} timeRange="24h" />,
		);
		expect(html).toContain("Low cache hit");
		// break-all set "Unknown" on 7 rows beside the badge at 320 px.
		expect(html).not.toContain("break-all");
		expect(html).toContain(
			'class="flex flex-wrap items-center gap-x-2 gap-y-1"><span class="min-w-0 break-words text-muted-foreground">Unknown<',
		);
	});
});
