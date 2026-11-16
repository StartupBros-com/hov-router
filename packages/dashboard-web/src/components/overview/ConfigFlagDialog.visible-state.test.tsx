import { describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";

// The real dialog portals its content, which a static render never draws.
mock.module("../ui/dialog", () => {
	const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
	return {
		Dialog: Pass,
		DialogContent: Pass,
		DialogDescription: Pass,
		DialogHeader: Pass,
		DialogTitle: Pass,
		DialogTrigger: Pass,
	};
});

const { queryKeys } = await import("../../lib/query-keys");
const { renderPage, seedState } = await import("../page-state-test-helpers");
const { ConfigFlagDialog } = await import("./ConfigFlagDialog");

const PATH = "/api/config/example";
const MESSAGE = "Could not load this setting";

function render(seed?: Parameters<typeof renderPage>[1]) {
	return renderPage(
		<ConfigFlagDialog
			title="Example"
			description="An example setting"
			path={PATH}
			switchLabel="Allow example"
		>
			<p>Explanation</p>
		</ConfigFlagDialog>,
		seed,
	);
}

describe("ConfigFlagDialog visible state", () => {
	it("shows no load error while the setting has not failed to load", () => {
		const html = render();
		expect(html).not.toContain('role="alert"');
		expect(html).not.toContain(MESSAGE);
	});

	it("shows an inline error with Retry when the load failed", () => {
		const html = render((client) =>
			seedState(client, queryKeys.configFlag(PATH), "error", undefined),
		);
		expect(html).toMatch(/role="alert"[^>]*>/);
		expect(html).toContain(MESSAGE);
		expect(html).toContain("Retry");
		// The switch row is left as it is.
		expect(html).toContain("Allow example");
	});

	it("still reports a failed refresh, since isError is the only trigger", () => {
		const html = render((client) =>
			seedState(client, queryKeys.configFlag(PATH), "cached", {
				enabled: true,
				source: "file",
			}),
		);
		expect(html).toContain(MESSAGE);
	});
});
