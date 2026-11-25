import { describe, expect, it } from "bun:test";
import { queryKeys } from "../../lib/query-keys";
import {
	expectHeader,
	renderPage,
	seedState,
} from "../page-state-test-helpers";
import { AlertsTab } from "./AlertsTab";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function alert(
	id: string,
	severity: "info" | "warning" | "critical",
	ageHours = 1,
) {
	return {
		id,
		timestamp: NOW - ageHours * HOUR,
		type: "auth_failure",
		severity,
		title: `Synthetic ${severity} alert`,
		message: "Made up for a presentation check.",
		value: null,
		threshold: null,
		account: null,
		model: null,
		project: null,
		requestId: null,
		acknowledged: false,
	};
}

function render(alerts: unknown[], unacknowledgedCount: number) {
	return renderPage(<AlertsTab />, (client) =>
		client.setQueryData(
			queryKeys.insightsAlerts(),
			{ alerts, unacknowledgedCount },
			{ updatedAt: NOW },
		),
	);
}

describe("Alerts states", () => {
	for (const state of ["loading", "error", "cached", "empty"] as const)
		it(state, () => {
			const html = renderPage(<AlertsTab />, (client) =>
				seedState(
					client,
					queryKeys.insightsAlerts(),
					state,
					state === "empty"
						? { alerts: [], unacknowledgedCount: 0 }
						: { alerts: [alert("cached", "critical")], unacknowledgedCount: 1 },
				),
			);
			expectHeader(html, "alerts");
			if (state === "loading") {
				expect(html).toContain('role="status"');
				expect(html).toContain('aria-label="Loading alerts"');
				expect(html).not.toContain("Unacknowledged:");
			}
			if (state === "error") {
				expect(html).toContain('role="alert"');
				expect(html).toContain("Alerts could not load");
				expect(html).toContain("Retry");
			}
			if (state === "cached") {
				expect(html).not.toContain('role="alert"');
				expect(html).toContain("Synthetic critical alert");
			}
			if (state === "empty") {
				expect(html).not.toContain('role="alert"');
				expect(html).toContain("No alerts yet");
			}
		});
});

describe("Alerts presentation", () => {
	it("marks each alert with its severity in the matching tone", () => {
		const html = render(
			[alert("c", "critical"), alert("w", "warning"), alert("i", "info")],
			3,
		);
		expect(html).toContain('data-tone="danger"');
		expect(html).toContain(">Critical</span>");
		expect(html).toContain("text-(--danger)");
		expect(html).toContain('data-tone="warning"');
		expect(html).toContain(">Warning</span>");
		expect(html).toContain("text-(--warning)");
		expect(html).toContain('data-tone="info"');
		expect(html).toContain(">Info</span>");
		expect(html).not.toMatch(/\bamber-\d/);
	});

	it("separates the stored total from the recent count the badge shows", () => {
		const html = render(
			[alert("w", "warning"), alert("i", "info"), alert("old", "critical", 30)],
			2428,
		);
		expect(html).toContain("Unacknowledged: 2428");
		expect(html).toContain("Warning or critical in the last 24 hours: 1.");
	});

	it("says so when nothing recent needs attention", () => {
		const html = render([alert("old", "critical", 30)], 1);
		expect(html).toContain(
			"No warning or critical alerts in the last 24 hours.",
		);
	});

	it("lets the header wrap Acknowledge all under the count", () => {
		const html = render([alert("w", "warning")], 1);
		const header = html.slice(0, html.indexOf("Unacknowledged: "));
		expect(header).toContain(
			'class="flex flex-wrap items-center justify-between gap-2"',
		);
	});
});
