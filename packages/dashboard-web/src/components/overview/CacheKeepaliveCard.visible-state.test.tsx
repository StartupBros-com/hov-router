import { describe, expect, it } from "bun:test";
import { renderPage, seedState } from "../page-state-test-helpers";
import { CacheKeepaliveCard } from "./CacheKeepaliveCard";

const MESSAGE = "Could not load the keep-alive setting";

describe("CacheKeepaliveCard visible state", () => {
	it("replaces the select with an inline error when the load failed", () => {
		const html = renderPage(<CacheKeepaliveCard />, (client) =>
			seedState(client, ["keepalive"], "error", undefined),
		);
		expect(html).toMatch(/role="alert"[^>]*>/);
		expect(html).toContain(MESSAGE);
		expect(html).toContain("Retry");
		expect(html).not.toContain('aria-label="Cache Keep-Alive"');
	});

	it("shows the select and no alert while loading", () => {
		const html = renderPage(<CacheKeepaliveCard />);
		expect(html).not.toContain('role="alert"');
		expect(html).not.toContain(MESSAGE);
		expect(html).toContain('aria-label="Cache Keep-Alive"');
	});

	it("keeps the select when data is cached even after a failed refresh", () => {
		const html = renderPage(<CacheKeepaliveCard />, (client) =>
			seedState(client, ["keepalive"], "cached", { ttlMinutes: 10 }),
		);
		expect(html).not.toContain('role="alert"');
		expect(html).not.toContain(MESSAGE);
		expect(html).toContain('aria-label="Cache Keep-Alive"');
	});
});
