import { describe, expect, it } from "bun:test";
import { API_LIMITS } from "../constants";
import { queryKeys } from "../lib/query-keys";
import { expectHeader, renderPage, seedState } from "./page-state-test-helpers";
import { RequestsTab } from "./RequestsTab";

describe("Requests states", () => {
	for (const state of ["loading", "error", "cached", "empty"] as const)
		it(state, () => {
			const html = renderPage(<RequestsTab />, (client) =>
				seedState(
					client,
					queryKeys.requests(API_LIMITS.requestsDetail),
					state,
					{
						requests:
							state === "cached"
								? [
										{
											id: "cached-request",
											request: { headers: {}, body: null },
											response: { status: 200, headers: {}, body: null },
											meta: {
												timestamp: 1,
												method: "POST",
												path: "/v1/messages",
												accountName: "Cached account",
												success: true,
											},
										},
									]
								: [],
						detailsMap: [],
					},
				),
			);
			expectHeader(html, "requests");
			expect(html).toContain("Request History");
			if (state === "loading") expect(html).toContain('role="status"');
			if (state === "loading") expect(html).toContain("Loading requests");
			if (state === "error") {
				expect(html).toContain('role="alert"');
				expect(html).toContain(
					"Network error. Please check your connection and try again.",
				);
				expect(html).not.toContain("Failed to fetch");
				expect(html).toContain("Retry");
				expect(html).toContain("Requests could not load");
			}
			if (state === "cached" || state === "empty") {
				expect(html).not.toContain('role="alert"');
				expect(html).toContain(
					state === "cached" ? "Cached account" : "No requests found",
				);
			}
		});
});
