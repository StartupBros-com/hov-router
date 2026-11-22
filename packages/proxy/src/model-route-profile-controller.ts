import { Logger } from "@better-ccflare/logger";
import {
	MODEL_ROUTE_PROFILES_ENV,
	type ModelRouteProfile,
	type ModelRouteSessionRegistry,
	parseModelRouteProfiles,
} from "./model-route-profiles";
import {
	type LoadedModelRouteProfiles,
	loadModelRouteProfiles,
	MODEL_ROUTE_PROFILES_FILE_ENV,
	type ModelRouteProfilesStatus,
	modelRouteProfilesSha256,
	setActiveModelRouteProfiles,
} from "./model-route-profiles-source";

const log = new Logger("ModelRouteProfiles");

/** The same cap as the profiles file. */
export const MAX_STORED_ROUTE_PROFILES_BYTES = 256 * 1024;
const DEFAULT_REVISION_WATCH_MS = 5_000;

/** The stored lane set: the JSON array text exactly as written, and its revision. */
export interface StoredModelRouteProfiles {
	readonly raw: string;
	readonly revision: number;
	readonly updatedAt: number;
	readonly source: string;
}

/** Persistence for the lane set; DatabaseOperations implements it. */
export interface ModelRouteProfileStore {
	getModelRouteProfileConfig(): Promise<StoredModelRouteProfiles | null>;
	getModelRouteProfileRevision(): Promise<number | null>;
	/** Returns the new revision, or null when the stored revision is not `expectedRevision` (0: none stored). */
	saveModelRouteProfileConfig(input: {
		raw: string;
		expectedRevision: number;
		source: string;
		now: number;
	}): Promise<number | null>;
}

export interface StartModelRouteProfilesOptions {
	/** Absent outside the server (tools, narrow tests): file or environment only, no live edits. */
	readonly store?: ModelRouteProfileStore;
	readonly env?: Record<string, string | undefined>;
	readonly lastGoodPath?: string;
	readonly now?: () => number;
}

/** A lane set the parser refused, or a body that is not one. */
export class ModelRouteProfilesInvalidError extends Error {
	readonly code = "invalid_route_profiles";
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ModelRouteProfilesInvalidError";
	}
}

/** The caller edited an older revision than the one stored. */
export class ModelRouteProfilesConflictError extends Error {
	readonly code = "stale_route_profiles";
	constructor(readonly currentRevision: number) {
		super(
			`The route profiles changed (now revision ${currentRevision}); read them again and reapply your edit`,
		);
		this.name = "ModelRouteProfilesConflictError";
	}
}

export class ModelRouteProfilesUnavailableError extends Error {
	constructor() {
		super("This server has no database store for route profiles");
		this.name = "ModelRouteProfilesUnavailableError";
	}
}

interface ProfilesInForce {
	readonly profiles: readonly ModelRouteProfile[];
	readonly status: ModelRouteProfilesStatus;
	/** The text they were parsed from; absent when none is configured. */
	readonly raw: string | undefined;
	/** The stored revision; 0 when the lanes do not come from the database. */
	readonly revision: number;
}

/**
 * Owns the route lanes in force in this process (#971). The database row is
 * the truth once it exists: every write is a compare-and-swap on its revision,
 * and reads re-check it, so an edit made through another backend (the old one
 * during a backend-only handoff) is picked up without a restart. Each change
 * is applied to the session registry, the module-level reader and /health at
 * once.
 */
export class ModelRouteProfileController {
	private current: ProfilesInForce;
	private registry: ModelRouteSessionRegistry | undefined;
	private pendingReconcile: Promise<boolean> | null = null;
	private rejectedRevision: number | null = null;
	private watch: ReturnType<typeof setInterval> | null = null;

	private constructor(
		private readonly store: ModelRouteProfileStore | undefined,
		private readonly ignored: "env" | "file" | undefined,
		private readonly now: () => number,
		initial: ProfilesInForce,
	) {
		this.current = initial;
		setActiveModelRouteProfiles(initial.profiles);
	}

