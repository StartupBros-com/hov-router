import { describe, expect, test } from "bun:test";
import {
	CLAUDE_MODEL_IDS,
	getModelDisplayName,
	getModelFamily,
	getStrictClaudeModelFamily,
	isRouteOnlyClaudeModelId,
	isValidModelId,
	isWellFormedConcreteClaudeModelId,
	KNOWN_PATTERNS,
	LATEST_FABLE_MODEL,
	LATEST_MYTHOS_MODEL,
	LATEST_OPUS_MODEL,
	resolveRouteProfileModelAlias,
	resolveStoredPolicyAliasModel,
} from "./index";

describe("route-only Claude models (Mythos)", () => {
	test("a route profile's bare mythos resolves to the router's latest Mythos", () => {
		expect(resolveRouteProfileModelAlias("mythos")).toBe(LATEST_MYTHOS_MODEL);
		expect(resolveRouteProfileModelAlias(" Mythos ")).toBe(LATEST_MYTHOS_MODEL);
		expect(isRouteOnlyClaudeModelId(LATEST_MYTHOS_MODEL)).toBe(true);
		expect(getModelDisplayName(LATEST_MYTHOS_MODEL)).toMatch(
			/^Claude Mythos \d+(\.\d+)?$/,
		);
	});

	test("a route profile still resolves the combo families and keeps anything else as written", () => {
		expect(resolveRouteProfileModelAlias("opus")).toBe(LATEST_OPUS_MODEL);
		for (const written of [
			"claude-mythos-5-2",
			"claude-opus-5-5",
			"mythos-latest",
			"constructor",
			"toString",
			"__proto__",
		]) {
			expect(resolveRouteProfileModelAlias(written)).toBe(written);
		}
	});

	test("ordinary routing never learns Mythos (planted negative)", () => {
		// A bare Mythos request must stay outside every family, combo alias and
		// catalog path, so it can never be load-balanced onto an account
		// without a Cyber Verification grant.
		expect(KNOWN_PATTERNS).not.toContain("mythos" as never);
		expect(getModelFamily(LATEST_MYTHOS_MODEL)).toBeNull();
		expect(getStrictClaudeModelFamily(LATEST_MYTHOS_MODEL)).toBeNull();
		expect(isWellFormedConcreteClaudeModelId(LATEST_MYTHOS_MODEL)).toBe(false);
		expect(isValidModelId(LATEST_MYTHOS_MODEL)).toBe(false);
		expect(
			Object.values(CLAUDE_MODEL_IDS).some((id) => id.includes("mythos")),
		).toBe(false);
		expect(resolveStoredPolicyAliasModel("mythos")).toBe("mythos");
	});

	test("Mythos and Fable name the same version", () => {
		// They have shipped in step (Mythos 5, 5.1, 5.2 beside Fable 5, 5.1, 5.2).
		// When LATEST_FABLE_MODEL moves, decide whether LATEST_MYTHOS_MODEL moves
		// with it; if Anthropic ships one without the other, change this test to
		// say so rather than silently letting the CVP route fall behind.
		const version = (id: string, family: string) =>
			id.replace(new RegExp(`^claude-${family}-`), "");
		expect(version(LATEST_MYTHOS_MODEL, "mythos")).toBe(
			version(LATEST_FABLE_MODEL, "fable"),
		);
	});
});
