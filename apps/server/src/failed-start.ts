import { isStorageFullError } from "@better-ccflare/core";
import { StartOutOfSpaceError } from "@better-ccflare/database";

/**
 * What a start that failed for lack of disk space exits with: the errno of
 * ENOSPC.
 *
 * The runner (`scripts/run-ccflare-stack.sh`) reads it. After this status it
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
 * for space on a disk that is not full would wait for ever.
 */
export function failedStartExitStatus(error: unknown): number {
	return refusedForSpace(error) || isStorageFullError(error)
		? OUT_OF_SPACE_EXIT_STATUS
		: 1;
}

export interface FailedStartOptions {
	/** Replace the process in tests. */
	exit?: (code: number) => void;
	report?: (line: string, error: unknown) => void;
}

/**
 * End the process after a start that failed, with a status that says whether
 * the disk was full.
 *
 * Both entry points pass a failed `startServer()` here. Before, the failure
 * was a rejection nobody handled, which the runtime turns into exit code 1
 * whatever the cause, so the runner could not tell a full disk from a broken
 * build.
 */
export function exitOnFailedStart(
	error: unknown,
	options: FailedStartOptions = {},
): void {
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const report =
		options.report ??
		((line: string, cause: unknown) => console.error(line, cause));
	const status = failedStartExitStatus(error);
	try {
		report(
			status === OUT_OF_SPACE_EXIT_STATUS
				? `[start] failed because there is no space left on the disk; exiting with status ${status}:`
				: `[start] failed; exiting with status ${status}:`,
			error,
		);
	} catch {
		// stderr can be unwritable for the same reason the start failed.
	}
	exit(status);
}
