import { describe, expect, it } from "bun:test";
import {
	getAccountOwnedModelMappings,
	MAX_MODEL_MAPPING_CANDIDATES,
	parseModelMappings,
} from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import {
	foldLegacyModelMappings,
	type LegacyModelMappingRow,
} from "../legacy-model-mapping-fold";

const cap = Array.from(
	{ length: MAX_MODEL_MAPPING_CANDIDATES },
	(_, i) => `cap-${i}`,
);

interface Case {
	name: string;
	row: LegacyModelMappingRow;
	/** Parsed model_mappings after the fold; null when the field stays null. */
	mappings: Record<string, string | string[]> | null;
	/** Exact custom_endpoint after the fold. */
	customEndpoint: string | null;
	/** Whether model_mappings must stay byte-identical. */
	mappingsUnchanged?: boolean;
	warnings?: number;
}

const row = (
	fields: Partial<LegacyModelMappingRow>,
): LegacyModelMappingRow => ({
	model_mappings: null,
	custom_endpoint: null,
	model_fallbacks: null,
	...fields,
});

const CASES: Case[] = [
	{
		name: "model_mappings alone stays byte-identical",
		row: row({ model_mappings: '{ "opus": "a" }' }),
		mappings: { opus: "a" },
		customEndpoint: null,
		mappingsUnchanged: true,
	},
	{
		name: "Vertex custom_endpoint JSON without modelMappings stays byte-identical",
		row: row({
			custom_endpoint: '{ "projectId": "p", "region": "us-east5" }',
		}),
		mappings: null,
		customEndpoint: '{ "projectId": "p", "region": "us-east5" }',
	},
	{
		name: "plain custom_endpoint URL stays byte-identical",
		row: row({ custom_endpoint: "https://e.example/v1" }),
		mappings: null,
		customEndpoint: "https://e.example/v1",
	},
	{
		name: "custom_endpoint modelMappings alone moves into model_mappings",
		row: row({
			custom_endpoint:
				'{"endpoint":"https://e.example","modelMappings":{"opus":"o1"}}',
		}),
		mappings: { opus: "o1" },
		customEndpoint: '{"endpoint":"https://e.example"}',
	},
	{
		name: "custom_endpoint holding only modelMappings becomes an empty object",
		row: row({ custom_endpoint: '{"modelMappings":{"sonnet":"s1"}}' }),
		mappings: { sonnet: "s1" },
		customEndpoint: "{}",
	},
	{
		name: "custom_endpoint modelMappings overrides a family",
		row: row({
			model_mappings: '{"opus":"a","haiku":"h"}',
			custom_endpoint: '{"modelMappings":{"opus":"b"}}',
		}),
		mappings: { opus: "b", haiku: "h" },
		customEndpoint: "{}",
	},
	{
		name: "model_fallbacks alone sets the family",
		row: row({ model_fallbacks: '{"opus":"fb"}' }),
		mappings: { opus: "fb" },
		customEndpoint: null,
	},
	{
		name: "model_fallbacks appends to an existing family",
		row: row({
			model_mappings: '{"opus":"a"}',
			model_fallbacks: '{"opus":"fb"}',
		}),
		mappings: { opus: ["a", "fb"] },
		customEndpoint: null,
	},
	{
		name: "a fallback already among the candidates is not repeated",
		row: row({
			model_mappings: '{"opus":["a","fb"]}',
			model_fallbacks: '{"opus":"fb"}',
		}),
		mappings: { opus: ["a", "fb"] },
		customEndpoint: null,
	},
	{
		name: "a fallback past the candidate cap is dropped",
		row: row({
			model_mappings: JSON.stringify({ opus: cap }),
			model_fallbacks: '{"opus":"fb"}',
		}),
		mappings: { opus: cap },
		customEndpoint: null,
		warnings: 1,
	},
	{
		name: "all three sources combine in router order",
		row: row({
			model_mappings: '{"opus":"a","sonnet":"s"}',
			custom_endpoint: '{"endpoint":"x","modelMappings":{"opus":"b"}}',
			model_fallbacks: '{"opus":"fb","haiku":"hf"}',
		}),
		mappings: { opus: ["b", "fb"], sonnet: "s", haiku: "hf" },
		customEndpoint: '{"endpoint":"x"}',
	},
	{
		name: "array values in custom_endpoint modelMappings keep their order",
		row: row({
			custom_endpoint: '{"modelMappings":{"opus":["x","y"]}}',
			model_fallbacks: '{"opus":"z"}',
		}),
		mappings: { opus: ["x", "y", "z"] },
		customEndpoint: "{}",
	},
	{
		name: "a single-element array collapses before a fallback appends",
		row: row({
			model_mappings: '{"opus":["a"]}',
			model_fallbacks: '{"opus":"fb"}',
		}),
		mappings: { opus: ["a", "fb"] },
		customEndpoint: null,
	},
	{
		name: "an array value in model_fallbacks was never routed",
		row: row({
			model_mappings: '{"opus":"a"}',
			model_fallbacks: '{"opus":["fb"]}',
		}),
		mappings: { opus: "a" },
		customEndpoint: null,
		mappingsUnchanged: true,
		warnings: 1,
	},
	{
		name: "invalid JSON in model_fallbacks was never routed",
		row: row({ model_mappings: '{"opus":"a"}', model_fallbacks: "{opus" }),
		mappings: { opus: "a" },
		customEndpoint: null,
		mappingsUnchanged: true,
		warnings: 1,
	},
	{
		name: "wrapped model_fallbacks was never routed",
		row: row({ model_fallbacks: '{"modelFallbacks":{"opus":"a"}}' }),
		mappings: null,
		customEndpoint: null,
		warnings: 1,
	},
	{
		name: "invalid JSON in custom_endpoint is left alone",
		row: row({ custom_endpoint: '{"modelMappings": nope' }),
		mappings: null,
		customEndpoint: '{"modelMappings": nope',
	},
	{
		name: "invalid custom_endpoint modelMappings is removed without routing",
		row: row({
			model_mappings: '{"opus":"a"}',
			custom_endpoint: '{"endpoint":"x","modelMappings":{"opus":{"x":1}}}',
		}),
		mappings: { opus: "a" },
		customEndpoint: '{"endpoint":"x"}',
		mappingsUnchanged: true,
		warnings: 1,
	},
	{
		name: "unparseable model_mappings is replaced by the legacy mappings",
		row: row({ model_mappings: "{bad", model_fallbacks: '{"opus":"fb"}' }),
		mappings: { opus: "fb" },
		customEndpoint: null,
		warnings: 1,
	},
	{
		name: "wrapped model_mappings is left alone; it never routed",
		row: row({ model_mappings: '{"modelMappings":{"opus":"a"}}' }),
		mappings: null,
		customEndpoint: null,
		mappingsUnchanged: true,
	},
];

