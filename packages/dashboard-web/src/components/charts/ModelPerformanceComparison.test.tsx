import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// recharts draws nothing in a server render (ResponsiveContainer has no size),
// so record the props each y-axis receives. The browser check measures the
// rendered axes; this pins the prop that makes recharts size them.
type AxisProps = {
	yAxisId?: string;
	width?: unknown;
	label?: { value?: string };
};
const axes: AxisProps[] = [];
type XAxisProps = {
	angle?: number;
	textAnchor?: string;
	height?: number;
	tickFormatter?: (value: string) => string;
};
const xAxes: XAxisProps[] = [];
type TooltipProps = {
	content?: (props: {
		active: boolean;
		payload: { payload: unknown }[];
	}) => ReactNode;
};
const tooltips: TooltipProps[] = [];
type LegendProps = { wrapperStyle?: { paddingBottom?: string } };
const legends: LegendProps[] = [];
const pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
const none = () => null;
mock.module("recharts", () => ({
	Area: none,
	AreaChart: pass,
	Bar: none,
	CartesianGrid: none,
	ComposedChart: pass,
	Legend: (props: LegendProps) => {
		legends.push(props);
		return null;
	},
	Line: none,
	ResponsiveContainer: pass,
	Scatter: none,
	Tooltip: (props: TooltipProps) => {
		tooltips.push(props);
		return null;
	},
	useChartWidth: () => undefined,
	useOffset: () => undefined,
	XAxis: (props: XAxisProps) => {
		xAxes.push(props);
		return null;
	},
	YAxis: (props: AxisProps) => {
		axes.push(props);
		return null;
	},
}));

const { ModelPerformanceComparison } = await import(
	"./ModelPerformanceComparison"
);

const data = [
	{
		model: "synthetic-opus-model",
		avgTokensPerSecond: 42,
		costPer1kTokens: 0.0016,
		avgResponseTime: 5400,
		errorRate: 1.5,
		totalRequests: 900,
	},
	{
		model: "synthetic-haiku-model",
		avgTokensPerSecond: 120,
		costPer1kTokens: 0.0004,
		avgResponseTime: 1200,
		errorRate: 0,
		totalRequests: 400,
	},
];

beforeEach(() => {
	axes.length = 0;
	xAxes.length = 0;
	tooltips.length = 0;
	legends.length = 0;
});

// The chart reads the viewport through matchMedia, which a server render
// lacks; stub it for the width each test describes.
const g = globalThis as unknown as { window?: unknown };
function renderAtWidth(wide: boolean, node: ReactNode): void {
	const original = g.window;
	g.window = { matchMedia: () => ({ matches: wide }) };
	try {
		renderToStaticMarkup(node);
	} finally {
		g.window = original;
	}
}

describe("ModelPerformanceComparison axes", () => {
	for (const [viewMode, titles] of [
		["speed-cost", ["Tokens/Second", "Cost per 1K Tokens ($)"]],
		["performance", ["Response Time (ms)", "Error Rate (%)"]],
		["efficiency", ["Efficiency Score"]],
	] as const)
		it(`sizes every titled y-axis to its ticks in the ${viewMode} view`, () => {
			renderAtWidth(
				true,
				<ModelPerformanceComparison data={data} viewMode={viewMode} />,
			);
			expect(axes.map((axis) => axis.label?.value)).toEqual([...titles]);
			// A fixed 60 px axis put "Cost per 1K Tokens ($)" over 0.0004…0.0016
			// and "Efficiency Score" over 20000…60000.
			for (const axis of axes) expect(axis.width).toBe("auto");
		});

	for (const viewMode of ["speed-cost", "performance"] as const)
		it(`drops the rotated axis titles on a phone in the ${viewMode} view`, () => {
			renderAtWidth(
				false,
				<ModelPerformanceComparison data={data} viewMode={viewMode} />,
			);
			// The titles and margins left the plot about 50 px wide at 320-360 px.
			expect(axes).toHaveLength(2);
			expect(axes.map((axis) => axis.label)).toEqual([undefined, undefined]);
			for (const axis of axes) expect(axis.width).toBe("auto");
		});
});

describe("ModelPerformanceComparison legend", () => {
	for (const viewMode of ["speed-cost", "performance"] as const)
		it(`leaves a gap under the legend in the ${viewMode} view`, () => {
			renderAtWidth(
				false,
				<ModelPerformanceComparison data={data} viewMode={viewMode} />,
			);
			// recharts sizes the legend from its box and starts the plot right
			// under it. The top tick label is centred on the plot's top edge, so
			// without the padding its upper half ran 4 px into a one-row legend
			// at 360 px.
			expect(legends).toHaveLength(1);
			expect(legends[0]?.wrapperStyle?.paddingBottom).toBe("10px");
		});
});

describe("ModelPerformanceComparison model labels", () => {
	for (const viewMode of ["speed-cost", "performance"] as const) {
		it(`stands the model names upright on a phone in the ${viewMode} view`, () => {
			renderAtWidth(
				false,
				<ModelPerformanceComparison data={data} viewMode={viewMode} />,
			);
			// At -45 degrees the first name hung up to 41 px left of a 238 px
			// chart; upright, each name hangs straight down from its bar.
			expect(xAxes).toHaveLength(1);
			expect(xAxes[0]?.angle).toBe(-90);
			expect(xAxes[0]?.textAnchor).toBe("end");
			// Upright, a name's length is its depth below the plot: the axis
			// holds about 184 px, and 26 characters of 12 px text measure up to
			// about 180 px. Every catalogue id fits whole; longer names are cut
			// at the end, and the tooltip carries them in full.
			expect(xAxes[0]?.height).toBe(112);
			const format = xAxes[0]?.tickFormatter;
			expect(format?.("claude-sonnet-4-5-20250929")).toBe(
				"claude-sonnet-4-5-20250929",
			);
			expect(format?.("qwen3-coder-480b-a35b-instruct")).toBe(
				"qwen3-coder-480b-a35b-ins…",
			);
		});

		it(`keeps the model names at -45 degrees from sm up in the ${viewMode} view`, () => {
			renderAtWidth(
				true,
				<ModelPerformanceComparison data={data} viewMode={viewMode} />,
			);
			expect(xAxes).toHaveLength(1);
			expect(xAxes[0]?.angle).toBe(-45);
			expect(xAxes[0]?.textAnchor).toBe("end");
			expect(xAxes[0]?.height).toBe(80);
			expect(xAxes[0]?.tickFormatter).toBeUndefined();
		});
	}

	it("leaves the efficiency view's labels at -45 degrees on a phone", () => {
		renderAtWidth(
			false,
			<ModelPerformanceComparison data={data} viewMode="efficiency" />,
		);
		expect(xAxes).toHaveLength(1);
		expect(xAxes[0]?.angle).toBe(-45);
	});
});

describe("ModelPerformanceComparison efficiency tooltip", () => {
	it("draws its custom content on the popover background", () => {
		renderToStaticMarkup(
			<ModelPerformanceComparison data={data} viewMode="efficiency" />,
		);
		const content = tooltips[0]?.content;
		expect(content).toBeFunction();
		const html = renderToStaticMarkup(
			content?.({ active: true, payload: [{ payload: data[1] }] }),
		);
		expect(html).toContain("synthetic-haiku-model");
		// recharts ignores contentStyle when a tooltip has custom content, so
		// the content itself must carry the background, or its text sits on
		// the chart.
		expect(html).toContain("background-color:var(--popover)");
		expect(html).toContain("border:1px solid var(--border)");
		expect(html).toContain("color:var(--popover-foreground)");
	});
});
