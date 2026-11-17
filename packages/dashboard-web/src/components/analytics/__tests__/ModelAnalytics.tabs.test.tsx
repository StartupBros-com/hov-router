import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelAnalytics } from "../ModelAnalytics";

function triggers(): string[] {
	const html = renderToStaticMarkup(
		<ModelAnalytics modelPerformance={[]} costByModel={[]} timeRange="24h" />,
	);
	return [
		...html.matchAll(/<button\b[^>]*role="tab"[^>]*>(.*?)<\/button>/g),
	].map(([, inner]) => inner);
}

describe("ModelAnalytics tab labels", () => {
	it("offers a short label for narrow screens and the full label from sm up", () => {
		const [compare, details] = triggers();
		expect(compare).toMatch(/<span class="sm:hidden">Compare<\/span>/);
		expect(compare).toMatch(
			/<span class="hidden sm:inline">Multi-Metric Comparison<\/span>/,
		);
		expect(details).toMatch(/<span class="sm:hidden">Details<\/span>/);
		expect(details).toMatch(
			/<span class="hidden sm:inline">Detailed Analysis<\/span>/,
		);
	});

	it("hides the tab icons below sm", () => {
		for (const inner of triggers()) {
			expect(inner).toMatch(/<svg[^>]*class="[^"]*\bhidden\b[^"]*\bsm:block\b/);
		}
	});
});
