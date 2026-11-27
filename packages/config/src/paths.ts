import { join } from "node:path";
import { CONFIG_FILENAME, getPlatformConfigDir } from "./paths-common";

export function resolveConfigPath(): string {
	const explicitPath = process.env.HOV_ROUTER_CONFIG_PATH;
	if (explicitPath) {
		return explicitPath;
	}

	// Use common platform config directory
	const configDir = getPlatformConfigDir();
	return join(configDir, CONFIG_FILENAME);
}
