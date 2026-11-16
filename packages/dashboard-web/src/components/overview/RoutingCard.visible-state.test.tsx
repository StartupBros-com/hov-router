import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RoutingCardView, type RoutingCardViewProps } from "./RoutingCard";

const base: RoutingCardViewProps = {
	strategy: "session",
	onStrategyChange: () => {},
	strategyDisabled: false,
	strategySource: "file",
	capacityMode: "off",
	capacitySource: "file",
	onCapacityChange: () => {},
	capacityDisabled: false,
};

function render(props: Partial<RoutingCardViewProps> = {}) {
	return renderToStaticMarkup(<RoutingCardView {...base} {...props} />);
}

const STRATEGY_FAILED =
	"Could not save the load-balancing strategy. The previous setting is still in effect.";
const CAPACITY_FAILED =
	"Could not save the model-scoped capacity routing setting. The previous setting is still in effect.";

describe("RoutingCard visible state", () => {
	it("shows no save error while neither save has failed", () => {
		const html = render();
		expect(html).not.toContain('role="alert"');
		expect(html).not.toContain(STRATEGY_FAILED);
		expect(html).not.toContain(CAPACITY_FAILED);
	});

	it("shows the strategy save error only when it failed", () => {
		const html = render({ strategySaveFailed: true });
		expect(html).toMatch(
			new RegExp(`role="alert"[^>]*>${STRATEGY_FAILED.replace(".", "\\.")}<`),
		);
		expect(html).not.toContain(CAPACITY_FAILED);
	});

	it("shows the capacity save error only when it failed", () => {
		const html = render({ capacitySaveFailed: true });
		expect(html).toMatch(
			new RegExp(`role="alert"[^>]*>${CAPACITY_FAILED.replace(".", "\\.")}<`),
		);
		expect(html).not.toContain(STRATEGY_FAILED);
	});

	it("says Enabled or Disabled beside the capacity switch", () => {
		const off = render({ capacityMode: "off" });
		expect(off).toMatch(
			/<span class="text-sm text-muted-foreground">Disabled<\/span>/,
		);
		expect(off).not.toMatch(
			/<span class="text-sm text-muted-foreground">Enabled<\/span>/,
		);
		const on = render({ capacityMode: "exhausted" });
		expect(on).toMatch(
			/<span class="text-sm text-muted-foreground">Enabled<\/span>/,
		);
		expect(on).not.toMatch(
			/<span class="text-sm text-muted-foreground">Disabled<\/span>/,
		);
	});

	it("spells out the env-lock reasons only when env-locked", () => {
		const free = render();
		expect(free).not.toContain("Set by the LB_STRATEGY environment variable");
		expect(free).not.toContain(
			"Set by the MODEL_SCOPED_CAPACITY_ROUTING environment variable",
		);
		const locked = render({ strategySource: "env", capacitySource: "env" });
		expect(locked).toMatch(
			/<p class="text-xs text-muted-foreground">Set by the LB_STRATEGY environment variable; change the env var to edit this\.<\/p>/,
		);
		expect(locked).toMatch(
			/<p class="text-xs text-muted-foreground">Set by the MODEL_SCOPED_CAPACITY_ROUTING environment variable; change the env var to edit this\.<\/p>/,
		);
		const strategyOnly = render({ strategySource: "env" });
		expect(strategyOnly).not.toMatch(
			/<p class="text-xs text-muted-foreground">Set by the MODEL_SCOPED/,
		);
	});
});
