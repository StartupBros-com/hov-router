import { describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { queryKeys } from "../lib/query-keys";

// The real dialog portals its content, which a static render never draws.
mock.module("./ui/dialog", () => {
	const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
	return {
		Dialog: Pass,
		DialogContent: Pass,
		DialogDescription: Pass,
		DialogFooter: Pass,
		DialogHeader: Pass,
		DialogTitle: Pass,
		DialogTrigger: Pass,
	};
});

const { AgentsTab } = await import("./AgentsTab");
const { renderPage, seedState } = await import("./page-state-test-helpers");

const agent = {
	id: "cached-agent",
	name: "Cached agent",
	description: "Agent from the query cache",
	color: "blue",
	source: "global",
	systemPrompt: "",
	tools: [],
};

function tagWith(html: string, needle: string) {
	const index = html.indexOf(needle);
	expect(index).toBeGreaterThan(-1);
	const start = html.lastIndexOf("<", index);
	return html.slice(start, html.indexOf(">", index) + 1);
}

describe("AgentsTab visible state", () => {
	it("lets the workspace autodiscover variable wrap on a narrow screen", () => {
		const html = renderPage(<AgentsTab />, (client) =>
			seedState(client, queryKeys.agents(), "empty", {
				agents: [],
				globalAgents: [],
				workspaceAgents: [],
				pluginAgents: [],
				workspaces: [],
			}),
		);
		const at = html.indexOf("HOV_ROUTER_AGENT_WORKSPACE_AUTODISCOVER=true");
		expect(at).toBeGreaterThan(-1);
		const start = html.lastIndexOf("<p ", at);
		expect(html.slice(start, html.indexOf(">", start))).toContain(
			"break-words",
		);
	});

	describe("with agents listed", () => {
		const html = renderPage(<AgentsTab />, (client) =>
			seedState(client, queryKeys.agents(), "empty", {
				agents: [agent],
				globalAgents: [agent],
				workspaceAgents: [],
				pluginAgents: [],
				workspaces: [],
			}),
		);

		it("keeps the refresh button from shrinking", () => {
			expect(tagWith(html, 'aria-label="Refresh model list"')).toMatch(
				/\sshrink-0[\s"]/,
			);
		});

		it("makes the bulk model trigger 44 px tall", () => {
			expect(tagWith(html, 'aria-label="Model for all agents"')).toContain(
				"h-11",
			);
		});
	});
});
