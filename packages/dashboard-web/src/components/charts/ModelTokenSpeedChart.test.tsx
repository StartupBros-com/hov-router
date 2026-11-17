import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// recharts draws nothing in a server render, so record the props the chart
// hands it. The browser check measures the rendered plot and labels; this
// pins the props that produce them.
type XAxisProps = {
	angle?: number;
	textAnchor?: string;
	height?: number;
	tickFormatter?: (value: string) => string;
};
type YAxisProps = { label?: { value?: string } };
type BarChartProps = { margin?: { left?: number; right?: number } };
type ContainerProps = { height?: number | string; children?: ReactNode };
const xAxes: XAxisProps[] = [];
const yAxes: YAxisProps[] = [];
const barCharts: BarChartProps[] = [];
const containers: ContainerProps[] = [];
const pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
const none = () => null;
mock.module("recharts", () => ({
	Bar: pass,
	BarChart: (props: BarChartProps & { children?: ReactNode }) => {
		barCharts.push(props);
		return <>{props.children}</>;
	},
	CartesianGrid: none,
	Cell: none,
	ErrorBar: none,
	ResponsiveContainer: (props: ContainerProps) => {
		containers.push(props);
		return <>{props.children}</>;
	},
	Tooltip: none,
	useChartWidth: () => undefined,
	useOffset: () => undefined,
	XAxis: (props: XAxisProps) => {
		xAxes.push(props);
		return null;
	},
	YAxis: (props: YAxisProps) => {
		yAxes.push(props);
		return null;
	},
}));

const { ModelTokenSpeedChart } = await import("./ModelTokenSpeedChart");

const data = [
	{
		model: "synthetic-haiku-model",
		avgTokensPerSecond: 91,
		minTokensPerSecond: 40,
		maxTokensPerSecond: 140,
	},
	{
		model: "synthetic-opus-model",
		avgTokensPerSecond: 38,
		minTokensPerSecond: 20,
		maxTokensPerSecond: 60,
	},
];

beforeEach(() => {
	xAxes.length = 0;
	yAxes.length = 0;
	barCharts.length = 0;
	containers.length = 0;
});

// The chart reads the viewport through matchMedia, which a server render
// lacks; stub it for the width each test describes.
const g = globalThis as unknown as { window?: unknown };
function renderAtWidth(wide: boolean, node: ReactNode): string {
	const original = g.window;
	g.window = { matchMedia: () => ({ matches: wide }) };
	try {
		return renderToStaticMarkup(node);
	} finally {
		g.window = original;
	}
}

describe("ModelTokenSpeedChart on a phone", () => {
	it("gives the plot the width the margins and axis title took", () => {
		renderAtWidth(false, <ModelTokenSpeedChart data={data} height={300} />);
		// A 60 px left margin and the rotated "Tokens/Second" title left the
		// plot 88 px of a 238 px chart at 320 px.
		expect(barCharts[0]?.margin?.left).toBe(0);
		expect(barCharts[0]?.margin?.right).toBe(8);
		expect(yAxes).toHaveLength(1);
		expect(yAxes[0]?.label).toBeUndefined();
	});

	it("stands the model names upright and grows the chart to hold them", () => {
		renderAtWidth(false, <ModelTokenSpeedChart data={data} height={300} />);
		// Without the left margin, a name at -45 degrees reaches past the
		// chart's left edge. Upright, it hangs straight down from its bar.
		expect(xAxes).toHaveLength(1);
		expect(xAxes[0]?.angle).toBe(-90);
		expect(xAxes[0]?.textAnchor).toBe("end");
		expect(xAxes[0]?.height).toBe(112);
		expect(xAxes[0]?.tickFormatter?.("qwen3-coder-480b-a35b-instruct")).toBe(
			"qwen3-coder-480b-a35b-ins…",
		);
		// The axis is 32 px deeper than the desktop one; the chart grows by as
		// much so the plot keeps its height.
		expect(containers[0]?.height).toBe(332);
	});

	it("keeps the loading skeleton at the height it was given", () => {
		const html = renderAtWidth(
			false,
			<ModelTokenSpeedChart loading data={[]} height={300} />,
		);
		expect(html).toContain("height:300px");
	});
});

describe("ModelTokenSpeedChart from sm up", () => {
	it("keeps the desktop margins, axis title and -45 degree names", () => {
		renderAtWidth(true, <ModelTokenSpeedChart data={data} height={300} />);
		expect(barCharts[0]?.margin?.left).toBe(60);
		expect(yAxes[0]?.label?.value).toBe("Tokens/Second");
		expect(xAxes[0]?.angle).toBe(-45);
		expect(xAxes[0]?.height).toBe(80);
		expect(xAxes[0]?.tickFormatter).toBeUndefined();
		expect(containers[0]?.height).toBe(300);
	});
});