	/**
	 * Precedence: a stored set is the only source. Without one, the file or
	 * environment variable loads as before and, when it parsed, is imported
	 * byte for byte as revision 1. Stored lanes that do not parse in this build
	 * are a startup error, as an unparseable file with no fallback is, so a
	 * deploy's health gate refuses the build instead of serving no lanes.
	 */
	static async start(
		options: StartModelRouteProfilesOptions = {},
	): Promise<ModelRouteProfileController> {
		const env = options.env ?? process.env;
		const now = options.now ?? Date.now;
		const store = options.store;
		const ignored = configuredVariable(env);
		const create = (initial: ProfilesInForce) =>
			new ModelRouteProfileController(store, ignored, now, initial);

		if (store) {
			const stored = await store.getModelRouteProfileConfig();
			if (stored) {
				if (ignored) {
					log.warn(
						`${variableName(ignored)} is set, but the database holds the route profiles (revision ${stored.revision}); the variable is not read. Edit lanes on the dashboard's Route Lanes page or through /api/route-profiles.`,
					);
				}
				return create(fromStored(stored, parseStoredAtStart(stored), ignored));
			}
		}

		const loaded = loadModelRouteProfiles(env, {
			lastGoodPath: options.lastGoodPath,
		});
		const fromLoaded: ProfilesInForce = {
			profiles: loaded.profiles,
			status: loaded.status,
			raw: loaded.raw,
			revision: 0,
		};
		if (!store || !importable(loaded)) return create(fromLoaded);

		const source = `import:${loaded.status.source}`;
		try {
			await store.saveModelRouteProfileConfig({
				raw: loaded.raw,
				expectedRevision: 0,
				source,
				now: now(),
			});
			// Insert-if-absent, then read back: another backend may have stored first.
			const stored = await store.getModelRouteProfileConfig();
			if (stored) {
				const profiles =
					stored.raw === loaded.raw
						? loaded.profiles
						: parseStoredAtStart(stored);
				log.info(
					`Route profiles stored in the database as revision ${stored.revision} (${stored.source}); edit them through /api/route-profiles from now on.`,
				);
				return create(fromStored(stored, profiles, ignored));
			}
		} catch (error) {
			log.warn(
				`Could not store the route profiles in the database; serving them from ${loaded.status.source} for this run: ${errorText(error)}`,
			);
		}
		return create(fromLoaded);
	}

	getProfiles(): readonly ModelRouteProfile[] {
		return this.current.profiles;
	}

	getStatus(): ModelRouteProfilesStatus {
		return this.current.status;
	}

	/** 0 when the lanes in force do not come from the database. */
	getRevision(): number {
		return this.current.revision;
	}

	/** The lane definitions as written (family names unresolved), for editing. */
	getDefinitions(): unknown[] {
		const raw = this.current.raw;
		if (raw === undefined || raw.trim() === "") return [];
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	}

	/** The registry the proxy routes with; it follows every later change. */
	attachRegistry(registry: ModelRouteSessionRegistry): void {
		this.registry = registry;
		registry.setProfiles(this.current.profiles);
	}

	/**
	 * Replace the whole lane set. `revision` is the one the caller read (0 when
	 * none is stored); a stale one is refused, so two editors never silently
	 * overwrite each other.
	 */
	async replace(input: {
		revision?: unknown;
		profiles?: unknown;
	}): Promise<void> {
		const store = this.store;
		if (!store) throw new ModelRouteProfilesUnavailableError();
		const { revision, profiles } = input;
		if (
			typeof revision !== "number" ||
			!Number.isSafeInteger(revision) ||
			revision < 0
		) {
			throw new ModelRouteProfilesInvalidError(
				"revision must be the revision you read (0 when none is stored)",
			);
		}
		if (!Array.isArray(profiles)) {
			throw new ModelRouteProfilesInvalidError(
				"profiles must be a JSON array of lanes",
			);
		}
		const raw = `${JSON.stringify(profiles, null, 2)}\n`;
		if (Buffer.byteLength(raw, "utf8") > MAX_STORED_ROUTE_PROFILES_BYTES) {
			throw new ModelRouteProfilesInvalidError(
				"profiles must be at most 256 KiB as JSON",
			);
		}
		let parsed: readonly ModelRouteProfile[];
		try {
			parsed = parseModelRouteProfiles(raw);
		} catch (error) {
			throw new ModelRouteProfilesInvalidError(
				withoutVariablePrefix(errorText(error)),
				{ cause: error },
			);
		}

		const updatedAt = this.now();
		const saved = await store.saveModelRouteProfileConfig({
			raw,
			expectedRevision: revision,
			source: "api",
			now: updatedAt,
		});
		if (saved === null) {
			await this.reconcile();
			throw new ModelRouteProfilesConflictError(
				(await store.getModelRouteProfileRevision()) ?? 0,
			);
		}
		this.applyIfNewer(
			fromStored(
				{ raw, revision: saved, updatedAt, source: "api" },
				parsed,
				this.ignored,
			),
		);
		log.info(
			`Route profiles updated through the API: revision ${saved}, ${parsed.length} lanes, sha256 ${modelRouteProfilesSha256(raw)}`,
		);
	}

