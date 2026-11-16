import { describe, expect, it, mock } from "bun:test";
import type { RoutingAttemptSummaryResponse } from "@better-ccflare/types";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderPage } from "../page-state-test-helpers";
import { DataRetentionCard } from "./DataRetentionCard";
import { ProviderDefaultsStatus } from "./ProviderModelDefaultsDialog";
import {
	type RoutingAttemptSummaryViewState,
	RoutingCardView,
	type RoutingCardViewProps,
} from "./RoutingCard";
import { SystemCacheTtlCard } from "./SystemCacheTtlCard";
import { UsageThrottlingCard } from "./UsageThrottlingCard";

type El = ReactElement<Record<string, unknown>>;

function findElement(
	node: ReactNode,
	predicate: (element: El) => boolean,
): El | null {
	if (Array.isArray(node)) {
		for (const child of node) {
			const match = findElement(child, predicate);
			if (match) return match;
		}
		return null;
	}
	if (!isValidElement<Record<string, unknown>>(node)) return null;
	if (predicate(node)) return node;
	return findElement(node.props.children as ReactNode, predicate);
}

/** Expand a function-component element one level so its inner Button is walkable. */
function expand(element: El | null): ReactNode {
	return (element?.type as (props: unknown) => ReactNode)(element?.props);
}

function clickRetry(tree: ReactNode) {
	const stateEl = findElement(
		tree,
		(e) => typeof e.props.onRetry === "function",
	);
	expect(stateEl).not.toBeNull();
	const button = findElement(
		expand(stateEl),
		(e) => typeof e.props.onClick === "function",
	);
	expect(button).not.toBeNull();
	(button?.props.onClick as () => void)();
}

const populatedSummary: RoutingAttemptSummaryResponse = {
	window: "24h",
	generatedAt: "2026-08-26T12:00:00.000Z",
	windowStart: "2026-08-25T12:00:00.000Z",
	windowEnd: "2026-08-26T12:00:00.000Z",
	firstObservedAt: "2026-08-25T10:00:00.000Z",
	totalAttempts: 4,
	distinctRequests: 3,
	recoveredRequests: 1,
	terminalFailureRequests: 1,
	awaitingTerminalRequests: 1,
	byReasonScope: [],
};

function viewProps(
	overrides: Partial<RoutingCardViewProps> = {},
): RoutingCardViewProps {
	return {
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
}

const errorState: RoutingAttemptSummaryViewState = {
	status: "error",
	message: "boom",
};

describe("RoutingCardView presentation", () => {
	it("renders Retry inside the alert and calls the spy once", () => {
		const onRetry = mock(() => undefined);
		const props = viewProps({
			routingAttempts: errorState,
			onRetryRoutingAttempts: onRetry,
		});
		const html = renderToStaticMarkup(<RoutingCardView {...props} />);
		expect(html).toMatch(/role="alert"[\s\S]*Retry/);
		clickRetry(RoutingCardView(props));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("renders no Retry without the prop", () => {
		const html = renderToStaticMarkup(
			<RoutingCardView {...viewProps({ routingAttempts: errorState })} />,
		);
		expect(html).toContain('role="alert"');
		expect(html).not.toContain("Retry");
	});

	it("draws env-locked as a warning pill that keeps its title", () => {
		const html = renderToStaticMarkup(
			<RoutingCardView
				{...viewProps({ strategySource: "env", capacitySource: "env" })}
			/>,
		);
		expect(html.match(/data-tone="warning"/g)).toHaveLength(2);
		expect(html).toMatch(
			/<span[^>]*data-tone="warning"[^>]*title="Set by the LB_STRATEGY environment variable[^"]*"[^>]*>env-locked<\/span>|<span[^>]*title="Set by the LB_STRATEGY environment variable[^"]*"[^>]*data-tone="warning"[^>]*>env-locked<\/span>/,
		);
	});

	it("keeps the totals sentence whole inside a tabular-nums paragraph", () => {
		const html = renderToStaticMarkup(
			<RoutingCardView
				{...viewProps({
					routingAttempts: { status: "success", data: populatedSummary },
				})}
			/>,
		);
		const paragraph = html.match(
			/<p class="([^"]*)">4 attempts across[^<]*(?:<!-- -->[^<]*)*logical requests<\/p>/,
		);
		expect(paragraph).not.toBeNull();
		expect(paragraph?.[1]).toContain("tabular-nums");
		expect(html.replace(/<!-- -->/g, "")).toContain(
			"4 attempts across 3 logical requests",
		);
	});

	it("sizes the strategy trigger at 44 px", () => {
		const html = renderToStaticMarkup(<RoutingCardView {...viewProps()} />);
		expect(html).toMatch(
			/<button[^>]*class="[^"]*\bh-11\b[^"]*"[^>]*id="routing-strategy"/,
		);
	});
});

describe("ProviderDefaultsStatus", () => {
	it("announces loading as a status", () => {
		const html = renderToStaticMarkup(
			<ProviderDefaultsStatus
				isLoading
				isError={false}
				error={null}
				isEmpty={false}
				onRetry={() => {}}
			/>,
		);
		expect(html).toContain('role="status"');
		expect(html).toContain("Loading provider defaults");
	});

	it("shows the load error with a Retry that calls refetch", () => {
		const refetch = mock(() => undefined);
		const props = {
			isLoading: false,
			isError: true,
			error: new Error("nope"),
			isEmpty: false,
			onRetry: refetch,
		};
		const html = renderToStaticMarkup(<ProviderDefaultsStatus {...props} />);
		expect(html).toContain('role="alert"');
		expect(html).toContain("Could not load provider defaults. nope");
		expect(html).toContain("Retry");
		clickRetry(ProviderDefaultsStatus(props));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("shows the empty text", () => {
		const html = renderToStaticMarkup(
			<ProviderDefaultsStatus
				isLoading={false}
				isError={false}
				error={null}
				isEmpty
				onRetry={() => {}}
			/>,
		);
		expect(html).toContain(
			"No provider has a built-in default map to configure.",
		);
		expect(html).not.toContain('role="alert"');
	});
});

describe("SystemCacheTtlCard", () => {
	it("puts the switch in an h-11 w-11 hit box and keeps its name", () => {
		const html = renderPage(<SystemCacheTtlCard />);
		expect(html).toMatch(/<label[^>]*class="[^"]*h-11 w-11[^"]*"[^>]*><button/);
		expect(html).toContain('aria-label="System Prompt Cache TTL"');
		expect(html).toContain("Disabled");
	});
});

describe("UsageThrottlingCard", () => {
	it("labels each switch at 44 px and keeps its aria-label", () => {
		const html = renderPage(<UsageThrottlingCard />);
		for (const [id, name] of [
			["usage-throttling-five-hour", "5-hour window"],
			["usage-throttling-weekly", "Weekly window"],
		] as const) {
			expect(html).toMatch(
				new RegExp(`<label[^>]*class="[^"]*min-h-11[^"]*"[^>]*for="${id}"`),
			);
			expect(html).toContain(`id="${id}"`);
			expect(html).toContain(`aria-label="${name}"`);
		}
	});
});

describe("DataRetentionCard", () => {
	it("labels the payload switch at 44 px and uses the warning token", () => {
		const html = renderPage(<DataRetentionCard />);
		expect(html).toMatch(
			/<label[^>]*class="[^"]*min-h-11[^"]*"[^>]*for="retention-store-payloads"/,
		);
		expect(html).toContain('id="retention-store-payloads"');
		expect(html).toContain("text-(--warning)");
		expect(html).not.toContain("amber");
	});
});
