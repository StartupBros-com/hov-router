import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { PAGE_META } from "../lib/page-meta";
import { queryKeys } from "../lib/query-keys";
import { AgentsTab } from "./AgentsTab";
import { expectHeader, renderPage, seedState } from "./page-state-test-helpers";

function render(state: string) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, retryOnMount: false } },
	});
	const queryKey = queryKeys.agents();
	if (state === "empty" || state === "cached")
		client.setQueryData(queryKey, {
			agents: [],
			globalAgents: [],
			workspaceAgents: [],
			pluginAgents: [],
			workspaces: [],
		});
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
				<AgentsTab />
			</QueryClientProvider>,
		);
	} finally {
		client.clear();
	}
}
describe("Agents states", () => {
	it("keeps populated agents and header counts after a failed refresh", () => {
		const agent = {
			id: "cached-agent",
			name: "Cached agent",
			description: "Agent from the query cache",
			color: "blue",
			source: "global",
			systemPrompt: "",
			tools: [],
		};
		const html = renderPage(<AgentsTab />, (client) =>
			seedState(client, queryKeys.agents(), "cached", {
				agents: [agent],
				globalAgents: [agent],
				workspaceAgents: [],
				pluginAgents: [],
				workspaces: [],
			}),
		);
		expectHeader(html, "agents");
		expect(html).toContain("Cached agent");
		expect(html).toContain("1 Global");
		expect(html).not.toContain('role="alert"');
		expect(html).not.toContain("No agents yet");
	});
	for (const state of ["loading", "error", "cached", "empty"])
		it(state, () => {
			const html = render(state);
			expect(html.match(/<h1\b/g)).toHaveLength(1);
			expect(html).toContain(`>${PAGE_META.agents.title}</h1>`);
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
				expect(html).toContain("No agents yet");
				expect(html).toContain("Global Agents");
			}
		});
});