	/**
	 * Re-read the stored revision and apply a newer stored set. Returns whether
	 * the lanes in force changed. Concurrent calls share one read.
	 */
	reconcile(): Promise<boolean> {
		const store = this.store;
		if (!store) return Promise.resolve(false);
		if (this.pendingReconcile) return this.pendingReconcile;
		this.pendingReconcile = this.reconcileOnce(store).finally(() => {
			this.pendingReconcile = null;
		});
		return this.pendingReconcile;
	}

	/** Check the stored revision on an interval (unref'd); a no-op without a store. */
	startRevisionWatch(intervalMs = DEFAULT_REVISION_WATCH_MS): void {
		if (!this.store || this.watch) return;
		this.watch = setInterval(() => {
			void this.reconcile();
		}, intervalMs);
		this.watch.unref?.();
	}

	stopRevisionWatch(): void {
		if (!this.watch) return;
		clearInterval(this.watch);
		this.watch = null;
	}

	private async reconcileOnce(store: ModelRouteProfileStore): Promise<boolean> {
		let stored: StoredModelRouteProfiles | null;
		try {
			const revision = await store.getModelRouteProfileRevision();
			if (
				revision === null ||
				revision === this.current.revision ||
				revision === this.rejectedRevision
			) {
				return false;
			}
			stored = await store.getModelRouteProfileConfig();
		} catch (error) {
			log.warn(`Could not read the stored route profiles: ${errorText(error)}`);
			return false;
		}
		if (!stored || stored.revision === this.current.revision) return false;
		let profiles: readonly ModelRouteProfile[];
		try {
			profiles = parseModelRouteProfiles(stored.raw);
		} catch (error) {
			this.rejectedRevision = stored.revision;
			log.error(
				`Stored route profiles revision ${stored.revision} do not parse in this build; keeping revision ${this.current.revision}: ${withoutVariablePrefix(errorText(error))}`,
			);
			return false;
		}
		const applied = this.applyIfNewer(
			fromStored(stored, profiles, this.ignored),
		);
		if (applied) {
			log.info(
				`Route profiles reloaded from the database: revision ${stored.revision}, ${profiles.length} lanes`,
			);
		}
		return applied;
	}

	/** Stored revisions only move forward; lanes not from the database yield to any stored set. */
	private applyIfNewer(next: ProfilesInForce): boolean {
		if (
			this.current.status.source === "database" &&
			next.revision <= this.current.revision
		) {
			return false;
		}
		this.current = next;
		setActiveModelRouteProfiles(next.profiles);
		this.registry?.setProfiles(next.profiles);
		return true;
	}
}

function configuredVariable(
	env: Record<string, string | undefined>,
): "env" | "file" | undefined {
	if (env[MODEL_ROUTE_PROFILES_FILE_ENV]?.trim()) return "file";
	if (env[MODEL_ROUTE_PROFILES_ENV]?.trim()) return "env";
	return undefined;
}

function variableName(source: "env" | "file"): string {
	return source === "file"
		? MODEL_ROUTE_PROFILES_FILE_ENV
		: MODEL_ROUTE_PROFILES_ENV;
}

function importable(
	loaded: LoadedModelRouteProfiles,
): loaded is LoadedModelRouteProfiles & { raw: string } {
	return (
		loaded.raw !== undefined &&
		loaded.status.status === "ok" &&
		(loaded.status.source === "file" || loaded.status.source === "env")
	);
}

function fromStored(
	stored: StoredModelRouteProfiles,
	profiles: readonly ModelRouteProfile[],
	ignored: "env" | "file" | undefined,
): ProfilesInForce {
	return {
		profiles,
		raw: stored.raw,
		revision: stored.revision,
		status: {
			source: "database",
			status: "ok",
			count: profiles.length,
			sha256: modelRouteProfilesSha256(stored.raw),
			revision: stored.revision,
			...(ignored ? { ignored } : {}),
		},
	};
}

function parseStoredAtStart(
	stored: StoredModelRouteProfiles,
): readonly ModelRouteProfile[] {
	try {
		return parseModelRouteProfiles(stored.raw);
	} catch (error) {
		throw new Error(
			`stored route profiles (revision ${stored.revision}) do not parse in this build: ${withoutVariablePrefix(errorText(error))}`,
			{ cause: error },
		);
	}
}

function withoutVariablePrefix(message: string): string {
	const prefix = `${MODEL_ROUTE_PROFILES_ENV}: `;
	return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
