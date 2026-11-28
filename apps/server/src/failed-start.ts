import { isStorageFullError } from "@hov-router/core";
import { StartOutOfSpaceError } from "@hov-router/database";

/**
 * What a start that failed for lack of disk space exits with: the errno of
 * ENOSPC.
 *
 * The runner (`scripts/run-hov-router.sh`) reads it. After this status it
 * waits for space and starts the backend again, and does not count the
 * failure toward the restart circuit that takes the unit down (#827). The
 * runner and the transaction module carry the same number; a test holds the
 * three together.
 */
export const OUT_OF_SPACE_EXIT_STATUS = 28;

/** How far down a `cause` chain to look. Real chains are two or three deep. */
const MAX_CAUSE_DEPTH = 8;

function refusedForSpace(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (current instanceof StartOutOfSpaceError) return true;
		if (typeof current !== "object" || current === null) return false;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * The exit status for a start that failed with `error`.
 *
 * Out of space means the database open the start gave up on
 * (`StartOutOfSpaceError`) or a write that says the disk is full. An I/O
 * error is not that: it can come from a failing device, and a runner waiting
 * for space on a disk that is not full would wait for ever. The database open
 * holds to the same rule: the index I/O error it sees on a full disk becomes
 * a `StartOutOfSpaceError` only when the filesystem is short of room as well
 * (`openWithStartReserve`).
 */
export function failedStartExitStatus(error: unknown): number {
	return refusedForSpace(error) || isStorageFullError(error)
		? OUT_OF_SPACE_EXIT_STATUS
		: 1;
}

/**
 * An error and its causes on one line: the name, message and code of each.
 */
function describeOnOneLine(error: unknown): string {
	const parts: string[] = [];
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (typeof current !== "object" || current === null) {
			parts.push(String(current));
			break;
		}
		const { name, message, code, cause } = current as {
			name?: unknown;
			message?: unknown;
			code?: unknown;
			cause?: unknown;
		};
		const said = [name, message]
			.filter((part) => typeof part === "string" && part !== "")
			.join(": ");
		parts.push(
			typeof code === "string" || typeof code === "number"
				? `${said || "error"} [${code}]`
				: said || "error",
		);
		if (cause === undefined) break;
		current = cause;
	}
	return parts.join("; caused by ").replace(/\s+/g, " ");
}

export interface FailedStartOptions {
	/** Replace the process in tests. */
	exit?: (code: number) => void;
	report?: (line: string, error?: unknown) => void;
}

/**
 * End the process after a start that failed, with a status that says whether
 * the disk was full.
 *
 * Both entry points pass a failed `startServer()` here. Before, the failure
 * was a rejection nobody handled, which the runtime turns into exit code 1
 * whatever the cause, so the runner could not tell a full disk from a broken
 * build.
 *
 * A start that found no space is reported in one line, without the error
 * itself. The runner starts the backend again for as long as the disk stays
 * full, and the compiled build prints a page of its own bundled source under
 * an error it is handed. Any other failed start still shows the error, stack
 * included.
 */
export function exitOnFailedStart(
	error: unknown,
	options: FailedStartOptions = {},
): void {
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const report =
		options.report ??
		((line: string, ...cause: unknown[]) => console.error(line, ...cause));
	const status = failedStartExitStatus(error);
	try {
		if (status === OUT_OF_SPACE_EXIT_STATUS) {
			report(
				`[start] failed because there is no space left on the disk; exiting with status ${status}: ${describeOnOneLine(error)}`,
			);
		} else {
			report(`[start] failed; exiting with status ${status}:`, error);
		}
	} catch {
		// stderr can be unwritable for the same reason the start failed.
	}
	exit(status);
}
