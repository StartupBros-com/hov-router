import { describe, expect, it } from "bun:test";
import { useFleetUsageHistory } from "../../hooks/queries";
import { queryKeys } from "../../lib/query-keys";
import {
	expectHeader,
	renderPage,
	seedState,
} from "../page-state-test-helpers";
import { FleetHistorySection, UsageHistoryTab } from "./UsageHistoryTab";

const account = { id: "account-1", name: "History account", paused: false };
describe("Usage History states", () => {
	for (const state of ["loading", "error", "cached", "empty"] as const)
		it(`fleet history ${state}`, () => {
			function FleetSection() {
				const query = useFleetUsageHistory("24h");
				return <FleetHistorySection query={query} />;
			}
			const html = renderPage(<FleetSection />, (client) =>
				seedState(client, queryKeys.fleetUsageHistory("24h"), state, {
					accounts: [],
					truncated: state === "cached",
					omittedAccountCount: 2,
					returnedPointCount: 100,
				}),
			);
			if (state === "loading") expect(html).toContain('role="status"');
			if (state === "loading")
				expect(html).toContain("Loading fleet usage history");
			if (state === "error") {
				expect(html).toContain("Fleet usage history could not load");
				expect(html).toContain('role="alert"');
				expect(html).toContain(
					"Network error. Please check your connection and try again.",
				);
				expect(html).not.toContain("Failed to fetch");
				expect(html).toContain("Retry");
			}
			if (state === "cached") {
				expect(html).not.toContain('role="alert"');
				expect(html).toContain("2 accounts not shown");
			}
			if (state === "empty")
				expect(html).toContain(
					"No accounts have usage snapshots in this range yet.",
				);
		});
	for (const section of ["accounts", "history"] as const)
		for (const state of ["loading", "error", "cached", "empty"] as const)
			it(`${section} ${state}`, () => {
				const html = renderPage(<UsageHistoryTab />, (client) => {
					if (section === "history")
						client.setQueryData(queryKeys.accounts(), [account]);
					seedState(
						client,
						section === "accounts"
							? queryKeys.accounts()
							: queryKeys.usageHistory("account-1", "24h"),
						state,
						section === "accounts"
							? state === "empty"
								? []
								: [account]
							: { windows: [] },
					);
				});
				expectHeader(html, "usageHistory");
				expect(html).toContain('aria-label="Time range"');
				if (state === "loading") expect(html).toContain('role="status"');
				if (state === "loading")
					expect(html).toContain(
						section === "accounts"
							? "Loading accounts"
							: "Loading usage history",
					);
				if (state === "error")
					expect(html).toContain(
						section === "accounts"
							? "Accounts could not load"
							: "Usage history could not load",
					);
				if (section === "accounts" && state !== "cached") {
					expect(html).not.toContain(
						"Select an account to view its usage history.",
					);
					expect(html).not.toContain("Loading usage history");
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
				if (state === "empty")
					expect(html).toContain(
						section === "accounts"
							? "No accounts yet"
							: "Collecting usage data",
					);
			});
});
