import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoutingObservation } from "../../../api";
import {
	formatShortDuration,
	ObservedRoutingTable,
} from "../ObservedRoutingTable";

const NOW = 1_700_000_000_000;

function mkObservation(
	family: string,
	names: string[],
	observedAtMs: number,
): RoutingObservation {
	return {
		family,
		order: names.map((name, i) => ({ id: `id-${i}`, name })),
		model: `claude-${family}`,
		observedAtMs,
	};
}

describe("ObservedRoutingTable", () => {
	it("renders nothing when there are no observations at all", () => {
		expect(
			renderToStaticMarkup(
				<ObservedRoutingTable observations={undefined} now={NOW} />,
			),
		).toBe("");
		expect(
			renderToStaticMarkup(
				<ObservedRoutingTable observations={null} now={NOW} />,
			),
		).toBe("");
		expect(
			renderToStaticMarkup(
				<ObservedRoutingTable observations={{}} now={NOW} />,
			),
		).toBe("");
	});

	it("renders every observed family, including one that also has its own pool row (fable)", () => {
		const html = renderToStaticMarkup(
			<ObservedRoutingTable
				observations={{
					fable: mkObservation("fable", ["acc-fable"], NOW - 1000),
					sonnet: mkObservation("sonnet", ["acc-b", "acc-a"], NOW - 65_000),
					opus: mkObservation("opus", ["acc-c"], NOW - 5000),
				}}
				now={NOW}
			/>,
		);
		expect(html).toContain(
			"Observed routing order — the last decision the proxy actually made",
		);
		expect(html).toContain("Fable");
		expect(html).toContain("Sonnet");
		expect(html).toContain("Opus");
		expect(html).toContain("acc-fable");
		expect(html).toContain("acc-b");
		expect(html).toContain("acc-a");
		expect(html).toContain("acc-c");
	});

	it("renders 1-based rank numbers for a multi-account chain", () => {
		const html = renderToStaticMarkup(
			<ObservedRoutingTable
				observations={{
					sonnet: mkObservation(
						"sonnet",
						["acc-a", "acc-b", "acc-c"],
						NOW - 1000,
					),
				}}
				now={NOW}
			/>,
		);
		expect(html).toContain('title="Position 1 of sonnet routing order"');
		expect(html).toContain('title="Position 2 of sonnet routing order"');
		expect(html).toContain('title="Position 3 of sonnet routing order"');
	});

	it("marks the first account with the primary text token, not a raw palette class", () => {
		const html = renderToStaticMarkup(
			<ObservedRoutingTable
				observations={{
					sonnet: mkObservation("sonnet", ["max-echo", "max-fox"], NOW - 1000),
				}}
				now={NOW}
			/>,
		);
		expect(html).not.toContain("orange-");
		expect(html).toContain("border-primary text-(--primary-text)");
		// The rank digit on the first pill: card colour on the primary text
		// token (white on the bright --primary orange measured 2.73:1).
		expect(html).toMatch(/bg-\(--primary-text\) text-card"[^>]*>1</);
		expect(html).not.toContain("bg-primary text-primary-foreground");
	});

	it("never breaks an account name across lines, and gives the chain its own line on phones", () => {
		const html = renderToStaticMarkup(
			<ObservedRoutingTable
				observations={{
					sonnet: mkObservation("sonnet", ["max-echo", "max-fox"], NOW - 1000),
				}}
				now={NOW}
			/>,
		);
		const pills = html.match(/<span class="[^"]*rounded-full border[^"]*"/g);
		expect(pills).toHaveLength(2);
		for (const pill of pills ?? []) {
			expect(pill).toContain("whitespace-nowrap");
			expect(pill).toContain("max-w-full");
		}
		expect(html).toContain(
			'class="min-w-0 truncate" title="max-echo">max-echo<',
		);
		// Below sm the chain drops under the family label and observed age;
		// from sm up the row keeps its single-line layout.
		expect(html).toContain(
			"flex min-w-0 basis-full order-last flex-wrap items-center gap-1 sm:order-none sm:flex-1",
		);
	});

	it("renders the observed-age text per family", () => {
		const html = renderToStaticMarkup(
			<ObservedRoutingTable
				observations={{
					fable: mkObservation("fable", ["acc-a"], NOW - 5000),
				}}
				now={NOW}
			/>,
		);
		expect(html).toContain("observed 5s ago");
	});
});

describe("formatShortDuration", () => {
	it("formats sub-minute durations as seconds", () => {
		expect(formatShortDuration(12_000)).toBe("12s");
	});

	it("formats 0ms as 0s", () => {
		expect(formatShortDuration(0)).toBe("0s");
	});

	it("rounds sub-minute durations to the nearest second", () => {
		expect(formatShortDuration(12_400)).toBe("12s");
		expect(formatShortDuration(12_600)).toBe("13s");
	});

	it("stays in the minutes-only branch once rounded to >= 1 minute", () => {
		// 3 minutes exactly.
		expect(formatShortDuration(180_000)).toBe("3m");
	});

	it("formats hours + minutes for durations >= 1 hour", () => {
		// 2h 5m.
		expect(formatShortDuration(2 * 60 * 60 * 1000 + 5 * 60 * 1000)).toBe(
			"2h 5m",
		);
	});

	it("preserves pre-existing minute-rounding behavior at the 30s boundary", () => {
		// 30000ms rounds to 1 minute under Math.round(ms / 60000) -- must stay
		// "1m", not fall into the new seconds branch.
		expect(formatShortDuration(30_000)).toBe("1m");
	});

	it("takes the seconds branch just below the 30s boundary", () => {
		expect(formatShortDuration(29_999)).toBe("30s");
	});
});
