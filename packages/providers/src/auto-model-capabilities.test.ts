import { describe, expect, it } from "bun:test";
import {
	getSupportedLineIdentities,
	getSupportedLines,
	normalizeAutoModelCapabilities,
} from "./auto-model-capabilities";

describe("getSupportedLineIdentities", () => {
	it("lists every approved line's identities, oldest to newest", () => {
		const lines = getSupportedLineIdentities();
		expect(Object.keys(lines).sort()).toEqual(
			[...getSupportedLines("anthropic"), ...getSupportedLines("codex")].sort(),
		);
		expect(lines["gpt-sol"]).toEqual(["gpt-5.6-sol", "gpt-6.1-sol"]);
	});

	it("returns a copy the caller cannot use to widen a line", () => {
		const first = getSupportedLineIdentities();
		(first["gpt-sol"] as string[]).push("gpt-99-sol");
		expect(getSupportedLineIdentities()["gpt-sol"]).not.toContain("gpt-99-sol");
	});
});

describe("exact-model capability normalization", () => {
	it.each(
		[
			undefined,
			null,
			[],
			"high",
			["high"],
			[null],
			[[]],
			[{}],
			[{ effort: null }],
			[{ effort: 1 }],
			[{ effort: "" }],
			[{ effort: "HIGH" }],
			[{ effort: " high " }],
			[{ effort: "high" }, { effort: "unknown" }],
			Array(7).fill({ effort: "high" }),
			Object.assign(Array(2), { 0: { effort: "high" } }),
		].map((levels) => ({ levels })),
	)("keeps invalid reasoning support unknown ($levels)", ({ levels }) => {
		expect(
			normalizeAutoModelCapabilities("codex", {
				supported_reasoning_levels: levels,
			}).supportedReasoningEfforts,
		).toBeNull();
	});
	it("captures immutable exact reasoning support and revisions support changes", () => {
		const levels = [{ effort: "high", description: "High" }, { effort: "max" }];
		const raw = { supported_reasoning_levels: levels };
		const first = normalizeAutoModelCapabilities("codex", raw);
		expect(first.supportedReasoningEfforts).toEqual(["high", "max"]);
		expect(Object.isFrozen(first.supportedReasoningEfforts)).toBe(true);
		levels[0].effort = "low";
		levels.push({ effort: "medium" });
		expect(first.supportedReasoningEfforts).toEqual(["high", "max"]);
		expect(normalizeAutoModelCapabilities("codex", raw).revision).not.toBe(
			first.revision,
		);
		expect(
			normalizeAutoModelCapabilities("anthropic", raw)
				.supportedReasoningEfforts,
		).toBeNull();
	});
	it("does not accept contradictory capacity fields", () => {
		const result = normalizeAutoModelCapabilities("codex", {
			context_window: 872000,
			max_context_window: 272000,
		});
		expect(result.contextWindow).toBeNull();
		expect(result.maxContextWindow).toBeNull();
	});
	it.each([
		0,
		-1,
		1.5,
		NaN,
		Infinity,
		Number.MAX_SAFE_INTEGER + 1,
		"128000",
		null,
	])("keeps malformed capacities unknown (%s)", (value) => {
		const result = normalizeAutoModelCapabilities("codex", {
			context_window: value,
			max_context_window: value,
			max_output_tokens: value,
		});
		expect(result.contextWindow).toBeNull();
		expect(result.maxContextWindow).toBeNull();
		expect(result.maxOutputTokens).toBeNull();
	});
	it.each([
		0,
		-1,
		101,
		NaN,
		Infinity,
		"95",
	])("rejects invalid usable percentages (%s)", (value) => {
		expect(
			normalizeAutoModelCapabilities("codex", {
				effective_context_window_percent: value,
			}).effectiveContextPercent,
		).toBeNull();
	});
	it.each(
		[[], ["text", 5], ["text", "unknown"], "image"].map((value) => ({ value })),
	)("does not guess malformed modalities (%s)", ({ value }) => {
		expect(
			normalizeAutoModelCapabilities("codex", { input_modalities: value })
				.inputModalities,
		).toBeNull();
	});
	it("retains native exact facts, boundaries and immutable semantic revisions", () => {
		const raw = {
			max_input_tokens: 1000000,
			max_tokens: 128000,
			capabilities: {
				image_input: { supported: true },
				tool_choice: { supported: false },
			},
		};
		const first = normalizeAutoModelCapabilities("anthropic", raw);
		expect(first.contextWindow).toBe(1000000);
		expect(first.maxOutputTokens).toBe(128000);
		expect(first.nativeCapabilities).toEqual(raw.capabilities);
		expect(
			normalizeAutoModelCapabilities("anthropic", {
				...raw,
				display_name: "renamed",
			}).revision,
		).toBe(first.revision);
		expect(
			normalizeAutoModelCapabilities("anthropic", { ...raw, max_tokens: 64000 })
				.revision,
		).not.toBe(first.revision);
		raw.capabilities.image_input.supported = false;
		expect(first.nativeCapabilities).toEqual({
			image_input: { supported: true },
			tool_choice: { supported: false },
		});
		expect(
			normalizeAutoModelCapabilities("codex", {
				max_output_tokens: Number.MAX_SAFE_INTEGER,
			}).maxOutputTokens,
		).toBe(Number.MAX_SAFE_INTEGER);
	});
	it("preserves sourced capacity, modalities and tool evidence without inventing output", () => {
		const capability = normalizeAutoModelCapabilities("codex", {
			context_window: 272000,
			max_context_window: 872000,
			effective_context_window_percent: 95,
			input_modalities: ["text", "image"],
			tool_mode: "function",
			supports_search_tool: true,
			experimental_supported_tools: ["web_search"],
		});
		expect(capability.contextWindow).toBe(272000);
		expect(capability.maxContextWindow).toBe(872000);
		expect(capability.effectiveContextPercent).toBe(95);
		expect(capability.maxOutputTokens).toBeNull();
		expect(capability.inputModalities).toEqual(["text", "image"]);
		expect(capability.toolEvidence).toEqual({
			tool_mode: "function",
			supports_search_tool: true,
			experimental_supported_tools: ["web_search"],
		});
		expect(Object.isFrozen(capability)).toBe(true);
		expect(Object.isFrozen(capability.inputModalities)).toBe(true);
	});
});
