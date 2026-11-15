import { describe, expect, it } from "bun:test";
import { queryKeys } from "../lib/query-keys";
import { expectHeader, renderPage, seedState } from "./page-state-test-helpers";
import { SettingsTab } from "./SettingsTab";

describe("Settings routing summary states", () => {
	for (const state of ["loading", "error", "cached", "empty"] as const)
		it(state, () => {
			const html = renderPage(<SettingsTab />, (client) =>
				seedState(client, queryKeys.routingAttemptSummary(), state, {
					totalAttempts: state === "cached" ? 4 : 0,
					distinctRequests: 3,
					recoveredRequests: 1,
					terminalFailureRequests: 1,
					awaitingTerminalRequests: 1,
					byReasonScope: [],
				}),
			);
			expectHeader(html, "settings");
			expect(html).toContain("Routing attempts (last 24 hours)");
			if (state === "loading")
				expect(html).toContain("Loading routing-attempt summary");
			if (state === "error") {
				expect(html).toContain('role="alert"');
				expect(html).toContain(
					"Network error. Please check your connection and try again.",
				);
				expect(html).not.toContain("Failed to fetch");
				expect(html).toContain("Routing-attempt summary could not load.");
			}
			if (state === "cached" || state === "empty") {
				expect(html).not.toContain('role="alert"');
				expect(html).toContain(
					state === "cached"
						? "4 attempts across 3 logical requests"
						: "No upstream routing attempts in this window.",
				);
			}
		});
});
