import {
	BadRequest,
	Conflict,
	HttpError,
	ServiceUnavailable,
} from "@hov-router/errors";
import {
	MAX_STORED_ROUTE_PROFILES_BYTES,
	type ModelRouteProfile,
	type ModelRouteProfileController,
	ModelRouteProfilesConflictError,
	ModelRouteProfilesInvalidError,
	ModelRouteProfilesUnavailableError,
	modelRouteProfileModelIds,
} from "@hov-router/proxy";
import { errorResponse, jsonResponse } from "../utils/http-error";

export interface RouteProfileAccount {
	readonly id: string;
	readonly name: string;
}

export interface RouteProfilesHandlerDependencies {
	readonly controller: ModelRouteProfileController | undefined;
	readonly listAccounts: () => Promise<readonly RouteProfileAccount[]>;
}

/** One lane as the router resolved it; `profiles` keeps the written form. */
interface RouteLaneView {
	id: string;
	displayName: string;
	modelIds: readonly string[];
	accountId?: string;
	accountName?: string;
	selection?: string;
	logicalModel: string;
	exclusiveAccount: boolean;
}

/** The same cap as the stored set; nothing reads a larger body. */
const MAX_BODY_BYTES = MAX_STORED_ROUTE_PROFILES_BYTES;

/**
 * GET /api/route-profiles: the lanes in force, as written (`profiles`, what a
 * PUT sends back) and as resolved (`lanes`), with the revision to edit
 * against (#971).
 */
export function createRouteProfilesGetHandler(
	deps: RouteProfilesHandlerDependencies,
) {
	return async (): Promise<Response> => {
		try {
			const controller = requireController(deps.controller);
			await controller.reconcile();
			return jsonResponse({
				success: true,
				data: await describe(controller, deps),
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

/**
 * PUT /api/route-profiles with `{revision, profiles}` replaces the whole lane
 * set. It takes effect at once: no restart, no deploy.
 */
export function createRouteProfilesPutHandler(
	deps: RouteProfilesHandlerDependencies,
) {
	return async (req: Request): Promise<Response> => {
		try {
			const controller = requireController(deps.controller);
			const body = await readObjectBody(req);
			try {
				await controller.replace(body);
			} catch (error) {
				throw toHttpError(error);
			}
			return jsonResponse({
				success: true,
				data: await describe(controller, deps),
			});
		} catch (error) {
			return errorResponse(error);
		}
	};
}

function requireController(
	controller: ModelRouteProfileController | undefined,
): ModelRouteProfileController {
	if (!controller) {
		throw ServiceUnavailable("Route profiles are not editable on this server");
	}
	return controller;
}

function toHttpError(error: unknown): unknown {
	if (error instanceof ModelRouteProfilesInvalidError) {
		return BadRequest(error.message, { code: error.code });
	}
	if (error instanceof ModelRouteProfilesConflictError) {
		return Conflict(error.message, {
			code: error.code,
			revision: error.currentRevision,
		});
	}
	if (error instanceof ModelRouteProfilesUnavailableError) {
		return ServiceUnavailable(error.message);
	}
	return error;
}

async function readObjectBody(req: Request): Promise<Record<string, unknown>> {
	const declared = Number(req.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		throw tooLarge();
	}
	const text = await req.text();
	if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw tooLarge();
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw BadRequest("request body must contain valid JSON");
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw BadRequest(
			"request body must be a JSON object with revision and profiles",
		);
	}
	return value as Record<string, unknown>;
}

function tooLarge(): HttpError {
	return new HttpError(413, "Route profiles must be at most 256 KiB as JSON");
}

async function describe(
	controller: ModelRouteProfileController,
	deps: RouteProfilesHandlerDependencies,
) {
	const profiles = controller.getProfiles();
	const accountNames = new Map(
		(await deps.listAccounts()).map((account) => [account.id, account.name]),
	);
	const warnings: string[] = [];
	for (const profile of profiles) {
		if (profile.accountId && !accountNames.has(profile.accountId)) {
			warnings.push(
				`lane ${profile.id}: account ${profile.accountId} matches no account`,
			);
		}
	}
	return {
		revision: controller.getRevision(),
		profiles: controller.getDefinitions(),
		lanes: profiles.map((profile) => laneView(profile, accountNames)),
		status: controller.getStatus(),
		warnings,
	};
}

function laneView(
	profile: ModelRouteProfile,
	accountNames: ReadonlyMap<string, string>,
): RouteLaneView {
	const view: RouteLaneView = {
		id: profile.id,
		displayName: profile.displayName,
		modelIds: modelRouteProfileModelIds(profile),
		logicalModel: profile.logicalModel,
		exclusiveAccount: profile.exclusiveAccount === true,
	};
	if (profile.accountId) {
		view.accountId = profile.accountId;
		const name = accountNames.get(profile.accountId);
		if (name !== undefined) view.accountName = name;
	}
	if (profile.selection) view.selection = profile.selection;
	return view;
}
