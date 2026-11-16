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
	Tooltip: none,
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
