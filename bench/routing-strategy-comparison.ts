import {
	SessionAffinityStrategy,
	SessionDrainSoonestStrategy,
} from "@better-ccflare/load-balancer";
import type { Account, RoutingCandidateMetadata } from "@better-ccflare/types";
import {
	account,
	candidate,
	meta,
	store,
} from "../packages/load-balancer/src/strategies/__tests__/candidate-routing-fixture";

const epoch = Date.UTC(2026, 0, 1);
const minute = 60_000;
type Route = RoutingCandidateMetadata;
type Step = ReturnType<typeof step>;
function step(routes: Route[], lane = "one", minutes = 0, catalog = routes) {
	return { routes, lane, minutes, catalog };
}
interface Scenario {
	name: string;
	steps: Step[];
	provider?: Account["provider"];
	pastReset?: boolean;
}
function scenarios(): Scenario[] {
	const a = candidate("a", "a", 0, 0);
	const b = candidate("b", "b", 0, 1);
	const pressure = [
		candidate("a", "a", 0, 0, "cold"),
		candidate("b", "b", 0, 1, "critical"),
	];
	const both = [a, b];
	const sibling = candidate("sibling", "a", 0, 1);
	const siblings = [a, sibling];
	return [
		{ name: "weekly reset versus utilization", steps: [step(both)] },
		{
			name: "interleaved lanes",
			steps: [step([a]), step([b], "two"), step(both), step(both, "two")],
		},
		{
			name: "Codex pressure",
			provider: "codex",
			steps: [step([a]), step(pressure, "one", 1)],
		},
		{
			name: "Anthropic pressure and idle expiry",
			steps: [step([a]), step(pressure, "one", 1), step(pressure, "one", 7)],
		},
		{
			name: "owner unavailable",
			steps: [step([a]), step([b], "one", 1, both), step([], "one", 2, both)],
		},
		{
			name: "tier and fallback rung",
			steps: [
				step([{ ...a, tier: 1 }, b]),
				step(
					[
						{ ...a, routeFallbackRung: "profile_root_model" },
						{ ...b, routeFallbackRung: "profile_requested_model" },
					],
					"two",
				),
			],
		},
		{ name: "unknown and past resets", pastReset: true, steps: [step(both)] },
		{
			name: "sibling slots",
			steps: [
				step([a]),
				step([sibling, a]),
				step([sibling], "one", 1, siblings),
			],
		},
	];
}

async function replay(
	scenario: Scenario,
	Strategy: typeof SessionAffinityStrategy | typeof SessionDrainSoonestStrategy,
) {
	const originalClock = Date.now;
	let now = epoch;
	Date.now = () => now;
	try {
		const strategy = new Strategy();
		strategy.initialize({
			...store,
			getAccountUtilization: (id) => (id === "a" ? 80 : 10),
			getAccountWeeklyReset: (id) =>
				scenario.pastReset
					? id === "a"
						? epoch - minute
						: null
					: epoch + (id === "a" ? 1 : 6) * 86400000,
		});
		const accounts = new Map<string, Account>();
		const previous = new Map<string, Route>();
		const counts = {
			continuations: 0,
			accountChanges: 0,
			candidateChanges: 0,
			noCandidate: 0,
			outsideEligible: 0,
		};
		const decisions = [];
		for (const [index, input] of structuredClone(scenario.steps).entries()) {
			now = epoch + input.minutes * minute;
			const eligible = structuredClone(input.routes);
			const candidates = input.routes.map(({ accountId }) => {
				const item = accounts.get(accountId) ?? {
					...account(accountId),
					provider: scenario.provider ?? "anthropic",
				};
				accounts.set(accountId, item);
				return item;
			});
			const request = meta(input.routes, input.lane);
			request.id = `decision-${index}`;
			request.routingCandidateCatalog = input.catalog;
			const ordered = await strategy.select(candidates, request);
			const first = ordered[0];
			const selected = first ? (request.routingCandidates?.[0] ?? null) : null;
			const prior = previous.get(input.lane);
			if (prior) counts.continuations++;
			if (!first) counts.noCandidate++;
			if (
				ordered.some((item, position) => {
					const route = request.routingCandidates?.[position];
					return (
						!route ||
						!eligible.some(
							(r) =>
								r.accountId === item.id &&
								r.accountId === route.accountId &&
								r.candidateId === route.candidateId &&
								r.modelOverride === route.modelOverride &&
								r.comboSlotId === route.comboSlotId,
						)
					);
				})
			)
				counts.outsideEligible++;
			if (first && selected) {
				if (prior) {
					if (prior.accountId !== first.id) counts.accountChanges++;
					if (prior.candidateId !== selected.candidateId)
						counts.candidateChanges++;
				}
				previous.set(input.lane, selected);
			}
			decisions.push({
				lane: input.lane,
				minutes: input.minutes,
				eligible,
				accountId: first?.id ?? null,
				selected,
			});
		}
		return { counts: { total: decisions.length, ...counts }, decisions };
	} finally {
		Date.now = originalClock;
	}
}

export async function compareRouting() {
	const rows = [];
	for (const scenario of scenarios())
		rows.push({
			name: scenario.name,
			"session-affinity": await replay(scenario, SessionAffinityStrategy),
			"session-drain-soonest": await replay(
				scenario,
				SessionDrainSoonestStrategy,
			),
		});
	return {
		scope:
			"Offline simulation of strategy-stage decisions after supplied eligibility; not provider requests or performance measurements.",
		denominators: {
			total: "All calls to select",
			continuations:
				"Decisions with a prior selection on the same lane, including empty selections",
			accountChanges: "Changed first account among continuations",
			candidateChanges: "Changed first candidate among continuations",
			noCandidate: "Empty selections among all decisions",
			outsideEligible:
				"Decisions returning any first or fallback candidate outside supplied eligible account/candidate pairs; expected zero",
		},
		scenarios: rows,
	};
}
if (import.meta.main)
	console.log(JSON.stringify(await compareRouting(), null, 2));
