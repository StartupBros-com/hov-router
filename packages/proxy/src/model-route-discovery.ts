import {
	getModelDisplayName,
	getModelFamily,
	isFirstPartyAnthropicAccount,
	isRouteOnlyClaudeModelId,
} from "@better-ccflare/core";
import { previewAccountPhysicalModel } from "@better-ccflare/providers";
import type { Account, QualityApprovedLine } from "@better-ccflare/types";
import {
	getCodexCatalogLineTarget,
	getCodexCatalogRoleTarget,
	getKnownCodexModels,
} from "./codex-model-catalog";
import { getRouteProfileConstraintViolation } from "./handlers/account-selector";
import type {
	ModelRouteProfile,
	ModelRouteSessionRegistry,
} from "./model-route-profiles";
import {
	clipPickerText,
	describeModelRouteProfileFlow,
} from "./model-route-profiles";

const MAX_DISPLAY_NAME_LENGTH = 120;

export interface ModelRouteDiscoveryModel {
	readonly id: string;
	readonly display_name: string;
	readonly description: string;
}

/** In-memory lookups only: discovery never refreshes catalogs or calls providers. */
export interface ModelRouteDiscoveryDeps {
	readonly catalogRoleTarget: (
		accountId: string,
		family: NonNullable<ReturnType<typeof getModelFamily>>,
	) => string | null;
	readonly catalogLineTarget: (
		accountId: string,
		line: QualityApprovedLine,
	) => string | null;
	readonly codexModelDisplayName: (
		accountId: string,
		model: string,
	) => string | null;
	readonly previewPhysicalModel: (
		account: Account,
		logicalModel: string,
	) => string | null;
}

const DEFAULT_DEPS: ModelRouteDiscoveryDeps = {
	catalogRoleTarget: getCodexCatalogRoleTarget,
	catalogLineTarget: getCodexCatalogLineTarget,
	codexModelDisplayName: (accountId, model) =>
		getKnownCodexModels(accountId)?.models.find((entry) => entry.id === model)
			?.displayName ?? null,
	previewPhysicalModel: (account, logicalModel) =>
		previewAccountPhysicalModel(account, logicalModel),
};

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function clip(value: string): string {
	return clipPickerText(value, MAX_DISPLAY_NAME_LENGTH);
}

/**
 * An account belongs to a route when the selector's own constraint would admit
 * it. A cold catalog is not a rejection: role targets publish shortly after a
 * restart, and hiding the row meanwhile would strand clients that start then.
 */
function admits(profile: ModelRouteProfile, account: Account): boolean {
	if (account.paused) return false;
	const violation = getRouteProfileConstraintViolation(
		account,
		{
			routeProfileId: profile.id,
			routeProfileSelection: profile.selection ?? null,
			routeProfileLogicalModel: profile.logicalModel,
			routeExpectedProvider: profile.expectedProvider ?? null,
			routeExpectedPhysicalModel: profile.expectedPhysicalModel ?? null,
			routeProfileExpectedPhysicalModel: profile.expectedPhysicalModel ?? null,
			routePhysicalModelPolicy: profile.physicalModelPolicy ?? null,
			routeProfileLine: profile.line ?? null,
			routeCatalogRoleTargetByAccountId: null,
		},
		profile.logicalModel,
	);
	return violation === null || violation === "catalog_role_unavailable";
}

function servedModel(
	profile: ModelRouteProfile,
	account: Account,
	deps: ModelRouteDiscoveryDeps,
): string | null {
	if (profile.physicalModelPolicy === "catalog-role") {
		const family = getModelFamily(profile.logicalModel);
		return family ? deps.catalogRoleTarget(account.id, family) : null;
	}
	if (profile.physicalModelPolicy === "line") {
		return profile.line
			? deps.catalogLineTarget(account.id, profile.line)
			: null;
	}
	return (
		profile.expectedPhysicalModel ??
		deps.previewPhysicalModel(account, profile.logicalModel) ??
		routeOnlyNativeModel(profile, account)
	);
}

