import { HttpError } from "@better-ccflare/http-common";
import { api } from "../api";

/**
 * Adapter for the route lanes endpoints (#971): Claude Code `/model` route
 * profiles, stored in the database and edited live.
 *
 *   GET /api/route-profiles
 *     -> { success, data: { revision, profiles, lanes, status, warnings } }
 *        `profiles` is the set as written (what a PUT sends back); `lanes`
 *        is each lane resolved for display.
 *   PUT /api/route-profiles   body { revision, profiles }
 *     -> 200 with the same data at the new revision
 *     -> 400 with the parser's message (invalid lanes)
 *     -> 409 when the revision is stale (the lanes changed since the read)
 *
 * Every write replaces the whole set, so an edit reads, modifies and writes
 * against the revision it read.
 */

/** A lane as written. Fields the form does not edit are kept as they are. */
export type RouteLaneDefinition = Record<string, unknown> & { id: string };

export interface RouteLaneView {
	id: string;
	displayName: string;
	modelIds: string[];
	accountId?: string;
	accountName?: string;
	selection?: string;
	/** The model the lane serves, a family name resolved for this build. */
	logicalModel: string;
	exclusiveAccount: boolean;
}

export interface RouteLanesStatus {
	source: "none" | "env" | "file" | "database";
	status: "ok" | "last_good";
	count: number;
	sha256?: string;
	revision?: number;
	ignored?: "env" | "file";
}

export interface RouteLanes {
	revision: number;
	profiles: RouteLaneDefinition[];
	lanes: RouteLaneView[];
	status: RouteLanesStatus;
	warnings: string[];
}

export async function fetchRouteLanes(): Promise<RouteLanes> {
	const res = await api.get<{ success: boolean; data: RouteLanes }>(
		"/api/route-profiles",
	);
	return res.data;
}

export async function saveRouteLanes(input: {
	revision: number;
	profiles: readonly RouteLaneDefinition[];
}): Promise<RouteLanes> {
	const res = await api.put<{ success: boolean; data: RouteLanes }>(
		"/api/route-profiles",
		input,
	);
	return res.data;
}

/**
 * True when a save failed because the lanes changed after they were read.
 * The client keeps only the server's message string in `details` (see
 * `parseHttpError`), so the status is the signal: the endpoint answers 409
 * for nothing else.
 */
export function isStaleRouteLanesError(error: unknown): boolean {
	return error instanceof HttpError && error.status === 409;
}

export interface RouteLaneFormValues {
	id: string;
	displayName: string;
	accountId: string;
	logicalModel: string;
	description: string;
	exclusiveAccount: boolean;
}

export const EMPTY_LANE_FORM: RouteLaneFormValues = {
	id: "",
	displayName: "",
	accountId: "",
	logicalModel: "",
	description: "",
	exclusiveAccount: false,
};

export function laneFormValues(
	definition: RouteLaneDefinition,
): RouteLaneFormValues {
	const text = (key: string) => {
		const value = definition[key];
		return typeof value === "string" ? value : "";
	};
	return {
		id: definition.id,
		displayName: text("displayName"),
		accountId: text("accountId"),
		logicalModel: text("logicalModel"),
		description: text("description"),
		exclusiveAccount: definition.exclusiveAccount === true,
	};
}

/**
 * Apply the form to a lane, keeping every field the form does not edit
 * (aliases, effort, context window and the rest) exactly as written. A blank
 * optional field is removed rather than sent as an empty string.
 */
export function applyLaneForm(
	base: RouteLaneDefinition | undefined,
	values: RouteLaneFormValues,
): RouteLaneDefinition {
	const next: RouteLaneDefinition = { ...(base ?? {}), id: values.id.trim() };
	next.displayName = values.displayName.trim();
	next.logicalModel = values.logicalModel.trim();
	const accountId = values.accountId.trim();
	if (accountId) next.accountId = accountId;
	else delete next.accountId;
	const description = values.description.trim();
	if (description) next.description = description;
	else delete next.description;
	if (values.exclusiveAccount) next.exclusiveAccount = true;
	else delete next.exclusiveAccount;
	return next;
}

/** Replace the lane whose id is `originalId`, or append when it is null. */
export function upsertLane(
	profiles: readonly RouteLaneDefinition[],
	originalId: string | null,
	lane: RouteLaneDefinition,
): RouteLaneDefinition[] {
	if (originalId === null) return [...profiles, lane];
	let replaced = false;
	const next = profiles.map((profile) => {
		if (profile.id !== originalId) return profile;
		replaced = true;
		return lane;
	});
	return replaced ? next : [...next, lane];
}

export function removeLane(
	profiles: readonly RouteLaneDefinition[],
	id: string,
): RouteLaneDefinition[] {
	return profiles.filter((profile) => profile.id !== id);
}

/** What a save sends: the whole set, at the revision it was built from. */
export interface RouteLanesSave {
	revision: number;
	profiles: RouteLaneDefinition[];
}

/*
 * The save builders take the lanes as they were when the dialog opened, never
 * the live query data. A refetch while a dialog is open (after a 409, or on
 * window focus) must not pair the dialog's older content with the newer
 * revision: the server would accept that and drop the other writer's change.
 */

/** Save one lane added (`originalId` null) or edited through the form. */
export function laneEditSave(
	base: RouteLanes,
	originalId: string | null,
	values: RouteLaneFormValues,
): RouteLanesSave {
	const definition =
		originalId === null
			? undefined
			: base.profiles.find((profile) => profile.id === originalId);
	return {
		revision: base.revision,
		profiles: upsertLane(
			base.profiles,
			originalId,
			applyLaneForm(definition, values),
		),
	};
}

export function laneDeleteSave(base: RouteLanes, id: string): RouteLanesSave {
	return { revision: base.revision, profiles: removeLane(base.profiles, id) };
}

/** Save the "edit as JSON" text as the whole set. */
export function laneSetSave(
	base: RouteLanes,
	text: string,
): { ok: true; save: RouteLanesSave } | { ok: false; error: string } {
	const parsed = parseLaneSetText(text);
	if (!parsed.ok) return parsed;
	return {
		ok: true,
		save: { revision: base.revision, profiles: parsed.profiles },
	};
}

export function formatLaneSet(
	profiles: readonly RouteLaneDefinition[],
): string {
	return `${JSON.stringify(profiles, null, 2)}\n`;
}

/**
 * Parse the "edit as JSON" text. Only the shape is checked here (an array of
 * objects with a string id); the server validates everything else and its
 * message is shown as returned.
 */
export function parseLaneSetText(
	text: string,
):
	| { ok: true; profiles: RouteLaneDefinition[] }
	| { ok: false; error: string } {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return {
			ok: false,
			error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (!Array.isArray(value)) {
		return { ok: false, error: "The lane set must be a JSON array" };
	}
	for (const [index, entry] of value.entries()) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			Array.isArray(entry) ||
			typeof (entry as { id?: unknown }).id !== "string"
		) {
			return {
				ok: false,
				error: `Lane ${index} must be an object with a string id`,
			};
		}
	}
	return { ok: true, profiles: value as RouteLaneDefinition[] };
}
