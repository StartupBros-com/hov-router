import { describe, expect, it, mock } from "bun:test";

const HOUR = 60 * 60 * 1000;
const real = await import("../../hooks/queries");
mock.module("../../hooks/queries", () => ({
	...real,
	useStorageInfo: () => ({
		data: {
			integrity_status: "ok",
			last_full_check_at: new Date(Date.now() - HOUR).toISOString(),
			last_quick_check_at: new Date(Date.now() - HOUR / 6).toISOString(),
			last_full_result: "ok",
			last_quick_result: "ok",
		},
		isError: false,
		error: null,
		refetch: () => {},
	}),
	useTriggerIntegrityCheck: () => ({
		mutate: () => {},
		isPending: false,
		isError: false,
	}),
}));

const { renderPage } = await import("../page-state-test-helpers");
const { StorageIntegrityCard } = await import("./StorageIntegrityCard");

describe("StorageIntegrityCard visible state", () => {
	it("shows Healthy in the shared success tone, not raw green classes", () => {
		const html = renderPage(<StorageIntegrityCard />);
		expect(html).toMatch(/data-tone="success"[^>]*>Healthy</);
		expect(html).not.toMatch(/\bgreen-\d/);
	});

	it("lets the two check buttons wrap instead of pushing the page sideways", () => {
		const html = renderPage(<StorageIntegrityCard />);
		const row = html.slice(0, html.indexOf("Run quick check"));
		expect(row.slice(row.lastIndexOf("<div"))).toContain(
			'class="flex flex-wrap gap-2"',
		);
		expect(html).toContain("Run full check");
	});
});
