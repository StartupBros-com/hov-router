/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import { StrategyName } from "@hov-router/core";
import type { RoutingAttemptSummaryResponse } from "@hov-router/types";
import { renderToStaticMarkup } from "react-dom/server";
import {
	getStrategySelectItems,
	RoutingCardView,
	type RoutingCardViewProps,
} from "./RoutingCard";

const emptySummary: RoutingAttemptSummaryResponse = {
	window: "24h",
	generatedAt: "2026-08-26T12:00:00.000Z",
	windowStart: "2026-08-25T12:00:00.000Z",
	windowEnd: "2026-08-26T12:00:00.000Z",
	firstObservedAt: null,
	totalAttempts: 0,
	distinctRequests: 0,
	recoveredRequests: 0,
	terminalFailureRequests: 0,
	awaitingTerminalRequests: 0,
	byReasonScope: [],
};

const populatedSummary: RoutingAttemptSummaryResponse = {
	...emptySummary,
	firstObservedAt: "2026-08-25T10:00:00.000Z",
	totalAttempts: 4,
	distinctRequests: 3,
	recoveredRequests: 1,
	terminalFailureRequests: 1,
	awaitingTerminalRequests: 1,
	byReasonScope: [
		{
			reason: "model_scoped_429",
			scope: "model",
			attemptCount: 4,
			distinctRequests: 3,
			recoveredRequests: 1,
			terminalFailureRequests: 1,
			awaitingTerminalRequests: 1,
		},
	],
};

function render(overrides: Partial<RoutingCardViewProps> = {}): string {
	const props: RoutingCardViewProps = {
		strategy: "session",
		onStrategyChange: () => {},
		strategyDisabled: false,
		strategySource: "default",
		capacityMode: "off",
		capacitySource: "default",
		onCapacityChange: () => {},
		capacityDisabled: false,
		...overrides,
	};
	return renderToStaticMarkup(<RoutingCardView {...props} />);
}

