import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RoutingObservation } from "../../../api";
import type { PoolGroup } from "../../../lib/pool-forecast";
import type { PoolUsageResult } from "../../../lib/pool-usage";
import { PoolCapacitySection } from "../PoolCapacitySection";
import { AccountList, PoolRunway } from "../PoolRunway";

const NOW = 1_700_000_000_000;

// Empty result isolates the routing disclosure from the forecast.
const EMPTY_RESULT: PoolUsageResult = {
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
};

function mkObservation(
	family: string,
	names: string[],
	observedAtMs: number,
): RoutingObservation {
	return {
		family,
		order: names.map((name, i) => ({ id: `id-${i}`, name })),
		model: `claude-${family}`,
		observedAtMs,
	};
}

describe("PoolCapacitySection -- observed routing table", () => {
	const fablePool: PoolGroup = {
		provider: "anthropic",
		members: [],
		kind: "family",
		subtitle: "0 accounts",
		accounts: [],
		forecast: null,
		usedPct: null,
		hasPace: false,
		hasAnyReset: false,
		id: "scoped:Fable",
		title: "Fable pool",
		result: EMPTY_RESULT,
		window: "weekly_scoped" as const,
	};

	it("renders no routing disclosure when there are no observations", () => {
		for (const observations of [undefined, null, {}]) {
			const html = renderToStaticMarkup(
				<PoolCapacitySection
					groups={[fablePool]}
					hidden={[]}
					onUseReset={() => {}}
					now={NOW}
					observations={observations}
				/>,
			);
			expect(html).not.toContain("Observed routing order");
			expect(html).not.toContain("<details");
		}
	});

	it("renders every observed family, including one that also has its own pool row", () => {
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				groups={[fablePool]}
				hidden={[]}
				onUseReset={() => {}}
				now={NOW}
				observations={{
					fable: mkObservation("fable", ["acc-fable"], NOW - 1000),
					sonnet: mkObservation("sonnet", ["acc-b", "acc-a"], NOW - 65_000),
					opus: mkObservation("opus", ["acc-c"], NOW - 5000),
				}}
			/>,
		);
		// The summary names the disclosure once; the open table explains it.
		expect(html.match(/Observed routing order/g)).toHaveLength(1);
		expect(html).toContain("The last decision the proxy actually made");
		expect(html).toContain("<details");
		// fable has its own "Fable pool" row above AND still appears in the
		// observed-routing table -- the table is the single source, showing
		// every recorded family regardless of a pairing pool row.
		expect(html).toContain("acc-fable");
		expect(html).toContain("acc-c");
		expect(html).toContain("acc-b");
		expect(html).toContain("acc-a");
		expect(html).toContain("observed 5s ago");
		expect(html).toContain("observed 1m ago");
	});

	it("keeps the empty shared state and observations when no pools exist", () => {
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				groups={[]}
				hidden={[]}
				onUseReset={() => {}}
				now={NOW}
				observations={{ opus: mkObservation("opus", ["acc-c"], NOW - 5000) }}
			/>,
		);
		expect(html).toContain("No pool capacity yet.");
		expect(html).toContain("acc-c");
	});
});

