import { describe, expect, it } from "bun:test";
import type { Agent } from "@better-ccflare/types";
import { renderPage } from "../page-state-test-helpers";
import { AgentCard } from "./AgentCard";

const agent = {
	id: "reviewer",
	name: "Reviewer",
	description: "Reviews code",
	color: "blue",
	source: "global",
	systemPrompt: "",
	tools: [],
} as unknown as Agent;

function tagWith(html: string, needle: string) {
	const index = html.indexOf(needle);
	expect(index).toBeGreaterThan(-1);
	const start = html.lastIndexOf("<", index);
	return html.slice(start, html.indexOf(">", index) + 1);
}

describe("AgentCard visible state", () => {
	const html = renderPage(<AgentCard agent={agent} />);

	it("shows the edit button without hover and keeps it from shrinking", () => {
		const tag = tagWith(html, 'aria-label="Edit Reviewer"');
		expect(tag).not.toContain("opacity-0");
		expect(tag).not.toContain("group-hover:opacity-100");
		expect(tag).toMatch(/\sshrink-0[\s"]/);
		expect(tag).toContain("disabled:cursor-not-allowed");
		expect(tag).toContain("h-11 w-11");
	});

	it("makes the model preference trigger 44 px tall", () => {
		const tag = tagWith(html, 'aria-label="Model Preference for Reviewer"');
		expect(tag).toContain("h-11");
	});
});
