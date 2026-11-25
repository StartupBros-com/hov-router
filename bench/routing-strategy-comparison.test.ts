import { expect, spyOn, test } from "bun:test";
import { SessionAffinityStrategy } from "@better-ccflare/load-balancer";
import {
	account,
	candidate,
} from "../packages/load-balancer/src/strategies/__tests__/candidate-routing-fixture";
import { compareRouting } from "./routing-strategy-comparison";

test("compares first choices and counts changes only on continuing lanes", async () => {
	const report = await compareRouting();
	const scenario = (name: string) => {
		const row = report.scenarios.find((s) => s.name === name);
		if (!row) throw new Error(`missing ${name}`);
		return row;
	};
	for (const policy of ["session-affinity", "session-drain-soonest"] as const) {
		const choices = (name: string) =>
			scenario(name)[policy].decisions.map(
				(d) => d.selected?.candidateId ?? null,
			);
		const drain = policy === "session-drain-soonest";
		expect(choices("weekly reset versus utilization")).toEqual([
			drain ? "a" : "b",
		]);
		expect(choices("interleaved lanes")).toEqual(["a", "b", "a", "b"]);
		expect(scenario("interleaved lanes")[policy].counts).toEqual({
			total: 4,
			continuations: 2,
			accountChanges: 0,
			candidateChanges: 0,
			noCandidate: 0,
			outsideEligible: 0,
		});
		expect(choices("Codex pressure")).toEqual(["a", drain ? "a" : "b"]);
		expect(choices("Anthropic pressure and idle expiry")).toEqual([
			"a",
			drain ? "a" : "b",
			"b",
		]);
		expect(choices("owner unavailable")).toEqual(["a", "b", null]);
		expect(choices("tier and fallback rung")).toEqual(["b", "b"]);
		expect(choices("unknown and past resets")).toEqual(["b"]);
		expect(choices("sibling slots")).toEqual(["a", "a", "sibling"]);
		expect(
			scenario("sibling slots")[policy].decisions.map((d) => [
				d.accountId,
				d.selected?.modelOverride,
				d.selected?.comboSlotId,
			]),
		).toEqual([
			["a", "model-a", "a"],
			["a", "model-a", "a"],
			["a", "model-sibling", "sibling"],
		]);
		expect(scenario("owner unavailable")[policy].counts).toEqual({
			total: 3,
			continuations: 2,
			accountChanges: 1,
			candidateChanges: 1,
			noCandidate: 1,
			outsideEligible: 0,
		});
		expect(scenario("sibling slots")[policy].counts).toMatchObject({
			accountChanges: 0,
			candidateChanges: 1,
		});
		for (const row of report.scenarios)
			expect(row[policy].counts.outsideEligible).toBe(0);
	}
});

test("counts an ineligible fallback even when the first choice is eligible", async () => {
	const select = spyOn(
		SessionAffinityStrategy.prototype,
		"select",
	).mockImplementationOnce(async (accounts, request) => {
		request.routingCandidates = [
			candidate("a", "a", 0, 0),
			candidate("outside", "outside", 0, 1),
		];
		const first = accounts[0];
		if (!first) throw new Error("fixture requires an eligible first candidate");
		return [first, account("outside")];
	});
	try {
		const report = await compareRouting();
		expect(
			report.scenarios[0]?.["session-affinity"].counts.outsideEligible,
		).toBe(1);
	} finally {
		select.mockRestore();
	}
});

test("replay restores the clock and starts both policies with clean state", async () => {
	const clock = Date.now;
	const first = await compareRouting();
	expect(Date.now).toBe(clock);
	expect(await compareRouting()).toEqual(first);
});
