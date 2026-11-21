/**
 * Read AWS shared credentials and config file contents (~/.aws/credentials,
 * ~/.aws/config) for a profile name taken from a CLI argument or an API body.
 *
 * The name is compared as literal text and never built into a regular
 * expression, so a `.`, `*` or `(` in it can neither match another profile's
 * section nor make the match throw or backtrack.
 */

function lines(content: string): string[] {
	return content.split(/\r?\n/);
}

function isSectionHeader(line: string): boolean {
	return line.trimStart().startsWith("[");
}

/** Whether the credentials file content has a `[profile]` section header. */
export function hasAwsCredentialsProfile(
	content: string,
	profile: string,
): boolean {
	const header = `[${profile}]`;
	return lines(content).some((line) => line.trimStart().startsWith(header));
}

/**
 * The `region` value in the config file section for a profile: `[default]` for
 * the default profile, `[profile <name>]` for a named one. Returns null when the
 * section or its region line is missing.
 */
export function readAwsConfigRegion(
	content: string,
	profile: string,
): string | null {
	const header = profile === "default" ? "[default]" : `[profile ${profile}]`;
	const all = lines(content);
	const start = all.findIndex((line) => line.trimStart().startsWith(header));
	if (start === -1) return null;
	for (const line of all.slice(start + 1)) {
		if (isSectionHeader(line)) return null;
		const region = line.match(/^region\s*=\s*(.+)$/);
		if (region) return region[1].trim();
	}
	return null;
}
