import { describe, expect, it } from "bun:test";
import { queryKeys } from "../lib/query-keys";
import { InsightsTab } from "./InsightsTab";
import { expectHeader, renderPage, seedState } from "./page-state-test-helpers";

const fixtures = {
	cache: {
		totals: { unknownPricingModels: [] },
		byModel: [],
		byAccount: [],
		byProject: [],
		timeSeries: [],
	},
	context: {
		meta: { payloadCoverage: { requestsInRange: 2, requestsWithPayload: 0 } },
		composition: {
			totals: { estimatedTokens: { total: 0 } },
			tokenTotals: {},
			perRequest: [],
		},
		growthCurve: { sessions: [] },
	},
	anomalies: {
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
	},
	alerts: { alerts: [], unacknowledgedCount: 0 },
};
const keys = {
	cache: queryKeys.insightsCache("24h"),
	context: queryKeys.insightsContext("24h"),
	anomalies: queryKeys.insightsAnomalies("24h"),
	alerts: queryKeys.insightsAlerts(),
};
describe("Insights independent sections", () => {
	it("keeps cached alerts after a failed refresh", () => {
		const html = renderPage(<InsightsTab />, (client) => {
			for (const section of ["cache", "context", "anomalies"] as const)
				client.setQueryData(keys[section], fixtures[section]);
			seedState(client, keys.alerts, "cached", {
				alerts: [
					{
						id: "cached-alert",
						title: "Cached alert",
						message: "Previously fetched alert",
						timestamp: 1,
						acknowledged: false,
					},
				],
				unacknowledgedCount: 1,
			});
		});
		expectHeader(html, "insights");
		expect(html).toContain("Cached alert");
		expect(html).not.toContain('role="alert"');
	});
	for (const section of ["cache", "context", "anomalies", "alerts"] as const)
		for (const state of ["loading", "error", "cached", "empty"] as const)
			it(`${section} ${state}`, () => {
				const html = renderPage(<InsightsTab />, (client) => {
					for (const other of [
						"cache",
						"context",
						"anomalies",
						"alerts",
					] as const)
						if (other !== section)
							client.setQueryData(keys[other], fixtures[other]);
					seedState(client, keys[section], state, fixtures[section]);
				});
				expectHeader(html, "insights");
				expect(html).toContain('aria-label="Time range"');
				const content = {
					cache: "Cache Savings",
					context: "Requests Analyzed",
					anomalies: "Token outliers (total tokens)",
					alerts: "Unacknowledged:",
				};
				for (const other of [
					"cache",
					"context",
					"anomalies",
					"alerts",
				] as const)
					if (other !== section) expect(html).toContain(content[other]);
				if (state === "loading") {
					expect(html).toContain(
						`aria-label="Loading ${section === "anomalies" ? "anomaly insights" : section === "alerts" ? "alerts" : `${section} insights`}"`,
					);
					expect(html).not.toContain(content[section]);
				}
				if (state === "loading") expect(html).toContain('role="status"');
				if (state === "error") {
					expect(html).toContain('role="alert"');
					expect(html).toContain("Retry");
				}
				if (state === "cached" || state === "empty")
					expect(html).not.toContain('role="alert"');
				if (state === "cached") expect(html).toContain(content[section]);
				if (section === "context" && state === "empty")
					expect(html).toContain("No stored payloads to analyze");
				if (section === "alerts" && state === "empty")
					expect(html).toContain("No alerts yet");
			});
});
