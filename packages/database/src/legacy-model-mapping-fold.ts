import {
	MAX_MODEL_MAPPING_CANDIDATES,
	validateModelMappings,
} from "@hov-router/core";

type ModelMappings = Record<string, string | string[]>;

/** The three account fields that could hold model mappings before 7.0.0. */
export interface LegacyModelMappingRow {
	model_mappings: string | null;
	custom_endpoint: string | null;
	model_fallbacks: string | null;
}

export interface LegacyModelMappingFold {
	/** model_mappings to store. Unchanged when neither legacy source added a mapping. */
	model_mappings: string | null;
	/** custom_endpoint without its `modelMappings` key. Unchanged when it had none. */
	custom_endpoint: string | null;
	warnings: string[];
}

function parseJson(value: string | null): unknown {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function validMappings(value: unknown, field: string): ModelMappings | null {
	try {
		return validateModelMappings(value, field);
	} catch {
		return null;
	}
}

function parseEndpointObject(
	customEndpoint: string | null,
): Record<string, unknown> | null {
	const trimmed = customEndpoint?.trim();
	if (!trimmed?.startsWith("{")) return null;
	const parsed = parseJson(trimmed);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	return parsed as Record<string, unknown>;
}

/**
 * Fold the two retired mapping stores into `model_mappings`, exactly as the
 * router merged them at request time before 7.0.0:
 *
 * 1. `model_mappings`, when it parses.
 * 2. `custom_endpoint` JSON `modelMappings`, overriding per family.
 * 3. `model_fallbacks` (single strings only), appended to the family's
 *    candidates when missing and the family has fewer than
 *    MAX_MODEL_MAPPING_CANDIDATES, or set when the family had no mapping.
 *
 * A source that never parsed was never routed, so it contributes nothing.
 */
export function foldLegacyModelMappings(
	row: LegacyModelMappingRow,
): LegacyModelMappingFold {
	const warnings: string[] = [];
	const accountMappings = validMappings(
		parseJson(row.model_mappings),
		"model_mappings",
	);

	const endpoint = parseEndpointObject(row.custom_endpoint);
	const hasEndpointMappings =
		endpoint !== null && Object.hasOwn(endpoint, "modelMappings");
	const endpointMappings = hasEndpointMappings
		? validMappings(endpoint.modelMappings, "custom_endpoint.modelMappings")
		: null;
	if (hasEndpointMappings && !endpointMappings) {
		warnings.push(
			"removed invalid custom_endpoint modelMappings, which the router ignored",
		);
	}

	let fallbacks: Record<string, string> | null = null;
	if (row.model_fallbacks?.trim()) {
		const parsed = parseJson(row.model_fallbacks);
		const validated =
			parsed === undefined ? null : validMappings(parsed, "model_fallbacks");
		const hasArrayValue =
			validated !== null &&
			Object.values(parsed as Record<string, unknown>).some(Array.isArray);
		if (validated && !hasArrayValue) {
			fallbacks = validated as Record<string, string>;
		} else {
			warnings.push(
				"removed invalid model_fallbacks, which the router ignored",
			);
		}
	}

	const merged: ModelMappings = { ...(accountMappings ?? {}) };
	let contributed = false;
	if (endpointMappings && Object.keys(endpointMappings).length > 0) {
		Object.assign(merged, endpointMappings);
		contributed = true;
	}
	for (const [family, fallback] of Object.entries(fallbacks ?? {})) {
		contributed = true;
		const existing = merged[family];
		if (existing === undefined) {
			merged[family] = fallback;
			continue;
		}
		const candidates = Array.isArray(existing) ? existing : [existing];
		if (candidates.includes(fallback)) continue;
		if (candidates.length >= MAX_MODEL_MAPPING_CANDIDATES) {
			warnings.push(
				`dropped model_fallbacks value for '${family}' because the mapping already has ${MAX_MODEL_MAPPING_CANDIDATES} candidates, as the router did`,
			);
			continue;
		}
		merged[family] = [...candidates, fallback];
	}

	if (contributed && row.model_mappings?.trim() && accountMappings === null) {
		warnings.push(
			"replaced unparseable model_mappings, which the router ignored",
		);
	}

	let customEndpoint = row.custom_endpoint;
	if (hasEndpointMappings) {
		const { modelMappings: _removed, ...rest } = endpoint;
		customEndpoint = JSON.stringify(rest);
	}

	return {
		model_mappings: contributed ? JSON.stringify(merged) : row.model_mappings,
		custom_endpoint: customEndpoint,
		warnings,
	};
}
