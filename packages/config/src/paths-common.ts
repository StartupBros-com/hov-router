import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

export const CONFIG_DIR_NAME = "hov-router";
export const CONFIG_FILENAME = "hov-router.json";
export const DB_FILENAME = "hov-router.db";

/** The platform directory that holds per-application config directories. */
export function getPlatformConfigBaseDir(): string {
	if (platform === "win32") {
		// Windows: Use LOCALAPPDATA or APPDATA
		return (
			process.env.LOCALAPPDATA ??
			process.env.APPDATA ??
			join(homedir(), "AppData", "Local")
		);
	}
	// Linux/macOS: Follow XDG Base Directory specification
	return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

/**
 * Get the platform-specific configuration directory for hov-router
 */
export function getPlatformConfigDir(): string {
	return join(getPlatformConfigBaseDir(), CONFIG_DIR_NAME);
}
