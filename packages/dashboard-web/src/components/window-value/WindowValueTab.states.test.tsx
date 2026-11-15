import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { PAGE_META } from "../../lib/page-meta";
import { queryKeys } from "../../lib/query-keys";
import {
	expectHeader,
	renderPage,
	seedState,
} from "../page-state-test-helpers";
import { WindowValueTab } from "./WindowValueTab";

function render(state: "loading" | "error" | "cached" | "empty") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, retryOnMount: false } },
	});
	const queryKey = queryKeys.usageWindows("all");
	if (state === "empty" || state === "cached")
		client.setQueryData(queryKey, { accounts: [] });
	if (state === "error" || state === "cached")
		client
			.getQueryCache()
			.build(client, { queryKey })
			.setState({
				status: "error",
				error: new TypeError("Failed to fetch"),
				fetchStatus: "idle",
			});
	try {
		return renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<WindowValueTab />
			</QueryClientProvider>,
		);
	} finally {
		client.clear();
	}
}
describe("Window value states", () => {
	it("keeps a populated timeline on a failed refresh", () => {
		const html = renderPage(<WindowValueTab />, (client) =>
			seedState(client, queryKeys.usageWindows("all"), "cached", {
				accounts: [
					{
						accountId: "cached-account",
						accountName: "Cached window account",
						provider: "codex",
						windows: [
							{
								id: "closed-window",
								accountId: "cached-account",
								windowKey: "seven_day",
								startedAt: 1,
								resetsAt: 604800001,
								closedAt: 604800001,
								grantType: "natural",
								peakUtilization: 100,
								valueUsd: 42,
								inputTokens: 0,
								cacheReadInputTokens: 0,
								cacheCreationInputTokens: 0,
								outputTokens: 0,
								requestCount: 1,
								modelBreakdown: {},
								unpricedTokens: 0,
								projectionVersion: "v1",
							},
						],
						openWindow: null,
					},
				],
			}),
		);
		expectHeader(html, "windowValue");
		expect(html).toContain("Cached window account");
		expect(html).not.toContain('role="alert"');
		expect(html).not.toContain("No usage windows yet");
	});
	for (const state of ["loading", "error", "cached", "empty"] as const)
		it(state, () => {
			const html = render(state);
			expect(html.match(/<h1\b/g)).toHaveLength(1);
			expect(html).toContain(`>${PAGE_META.windowValue.title}</h1>`);
			if (state === "loading") expect(html).toContain('role="status"');
			if (state === "error") {
				expect(html).toContain('role="alert"');
				expect(html).toContain("Retry");
				expect(html).toContain(
					"Network error. Please check your connection and try again.",
				);
			}
			if (state === "cached" || state === "empty") {
				expect(html).not.toContain('role="alert"');
				expect(html).toContain("No usage windows yet");
				expect(html).toContain("border-dashed");
			}
		});
});
