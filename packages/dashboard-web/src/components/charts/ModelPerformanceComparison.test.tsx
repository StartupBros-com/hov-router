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
type TooltipProps = {
	content?: (props: {
		active: boolean;
		payload: { payload: unknown }[];
	}) => ReactNode;
};
const tooltips: TooltipProps[] = [];
const pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
const none = () => null;
mock.module("recharts", () => ({
	Area: none,
	AreaChart: pass,
	Bar: none,
	CartesianGrid: none,
	ComposedChart: pass,
	Legend: none,
	Line: none,
	ResponsiveContainer: pass,
	Scatter: none,
	Tooltip: (props: TooltipProps) => {
		tooltips.push(props);
		return null;
	},
	useChartWidth: () => undefined,
	useOffset: () => undefined,
	XAxis: none,
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
	tooltips.length = 0;
});

describe("ModelPerformanceComparison axes", () => {
	for (const [viewMode, titles] of [
		["speed-cost", ["Tokens/Second", "Cost per 1K Tokens ($)"]],
		["performance", ["Response Time (ms)", "Error Rate (%)"]],
		["efficiency", ["Efficiency Score"]],
	] as const)
		it(`sizes every titled y-axis to its ticks in the ${viewMode} view`, () => {
			renderToStaticMarkup(
				<ModelPerformanceComparison data={data} viewMode={viewMode} />,
			);
			expect(axes.map((axis) => axis.label?.value)).toEqual([...titles]);
			// A fixed 60 px axis put "Cost per 1K Tokens ($)" over 0.0004…0.0016
			// and "Efficiency Score" over 20000…60000.
			for (const axis of axes) expect(axis.width).toBe("auto");
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
