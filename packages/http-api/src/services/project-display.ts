/**
 * Display sanitiser for a request's `project` value wherever the alert
 * pipeline shows one. Moved here from the retired anomaly detectors (7.0.0,
 * #1012); the alert list still uses it at its read boundary.
 */

/**
 * Display cap for project names. The upstream `project` field on requests
 * is built from free-form text (#368 — known to sometimes leak prompt
 * content), so this is a defense-in-depth at the presentation layer: any
 * string leaving the API/alert pipeline through a `project` slot is
 * stripped of control characters and clamped to this many chars with an
 * ellipsis. Longer values look like obvious junk to the operator rather
 * than authentic-looking prompt content.
 */
export const PROJECT_DISPLAY_MAX_CHARS = 64;
/** Replacement character used when an input cannot be rendered. */
const ELLIPSIS = "…";

/**
 * Defence-in-depth sanitiser for values that originate as a request's
 * `project` field. The real extraction bug (prompt content leaking into
 * `project`) is fixed upstream in proxy/src/project-attribution.ts (#368)
 * — this function does not address that, it only ensures that whatever
 * reaches the JSON response or an alert message can never render as if
 * it were a normal label.
 *
 * - null / undefined / empty -> null
 * - control chars (incl. newlines, tabs) are stripped
 * - collapses runs of whitespace
 * - clamps to PROJECT_DISPLAY_MAX_CHARS, appending an ellipsis when truncated
 */
export function sanitizeProjectForDisplay(
	raw: string | null | undefined,
): string | null {
	if (raw == null) return null;
	// Strip ANSI CSI sequences FIRST while the leading ESC byte is
	// still present, then strip remaining C0 control chars (incl. any
	// orphan ESC) and DEL so prompt content cannot smuggle terminal
	// control bytes through the UI. See sanitizeProjectName in
	// packages/proxy/src/project-attribution.ts for the same pattern.
	const stripped = raw
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI sequences are the target, not a literal
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: C0 control range is the target, not a literal
		.replace(/[\x00-\x1f\x7f]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (stripped === "") return null;
	if (stripped.length <= PROJECT_DISPLAY_MAX_CHARS) return stripped;
	return stripped.slice(0, PROJECT_DISPLAY_MAX_CHARS - 1) + ELLIPSIS;
}
