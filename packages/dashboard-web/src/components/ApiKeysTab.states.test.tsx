import { describe, expect, it } from "bun:test";
import { ApiKeysTab } from "./ApiKeysTab";
import { expectHeader, renderPage, seedState } from "./page-state-test-helpers";

const keys = {
	success: true,
	data: [
		{
			id: "key-1",
			name: "Cached key",
			prefixLast8: "12345678",
			createdAt: "2026-01-01",
			lastUsed: null,
			usageCount: 1,
			isActive: true,
			role: "admin",
		},
	],
	count: 1,
};
describe("API Keys independent states", () => {
	for (const section of ["stats", "keys"] as const)
		for (const state of ["loading", "error", "cached", "empty"] as const)
			it(`${section} ${state}`, () => {
				const html = renderPage(<ApiKeysTab />, (client) => {
					if (section === "stats") client.setQueryData(["api-keys"], keys);
					else
						client.setQueryData(["api-keys-stats"], {
							data: { total: 1, active: 1, inactive: 0 },
						});
					seedState(
						client,
						[section === "stats" ? "api-keys-stats" : "api-keys"],
						state,
						section === "stats"
							? { data: { total: 1, active: 1, inactive: 0 } }
							: state === "empty"
								? { data: [], count: 0 }
								: keys,
					);
				});
				expectHeader(html, "keys");
				expect(html).toContain("Generate API Key");
				expect(html).toContain("Your API Keys");
				if (state === "loading") expect(html).toContain('role="status"');
				if (state === "loading")
					expect(html).toContain(
						section === "keys"
							? "Loading API keys"
							: "Loading API key statistics",
					);
				if (section === "keys" && (state === "loading" || state === "error")) {
					expect(html).toContain("Total Keys");
					expect(html).not.toContain("API key statistics could not load");
					expect(html).not.toContain("No API keys have been created yet.");
				}
				if (section === "stats" && (state === "loading" || state === "error")) {
					expect(html).toContain("Cached key");
					expect(html).not.toContain("API keys could not load");
				}
				if (state === "error")
					expect(html).toContain(
						section === "keys"
							? "API keys could not load"
							: "API key statistics could not load",
					);
				if (section === "keys" && state === "empty")
					expect(html).toContain("No API keys have been created yet.");
				if (state === "error") {
					expect(html).toContain('role="alert"');
					expect(html).toContain(
						"Network error. Please check your connection and try again.",
					);
					expect(html).not.toContain("Failed to fetch");
					expect(html).toContain("Retry");
					if (section === "stats") {
						expect(html).toContain("Cached key");
						expect(html).not.toContain("Total Keys");
					}
				}
				if (state === "cached" || state === "empty") {
					expect(html).not.toContain('role="alert"');
					if (state === "cached") expect(html).toContain("Cached key");
				}
				if (section === "keys" && state === "empty")
					expect(html).toContain("No API keys configured");
			});
});
