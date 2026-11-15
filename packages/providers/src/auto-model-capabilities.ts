import { createHash } from "node:crypto";
import {
	REASONING_EFFORT_VALUES,
	type ReasoningEffort,
} from "@better-ccflare/openai-formats";
import type {
	QualityApprovedLine,
	QualityProvider,
} from "@better-ccflare/types";

type EvidenceValue =
	| null
	| boolean
	| number
	| string
	| readonly EvidenceValue[]
	| { readonly [key: string]: EvidenceValue };

/** Facts only. Null is unknown, never a provider default or predecessor value. */
export interface AutoModelCapabilities {
	readonly contextWindow: number | null;
	readonly maxContextWindow: number | null;
	readonly effectiveContextPercent: number | null;
	readonly maxOutputTokens: number | null;
	/** Only Codex's absent/null catalog field delegates acceptance, not malformed data. */
	readonly providerManagedOutput: boolean;
	readonly inputModalities: readonly string[] | null;
	/** Exact owned Codex catalog support; unknown never grants effort preservation. */
	readonly supportedReasoningEfforts: readonly ReasoningEffort[] | null;
	/** The catalog's default effort, kept only when it is one of
	 * supportedReasoningEfforts, as the adapter's reasoning snapshot keeps it. */
	readonly defaultReasoningEffort: ReasoningEffort | null;
	/** Provider-specific evidence, not a generic tool support grant. */
	readonly toolEvidence: Readonly<Record<string, EvidenceValue>>;
	readonly nativeCapabilities: EvidenceValue;
	readonly revision: string;
}

/** Exact supported identities, oldest to newest. This is not lane policy or
 * entitlement: the compiled U1 policy still owns assignments/enrollment. No
 * prefix matcher, catalog priority or upgrade-to-an-unfamiliar-name adds an ID.
 * Sources: approved native model facts and observed Codex catalog identities.
 * New identities require reviewed support evidence before joining this adapter.
 */
const SUPPORTED_IDENTITIES: Readonly<
	Record<
		QualityApprovedLine,
		{ provider: QualityProvider; models: readonly string[] }
	>
> = {
	"claude-fable": { provider: "anthropic", models: ["claude-fable-5-1"] },
	"gpt-astra": { provider: "codex", models: ["gpt-6-astra"] },
	"claude-opus": { provider: "anthropic", models: ["claude-opus-5-5"] },
	"gpt-sol": { provider: "codex", models: ["gpt-5.6-sol", "gpt-6.1-sol"] },
	"claude-sonnet": { provider: "anthropic", models: ["claude-sonnet-5-5"] },
	"claude-haiku": {
		provider: "anthropic",
		models: ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
	},
};

/** Approved lines whose supported identities `provider` serves. */
export function getSupportedLines(
	provider: QualityProvider,
): QualityApprovedLine[] {
	return (Object.keys(SUPPORTED_IDENTITIES) as QualityApprovedLine[]).filter(
		(line) => SUPPORTED_IDENTITIES[line].provider === provider,
	);
}

/**
 * Every approved line's supported identities, oldest to newest, as a fresh
 * copy. Read-only reporting (the catalogue-gap alert): adding an identity
 * here still needs reviewed support evidence in SUPPORTED_IDENTITIES.
 */
export function getSupportedLineIdentities(): Record<
	QualityApprovedLine,
	readonly string[]
> {
	const lines = {} as Record<QualityApprovedLine, readonly string[]>;
	for (const line of Object.keys(
		SUPPORTED_IDENTITIES,
	) as QualityApprovedLine[]) {
		lines[line] = [...SUPPORTED_IDENTITIES[line].models];
	}
	return lines;
}

/** The newest supported identity of `line` among `modelIds`, or null. */
export function newestSupportedLineModel(
	line: QualityApprovedLine,
	modelIds: readonly string[],
): string | null {
	return (
		[...SUPPORTED_IDENTITIES[line].models]
			.reverse()
			.find((id) => modelIds.includes(id)) ?? null
	);
}

export function positiveSafeCapacity(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: null;
}

// Canonical key order gives stable content revisions, and copies/freezes every
// retained value so mutating a transport response cannot alter frozen evidence.
function evidenceValue(value: unknown, depth = 0): EvidenceValue {
	if (depth > 12) return null;
	if (value === null || typeof value === "boolean" || typeof value === "string")
		return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (Array.isArray(value))
		return Object.freeze(value.map((item) => evidenceValue(item, depth + 1)));
	if (value && typeof value === "object") {
		return Object.freeze(
			Object.fromEntries(
				Object.entries(value)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, item]) => [key, evidenceValue(item, depth + 1)]),
			),
		);
	}
	return null;
}

