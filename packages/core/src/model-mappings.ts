import { Logger } from "@better-ccflare/logger";
import type { Account, ComboFamily } from "@better-ccflare/types";
import { isForceAccountModelEnabled } from "./force-account-model";
import {
	LATEST_MODEL_BY_FAMILY,
	LATEST_ROUTE_ONLY_MODEL_BY_FAMILY,
} from "./models";
import {
	safeJsonParse,
	validateEndpointUrl,
	validateModelMappings,
} from "./validation";

const log = new Logger("ModelMappings");

// Inline types to avoid Bun import issues
// Types are now defined in index.ts and exported from there

// Known model family patterns for O(1) direct matching
// Pattern order: Check "fable" before "opus" before "haiku" before "sonnet" to avoid substring
// collisions in edge cases like "claude-opus-haiku-test" (though we would never see this pattern from the client)
export const KNOWN_PATTERNS = ["fable", "opus", "haiku", "sonnet"] as const;

/**
 * Get the model family (fable/opus/sonnet/haiku) from a model ID
 * Uses the same pattern matching as mapModelName()
 * @returns Model family or null if no pattern matches
 */
export function getModelFamily(
	modelId: string,
): "fable" | "opus" | "sonnet" | "haiku" | null {
	const normalized = modelId.toLowerCase();
	for (const pattern of KNOWN_PATTERNS) {
		if (normalized.includes(pattern)) {
			return pattern;
		}
	}
	return null;
}

/**
 * Recognize only canonical logical Claude model IDs for policy-pin conversion.
 * Unlike getModelFamily(), this deliberately rejects provider-qualified and
 * arbitrary custom model names that merely contain a family word.
 */
export function getStrictClaudeModelFamily(
	modelId: string,
): ComboFamily | null {
	const match = /^claude-(fable|opus|haiku|sonnet)(?:-|$)/i.exec(modelId);
	return (match?.[1]?.toLowerCase() as ComboFamily | undefined) ?? null;
}

/**
 * A well-formed concrete Claude model id: `claude-<family>-<digits>[-<digits>...][-<YYYYMMDD>]`.
 * Matches ids Claude Code actually sends (e.g. claude-opus-5-5, claude-fable-5-1,
 * claude-sonnet-4-5-20250929) while rejecting bare family aliases and
 * malformed/preview-style ids like "claude-opus-preview-xyz" or bare "claude-opus".
 * Deliberately does NOT check membership in CLAUDE_MODEL_IDS/any catalog — a
 * model released today must still shape-match so same-family pass-through
 * routing (see combo-membership-resolver.ts) doesn't silently downgrade it to
 * LATEST_MODEL_BY_FAMILY just because the bundled catalog hasn't caught up yet.
 */
export const CONCRETE_CLAUDE_MODEL_ID_PATTERN =
	/^claude-(?:fable|opus|sonnet|haiku)-\d+(?:-\d+)*(?:-\d{8})?$/i;

export function isWellFormedConcreteClaudeModelId(value: string): boolean {
	return CONCRETE_CLAUDE_MODEL_ID_PATTERN.test(value.trim());
}

/**
 * Check whether a stored value is a bare "family alias" — the literal family
 * name itself (e.g. "opus") used as a placeholder meaning "resolve to the
 * latest model in this family at read time", instead of a concrete model ID.
 * Comparison is trim + case-insensitive.
 */
export function isFamilyAliasModel(
	value: string,
	family: ComboFamily,
): boolean {
	return value.trim().toLowerCase() === family;
}

/**
 * Resolve a stored managed-model/slot-model value that may be a bare family
 * alias into a concrete model ID. If `value` (trimmed) equals the family name
 * itself, returns the currently-latest model for that family
 * (LATEST_MODEL_BY_FAMILY) — UNLESS `requestedModel` is a well-formed concrete
 * Claude id of that same family, in which case the client's own requested id
 * is passed through untouched instead. This is the "anthropic-passthrough"
 * fix: a bare alias means "track this family", not "always rewrite to the
 * newest release", so an older client (entitled only to an older version) or
 * a request for a model newer than the bundled catalog both keep their own
 * id rather than being silently upgraded or downgraded. A malformed id, or
 * one whose family doesn't match, falls back to today's LATEST behavior.
 * Otherwise (not a bare alias) returns the trimmed value unchanged — a
 * concrete pin always wins over pass-through.
 */
