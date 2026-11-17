import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The charts draw nothing in a server render, so record the props the
// Account Performance bar chart receives. The browser check measures the
// rendered labels; this pins the props that produce them.
type BarChartProps = {
	xAxisKey?: string;
	xAxisInterval?: number;
	xAxisAngle?: number;
	xAxisTextAnchor?: string;
	xAxisHeight?: number;
	xAxisTickFormatter?: (value: string) => string;
	height?: string | number;
};
const barCharts: BarChartProps[] = [];
const none = () => null;
mock.module("../../charts", () => ({
	BaseAreaChart: none,
	BaseBarChart: (props: BarChartProps) => {
		barCharts.push(props);
		return null;
	},
	BaseLineChart: none,
	BasePieChart: none,
}));

const { ChartsSection } = await import("../ChartsSection");

const accountHealthData = [
	"synthetic-account-a",
	"synthetic-account-b",
	"synthetic-account-c",
].map((name) => ({
	name,
	requests: 10,
	successRate: 100,
	planCostUsd: 0,
	apiCostUsd: 0,
	totalCostUsd: 0,
}));

// ChartsSection reads the viewport through matchMedia, which a server render
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

function renderSection(wide: boolean): BarChartProps {
	renderAtWidth(
		wide,
		<ChartsSection
			timeSeriesData={[]}
			modelData={[]}
			accountHealthData={accountHealthData}
			accountModelUsageData={[]}
			apiKeyPerformanceData={[]}
			loading={false}
		/>,
	);
	const accountChart = barCharts.find((props) => props.xAxisKey === "name");
	if (!accountChart) throw new Error("Account Performance chart not rendered");
	return accountChart;
}

beforeEach(() => {
	barCharts.length = 0;
});

describe("ChartsSection Account Performance axis", () => {
	it("angles and shortens every account name on a phone", () => {
		const props = renderSection(false);
		expect(props.xAxisInterval).toBe(0);
		expect(props.xAxisAngle).toBe(-45);
		expect(props.xAxisTextAnchor).toBe("end");
		// A 12-character name in the axis's 16 px text reaches 98 px below the
		// axis line in lower case and 119 px in capitals; a 72 px axis put the
		// names on the legend.
		expect(props.xAxisHeight).toBe(120);
		expect(props.height).toBe("medium");
		expect(props.xAxisTickFormatter?.("synthetic-account-a")).toBe(
			"synth…ount-a",
		);
	});

	it("keeps the desktop axis at BaseBarChart's defaults", () => {
		const props = renderSection(true);
		expect(props.xAxisInterval).toBeUndefined();
		expect(props.xAxisAngle).toBe(0);
		expect(props.xAxisTextAnchor).toBe("middle");
		expect(props.xAxisHeight).toBe(30);
		expect(props.xAxisTickFormatter).toBeUndefined();
		expect(props.height).toBe("small");
	});
});
