import { describe, expect, it } from "bun:test";
import { Activity } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricCard } from "./MetricCard";

function render(props: Partial<Parameters<typeof MetricCard>[0]>) {
	return renderToStaticMarkup(
		<MetricCard
			title="Avg Response Time"
			value="1.2s"
			icon={Activity}
			{...props}
		/>,
	);
}

describe("MetricCard trend", () => {
	it("points up for a rise that Overview rates worse", () => {
		// OverviewTab passes trend "down" for a rising response time (inverted).
		const html = render({ change: 20, trend: "down" });
		expect(html).toContain("lucide-trending-up");
		expect(html).not.toContain("lucide-trending-down");
		expect(html).toContain("text-(--danger)");
		expect(html).not.toContain("text-red-600");
		expect(html).toContain(">20%<");
	});

	it("points down for a fall that Overview rates better", () => {
		const html = render({ change: -15, trend: "up" });
		expect(html).toContain("lucide-trending-down");
		expect(html).toContain("text-success");
	});

	it("shows no trend when flat or without a change", () => {
		for (const html of [
			render({ change: 5, trend: "flat" }),
			render({ trend: "up" }),
		]) {
			expect(html).not.toContain("lucide-trending");
			expect(html).not.toContain("%<");
		}
	});

	it("keeps the comparison popover", () => {
		const html = render({
			change: 20,
			trend: "up",
			trendPeriod: "previous hour",
		});
		expect(html).toContain("Compared to previous hour");
		expect(html).toContain("cursor-help");
	});

	it("draws the value in tabular figures", () => {
		expect(render({})).toContain(
			'<p class="text-2xl font-bold tabular-nums">1.2s</p>',
		);
	});
});
