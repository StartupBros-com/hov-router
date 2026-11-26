import { join } from "node:path";
import { DB_FILENAME, getPlatformConfigDir } from "@hov-router/config";

export function resolveDbPath(): string {
	const explicitPath = process.env.HOV_ROUTER_DB_PATH;
	if (explicitPath) {
		return explicitPath;
	}

	const configDir = getPlatformConfigDir();

	// Always use the same database path for consistency
	// For development/testing, specify a different database using:
	// - Environment variable: HOV_ROUTER_DB_PATH=/path/to/dev.db
	// - Command line flag: --db-path /path/to/dev.db
	// - .env file: HOV_ROUTER_DB_PATH=/path/to/dev.db
	return join(configDir, DB_FILENAME);
}