export function resolveFamilyAliasModel(
	value: string,
	family: ComboFamily,
	requestedModel?: string | null,
): string {
	const trimmed = value.trim();
	if (trimmed.toLowerCase() === family) {
		if (
			requestedModel &&
			isWellFormedConcreteClaudeModelId(requestedModel) &&
			getStrictClaudeModelFamily(requestedModel) === family
		) {
			return requestedModel;
		}
		return LATEST_MODEL_BY_FAMILY[family];
	}
	return trimmed;
}

/**
 * Resolve a stored policy or slot model that is exactly a supported bare family
 * alias. Unlike resolveFamilyAliasModel(), this derives the alias family from
 * the stored value itself so a manual combo slot may intentionally target a
 * different family than its combo assignment. `requestedModel`, when given, is
 * forwarded to resolveFamilyAliasModel so a same-family concrete request can
 * pass through instead of being rewritten to LATEST_MODEL_BY_FAMILY.
 */
export function resolveStoredPolicyAliasModel(
	value: string,
	requestedModel?: string | null,
): string {
	const trimmed = value.trim();
	const family = KNOWN_PATTERNS.find(
		(candidate) => candidate === trimmed.toLowerCase(),
	);
	return family
		? resolveFamilyAliasModel(trimmed, family, requestedModel)
		: trimmed;
}

/**
 * Resolve a route profile's logicalModel: a bare family name, a combo family
 * ("opus") or a route-only one ("mythos"), becomes the router's latest model in
 * that family; anything else is returned trimmed and unchanged. Only route
 * profiles call this. Combo slots and stored policies use
 * resolveStoredPolicyAliasModel, which never learns a route-only family.
 */
export function resolveRouteProfileModelAlias(value: string): string {
	const trimmed = value.trim();
	return (
		LATEST_ROUTE_ONLY_MODEL_BY_FAMILY.get(trimmed.toLowerCase()) ??
		resolveStoredPolicyAliasModel(trimmed)
	);
}

/**
 * Internal window key for a per-model weekly (weekly_scoped) limit, derived from
 * the model display name. Kept byte-identical between the dashboard usage rows
 * and the proxy throttle snapshots so the two match (throttle-window match /
 * amber highlight). Only needs to start with `seven_day_` (so the pace marker
 * treats it as a 7-day window) and be stable per model.
 */
export function weeklyScopedWindowKey(displayName: string): string {
	const slug = displayName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `seven_day_${slug}`;
}

/**
 * Validate if a model ID is a valid Claude model
 * Accepts any model containing fable, opus, sonnet, or haiku (case-insensitive)
 * @returns true if model matches a known pattern
 */
export function isValidClaudeModel(modelId: string): boolean {
	return getModelFamily(modelId) !== null;
}

/**
 * Get a user-friendly error message listing allowed model patterns
 * @returns Error message string for API responses
 */
export function getAllowedModelsMessage(): string {
	return "Model must contain one of: fable, opus, sonnet, haiku (e.g., claude-fable-5, claude-opus-4-6, claude-sonnet-4-5-20250929)";
}

/** Read the endpoint from a URL or endpoint JSON. */
export function parseCustomEndpointData(
	customEndpoint: string | null,
): { endpoint?: string } | null {
	if (!customEndpoint) return null;
	const trimmed = customEndpoint.trim();
	if (!trimmed.startsWith("{")) return { endpoint: trimmed };
	try {
		const parsed = safeJsonParse<{ endpoint?: string }>(
			trimmed,
			"custom_endpoint",
		);
		return { endpoint: parsed.endpoint };
	} catch (error) {
		log.warn("Failed to parse custom_endpoint JSON:", error);
		return { endpoint: trimmed };
	}
}

function parseRuntimeModelMappings(
	json: string,
	field: string,
): Record<string, string | string[]> {
	return validateModelMappings(safeJsonParse<unknown>(json, field), field);
}

/**
 * Parse model mappings from account's model_mappings field.
 * Values may be a single string or an ordered array of model names to try.
 */
