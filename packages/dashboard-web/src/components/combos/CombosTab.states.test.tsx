import { describe, expect, it } from "bun:test";
import { queryKeys } from "../../lib/query-keys";
import {
	expectHeader,
	renderPage,
	seedState,
} from "../page-state-test-helpers";
import { CombosTab } from "./CombosTab";

describe("Combos states", () => {
	it("keeps saved combos after a failed refresh", () => {
		const html = renderPage(<CombosTab />, (client) => {
			client.setQueryData(queryKeys.families(), { families: [] });
			seedState(client, queryKeys.combos(), "cached", {
				combos: [
					{
						id: "cached-combo",
						name: "Cached fallback chain",
						description: null,
						enabled: true,
						created_at: 1,
						updated_at: 1,
						slot_count: 2,
					},
				],
			});
		});
		expectHeader(html, "combos");
		expect(html).toContain("Cached fallback chain");
		expect(html).not.toContain('role="alert"');
		expect(html).not.toContain("No combos yet");
		expect(html).not.toContain("Combos could not load");
	});
	it("shows a family error even while the combos dependency is pending", () => {
		const html = renderPage(<CombosTab />, (client) =>
			seedState(client, queryKeys.families(), "error", undefined),
		);
		expectHeader(html, "combos");
		expect(html).toContain("Family policies could not load");
		expect(html).toContain("Existing routing was not changed.");
		expect(html).toContain("Loading combos");
		expect(html).not.toContain("Combos could not load");
		expect(html).toContain(
			"Network error. Please check your connection and try again.",
		);
		expect(html).not.toContain("Failed to fetch");
		expect(html).toContain("Retry");
	});
	for (const section of ["combos", "families"] as const)
		for (const state of ["loading", "error", "cached", "empty"] as const)
			it(`${section} ${state}`, () => {
				const html = renderPage(<CombosTab />, (client) => {
					client.setQueryData(queryKeys.combos(), { combos: [] });
					client.setQueryData(queryKeys.families(), { families: [] });
					if (state === "loading" || state === "error")
						client.removeQueries({
							queryKey: queryKeys[section](),
							exact: true,
						});
					seedState(
						client,
						queryKeys[section](),
						state,
						section === "combos" ? { combos: [] } : { families: [] },
					);
				});
				expectHeader(html, "combos");
				expect(html).toContain("Create Combo");
				expect(html).toContain("Family Activation");
				if (state === "loading") expect(html).toContain('role="status"');
				if (state === "loading") {
					expect(html).toContain("Loading family policies");
					if (section === "combos") expect(html).toContain("Loading combos");
				}
				if (state === "error") {
					expect(html).toContain("Family policies could not load");
					expect(html).toContain("Existing routing was not changed.");
					if (section === "combos")
						expect(html.split("Combos could not load").length - 1).toBe(1);
				}
				if (state === "cached")
					expect(html).not.toContain("Combos could not load");
				if (state === "error") {
					expect(html).toContain('role="alert"');
					expect(html).toContain(
						"Network error. Please check your connection and try again.",
					);
					expect(html).not.toContain("Failed to fetch");
					expect(html).toContain("Retry");
				}
				if (state === "cached" || state === "empty") {
					expect(html).not.toContain('role="alert"');
					expect(html).toContain("No combos yet");
				}
			});
});
