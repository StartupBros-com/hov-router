import { describe, expect, it } from "bun:test";
import {
	LeastUsedStrategy,
	SessionAffinityStrategy,
	SessionStrategy,
} from "@hov-router/load-balancer";
import type { RoutingCandidateMetadata } from "@hov-router/types";
import { account, candidate, meta, store } from "./candidate-routing-fixture";

describe("atomic strategy candidates", () => {
	it("LeastUsedStrategy orders candidate metadata with duplicate accounts", async () => {
		const strategy = new LeastUsedStrategy();
		strategy.initialize(store);
		const shared = account("shared", 99);
		const requestMeta = meta([
			candidate("slot-cold", "shared", 0, 0, "cold"),
			candidate("slot-critical", "shared", 0, 1, "critical"),
		]);

		const ordered = await strategy.select([shared, shared], requestMeta);

		expect(ordered).toEqual([shared, shared]);
		expect(
			requestMeta.routingCandidates?.map((item) => item.candidateId),
		).toEqual(["slot-critical", "slot-cold"]);
	});

	it("SessionStrategy uses candidate tiers and keeps metadata aligned", async () => {
		const strategy = new SessionStrategy();
		strategy.initialize(store);
		const highAccountPriority = account("account-a", 50);
		const lowAccountPriority = account("account-b", 0);
		const requestMeta = meta([
			candidate("slot-a", "account-a", 0, 0),
			candidate("slot-b", "account-b", 10, 1),
		]);

		const ordered = await strategy.select(
			[highAccountPriority, lowAccountPriority],
			requestMeta,
		);

		expect(ordered.map((item) => item.id)).toEqual(["account-a", "account-b"]);
		expect(
			requestMeta.routingCandidates?.map((item) => item.candidateId),
		).toEqual(["slot-a", "slot-b"]);
	});

	it("orders descendant fallback rungs before account priority", async () => {
		const strategy = new SessionStrategy();
		strategy.initialize(store);
		const requested = account("requested", 50);
		const rootFallback = account("root-fallback", 0);
		const globalFallback = account("global-fallback", -10);
		const requestMeta = meta([
			candidate(
				"requested-slot",
				requested.id,
				requested.priority,
				0,
				undefined,
				"profile_requested_model",
			),
			candidate(
				"root-slot",
				rootFallback.id,
				rootFallback.priority,
				1,
				undefined,
				"profile_root_model",
			),
			candidate(
				"global-slot",
				globalFallback.id,
				globalFallback.priority,
				2,
				undefined,
				"global_requested_model",
			),
		]);

		const ordered = await strategy.select(
			[requested, rootFallback, globalFallback],
			requestMeta,
		);

		expect(ordered.map((item) => item.id)).toEqual([
			"requested",
			"root-fallback",
			"global-fallback",
		]);
		expect(
			requestMeta.routingCandidates?.map((item) => item.candidateId),
		).toEqual(["requested-slot", "root-slot", "global-slot"]);
	});

	it("SessionAffinityStrategy sticks to candidate identity for duplicate-account slots", async () => {
		const strategy = new SessionAffinityStrategy();
		strategy.initialize(store);
		const shared = account("shared");
		const firstMeta = meta([
			candidate("slot-a", "shared", 0, 0),
			candidate("slot-b", "shared", 0, 1),
		]);
		await strategy.select([shared, shared], firstMeta);
		expect(firstMeta.routingCandidates?.[0]?.candidateId).toBe("slot-a");

		const reorderedMeta = meta(
			[
				candidate("slot-b", "shared", 0, 1),
				candidate("slot-a", "shared", 0, 0),
			],
			"lane",
		);
		await strategy.select([shared, shared], reorderedMeta);

		expect(
			reorderedMeta.routingCandidates?.map((item) => item.candidateId),
		).toEqual(["slot-a", "slot-b"]);
	});

	it("SessionAffinityStrategy preempts on candidate pressure and retains the new owner", async () => {
		const strategy = new SessionAffinityStrategy();
		strategy.initialize(store);
		const cold = account("cold");
		const hot = account("hot");
		await strategy.select(
			[cold],
			meta([candidate("cold-slot", "cold", 0, 0, "cold")]),
		);

		const pressured = meta([
			candidate("cold-slot", "cold", 0, 0, "cold"),
			candidate("hot-slot", "hot", 0, 1, "critical"),
		]);
		expect((await strategy.select([cold, hot], pressured))[0]?.id).toBe("hot");
		expect(pressured.routingCandidates?.[0]?.candidateId).toBe("hot-slot");

		const equalized = meta([
			candidate("cold-slot", "cold", 0, 0),
			candidate("hot-slot", "hot", 0, 1),
		]);
		expect((await strategy.select([cold, hot], equalized))[0]?.id).toBe("hot");
	});

	it("SessionAffinityStrategy preserves a missing better-tier candidate for snapback", async () => {
		const strategy = new SessionAffinityStrategy();
		strategy.initialize(store);
		const preferred = account("preferred");
		const fallback = account("fallback");
		const catalog = [
			candidate("preferred-slot", "preferred", 0, 0),
			candidate("fallback-slot", "fallback", 10, 1),
		];
		await strategy.select([preferred, fallback], meta(catalog));

		const failoverMeta = meta([catalog[1] as RoutingCandidateMetadata]);
		failoverMeta.routingCandidateCatalog = catalog;
		expect((await strategy.select([fallback], failoverMeta))[0]?.id).toBe(
			"fallback",
		);

		const recoveredMeta = meta(catalog);
		expect(
			(await strategy.select([preferred, fallback], recoveredMeta))[0]?.id,
		).toBe("preferred");
		expect(recoveredMeta.routingCandidates?.[0]?.candidateId).toBe(
			"preferred-slot",
		);
	});
});