export function parseModelMappings(
	modelMappings: string | null,
): Record<string, string | string[]> | null {
	if (!modelMappings) {
		return null;
	}

	try {
		return parseRuntimeModelMappings(modelMappings, "model_mappings");
	} catch (error) {
		log.warn(
			`Failed to parse model_mappings JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

/**
 * Normalise a model mapping value to an array.
 */
function toArray(value: string | string[]): string[] {
	return Array.isArray(value) ? value : [value];
}

export interface ConfiguredModelMapping {
	models: string[];
	match: "exact" | "family";
}

/**
 * Get effective account mappings over shared environment mappings.
 */
export function getModelMappings(
	account: Account,
): Record<string, string | string[]> {
	const mappings: Record<string, string | string[]> = {};

	// Check for environment variable overrides (only in Node.js)
	if (
		typeof process !== "undefined" &&
		process.env?.OPENAI_COMPATIBLE_MODEL_MAPPINGS
	) {
		try {
			const envMappings = parseRuntimeModelMappings(
				process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS,
				"OPENAI_COMPATIBLE_MODEL_MAPPINGS environment variable",
			);
			Object.assign(mappings, envMappings);
		} catch (error) {
			log.warn(
				"Failed to parse OPENAI_COMPATIBLE_MODEL_MAPPINGS environment variable:",
				error,
			);
		}
	}

	return mergeAccountModelMappings(account, mappings);
}

/**
 * Read only mappings stored on this account.
 * Shared environment mappings are not capability proof.
 */
export function getAccountOwnedModelMappings(
	account: Account,
): Record<string, string | string[]> {
	return mergeAccountModelMappings(account, {});
}

function mergeAccountModelMappings(
	account: Account,
	mappings: Record<string, string | string[]>,
): Record<string, string | string[]> {
	// Check for account-specific mappings in model_mappings field
	const accountMappings = parseModelMappings(account.model_mappings);
	if (accountMappings) {
		Object.assign(mappings, accountMappings);
	}

	return mappings;
}

/**
 * Resolve only an explicitly configured model mapping. Unlike getModelList(),
 * this returns null for ordinary pass-through so provider capability checks can
 * distinguish operator intent from an undeclared/default model.
 */
export function getConfiguredModelMapping(
	anthropicModel: string,
	account: Account,
): ConfiguredModelMapping | null {
	const mappings = getModelMappings(account);
	if (mappings[anthropicModel] !== undefined) {
		return { models: toArray(mappings[anthropicModel]), match: "exact" };
	}

	const family = getModelFamily(anthropicModel);
	if (family && mappings[family] !== undefined) {
		return { models: toArray(mappings[family]), match: "family" };
	}

	return null;
}

/**
 * Check whether an account has any model mapping configuration.
 * Returns false if the account should just forward the model name unchanged.
 */
function hasAccountModelMappings(account: Account): boolean {
	if (account.model_mappings) return true;
	// Check env override
	if (
		typeof process !== "undefined" &&
		process.env?.OPENAI_COMPATIBLE_MODEL_MAPPINGS
	) {
		try {
			const envMappings = parseRuntimeModelMappings(
				process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS,
				"OPENAI_COMPATIBLE_MODEL_MAPPINGS environment variable",
			);
			if (envMappings && Object.keys(envMappings).length > 0) return true;
		} catch {
			// Ignore — treat parse error as no env override
		}
	}

	return false;
}

/**
 * Get the ordered list of models to try for a given Anthropic model name.
 * Returns [primaryModel, ...fallbacks] from the account's model_mappings.
 * Returns null if the account has no model mapping configuration — the model
 * name should be forwarded unchanged to the upstream provider.
 */
export function getModelList(
	anthropicModel: string,
	account: Account,
): string[] | null {
	// No custom mappings configured — don't touch the model name
	if (!hasAccountModelMappings(account)) {
		return null;
	}

	const configured = getConfiguredModelMapping(anthropicModel, account);
	if (configured) return configured.models;

	// No mapping for this model — pass through unchanged
	return [anthropicModel];
}

/** Providers whose upstream natively accepts Claude model ids. */
const PROVIDERS_ACCEPTING_CLIENT_MODEL = new Set([
	"anthropic",
	"claude-console-api",
	"deepseek",
]);

/** Whether this provider understands a Claude model id without translation. */
export function providerAcceptsClientModel(
	provider: string | null | undefined,
): boolean {
	return PROVIDERS_ACCEPTING_CLIENT_MODEL.has(provider ?? "anthropic");
}

/**
 * Map Anthropic model name to provider-specific model name (first in list).
 * Optimized for known model patterns with direct matching (O(1) vs O(n log n))
 */
export function mapModelName(anthropicModel: string, account: Account): string {
	if (isForceAccountModelEnabled()) return anthropicModel;
	const list = getModelList(anthropicModel, account);
	if (!list) return anthropicModel;

	const mapped = list[0];

	if (
		process.env.DEBUG?.includes("model") ||
		process.env.DEBUG === "true" ||
		process.env.NODE_ENV === "development"
	) {
		log.info(`Model mapping: ${anthropicModel} -> ${mapped}`);
	}

	return mapped;
}

/**
 * Get endpoint URL from account.
 *
 * Returns the custom endpoint string when one is configured, or `null` when the
 * account has no endpoint. Callers that need a hard default (xAI) must supply
 * their own fallback — this function never silently defaults to the OpenAI host.
 *
 * This replaces the old behavior of falling back to `https://api.openai.com`,
 * which made missing endpoints silently route to OpenAI (R3).
 */
export function getEndpointUrl(
	account: Pick<Account, "custom_endpoint">,
): string | null {
	const customEndpointData = parseCustomEndpointData(account.custom_endpoint);

	if (customEndpointData?.endpoint) {
		// Use the parsed endpoint from JSON
		return customEndpointData.endpoint;
	}

	if (
		account.custom_endpoint &&
		!account.custom_endpoint.trim().startsWith("{")
	) {
		// Plain string URL
		return account.custom_endpoint.trim();
	}

	// No custom endpoint — return null so callers can fail closed (R3)
	return null;
}

/**
 * True only for an Anthropic account whose resolved endpoint is the
 * first-party API (https://api.anthropic.com, no port or credentials).
 * OAuth and API-key accounts both qualify. Fails closed on unparsable URLs.
 */
export function isFirstPartyAnthropicAccount(
	account: Pick<Account, "provider" | "custom_endpoint">,
): boolean {
	if (account.provider !== "anthropic") return false;
	const endpoint = getEndpointUrl(account) ?? "https://api.anthropic.com";
	try {
		const url = new URL(endpoint);
		return (
			url.protocol === "https:" &&
			url.hostname === "api.anthropic.com" &&
			!url.port &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
}

/**
 * A typed result for compatible-endpoint resolution.
 * Either the endpoint is available, or the account is unavailable with a reason.
 */
export type CompatibleEndpointResolution =
	| { ok: true; endpoint: string }
	| { ok: false };

/**
 * Resolve a compatible account's endpoint with fail-closed semantics (R3).
 *
 * Returns `{ ok: true, endpoint }` when the account has a valid, parseable
 * endpoint URL. Returns `{ ok: false }` when the endpoint is missing, empty,
 * or unparseable — the account becomes unavailable instead of silently
 * routing to the default OpenAI host.
 *
 * The returned endpoint is validated and has its trailing slash stripped.
 */
export function resolveCompatibleEndpoint(
	account: Account,
): CompatibleEndpointResolution {
	let raw: string | null;
	try {
		raw = getEndpointUrl(account);
	} catch {
		return { ok: false };
	}

	if (!raw) {
		return { ok: false };
	}

	try {
		const validated = validateEndpointUrl(raw, "endpoint");
		return { ok: true, endpoint: validated };
	} catch {
		return { ok: false };
	}
}

export function createCustomEndpointData(endpoint: string): string {
	return JSON.stringify({ endpoint });
}

/**
 * Validate model mappings for storage. Values may be a string or string[].
 */
export function validateAndSanitizeModelMappings(
	mappings: unknown,
): Record<string, string | string[]> | null {
	if (!mappings) {
		return null;
	}

	try {
		return validateModelMappings(mappings, "modelMappings");
	} catch (error) {
		log.warn(
			`Invalid model mappings: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}
