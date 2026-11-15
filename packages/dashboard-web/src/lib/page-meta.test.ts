import { describe, expect, it } from "bun:test";
import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";
import { PAGE_META, pageMetaForPath } from "./page-meta";

const byPath = (field: "title" | "description") =>
	Object.fromEntries(Object.values(PAGE_META).map((m) => [m.path, m[field]]));

describe("page meta", () => {
	it("titles every page with its nav label", () => {
		expect(byPath("title")).toEqual({
			"/": "Overview",
			"/analytics": "Analytics",
			"/insights": "Insights",
			"/requests": "Requests",
			"/accounts": "Accounts",
			"/usage-history": "Usage History",
			"/window-value": "Window Value",
			"/combos": "Combos",
			"/agents": "Agents",
			"/keys": "API Keys",
			"/logs": "Logs",
			"/settings": "Settings",
		});
	});

	it("keeps each route's description", () => {
		expect(byPath("description")).toEqual({
			"/": `Monitor your ${PRODUCT_NAME} performance and usage`,
			"/analytics": "Usage patterns and trends over time",
			"/insights": "Cache efficiency and estimated cost savings",
			"/requests": "View detailed request and response data",
			"/accounts": "Provider accounts, usage limits and routing settings",
			"/usage-history":
				"Per-account usage windows over time, with limit prediction",
			"/window-value": "Track the value of active and completed usage windows",
			"/combos": "Define fallback chains for model families",
			"/agents": "Discover and manage Claude Code agents",
			"/keys": "Generate and manage API keys for authentication",
			"/logs": "Live system logs",
			"/settings": "Configure system behavior and data retention",
		});
	});

	it("resolves a path to its page and falls back to Overview", () => {
		expect(pageMetaForPath("/keys")).toBe(PAGE_META.keys);
		expect(pageMetaForPath("/usage-history")).toBe(PAGE_META.usageHistory);
		expect(pageMetaForPath("/")).toBe(PAGE_META.overview);
		expect(pageMetaForPath("/no-such-page")).toBe(PAGE_META.overview);
	});
});
