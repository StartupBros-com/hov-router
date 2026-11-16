import { describe, expect, it } from "bun:test";
import { queryKeys } from "../lib/query-keys";
import { OverviewTab } from "./OverviewTab";
import { expectHeader, renderPage, seedState } from "./page-state-test-helpers";

const analyticsKey = queryKeys.analytics(
	"24h",
	{ accounts: [], models: [], status: "all" },
	"normal",
);
const analytics = {
	timeSeries: [],
	totals: { requests: 0 },
	modelDistribution: [],
};
describe("Overview states", () => {
	for (const section of ["analytics", "storage", "recentErrors"] as const)
		for (const state of ["loading", "error", "cached", "empty"] as const)
			it(`${section} ${state}`, () => {
				const key =
					section === "analytics"
						? analyticsKey
						: section === "storage"
							? queryKeys.storage()
							: queryKeys.recentErrors(24);
				const html = renderPage(<OverviewTab />, (client) => {
					client.setQueryData(queryKeys.accounts(), []);
					client.setQueryData(analyticsKey, analytics);
					client.setQueryData(queryKeys.storage(), {
						integrity_status: "unchecked",
					});
					client.setQueryData(queryKeys.recentErrors(24), []);
					if (state === "loading" || state === "error")
						client.removeQueries({ queryKey: key, exact: true });
					seedState(
						client,
						key,
						state,
						section === "analytics"
							? analytics
							: section === "storage"
								? { integrity_status: "unchecked" }
								: [],
					);
				});
				expectHeader(html, "overview");
				expect(html).toContain("No pool capacity yet.");
				expect(html).toContain("Storage Integrity");
				if (section === "analytics" && state === "loading") {
					expect(html).toContain('aria-label="Time range"');
					expect(html).not.toContain("Total Requests");
				}
				if (
					section === "analytics" &&
					(state === "cached" || state === "empty")
				)
					expect(html).toContain("Total Requests");
				if (section === "storage" && (state === "cached" || state === "empty"))
					expect(html).toContain("Integrity not yet verified");
				if (section === "recentErrors" && state === "empty") {
					// An empty error list renders nothing, as it did before the shared states.
					expect(html).not.toContain("Recent Errors");
					expect(html).not.toContain("No recent errors yet");
				}
				if (section === "analytics") {
					if (state === "loading" || state === "error") {
						for (const copy of [
							"Pool capacity",
							"System Status",
							"Storage Integrity",
							'aria-label="Time range"',
						])
							expect(html).toContain(copy);
						expect(html).not.toContain("Total Requests");
					}
					if (state === "loading") expect(html).toContain("Loading analytics");
					if (state === "error")
						expect(html).toContain("Analytics could not load");
					if (state === "cached")
						expect(html).not.toContain("Analytics could not load");
				}
				if (section === "storage") {
					if (state === "loading")
						expect(html).toContain("Loading storage status");
					if (state === "error") {
						expect(html).toContain("Storage status could not load");
						expect(html).toContain("Total Requests");
					}
					if (state === "cached" || state === "empty")
						expect(html).not.toContain("Storage status could not load");
				}
				if (section === "recentErrors") {
					if (state === "error")
						expect(html).toContain("Recent errors could not load");
					else {
						expect(html).not.toContain("Recent Errors");
						expect(html).not.toContain("Loading recent errors");
						expect(html).not.toContain("Recent errors could not load");
						expect(html).not.toContain("No recent errors yet");
					}
				}
				if (state === "error") {
					expect(html).toContain('role="alert"');
					expect(html).toContain(
						"Network error. Please check your connection and try again.",
					);
					expect(html).not.toContain("Failed to fetch");
					expect(html).toContain("Retry");
				}
				if (state === "cached" || state === "empty")
					expect(html).not.toContain('role="alert"');
			});
});
