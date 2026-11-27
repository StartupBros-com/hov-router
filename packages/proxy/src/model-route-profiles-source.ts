import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { getPlatformConfigDir } from "@hov-router/config";
import { Logger } from "@hov-router/logger";
import {
	MODEL_ROUTE_PROFILES_ENV,
	type ModelRouteProfile,
	parseModelRouteProfiles,
} from "./model-route-profiles";

const log = new Logger("ModelRouteProfiles");

/**
 * Names a file holding the same JSON array as `HOV_ROUTER_MODEL_ROUTE_PROFILES_JSON`.
 * The backend reads it at every start, so a backend-only deploy (or any other
 * backend restart under the running guard) loads an edit. An environment
 * value reaches the backend only on a full unit restart.
 */
export const MODEL_ROUTE_PROFILES_FILE_ENV =
	"HOV_ROUTER_MODEL_ROUTE_PROFILES_FILE" as const;

const MAX_PROFILES_FILE_BYTES = 256 * 1024;
// The record holds the profile text plus a few small fields.
const MAX_LAST_GOOD_FILE_BYTES = 2 * MAX_PROFILES_FILE_BYTES;
const LAST_GOOD_FILE_NAME = "model-route-profiles.last-good.json";

export interface ModelRouteProfilesStatus {
	/** `database`: the stored lanes, edited live through the API (#971). */
	source: "none" | "env" | "file" | "database";
	/** `last_good`: the file could not be used, so the last copy that loaded is in force. */
	status: "ok" | "last_good";
	count: number;
	path?: string;
	/** sha256 of the profile bytes in force (the file's, or the last-good copy's). */
	sha256?: string;
	/** File source only: a last-good copy of the profiles in force is on disk. */
	fallbackReady?: boolean;
	/** Database source only: the stored revision in force. */
	revision?: number;
	/** Database source only: this variable is still set but no longer read. */
	ignored?: "env" | "file";
	/** Why the file was not used; present only with `last_good`. Logged, not served. */
	error?: string;
}

export interface LoadedModelRouteProfiles {
	profiles: readonly ModelRouteProfile[];
	status: ModelRouteProfilesStatus;
	/** The text the profiles in force were parsed from; absent when none is set. */
	raw?: string;
}

export interface LoadModelRouteProfilesOptions {
	/** Where the last good file contents are kept. Defaults to the config directory. */
	lastGoodPath?: string;
}

interface LastGoodRecord {
	version: 1;
	path: string;
	sha256: string;
	savedAt: string;
	raw: string;
}

export function defaultModelRouteProfilesLastGoodPath(): string {
	return join(getPlatformConfigDir(), LAST_GOOD_FILE_NAME);
}

/**
 * Load the route profiles for this process from the file or the environment.
 *
 * A malformed environment value stays a startup error, as before. A file can
 * change under a running router, and the runner restarts the backend on its
 * own (memory recycle, deploy rollback), so a broken file falls back to the
 * last copy that loaded, and says so. With no such copy it is a startup error.
 */