/**
 * No provider preview knows a route-only model (Mythos), on purpose: that keeps
 * it out of ordinary routing. A first-party Anthropic account forwards the
 * profile's model unchanged, so that is the model it serves.
 */
function routeOnlyNativeModel(
	profile: ModelRouteProfile,
	account: Account,
): string | null {
	return isRouteOnlyClaudeModelId(profile.logicalModel) &&
		isFirstPartyAnthropicAccount(account)
		? profile.logicalModel
		: null;
}

function servedModelLabel(
	profile: ModelRouteProfile,
	account: Account,
	deps: ModelRouteDiscoveryDeps,
): string | null {
	const model = servedModel(profile, account, deps);
	if (!model) return null;
	const vendorName =
		account.provider === "codex"
			? deps.codexModelDisplayName(account.id, model)
			: null;
	return oneLine(vendorName || getModelDisplayName(model)) || null;
}

interface DiscoveryRow {
	readonly id: string;
	/** The served model(s), or null while unknown. */
	readonly served: string | null;
	readonly where: string;
	readonly fallback: string;
	readonly description: string;
}

/**
 * Picker rows titled with what each route serves right now, so a catalog
 * reorder, a new model generation or a remapped account relabels the picker
 * with no config edit. Routes no account can serve are left out. The operator
 * `displayName` is only the fallback while the served model is unknown.
 *
 * The title is the model alone; where the lane runs leads the description.
 * Rows whose titles would match get ` · <where>` back so they stay distinct.
 */
export function buildModelRouteDiscoveryModels(
	registry: ModelRouteSessionRegistry,
	accounts: readonly Account[],
	deps: ModelRouteDiscoveryDeps = DEFAULT_DEPS,
): ModelRouteDiscoveryModel[] {
	const rows: DiscoveryRow[] = [];
	for (const profile of registry.getProfiles()) {
		const pooled = profile.selection === "capability";
		const members = accounts.filter(
			(account) =>
				(pooled
					? !registry.isProfileOnlyAccount(account.id)
					: account.id === profile.accountId) && admits(profile, account),
		);
		if (members.length === 0) continue;

		const served = [
			...new Set(
				members
					.map((account) => servedModelLabel(profile, account, deps))
					.filter((label): label is string => label !== null),
			),
		].sort();
		// A blank name reads as "one account", like the static rows.
		const accountName = pooled ? null : oneLine(members[0]?.name ?? "") || null;
		const context = profile.clientContextWindowHint === "1m" ? " (1M)" : "";
		rows.push({
			id: profile.discoveryModelId,
			served:
				served.length > 0 ? clip(`${served.join(" / ")}${context}`) : null,
			where: pooled
				? `${profile.expectedProvider ?? "account"} pool`
				: (accountName ?? "one account"),
			fallback: profile.displayName,
			description: describeModelRouteProfileFlow(profile, accountName),
		});
	}

	const titleCounts = new Map<string, number>();
	for (const row of rows) {
		const title = row.served ?? row.fallback;
		titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
	}
	return rows.map((row) => ({
		id: row.id,
		display_name:
			row.served === null
				? row.fallback
				: (titleCounts.get(row.served) ?? 0) > 1
					? clip(`${row.served} · ${row.where}`)
					: row.served,
		description: row.description,
	}));
}

/**
 * One local account read per discovery request. If it fails, the static
 * operator rows are better than no picker at all.
 */
export async function listModelRouteDiscoveryModels(
	registry: ModelRouteSessionRegistry,
	loadAccounts: () => Promise<readonly Account[]>,
	deps: ModelRouteDiscoveryDeps = DEFAULT_DEPS,
): Promise<ModelRouteDiscoveryModel[]> {
	let accounts: readonly Account[];
	try {
		accounts = await loadAccounts();
	} catch {
		return [...registry.getDiscoveryModels()];
	}
	return buildModelRouteDiscoveryModels(registry, accounts, deps);
}
