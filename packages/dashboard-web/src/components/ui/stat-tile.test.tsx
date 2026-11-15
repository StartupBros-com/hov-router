import { describe, expect, it } from "bun:test";
import { Zap } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatTile } from "./stat-tile";

const TONES = [
	"text-success",
	"text-warning",
	"text-destructive",
	"text-(--danger)",
];

describe("StatTile", () => {
	it("shows the label, a tabular value and the hint", () => {
		const html = renderToStaticMarkup(
			<StatTile
				label="Peak Speed"
				value="182 tok/s"
				hint="Maximum observed in the selected time range"
			/>,
		);
		expect(html).toContain(
			'<p class="text-sm text-muted-foreground">Peak Speed</p>',
		);
		expect(html).toContain(
			'<p class="text-2xl font-bold tabular-nums">182 tok/s</p>',
		);
		expect(html).toContain(
			'<p class="text-xs text-muted-foreground">Maximum observed in the selected time range</p>',
		);
	});

	it("adds no tone of its own", () => {
		const html = renderToStaticMarkup(
			<StatTile
				label="Weekly burn rate"
				value="+2.0%/hr"
				icon={Zap}
				hint="hint"
				rows={[
					{ label: "Exhaustion vs reset", value: "not exhausting" },
					{ label: "Weekly pace", value: "On pace", tooltip: "why" },
				]}
			/>,
		);
		for (const tone of TONES) expect(html).not.toContain(tone);
	});

	it("passes a caller's value and row tones through", () => {
		const html = renderToStaticMarkup(
			<StatTile
				label="Cache Savings"
				value="-$1.20"
				valueClassName="text-destructive"
				rows={[
					{
						label: "Weekly pace",
						value: "Over pace",
						valueClassName: "text-warning",
					},
				]}
			/>,
		);
		expect(html).toContain(
			'<p class="text-2xl font-bold tabular-nums text-destructive">-$1.20</p>',
		);
		expect(html).toContain(
			'<span class="font-medium tabular-nums text-right text-warning">Over pace</span>',
		);
	});

	it("draws the icon faint and hidden from screen readers", () => {
		const html = renderToStaticMarkup(
			<StatTile label="Output Speed" value="90 tok/s" icon={Zap} />,
		);
		expect(html).toContain("lucide-zap h-8 w-8 text-muted-foreground/20");
		expect(html).toContain('aria-hidden="true"');
	});

	it("leaves out the icon row when there is neither icon nor trend", () => {
		const html = renderToStaticMarkup(
			<StatTile label="Fastest Model" value="claude-haiku" />,
		);
		expect(html).not.toContain("mb-4");
		expect(html).not.toContain("lucide");
	});

	it("shows the trend and what it is compared to", () => {
		const html = renderToStaticMarkup(
			<StatTile
				label="Total Requests"
				value="1,204"
				icon={Zap}
				trend={{ change: 12, quality: "better", comparedTo: "previous hour" }}
			/>,
		);
		expect(html).toContain("lucide-trending-up");
		expect(html).toContain("text-success");
		expect(html).toContain(
			'<span class="sr-only">Compared to previous hour</span>',
		);
		expect(html).toContain('type="button"');
	});

	it("shows a trend with no comparison as plain text", () => {
		const html = renderToStaticMarkup(
			<StatTile
				label="Total Requests"
				value="1,204"
				trend={{ change: -3, quality: "worse" }}
			/>,
		);
		expect(html).toContain("lucide-trending-down");
		expect(html).not.toContain('type="button"');
	});

	it("lists each row with its label and value", () => {
		const html = renderToStaticMarkup(
			<StatTile
				label="Plan Value"
				value="$12.00"
				rows={[
					{ label: "Requests", value: 42 },
					{ label: "Cost", value: "$3.10", tooltip: "Billed at API rates" },
				]}
			/>,
		);
		expect(html).toContain("border-t border-border/50");
		expect(html).toContain(
			'<span class="text-muted-foreground shrink-0">Requests</span>',
		);
		expect(html).toContain(">42</span>");
		expect(html).toContain("$3.10");
		expect(html).toContain("cursor-help");
	});
});