function revision(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function normalizeAutoModelCapabilities(
	provider: QualityProvider,
	raw: Readonly<Record<string, unknown>>,
): AutoModelCapabilities {
	const percent = raw.effective_context_window_percent;
	const modalities = raw.input_modalities;
	const inputModalities = new Set<string>(
		Array.isArray(modalities) &&
			modalities.every(
				(item) =>
					typeof item === "string" &&
					["text", "image", "audio", "video", "pdf"].includes(item),
			)
			? modalities
			: [],
	);
	const nativeCapabilities =
		provider === "anthropic" ? evidenceValue(raw.capabilities) : null;
	if (provider === "anthropic") {
		// Reviewed exact IDs share the documented text baseline; never infer by prefix.
		// https://platform.claude.com/docs/en/about-claude/models/overview.md
		if (
			Object.values(SUPPORTED_IDENTITIES).some(
				(support) =>
					support.provider === provider &&
					typeof raw.id === "string" &&
					support.models.includes(raw.id),
			)
		)
			inputModalities.add("text");
		if (
			nativeCapabilities &&
			typeof nativeCapabilities === "object" &&
			!Array.isArray(nativeCapabilities)
		) {
			for (const [key, modality] of [
				["image_input", "image"],
				["pdf_input", "pdf"],
			] as const) {
				const capability = (
					nativeCapabilities as Record<string, EvidenceValue>
				)[key];
				if (
					!capability ||
					typeof capability !== "object" ||
					Array.isArray(capability)
				)
					continue;
				const supported = (capability as Record<string, EvidenceValue>)
					.supported;
				if (supported === true) inputModalities.add(modality);
				else if (supported === false) inputModalities.delete(modality);
			}
		}
	}
	const toolEvidence: Record<string, EvidenceValue> = {};
	for (const key of [
		"tool_mode",
		"supports_search_tool",
		"web_search_tool_type",
		"experimental_supported_tools",
		"supports_image_detail_original",
	]) {
		if (Object.hasOwn(raw, key)) toolEvidence[key] = evidenceValue(raw[key]);
	}
	const levels = raw.supported_reasoning_levels;
	const supportedReasoningEfforts =
		provider === "codex" &&
		Array.isArray(levels) &&
		levels.length > 0 &&
		levels.length <= REASONING_EFFORT_VALUES.length &&
		Array.from(levels).every(
			(level) =>
				level !== null &&
				typeof level === "object" &&
				!Array.isArray(level) &&
				REASONING_EFFORT_VALUES.includes(level.effort),
		)
			? Object.freeze([
					...new Set<ReasoningEffort>(levels.map((level) => level.effort)),
				])
			: null;
	const defaultLevel = raw.default_reasoning_level;
	const facts = {
		supportedReasoningEfforts,
		defaultReasoningEffort:
			supportedReasoningEfforts?.find((effort) => effort === defaultLevel) ??
			null,
		contextWindow: positiveSafeCapacity(
			provider === "codex" ? raw.context_window : raw.max_input_tokens,
		),
		maxContextWindow: positiveSafeCapacity(
			provider === "codex" ? raw.max_context_window : raw.max_input_tokens,
		),
		effectiveContextPercent:
			provider === "codex" &&
			typeof percent === "number" &&
			Number.isFinite(percent) &&
			percent > 0 &&
			percent <= 100
				? percent
				: null,
		maxOutputTokens: positiveSafeCapacity(
			provider === "codex" ? raw.max_output_tokens : raw.max_tokens,
		),
		providerManagedOutput:
			provider === "codex" &&
			(!Object.hasOwn(raw, "max_output_tokens") ||
				raw.max_output_tokens === null),
		inputModalities: inputModalities.size
			? Object.freeze([...inputModalities])
			: null,
		toolEvidence: Object.freeze(toolEvidence),
		nativeCapabilities,
	};
	if (
		facts.contextWindow !== null &&
		facts.maxContextWindow !== null &&
		facts.contextWindow > facts.maxContextWindow
	) {
		facts.contextWindow = null;
		facts.maxContextWindow = null;
	}
	return Object.freeze({
		...facts,
		revision: `quality-capability-v1:${revision([provider, facts])}`,
	});
}
