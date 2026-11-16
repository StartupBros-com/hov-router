import { describe, expect, it, mock } from "bun:test";
import type { Agent } from "@better-ccflare/types";
import type { ReactNode } from "react";

const state = { isError: false };
const real = await import("../../hooks/queries");
mock.module("../../hooks/queries", () => ({
	...real,
	useUpdateAgent: () => ({
		mutateAsync: async () => {},
		isPending: false,
		isError: state.isError,
	}),
}));
// The real dialog portals its content, which a static render never draws.
mock.module("../ui/dialog", () => {
	const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
	return {
		Dialog: Pass,
		DialogContent: Pass,
		DialogDescription: Pass,
		DialogFooter: Pass,
		DialogHeader: Pass,
		DialogTitle: Pass,
	};
});

const { renderPage } = await import("../page-state-test-helpers");
const { AgentEditDialog } = await import("./AgentEditDialog");

const agent = {
	id: "reviewer",
	name: "Reviewer",
	description: "Reviews code",
	color: "blue",
	source: "global",
	systemPrompt: "",
	tools: [],
} as unknown as Agent;

function render() {
	return renderPage(
		<AgentEditDialog agent={agent} open onOpenChange={() => {}} />,
	);
}

function tagWith(html: string, needle: string) {
	const index = html.indexOf(needle);
	expect(index).toBeGreaterThan(-1);
	const start = html.lastIndexOf("<", index);
	return html.slice(start, html.indexOf(">", index) + 1);
}

describe("AgentEditDialog visible state", () => {
	it("shows no alert while the save has not failed", () => {
		state.isError = false;
		const html = render();
		expect(html).not.toContain('role="alert"');
		expect(html).not.toContain("Could not save this agent.");
	});

	it("shows an alert above the footer once the save has failed", () => {
		state.isError = true;
		const html = render();
		const alert = html.indexOf('role="alert"');
		expect(alert).toBeGreaterThan(-1);
		expect(html).toContain(
			"Could not save this agent. Your changes are still here; try again.",
		);
		expect(alert).toBeLessThan(html.indexOf("Save Changes"));
		expect(alert).toBeGreaterThan(html.indexOf("Default Model (agent file)"));
	});

	it("makes the default model trigger 44 px tall", () => {
		state.isError = false;
		const tag = tagWith(render(), 'aria-label="Default Model (agent file)"');
		expect(tag).toContain("h-11");
	});
});