export function loadModelRouteProfiles(
	env: Record<string, string | undefined> = process.env,
	options: LoadModelRouteProfilesOptions = {},
): LoadedModelRouteProfiles {
	const raw = env[MODEL_ROUTE_PROFILES_ENV];
	const configuredPath = env[MODEL_ROUTE_PROFILES_FILE_ENV];
	const rawSet = raw !== undefined && raw.trim() !== "";
	const path = configuredPath?.trim();

	if (!path) {
		const profiles = parseModelRouteProfiles(raw);
		return {
			profiles,
			status: {
				source: rawSet ? "env" : "none",
				status: "ok",
				count: profiles.length,
			},
			...(rawSet ? { raw } : {}),
		};
	}
	if (rawSet) {
		throw new Error(
			`${MODEL_ROUTE_PROFILES_FILE_ENV} and ${MODEL_ROUTE_PROFILES_ENV} are both set; set only one`,
		);
	}
	if (!isAbsolute(path)) {
		throw new Error(
			`${MODEL_ROUTE_PROFILES_FILE_ENV} must be an absolute path (got ${path})`,
		);
	}

	const lastGoodPath =
		options.lastGoodPath ?? defaultModelRouteProfilesLastGoodPath();
	let failure: Error;
	try {
		const text = readProfilesFile(path);
		const profiles = parseFileProfiles(path, text);
		const sha256 = sha256Hex(text);
		const fallbackReady = saveLastGood(lastGoodPath, path, sha256, text);
		return {
			profiles,
			status: {
				source: "file",
				status: "ok",
				count: profiles.length,
				path,
				sha256,
				fallbackReady,
			},
			raw: text,
		};
	} catch (error) {
		failure = error instanceof Error ? error : new Error(String(error));
	}

	const fallback = readLastGood(lastGoodPath, path);
	if (!fallback) {
		throw new Error(`${failure.message}; no last-good copy to fall back to`);
	}
	log.error(
		`Route profiles file could not be used; serving the last good copy (sha256 ${fallback.sha256}): ${failure.message}`,
	);
	return {
		profiles: fallback.profiles,
		status: {
			source: "file",
			status: "last_good",
			count: fallback.profiles.length,
			path,
			sha256: fallback.sha256,
			fallbackReady: true,
			error: failure.message,
		},
		raw: fallback.raw,
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function fileError(path: string, message: string): Error {
	return new Error(`${MODEL_ROUTE_PROFILES_FILE_ENV} (${path}): ${message}`);
}

interface SecureReadPolicy {
	maxBytes: number;
	/** Mode bits that must be clear. */
	forbiddenModeBits: number;
	/** Owners accepted besides this process's own user. */
	allowRootOwner: boolean;
}

/**
 * Read a regular file without following a final symlink or blocking on a FIFO,
 * enforcing its owner and mode on the opened descriptor.
 */
function readSecureFile(
	path: string,
	policy: SecureReadPolicy,
	fail: (message: string) => Error,
): string {
	let fd: number;
	try {
		fd = openSync(
			path,
			fsConstants.O_RDONLY |
				(fsConstants.O_NOFOLLOW ?? 0) |
				(fsConstants.O_NONBLOCK ?? 0),
		);
	} catch (error) {
		throw fail(`cannot open (${errorText(error)})`);
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw fail("must be a regular file");
		// Windows reports no POSIX owner or group/other bits worth checking.
		if (process.platform !== "win32") {
			if ((stat.mode & policy.forbiddenModeBits) !== 0) {
				throw fail(
					policy.forbiddenModeBits === 0o022
						? "must not be writable by group or others"
						: "must not be accessible by group or others",
				);
			}
			const euid =
				typeof process.geteuid === "function" ? process.geteuid() : undefined;
			if (
				euid !== undefined &&
				stat.uid !== euid &&
				!(policy.allowRootOwner && stat.uid === 0)
			) {
				throw fail(
					policy.allowRootOwner
						? "must be owned by root or by the user the router runs as"
						: "must be owned by the user the router runs as",
				);
			}
		}
		if (stat.size > policy.maxBytes) {
			throw fail(`must be at most ${policy.maxBytes} bytes (is ${stat.size})`);
		}
		const buffer = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < buffer.length) {
			const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
			if (read === 0) break;
			offset += read;
		}
		return buffer.subarray(0, offset).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function readProfilesFile(path: string): string {
	const text = readSecureFile(
		path,
		{
			maxBytes: MAX_PROFILES_FILE_BYTES,
			forbiddenModeBits: 0o022,
			allowRootOwner: true,
		},
		(message) => fileError(path, message),
	);
	if (text.trim() === "") {
		throw fileError(path, "is empty; write [] for no profiles");
	}
	return text;
}

function parseFileProfiles(
	path: string,
	text: string,
): readonly ModelRouteProfile[] {
	try {
		return parseModelRouteProfiles(text);
	} catch (error) {
		const message = errorText(error);
		const prefix = `${MODEL_ROUTE_PROFILES_ENV}: `;
		throw fileError(
			path,
			message.startsWith(prefix) ? message.slice(prefix.length) : message,
		);
	}
}

/** sha256 of profile text as /health reports it: the file's bytes, or the stored text. */
export function modelRouteProfilesSha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

const sha256Hex = modelRouteProfilesSha256;

/** The copy lives in the router's own config directory; accept only a private file it owns. */
function readLastGoodRecord(lastGoodPath: string): LastGoodRecord | undefined {
	let text: string;
	try {
		text = readSecureFile(
			lastGoodPath,
			{
				maxBytes: MAX_LAST_GOOD_FILE_BYTES,
				forbiddenModeBits: 0o077,
				allowRootOwner: false,
			},
			(message) => new Error(`last-good copy ${lastGoodPath}: ${message}`),
		);
	} catch (error) {
		const message = errorText(error);
		// A missing copy is the normal first-load state; anything else is worth a line.
		if (!message.includes("ENOENT")) log.warn(message);
		return undefined;
	}
	try {
		const record = JSON.parse(text) as Partial<LastGoodRecord> | null;
		if (
			typeof record === "object" &&
			record !== null &&
			record.version === 1 &&
			typeof record.path === "string" &&
			typeof record.sha256 === "string" &&
			typeof record.raw === "string" &&
			sha256Hex(record.raw) === record.sha256
		) {
			return record as LastGoodRecord;
		}
	} catch {
		// Not JSON: treated as no copy.
	}
	log.warn(`last-good copy ${lastGoodPath} is not a valid record; ignoring it`);
	return undefined;
}

function readLastGood(
	lastGoodPath: string,
	path: string,
):
	| { profiles: readonly ModelRouteProfile[]; sha256: string; raw: string }
	| undefined {
	const record = readLastGoodRecord(lastGoodPath);
	if (!record || record.path !== path) return undefined;
	try {
		return {
			profiles: parseModelRouteProfiles(record.raw),
			sha256: record.sha256,
			raw: record.raw,
		};
	} catch (error) {
		log.error(
			`Last-good route profiles copy no longer parses: ${errorText(error)}`,
		);
		return undefined;
	}
}

/** Returns whether a last-good copy of exactly these profiles is now on disk. */
function saveLastGood(
	lastGoodPath: string,
	path: string,
	sha256: string,
	raw: string,
): boolean {
	const existing = readLastGoodRecord(lastGoodPath);
	if (existing?.path === path && existing.sha256 === sha256) return true;
	const record: LastGoodRecord = {
		version: 1,
		path,
		sha256,
		savedAt: new Date().toISOString(),
		raw,
	};
	const temporary = `${lastGoodPath}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(lastGoodPath), { recursive: true, mode: 0o700 });
		// `wx` refuses an existing path, so a planted symlink is never written through.
		writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temporary, lastGoodPath);
		return true;
	} catch (error) {
		try {
			rmSync(temporary, { force: true });
		} catch {
			// Bun's rmSync throws EFAULT, not a no-op, when the directory is not
			// one; a cleanup failure must not turn a lost fallback into a failed start.
		}
		// The profiles loaded; only the fallback for a later broken edit is lost.
		log.warn(
			`Could not save the last-good route profiles copy to ${lastGoodPath}: ${errorText(error)}`,
		);
		return false;
	}
}

let activeProfiles: readonly ModelRouteProfile[] | undefined;

/** Record the profiles in force, for readers outside the request path. Live edits update it (#971). */
export function setActiveModelRouteProfiles(
	profiles: readonly ModelRouteProfile[] | undefined,
): void {
	activeProfiles = profiles;
}

/**
 * The profiles in force in this process. Outside the server (tests, tools)
 * nothing is registered, and this parses the JSON variable as before.
 */
export function activeModelRouteProfiles(): readonly ModelRouteProfile[] {
	return activeProfiles ?? parseModelRouteProfiles();
}