describe("Pool capacity load error", () => {
	it("shows the shared error state in place of the rows", () => {
		let retried = 0;
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				groups={[]}
				hidden={[]}
				onUseReset={() => {}}
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

describe("runway card", () => {
	const group: PoolGroup = {
		id: "codex:weekly",
		provider: "codex",
		title: "Codex Pro weekly",
		subtitle: "3 accounts",
		kind: "weekly",
		window: "seven_day",
		result: EMPTY_RESULT,
		accounts: [
			{
				id: "a",
				name: "acct-a",
				pct: 100,
				resetMs: NOW + 3600000,
				state: "out",
				isPrimary: true,
				emptiesAtMs: null,
				leftAtResetPct: null,
			},
			{
				id: "b",
				name: "acct-b",
				pct: 100,
				resetMs: NOW + 7200000,
				state: "out",
				isPrimary: false,
				emptiesAtMs: null,
				leftAtResetPct: null,
			},
		],
		members: [
			{
				id: "a",
				name: "acct-a",
				bankedResets: {
					tracked: true,
					availableCount: 2,
					applicableCount: 0,
					stale: false,
				},
			},
			{
				id: "b",
				name: "acct-b",
				bankedResets: { tracked: true, availableCount: 1, stale: true },
			},
		] as PoolGroup["members"],
		forecast: null,
		usedPct: 100,
		hasPace: false,
		hasAnyReset: true,
	};
	it("shows one reset button per holding account, stale note, headline and neutral average", () => {
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				groups={[group]}
				hidden={[]}
				now={NOW}
				onUseReset={() => {}}
			/>,
		);
		expect(html).toContain("Out of quota now");
		expect(html).toContain("100% used across the pool");
		expect(html).toContain(
			'Use a banked reset on <span class="whitespace-nowrap">acct-a</span>',
		);
		expect(html).toContain(
			'Use a banked reset on <span class="whitespace-nowrap">acct-b</span>',
		);
		expect(html).toContain("2 held");
		expect(html).toContain("1 held");
		expect(html).toContain("Use reset needs a fresh count.");
		expect(html.match(/disabled=""/g)).toHaveLength(1);
		expect(html).toContain("Exact times");
		expect(html).not.toContain("Expand all");
		expect(html).not.toContain("will run out");
		expect(html).not.toContain("observed routing never mixes");
		expect(html).not.toContain(">next</span>");
	});
	it("offers each held reset once per card, in the first red pool", () => {
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				groups={[
					group,
					{ ...group, id: "codex:five_hour", title: "Codex Pro 5-hour" },
				]}
				hidden={[]}
				now={NOW}
				onUseReset={() => {}}
			/>,
		);
		expect(html.match(/Use a banked reset on/g)).toHaveLength(2);
	});
	it("keeps each account name on one line in the reset button", () => {
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				groups={[group]}
				hidden={[]}
				now={NOW}
				onUseReset={() => {}}
			/>,
		);
		expect(html).toContain('<span class="whitespace-nowrap">acct-a</span>');
	});
	it("does not offer resets outside Codex red states", () => {
		for (const g of [
			{ ...group, provider: "anthropic" },
			{
				...group,
				accounts: group.accounts.map((a) => ({
					...a,
					state: "active" as const,
					pct: 0,
				})),
			},
		]) {
			const html = renderToStaticMarkup(
				<PoolCapacitySection
					groups={[g]}
					hidden={[]}
					now={NOW}
					onUseReset={() => {}}
				/>,
			);
			expect(html).not.toContain("Use a banked reset on");
		}
	});
	it("exact times includes state, reset time, unused quota and only an active primary badge", () => {
		const g = {
			...group,
			accounts: [
				...group.accounts,
				{
					...group.accounts[0],
					id: "c",
					name: "acct-c",
					state: "active" as const,
					pct: 40,
					leftAtResetPct: 40,
				},
				{
					...group.accounts[0],
					id: "d",
					name: "acct-d",
					state: "unknown" as const,
					pct: null,
					resetMs: null,
				},
			],
		};
		const html = renderToStaticMarkup(
			<AccountList group={g} now={NOW} open onToggle={() => {}} />,
		);
		expect(html).toContain('aria-expanded="true"');
		expect(html).toContain("Hide exact times");
		expect(html).toContain(">Out</span>");
		expect(html).toContain("back in 1h");
		expect(html).toContain("40% used");
		expect(html).toContain("resets in 1h");
		expect(html).toContain("about 40% unused");
		expect(html).toContain("No data");
		expect(html).toContain("no reset time");
		expect(html.match(/>next<\/span>/g)).toHaveLength(1);
	});
	it("exact times names why a held account is not serving and keeps its own usage", () => {
		const held = (
			id: string,
			reason: "paused" | "rate_limited" | "five_hour_exhausted",
			backMs: number | null,
		) => ({
			...group.accounts[0],
			id,
			name: id,
			state: "held" as const,
			reason,
			pct: 40,
			resetMs: NOW + 50 * 3600000,
			backMs,
		});
		const g = {
			...group,
			accounts: [
				held("paused-acct", "paused", null),
				held("cooling-acct", "rate_limited", NOW + 5 * 60_000),
				held("five-out-acct", "five_hour_exhausted", NOW + 2 * 3600000),
			],
		};
		const html = renderToStaticMarkup(
			<AccountList group={g} now={NOW} open onToggle={() => {}} />,
		);
		expect(html).toContain(">paused</span>");
		expect(html).toContain(">cooling down</span>");
		expect(html).toContain(">out of 5-hour quota</span>");
		expect(html.match(/40% used/g)).toHaveLength(3);
		expect(html).toContain("back in 5m");
		expect(html).toContain("back in 2h");
		expect(html).toContain("resets in 2d 2h");
		// A held account is never "next", even when the server would pick it.
		expect(html).not.toContain(">next</span>");
		expect(html).not.toContain(">Out</span>");
	});
	it("with no forecast, speaks each account's state rather than claiming no data", () => {
		const g = {
			...group,
			forecast: null,
			accounts: [
				{
					...group.accounts[0],
					id: "p",
					name: "paused-acct",
					state: "held" as const,
					reason: "paused" as const,
					pct: 40,
					resetMs: NOW + 50 * 3600000,
					backMs: null,
				},
			],
		};
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				groups={[g]}
				hidden={[]}
				now={NOW}
				onUseReset={() => {}}
			/>,
		);
		expect(html).toContain("paused-acct: paused, 40% used, refills in 2d 2h");
		expect(html).not.toContain("no usage data");
	});
	it("names hidden pools even when every pool is hidden", () => {
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				groups={[]}
				hidden={[group]}
				now={NOW}
				onUseReset={() => {}}
			/>,
		);
		expect(html).toContain(
			"Not shown: Codex Pro weekly. No account in it reports when the limit resets.",
		);
	});
	it("lists three hidden pools as a comma list", () => {
		const html = renderToStaticMarkup(
			<PoolCapacitySection
				groups={[]}
				hidden={[
					group,
					{ ...group, id: "codex:five_hour", title: "Codex Pro 5-hour" },
					{ ...group, id: "zai:five_hour", title: "Z.ai 5-hour" },
				]}
				now={NOW}
				onUseReset={() => {}}
			/>,
		);
		expect(html).toContain(
			"Not shown: Codex Pro weekly, Codex Pro 5-hour, and Z.ai 5-hour. No account in them reports when the limit resets.",
		);
	});
	it("describes the charts only when a chart is drawn", () => {
		// Only hidden pools, nothing at all, or a pool with no forecast (no chart).
		const cases: Array<[PoolGroup[], PoolGroup[]]> = [
			[[], [group]],
			[[], []],
			[[group], []],
		];
		for (const [groups, hidden] of cases) {
			const html = renderToStaticMarkup(
				<PoolCapacitySection
					groups={groups}
					hidden={hidden}
					now={NOW}
					onUseReset={() => {}}
				/>,
			);
			expect(html).not.toContain("Each chart is the pool");
			expect(html).not.toContain("Forecast: each account keeps");
		}
		const charted: PoolGroup = {
			...group,
			id: "codex:charted",
			forecast: {
				series: [{ t: NOW, left: 0 }],
				capacity: 200,
				dry: null,
				nextRefill: null,
				refills: [],
				returns: [],
				lanes: { "acct-a": [0], "acct-b": [0] },
				horizonMs: 168 * 3600000,
			},
		};
		const shown = renderToStaticMarkup(
			<PoolCapacitySection
				groups={[group, charted]}
				hidden={[]}
				now={NOW}
				onUseReset={() => {}}
			/>,
		);
		expect(shown).toContain("Each chart is the pool");
		expect(shown).toContain("Forecast: each account keeps");
	});
	it("names each lane once for screen readers", () => {
		const g: PoolGroup = {
			...group,
			accounts: [{ ...group.accounts[0], state: "active", pct: 50 }],
			forecast: {
				series: [{ t: NOW, left: 50 }],
				capacity: 100,
				dry: null,
				nextRefill: null,
				refills: [],
				returns: [],
				lanes: { "acct-a": [50] },
				horizonMs: 168 * 3600000,
			},
		};
		const html = renderToStaticMarkup(
			<PoolRunway group={g} now={NOW} open={false} onToggle={() => {}} />,
		);
		expect(html).toContain('title="acct-a" aria-hidden="true">acct-a</span>');
		expect(html).toContain('<span class="sr-only">acct-a: 50% used');
	});
	it("gives the exact-times list its own name and references it only while open", () => {
		const closed = renderToStaticMarkup(
			<AccountList group={group} now={NOW} open={false} onToggle={() => {}} />,
		);
		expect(closed).not.toContain("aria-controls");
		const open = renderToStaticMarkup(
			<AccountList group={group} now={NOW} open onToggle={() => {}} />,
		);
		expect(open).toContain('aria-controls="runway-codex:weekly-accounts"');
		expect(open).toContain('aria-label="Codex Pro weekly exact times"');
	});
	it("marks an account serving on purchased credits", () => {
		const g = {
			...group,
			accounts: [
				{
					...group.accounts[0],
					state: "active" as const,
					pct: 100,
					onCredits: true,
				},
			],
		};
		const html = renderToStaticMarkup(
			<AccountList group={g} now={NOW} open onToggle={() => {}} />,
		);
		expect(html).toContain(">on credits</span>");
		expect(html).toContain("100% used");
	});
});
