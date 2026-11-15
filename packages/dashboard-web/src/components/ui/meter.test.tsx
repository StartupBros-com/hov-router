import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { METER_TONE_CLASS, Meter } from "./meter";
import { Progress } from "./progress";

/** The root's and the indicator's class lists, in document order. */
function classLists(html: string): string[][] {
	return html
		.split('class="')
		.slice(1)
		.map((rest) => rest.slice(0, rest.indexOf('"')).split(" "));
}

describe("Meter", () => {
	for (const [tone, fill] of [
		["strong", "bg-foreground"],
		["weak", "bg-muted-foreground"],
		["exhausted", "bg-destructive"],
	] as const) {
		it(`fills a ${tone} meter with ${fill}, last so it wins`, () => {
			const html = renderToStaticMarkup(
				<Meter value={40} tone={tone} aria-label="5h used" />,
			);
			const [, indicator] = classLists(html);
			expect(indicator.at(-1)).toBe(fill);
			expect(indicator).not.toContain("bg-primary");
			expect(METER_TONE_CLASS[tone]).toBe(fill);
		});
	}

	it("defaults to the strong tone", () => {
		const [, indicator] = classLists(
			renderToStaticMarkup(<Meter value={40} aria-label="5h used" />),
		);
		expect(indicator.at(-1)).toBe("bg-foreground");
	});

	it("draws the Accounts track and keeps it over a caller's background", () => {
		const [root] = classLists(
			renderToStaticMarkup(
				<Meter value={40} aria-label="5h used" className="h-3.5 bg-muted" />,
			),
		);
		expect(root.at(-1)).toBe("bg-muted-foreground/25");
		expect(root).not.toContain("bg-secondary");
		expect(root).not.toContain("bg-muted");
		expect(root).toContain("h-3.5");
	});

	it("is a named progressbar", () => {
		const html = renderToStaticMarkup(
			<Meter value={40} aria-label="5h pool used" />,
		);
		expect(html).toContain('role="progressbar"');
		expect(html).toContain('aria-label="5h pool used"');
		expect(html).toContain('aria-valuenow="40"');
	});

	it("clamps above 100 and draws nothing for an unknown value", () => {
		expect(
			renderToStaticMarkup(<Meter value={150} aria-label="7d used" />),
		).toContain('aria-valuenow="100"');
		const unknown = renderToStaticMarkup(
			<Meter value={null} aria-label="7d used" />,
		);
		expect(unknown).not.toContain("aria-valuenow");
		expect(unknown).toContain("translateX(-100%)");
	});

	it("renders exactly the markup Accounts' quota bar renders today", () => {
		// RateLimitProgress.tsx draws its bar with these props; the Accounts view
		// is signed off, so adopting Meter there must not change a byte.
		for (const [tone, fill] of [
			["strong", "bg-foreground"],
			["weak", "bg-muted-foreground"],
			["exhausted", "bg-destructive"],
		] as const) {
			const today = renderToStaticMarkup(
				<Progress
					value={62}
					aria-label="5-hour used"
					className="h-1.5 min-w-0 bg-muted-foreground/25"
					indicatorClassName={fill}
				/>,
			);
			const meter = renderToStaticMarkup(
				<Meter
					value={62}
					tone={tone}
					aria-label="5-hour used"
					className="h-1.5 min-w-0"
				/>,
			);
			expect(meter).toBe(today);
		}
	});
});