describe("RoutingCardView", () => {
	it("renders both the strategy selector and the capacity switch", () => {
		const html = render();
		expect(html).toContain('role="combobox"');
		expect(html).toContain("Load-balancing strategy");
		expect(html).toContain('role="switch"');
		expect(html).toContain("Model-scoped capacity routing");
	});

	it("describes both drain-soonest modes honestly", () => {
		const html = render();
		expect(html).not.toContain("never preempted");
		expect(html).toContain("affinity and routing policy allow");
		expect(html).toContain("account-level session");
		expect(html).toContain("within each authorized routing class");
		expect(html).toContain("only breaks ties");
		expect(html).toContain("explicit owner-retention");
		expect(html).toContain("Session affinity");
		expect(html).toContain("Least used");
	});

	it("reflects the exhausted capacity mode as a checked switch", () => {
		const html = render({ capacityMode: "exhausted", capacitySource: "file" });
		expect(html).toContain('aria-checked="true"');
	});

	it("describes the conditional model-pool exhaustion terminal", () => {
		const html = render({ capacityMode: "exhausted" });
		expect(html).toContain(
			"no capacity left for the requested model are skipped",
		);
		expect(html).toContain("the remaining accounts still handle the request");
		expect(html).toContain(
			"If none are left, the request fails with a retryable 503",
		);
		expect(html).toContain("model_pool_exhausted");
		expect(html).toContain("503");
		expect(html).not.toContain("model_family_exhausted");
	});

	it("reflects the off capacity mode as an unchecked switch", () => {
		const html = render({ capacityMode: "off", capacitySource: "file" });
		expect(html).toContain('aria-checked="false"');
	});

	it("locks the switch and shows an env-locked badge when the source is env", () => {
		const html = render({ capacityMode: "exhausted", capacitySource: "env" });
		expect(html).toContain("env-locked");
		expect(html).toContain("data-disabled");
		expect(html).toContain("MODEL_SCOPED_CAPACITY_ROUTING");
	});

	it("locks the switch off when the environment does", () => {
		const html = render({ capacityMode: "off", capacitySource: "env" });
		expect(html).toContain('aria-checked="false"');
		expect(html).toContain("data-disabled");
		expect(html).toContain("env-locked");
	});

	it("leaves the switch enabled and hides the badge for the file source", () => {
		const html = render({ capacityMode: "exhausted", capacitySource: "file" });
		expect(html).not.toContain("env-locked");
		expect(html).not.toContain("data-disabled");
	});

	it("leaves the switch enabled and hides the badge for the default source", () => {
		const html = render({
			capacityMode: "exhausted",
			capacitySource: "default",
		});
		expect(html).not.toContain("env-locked");
		expect(html).not.toContain("data-disabled");
	});

	it("locks the strategy select and shows an env-locked badge when strategySource is env", () => {
		const html = render({ strategy: "session", strategySource: "env" });
		expect(html).toContain("env-locked");
		expect(html).toContain("data-disabled");
		expect(html).toContain("LB_STRATEGY");
	});

	it("leaves the strategy select enabled and hides its badge for the file source", () => {
		const html = render({ strategy: "session", strategySource: "file" });
		expect(html).not.toContain("env-locked");
		expect(html).not.toContain("data-disabled");
	});

	it("leaves the strategy select enabled and hides its badge for the default source", () => {
		const html = render({ strategy: "session", strategySource: "default" });
		expect(html).not.toContain("env-locked");
		expect(html).not.toContain("data-disabled");
	});

	it("associates labels with their controls", () => {
		const html = render();
		expect(html).toContain('for="routing-strategy"');
		expect(html).toContain('id="routing-strategy"');
		expect(html).toContain('for="routing-capacity"');
		expect(html).toContain('id="routing-capacity"');
	});

	it("does not throw when the effective strategy is not listed", () => {
		const html = render({ strategy: "future-strategy" });
		expect(html).toContain('role="combobox"');
	});

	describe("routing-attempt aggregate section", () => {
		it("renders a loading state that distinguishes upstream routing events from terminal client failures", () => {
			const html = render({ routingAttempts: { status: "loading" } });
			expect(html).toContain("Routing attempts (last 24 hours)");
			expect(html).toContain("post-deployment only");
			expect(html).toContain("not backfilled");
			expect(html).toContain("Loading routing-attempt summary");
			expect(html).toContain(
				"upstream routing events, not terminal client failures",
			);
		});

		it("renders an empty state without a chart, identifier drilldown, or observed timestamp", () => {
			const html = render({
				routingAttempts: { status: "success", data: emptySummary },
			});
			expect(html).toContain("No upstream routing attempts in this window.");
			expect(html).not.toContain("First observed");
			expect(html).not.toContain("accountId");
			expect(html).not.toContain("chart");
		});

		it("renders a text-labelled populated aggregate with reason and scope rows", () => {
			const html = render({
				routingAttempts: { status: "success", data: populatedSummary },
			});
			expect(html).toContain("4 attempts across 3 logical requests");
			expect(html).toContain("First observed");
			expect(html).toContain('dateTime="2026-08-25T10:00:00.000Z"');
			expect(html).toContain("1 recovered");
			expect(html).toContain("1 terminal failure");
			// #918: a plain title, with the raw reason kept as its tooltip.
			expect(html).toContain("Model family capacity exhausted · model");
			expect(html).toContain('title="model_scoped_429"');
			expect(html).not.toContain(">model_scoped_429 · model<");
			expect(html).toContain(
				"4 attempts; 1 recovered; 1 terminal failure; 1 awaiting terminal",
			);
		});

		it("renders an inline error state", () => {
			const html = render({ routingAttempts: { status: "error" } });
			expect(html).toContain("Routing-attempt summary could not load.");
		});
	});
});

describe("getStrategySelectItems", () => {
	const known = Object.values(StrategyName).sort();
	for (const current of [...known, "future-strategy"]) {
		it(`offers every supported strategy once when ${current} is current`, () => {
			const items = getStrategySelectItems(current);
			expect(
				items
					.filter((item) => !item.disabled)
					.map((item) => item.value)
					.sort(),
			).toEqual(known);
			expect(items.filter((item) => item.disabled)).toEqual(
				current === "future-strategy"
					? [
							{
								label: "future-strategy (current)",
								value: current,
								disabled: true,
							},
						]
					: [],
			);
		});
	}
});
