import { beforeEach, describe, expect, it, mock } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { CSSProperties } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// recharts draws nothing in a server render, so record what the helper hands
// its Tooltip. The browser check measures the hovered tooltips themselves.
type Seen = { wrapperStyle?: CSSProperties; contentStyle?: CSSProperties };
const seen: Seen[] = [];
const chart = { width: 320 as number | undefined, left: 140 };
mock.module("recharts", () => ({
	Tooltip: (props: Seen) => {
		seen.push(props);
		return null;
	},
	useChartWidth: () => chart.width,
	useOffset: () => ({ top: 5, bottom: 30, left: chart.left, right: 20 }),
}));

const { ChartTooltip, chartTooltipMaxWidth } = await import("./ChartTooltip");

beforeEach(() => {
	seen.length = 0;
	chart.width = 320;
	chart.left = 140;
});

describe("chartTooltipMaxWidth", () => {
	it("leaves the room between the plot's left edge and the chart's right edge", () => {
		expect(chartTooltipMaxWidth(320, 140)).toBe(180);
		expect(chartTooltipMaxWidth(1200, 60)).toBe(1140);
	});

	it("sets no cap before the chart has a width", () => {
		expect(chartTooltipMaxWidth(undefined, 140)).toBeUndefined();
		expect(chartTooltipMaxWidth(0, 140)).toBeUndefined();
	});

	it("caps at the whole chart when the plot offset is unknown", () => {
		expect(chartTooltipMaxWidth(320, undefined)).toBe(320);
	});
});

describe("ChartTooltip", () => {
	it("caps the tooltip's width and lets its text wrap", () => {
		renderToStaticMarkup(
			<ChartTooltip contentStyle={{ backgroundColor: "var(--popover)" }} />,
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.wrapperStyle?.maxWidth).toBe(180);
		expect(seen[0]?.wrapperStyle?.whiteSpace).toBe("normal");
		expect(seen[0]?.wrapperStyle?.overflowWrap).toBe("anywhere");
		expect(seen[0]?.contentStyle).toEqual({
			backgroundColor: "var(--popover)",
			whiteSpace: "normal",
			overflowWrap: "anywhere",
		});
	});

	it("keeps the caller's wrapper style alongside the cap", () => {
		renderToStaticMarkup(<ChartTooltip wrapperStyle={{ zIndex: 5 }} />);
		expect(seen[0]?.wrapperStyle).toMatchObject({ zIndex: 5, maxWidth: 180 });
	});

	it("adds no cap while the chart has no width", () => {
		chart.width = undefined;
		renderToStaticMarkup(<ChartTooltip />);
		expect(seen[0]?.wrapperStyle?.maxWidth).toBeUndefined();
	});
});

describe("chart tooltips", () => {
	it("all go through ChartTooltip", () => {
		const root = join(import.meta.dir, "..", "..");
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(path);
					continue;
				}
				if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts"))
					continue;
				if (entry.name.includes(".test.")) continue;
				if (path === join(import.meta.dir, "ChartTooltip.tsx")) continue;
				const source = readFileSync(path, "utf8");
				const at = source.indexOf('from "recharts"');
				if (at === -1) continue;
				const names = source.slice(source.lastIndexOf("{", at), at);
				if (/\bTooltip\b/.test(names)) offenders.push(relative(root, path));
			}
		};
		walk(root);
		expect(offenders).toEqual([]);
	});
});
