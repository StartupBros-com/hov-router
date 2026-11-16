import { describe, expect, it, mock } from "bun:test";

const state = {
	setFailed: false,
	storePayloads: true as boolean | undefined,
};
const real = await import("../../hooks/queries");
mock.module("../../hooks/queries", () => ({
	...real,
	useRetention: () => ({
		data:
			state.storePayloads === undefined
				? undefined
				: {
						payloadDays: 3,
						requestDays: 90,
						storePayloads: state.storePayloads,
					},
		isLoading: false,
	}),
	useSetRetention: () => ({
		mutate: () => {},
		isPending: false,
		isError: state.setFailed,
	}),
	useCleanupNow: () => ({
		mutate: () => {},
		isPending: false,
		isError: false,
		data: undefined,
	}),
}));

const { renderPage } = await import("../page-state-test-helpers");
const { DataRetentionCard } = await import("./DataRetentionCard");

const FAILED =
	"Could not save the retention settings. The previous values are still in effect.";

describe("DataRetentionCard visible state", () => {
	it("shows no save error while the save has not failed", () => {
		state.setFailed = false;
		const html = renderPage(<DataRetentionCard />);
		expect(html).not.toContain('role="alert"');
		expect(html).not.toContain(FAILED);
	});

	it("shows the save error below the store-payloads row once it failed", () => {
		state.setFailed = true;
		const html = renderPage(<DataRetentionCard />);
		expect(html).toMatch(/role="alert"[^>]*>Could not save the retention/);
		expect(html).toContain(FAILED);
		expect(html.indexOf(FAILED)).toBeGreaterThan(
			html.indexOf("retention-store-payloads"),
		);
	});

	it("says Enabled or Disabled beside the store-payloads switch", () => {
		state.setFailed = false;
		const word = (on: string, off: string) => {
			const html = renderPage(<DataRetentionCard />);
			expect(html).toContain(on);
			expect(html).not.toContain(off);
		};
		state.storePayloads = true;
		word(">Enabled</span>", ">Disabled</span>");
		state.storePayloads = false;
		word(">Disabled</span>", ">Enabled</span>");
		// No data yet: the switch is drawn on, so the word follows it.
		state.storePayloads = undefined;
		word(">Enabled</span>", ">Disabled</span>");
		state.storePayloads = true;
	});

	it("lets both retention rows wrap so Save can drop to its own line", () => {
		state.setFailed = false;
		const html = renderPage(<DataRetentionCard />);
		for (const id of ["retention-payload-days", "retention-request-days"]) {
			const label = html.indexOf(`for="${id}"`);
			expect(label).toBeGreaterThan(-1);
			// The inner label/input row is the parent of the label; its parent
			// is the outer row that holds the Save button.
			const inner = html.lastIndexOf("<div", label);
			const outer = html.lastIndexOf("<div", inner - 1);
			expect(html.slice(outer, html.indexOf(">", outer))).toContain(
				"flex-wrap",
			);
			expect(html.slice(inner, html.indexOf(">", inner))).not.toContain(
				"flex-wrap",
			);
		}
	});
});
