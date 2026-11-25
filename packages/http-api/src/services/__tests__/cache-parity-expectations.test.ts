import { describe, expect, test } from "bun:test";
import {
	buildCacheParityDriftReport,
	CACHE_PARITY_ACKNOWLEDGED_DEVIATIONS,
	CACHE_PARITY_DECLARED_DEFAULTS,
} from "../cache-parity-expectations";

describe("buildCacheParityDriftReport", () => {
	test("reports no deviations when the live policy matches declared defaults", () => {
		const report = buildCacheParityDriftReport(CACHE_PARITY_DECLARED_DEFAULTS);
		expect(report.deviations).toEqual([]);
		expect(report.declaredDefaults).toEqual(CACHE_PARITY_DECLARED_DEFAULTS);
	});

	test("declares only the levers the router still has", () => {
		// The removed Codex levers (session keys, prefix sharding, continuity
		// percentage, settle window, pacing bypass, explicit breakpoints, turn
		// state, WebSocket) were reported at fixed values until 7.0.0.
		expect(Object.keys(CACHE_PARITY_DECLARED_DEFAULTS).sort()).toEqual([
			"cacheKeyMode",
			"globalKeepaliveTtlMinutes",
			"pacingMs",
			"promptCacheKeyEnabled",
			"xaiCacheKeepaliveTtlMinutes",
		]);
	});

	test("an undeclared deviation reports as unacknowledged", () => {
		const report = buildCacheParityDriftReport({
			...CACHE_PARITY_DECLARED_DEFAULTS,
			pacingMs: 0,
		});
		expect(report.deviations).toEqual([
			{
				lever: "pacingMs",
				declaredValue: 60_000,
				liveValue: 0,
				acknowledged: false,
				acknowledgement: null,
			},
		]);
	});

	test("a deviation listed in the acknowledgement map reports as acknowledged", () => {
		// The map ships empty, so add one entry for this test and remove it
		// again afterwards.
		const acknowledgement = { issue: 730, note: "test-only acknowledgement" };
		CACHE_PARITY_ACKNOWLEDGED_DEVIATIONS.pacingMs = acknowledgement;
		try {
			const report = buildCacheParityDriftReport({
				...CACHE_PARITY_DECLARED_DEFAULTS,
				pacingMs: 0,
			});
			const entry = report.deviations.find(
				(deviation) => deviation.lever === "pacingMs",
			);
			expect(entry?.acknowledged).toBe(true);
			expect(entry?.acknowledgement).toEqual(acknowledgement);
		} finally {
			delete CACHE_PARITY_ACKNOWLEDGED_DEVIATIONS.pacingMs;
		}
		expect(CACHE_PARITY_ACKNOWLEDGED_DEVIATIONS).toEqual({});
	});

	test("reports only declared defaults and deviations", () => {
		// The 75% / 12% parity floor and its floorHeld flag were removed:
		// nothing read them.
		const report = buildCacheParityDriftReport(CACHE_PARITY_DECLARED_DEFAULTS);
		expect(Object.keys(report).sort()).toEqual([
			"declaredDefaults",
			"deviations",
		]);
	});
});
