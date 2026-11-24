import { describe, expect, it } from "bun:test";
import {
	getPublicValuePlan,
	PUBLIC_VALUE_PLANS,
	publicValuePlanObject,
} from "./public-value-plans";

const PRINTABLE = /^[\x20-\x7e]+$/;

describe("public value plan catalog", () => {
	it("holds exactly the six plans read on 2026-11-23", () => {
		expect(
			PUBLIC_VALUE_PLANS.map((p) => [p.key, p.provider, p.monthlyUsd]),
		).toEqual([
			["claude-pro", "anthropic", 20],
			["claude-max", "anthropic", 100],
			["claude-ultra", "anthropic", 200],
			["chatgpt-pro-100", "codex", 100],
			["chatgpt-pro-200", "codex", 200],
			["chatgpt-pro-500", "codex", 500],
		]);
	});

	it("has unique keys", () => {
		const keys = PUBLIC_VALUE_PLANS.map((p) => p.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("emits the six keys in the consumer's order and no provider", () => {
		for (const plan of PUBLIC_VALUE_PLANS)
			expect(Object.keys(publicValuePlanObject(plan))).toEqual([
				"key",
				"name",
				"formerName",
				"monthlyUsd",
				"priceSource",
				"priceCheckedOn",
			]);
	});

	it("satisfies every bound the value page checks", () => {
		for (const plan of PUBLIC_VALUE_PLANS) {
			const o = publicValuePlanObject(plan);
			expect(o.key).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/);
			expect(o.name.length).toBeGreaterThanOrEqual(1);
			expect(o.name.length).toBeLessThanOrEqual(80);
			expect(o.name).toMatch(PRINTABLE);
			if (o.formerName !== null) {
				expect(o.formerName.length).toBeGreaterThanOrEqual(1);
				expect(o.formerName.length).toBeLessThanOrEqual(80);
				expect(o.formerName).toMatch(PRINTABLE);
			}
			expect(typeof o.monthlyUsd).toBe("number");
			expect(Number.isFinite(o.monthlyUsd)).toBe(true);
			expect(o.monthlyUsd).toBeGreaterThanOrEqual(0);
			expect(o.monthlyUsd).toBeLessThanOrEqual(100_000);
			expect(o.priceSource.length).toBeLessThanOrEqual(300);
			expect(o.priceSource.startsWith("https://")).toBe(true);
			expect(new URL(o.priceSource).href).toBe(o.priceSource);
			expect(o.priceCheckedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(new Date(`${o.priceCheckedOn}T00:00:00Z`).toISOString()).toBe(
				`${o.priceCheckedOn}T00:00:00.000Z`,
			);
		}
	});

	it("matches the example fixture's claude-ultra plan object exactly", () => {
		const plan = getPublicValuePlan("claude-ultra");
		expect(plan && publicValuePlanObject(plan)).toEqual({
			key: "claude-ultra",
			name: "Claude Ultra",
			formerName: "Claude Max 20x",
			monthlyUsd: 200,
			priceSource: "https://claude.com/pricing",
			priceCheckedOn: "2026-11-23",
		});
	});

	it("looks a plan up by key and returns undefined for an unknown key", () => {
		expect(getPublicValuePlan("chatgpt-pro-500")?.provider).toBe("codex");
		expect(getPublicValuePlan("nope")).toBeUndefined();
	});
});
