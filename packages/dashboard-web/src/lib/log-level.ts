import type { StatusTone } from "./request-status";

/** Tone for a log level: ERROR danger, WARN and WARNING warning, INFO info. */
export function logLevelTone(level: string | undefined): StatusTone {
	switch (level?.toUpperCase()) {
		case "ERROR":
			return "danger";
		case "WARN":
		case "WARNING":
			return "warning";
		case "INFO":
			return "info";
		default:
			return "neutral";
	}
}

/** The level as the Logs page prints it: upper-cased, "LOG" when missing. */
export function logLevelLabel(level: string | undefined): string {
	return level ? level.toUpperCase() : "LOG";
}
