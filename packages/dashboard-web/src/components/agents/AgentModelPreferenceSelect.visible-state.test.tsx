import { describe, expect, it, mock } from "bun:test";
import type { Agent } from "@better-ccflare/types";

const state = { isError: false };
const real = await import("../../hooks/queries");
mock.module("../../hooks/queries", () => ({
	...real,
	useUpdateAgentPreference: () => ({
		mutate: () => {},
		isPending: false,
		isError: state.isError,
	}),
}));

const { renderPage } = await import("../page-state-test-helpers");
const { AgentModelPreferenceSelect } = await import(
	"./AgentModelPreferenceSelect"
);

const agent = {
	id: "reviewer",
	name: "Reviewer",
	description: "",
	color: "blue",
	source: "global",
	systemPrompt: "",
	tools: [],
} as unknown as Agent;

describe("AgentModelPreferenceSelect visible state", () => {
	it("shows no alert while the save has not failed", () => {
		state.isError = false;
		const html = renderPage(<AgentModelPreferenceSelect agent={agent} />);
		expect(html).not.toContain('role="alert"');
		expect(html).not.toContain("Could not save the model preference.");
	});

	it("shows an alert once the save has failed", () => {
		state.isError = true;
		const html = renderPage(<AgentModelPreferenceSelect agent={agent} />);
		expect(html).toMatch(
			/role="alert"[^>]*>Could not save the model preference\.</,
		);
	});
});
