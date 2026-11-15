import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PoolUsageResult } from "../../../lib/pool-usage";
import { PoolCapacitySection } from "../PoolCapacitySection";
import { PoolUsageRow } from "../PoolUsageRow";
import { atRiskBadge } from "../pool-usage-shared";

const NOW = 1_700_000_000_000;
const H = 3_600_000;

const COLOURED = [
	"text-success",
	"text-warning",
	"text-red-",
	"text-(--danger)",
	"bg-success-solid",
	"bg-warning-solid",
];

function NoopIcon() {
	return null;
}

function result(overrides: Partial<PoolUsageResult>): PoolUsageResult {
	return {
		average: null,
		activeAverage: null,
		worst: null,
		contributing: [],
		exhausted: [],
		excluded: [],
		fallback: [],
		earliestResetMs: null,
		earliestResetAccountName: null,
		atRisk: [],
		...overrides,
	};
}

function row(
	value: PoolUsageResult,
	extra: { isExpanded?: boolean; primaryAccountName?: string } = {},
) {
	return renderToStaticMarkup(
		<PoolUsageRow
			id="five_hour"
			title="5h Pool"
			icon={NoopIcon}
			result={value}
			window="five_hour"
			isExpanded={extra.isExpanded ?? false}
			onToggle={() => {}}
			primaryAccountName={extra.primaryAccountName}
			now={NOW}
		/>,
	);
}

/** Class lists of the per-account tile fills, in segment order. */
function tileFills(html: string): string[][] {
	return html
		.split('class="')
		.slice(1)
		.map((rest) => rest.slice(0, rest.indexOf('"')).split(" "))
		.filter((classes) => classes.includes("rounded-b"));
}

describe("PoolUsageRow headline", () => {
	for (const average of [30, 70, 95]) {
		it(`stays neutral at ${average}%`, () => {
			const html = row(
				result({
					average,
					contributing: [{ name: "a", pct: average, resetMs: null }],
				}),
			);
			for (const colour of COLOURED) expect(html).not.toContain(colour);
			expect(html).toContain(
				`<span class="text-2xl font-bold tabular-nums">${average}%</span>`,
			);
			expect(html).toContain('role="progressbar"');
			expect(html).toContain('aria-label="5h Pool average used"');
			expect(html).toContain(`aria-valuenow="${average}"`);
			expect(html).toContain("bg-muted-foreground/25");
			expect(html).toContain("bg-foreground");
		});
	}
});

describe("PoolUsageRow tiles", () => {
	it("fills an active tile neutral, even at 100%", () => {
		const html = row(
			result({
				average: 100,
				contributing: [{ name: "codex-credits", pct: 100, resetMs: null }],
			}),
			{ isExpanded: true },
		);
		const [fill] = tileFills(html);
		expect(fill).toContain("bg-foreground");
		expect(fill).not.toContain("bg-destructive");
	});

	it("fills only an exhausted tile red", () => {
		const html = row(
			result({
				average: 100,
				exhausted: [
					{ name: "spent", reason: "five_hour_exhausted", resetMs: null },
				],
			}),
			{ isExpanded: true },
		);
		const [fill] = tileFills(html);
		expect(fill).toContain("bg-destructive");
		expect(fill).not.toContain("bg-foreground");
	});

	it("draws tiles on the Accounts track and leaves unknown tiles empty", () => {
		const html = row(
			result({
				average: 30,
				contributing: [{ name: "a", pct: 30, resetMs: null }],
				excluded: [{ name: "b", reason: "no_usage_data", resetMs: null }],
			}),
			{ isExpanded: true },
		);
		for (const colour of COLOURED) expect(html).not.toContain(colour);
		expect(tileFills(html)).toHaveLength(1);
		expect(html).toContain(
			"relative h-12 w-full overflow-hidden rounded bg-muted-foreground/25",
		);
		expect(html).toContain("border-dashed");
	});

	it("marks the next account with the primary text token", () => {
		const html = row(
			result({
				average: 30,
				contributing: [{ name: "a", pct: 30, resetMs: null }],
			}),
			{ isExpanded: true, primaryAccountName: "a" },
		);
		expect(html).toContain(">next</span>");
		expect(html).toContain("text-(--primary-text)");
		expect(html).not.toContain("text-orange-");
	});
});

describe("will-run-out label", () => {
	it("is red while every account will run out, amber otherwise, hidden at 0", () => {
		expect(atRiskBadge(2, 2)).toEqual({
			label: "2 of 2 will run out",
			colorClass: "text-(--danger)",
		});
		expect(atRiskBadge(1, 3)).toEqual({
			label: "1 of 3 will run out",
			colorClass: "text-warning",
		});
		expect(atRiskBadge(0, 3)).toEqual({ label: null, colorClass: null });
	});

	it("renders beside the bar with its colour", () => {
		const html = row(
			result({
				average: 80,
				contributing: [{ name: "a", pct: 80, resetMs: NOW + 4 * H }],
				atRisk: [
					{
						name: "a",
						pct: 80,
						resetMs: NOW + 4 * H,
						exhaustsAtMs: NOW + H,
						timeToExhaustMs: H,
						remainingMs: 4 * H,
					},
				],
			}),
		);
		expect(html).toContain(
			'<span class="text-xs truncate text-(--danger)">1 of 1 will run out</span>',
		);
	});
});

describe("Pool capacity load error", () => {
	it("shows the shared error state in place of the rows", () => {
		let retried = 0;
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				pools={[
					{
						id: "five_hour",
						title: "5h Pool",
						icon: NoopIcon,
						result: result({}),
						window: "five_hour",
					},
				]}
				now={NOW}
				loadError={{
					message: "Network error. Please check your connection and try again.",
					onRetry: () => {
						retried++;
					},
				}}
			/>,
		);
		expect(html).toContain("Pool capacity");
		expect(html).toContain('role="alert"');
		expect(html).toContain(
			"Pool capacity could not load. Network error. Please check your connection and try again.",
		);
		expect(html).toContain(">Retry</button>");
		expect(html).not.toContain("5h Pool");
		expect(html).not.toContain("Expand all");
		expect(retried).toBe(0);
	});
});
