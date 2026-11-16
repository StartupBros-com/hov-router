import type { PillTone } from "../components/ui/status-pill";

export type StatusTone = Extract<
	PillTone,
	"neutral" | "success" | "info" | "warning" | "danger"
>;

/** Tone for an HTTP status: 2xx success, 3xx info, 4xx warning, 5xx danger. */
export function httpStatusTone(status: number | null | undefined): StatusTone {
	if (status == null) return "neutral";
	if (status >= 200 && status < 300) return "success";
	if (status >= 300 && status < 400) return "info";
	if (status >= 400 && status < 500) return "warning";
	if (status >= 500 && status < 600) return "danger";
	return "neutral";
}

/**
 * What a request row shows for its status. A request with no status code reads
 * "Pending" while it runs and "No response" once it has finished.
 */
export function requestStatusDisplay({
	statusCode,
	pending,
	isError,
}: {
	statusCode: number | null | undefined;
	pending: boolean;
	isError: boolean;
}): { text: string; tone: StatusTone } {
	if (statusCode) {
		return { text: String(statusCode), tone: httpStatusTone(statusCode) };
	}
	if (pending) return { text: "Pending", tone: "neutral" };
	return { text: "No response", tone: isError ? "danger" : "neutral" };
}
