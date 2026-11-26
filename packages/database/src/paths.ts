import { join } from "node:path";
import { getPlatformConfigDir } from "@hov-router/config";

export function resolveDbPath(): string {
	// Check for explicit DB path from environment (support both old and new env var names)
	const explicitPath =
		process.env.HOV_ROUTER_DB_PATH || process.env.HOV_ROUTER_DB_PATH;
	if (explicitPath) {
		return explicitPath;
	}

	const configDir = getPlatformConfigDir();

	// Always use the same database path for consistency
	// For development/testing, specify a different database using:
	// - Environment variable: HOV_ROUTER_DB_PATH=/path/to/dev.db
	// - Command line flag: --db-path /path/to/dev.db
	// - .env file: HOV_ROUTER_DB_PATH=/path/to/dev.db
	return join(configDir, "hov-router.db");
}
