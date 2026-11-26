import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	CONFIG_DIR_NAME,
	CONFIG_FILENAME,
	DB_FILENAME,
	getPlatformConfigBaseDir,
} from "./paths-common";

/**
 * HoV Router 8.0.0 renamed the names it inherited from better-ccflare and reads
 * only the new ones. A name it no longer reads would otherwise fall back in
 * silence: an ignored database path opens an empty default database, and an
 * ignored host setting binds every interface. These checks find the old names
 * so startup can refuse instead.
 *
 * Kept free of other application imports so entry points can run it before
 * any module reads the environment.
 */

/** EX_CONFIG: a configuration error that a restart cannot fix. */
export const RETIRED_NAME_EXIT_CODE = 78;

const RETIRED_CONFIG_DIR_NAME = "better-ccflare";
const RETIRED_FILE_STEM = "better-ccflare";
const RETIRED_HEADER_PREFIX = "x-better-ccflare-";

export interface RetiredEnvName {
	readonly name: string;
	readonly replacement: string;
}

export interface RetiredPath {
	readonly path: string;
	readonly replacement: string;
}

export function findRetiredEnvNames(
	env: Record<string, string | undefined>,
): RetiredEnvName[] {
	const found: RetiredEnvName[] = [];
	for (const name of Object.keys(env).sort()) {
		if (env[name] === undefined) continue;
		const replacement = replacementEnvName(name);
		if (replacement) found.push({ name, replacement });
	}
	return found;
}

function replacementEnvName(name: string): string | null {
	// The health endpoint's SHA override and the build provenance SHA were two
	// names before the rename and stay two, so one cannot certify the other.
	if (name === "BETTER_CCFLARE_GIT_SHA") return "HOV_ROUTER_HEALTH_GIT_SHA";
	for (const prefix of ["BETTER_CCFLARE_", "CCFLARE_", "ccflare_"]) {
		if (name.startsWith(prefix))
			return `HOV_ROUTER_${name.slice(prefix.length)}`;
	}
	return null;
}

export function findRetiredStorage(
	options: {
		env?: Record<string, string | undefined>;
		home?: string;
		configBase?: string;
	} = {},
): RetiredPath[] {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const base = options.configBase ?? getPlatformConfigBaseDir();
	const found: RetiredPath[] = [];

	const oldDir = join(base, RETIRED_CONFIG_DIR_NAME);
	const newDir = join(base, CONFIG_DIR_NAME);
	if (existsSync(oldDir) && !existsSync(newDir)) {
		found.push({ path: oldDir, replacement: newDir });
	}

	const configPath =
		env.HOV_ROUTER_CONFIG_PATH || join(newDir, CONFIG_FILENAME);
	const dbPath = env.HOV_ROUTER_DB_PATH || join(newDir, DB_FILENAME);
	for (const [current, oldName] of [
		[configPath, `${RETIRED_FILE_STEM}.json`],
		[dbPath, `${RETIRED_FILE_STEM}.db`],
	] as const) {
		const old = join(dirname(current), oldName);
		if (!existsSync(current) && existsSync(old)) {
			found.push({ path: old, replacement: current });
		}
	}
	// SQLite keeps committed pages in the -wal file until a checkpoint. A
	// database renamed without its log would open without them.
	const oldWal = join(dirname(dbPath), `${RETIRED_FILE_STEM}.db-wal`);
	if (oldWal !== `${dbPath}-wal` && existsSync(dbPath) && existsSync(oldWal)) {
		found.push({ path: oldWal, replacement: `${dbPath}-wal` });
	}

	const oldWorkspaces = join(home, ".better-ccflare", "workspaces.json");
	const newWorkspaces = join(home, ".hov-router", "workspaces.json");
	if (existsSync(oldWorkspaces) && !existsSync(newWorkspaces)) {
		found.push({ path: oldWorkspaces, replacement: newWorkspaces });
	}
	return found;
}

export function retiredNamesMessage(
	envNames: readonly RetiredEnvName[],
	paths: readonly RetiredPath[],
): string {
	const lines = [
		"HoV Router 8.0.0 renamed the names it inherited from better-ccflare and reads only the new ones.",
		'Rename these, then start it again (see "Renamed in 8.0.0" in docs/hov-router-migration.md):',
	];
	for (const { name, replacement } of envNames)
		lines.push(`  ${name} -> ${replacement}`);
	for (const { path, replacement } of paths)
		lines.push(`  ${path} -> ${replacement}`);
	return lines.join("\n");
}

/**
 * Exit with RETIRED_NAME_EXIT_CODE when the environment or the filesystem still
 * uses a retired name. Prints names and paths, never environment values.
 */
export function refuseRetiredNames(
	env: Record<string, string | undefined> = process.env,
): void {
	const envNames = findRetiredEnvNames(env);
	const paths = findRetiredStorage({ env });
	if (envNames.length === 0 && paths.length === 0) return;
	process.stderr.write(`${retiredNamesMessage(envNames, paths)}\n`);
	process.exit(RETIRED_NAME_EXIT_CODE);
}

export function findRetiredHeaders(headers: Headers): string[] {
	const found: string[] = [];
	for (const name of headers.keys()) {
		if (name.toLowerCase().startsWith(RETIRED_HEADER_PREFIX))
			found.push(name.toLowerCase());
	}
	return found.sort();
}

export function retiredHeaderResponse(names: readonly string[]): Response {
	const renames = names
		.map(
			(name) =>
				`${name} was renamed to x-hov-router-${name.slice(RETIRED_HEADER_PREFIX.length)}`,
		)
		.join("; ");
	return Response.json(
		{
			type: "error",
			error: {
				type: "invalid_request_error",
				message: `HoV Router 8.0.0 no longer reads these request headers: ${renames}.`,
			},
		},
		{ status: 400 },
	);
}
