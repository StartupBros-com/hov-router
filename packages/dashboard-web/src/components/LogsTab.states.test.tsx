import { describe, expect, it } from "bun:test";
import { queryKeys } from "../lib/query-keys";
import { LogsTab } from "./LogsTab";
import { expectHeader, renderPage, seedState } from "./page-state-test-helpers";

describe("Logs states", () => {
	for (const state of ["loading", "error", "cached", "empty"] as const)
		it(state, () => {
			const html = renderPage(<LogsTab />, (client) =>
				seedState(
					client,
					queryKeys.logHistory(),
					state,
					state === "empty"
						? []
						: [{ ts: 1, level: "info", msg: "Cached log entry" }],
				),
			);
			expectHeader(html, "logs");
			expect(html).toContain("Live Logs");
			expect(html).toContain("Auto-scroll to bottom");
			if (state === "loading") expect(html).toContain('role="status"');
			if (state === "loading") expect(html).toContain("Loading logs");
			if (state === "error") {
				expect(html).toContain('role="alert"');
				expect(html).toContain(
					"Network error. Please check your connection and try again.",
				);
				expect(html).not.toContain("Failed to fetch");
				expect(html).toContain("Retry");
				expect(html).toContain("Logs could not load");
			}
			if (state === "cached") {
				expect(html).not.toContain('role="alert"');
				expect(html).toContain("Cached log entry");
			}
			if (state === "empty") expect(html).toContain("No logs yet");
		});
});