describe("foldLegacyModelMappings", () => {
	for (const testCase of CASES) {
		it(testCase.name, () => {
			const folded = foldLegacyModelMappings(testCase.row);
			expect(folded.custom_endpoint).toBe(testCase.customEndpoint);
			if (testCase.mappingsUnchanged) {
				expect(folded.model_mappings).toBe(testCase.row.model_mappings);
			}
			if (testCase.mappings === null) {
				expect(parseModelMappings(folded.model_mappings)).toBeNull();
			} else {
				expect(JSON.parse(folded.model_mappings ?? "null")).toEqual(
					testCase.mappings,
				);
			}
			expect(folded.warnings).toHaveLength(testCase.warnings ?? 0);
		});

		// Proves the fold routes exactly as the request-time merge it replaces.
		// Removed together with that merge.
		it(`${testCase.name}: matches the request-time merge`, () => {
			const folded = foldLegacyModelMappings(testCase.row);
			const account = { name: "fold-test", ...testCase.row } as Account;
			expect(parseModelMappings(folded.model_mappings) ?? {}).toEqual(
				getAccountOwnedModelMappings(account),
			);
		});
	}

	it("is idempotent", () => {
		for (const testCase of CASES) {
			const once = foldLegacyModelMappings(testCase.row);
			const twice = foldLegacyModelMappings({
				model_mappings: once.model_mappings,
				custom_endpoint: once.custom_endpoint,
				model_fallbacks: null,
			});
			expect(twice.model_mappings).toBe(once.model_mappings);
			expect(twice.custom_endpoint).toBe(once.custom_endpoint);
		}
	});
});
