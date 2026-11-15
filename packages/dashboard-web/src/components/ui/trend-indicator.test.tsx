import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TrendIndicator } from "./trend-indicator";

const BETTER = "text-success";
const WORSE = "text-(--danger)";

function render(change: number, quality: "better" | "worse") {
	return renderToStaticMarkup(
		<TrendIndicator change={change} quality={quality} />,
	);
}

describe("TrendIndicator", () => {
	it("points up for a rise and colours it by quality", () => {
		const better = render(20, "better");
		expect(better).toContain("lucide-trending-up");
		expect(better).toContain(BETTER);
		expect(better).not.toContain(WORSE);

		// Response time rising 20% is worse: the arrow still points up.
		const worse = render(20, "worse");
		expect(worse).toContain("lucide-trending-up");
		expect(worse).not.toContain("lucide-trending-down");
		expect(worse).toContain(WORSE);
		expect(worse).not.toContain(BETTER);
		expect(worse).toContain(">20%<");
	});

	it("points down for a fall and colours it by quality", () => {
		// Cost falling 15% is better: the arrow still points down.
		const better = render(-15, "better");
		expect(better).toContain("lucide-trending-down");
		expect(better).not.toContain("lucide-trending-up");
		expect(better).toContain(BETTER);
		expect(better).toContain(">15%<");

		const worse = render(-15, "worse");
		expect(worse).toContain("lucide-trending-down");
		expect(worse).toContain(WORSE);
	});

	it("tells screen readers the direction and whether it is better", () => {
		const html = render(-15, "worse");
		expect(html).toContain('<span class="sr-only">Down </span>');
		expect(html).toContain('<span class="sr-only">, worse</span>');
		expect(html).toContain('aria-hidden="true"');
		expect(render(20, "better")).toContain('<span class="sr-only">Up </span>');
	});

	it("shows no arrow and no colour for a change that displays as 0%", () => {
		for (const change of [0, 0.4, -0.4, -0]) {
			for (const quality of ["better", "worse"] as const) {
				const html = render(change, quality);
				expect(html).toContain(">0%<");
				expect(html).not.toContain("lucide-trending");
				expect(html).not.toContain(BETTER);
				expect(html).not.toContain(WORSE);
				expect(html).toContain('<span class="sr-only">No change, </span>');
			}
		}
	});

	it("shows an arrow from the first change that displays as 1%", () => {
		expect(render(0.5, "better")).toContain("lucide-trending-up");
		expect(render(0.5, "better")).toContain(">1%<");
		expect(render(-0.5, "worse")).toContain("lucide-trending-down");
	});
});
