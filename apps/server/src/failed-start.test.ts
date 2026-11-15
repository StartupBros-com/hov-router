/**
 * A start that fails ends the process. What it exits with tells the runner
 * what to do next: status 28 means the disk is full, and the runner then
 * waits for space instead of counting the failure toward the restart circuit
 * that takes the unit down (#827). Anything else stays 1 and is counted.
 *
 * The status itself, on a real full filesystem and through both ways the
 * server is started, is checked by the full-disk scenario
 * (`disk-full.test.ts`).
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StartOutOfSpaceError } from "@better-ccflare/database";
import {
	exitOnFailedStart,
	failedStartExitStatus,
	OUT_OF_SPACE_EXIT_STATUS,
} from "./failed-start";

const repoRoot = join(import.meta.dir, "../../..");

function coded(code: string, message = code): Error {
	return Object.assign(new Error(message), { code });
}

describe("the exit status of a start that failed", () => {
	it("is 28 when the database could not be opened for lack of space", () => {
		// What SQLite says when it cannot rebuild its index is an I/O error
		// code. The open has already decided that this one means "full": the
		// filesystem had no room either.
		const refusal = new StartOutOfSpaceError(
			{ dbPath: "/state/router.db", releasedBytes: 65_536, availableBytes: 0 },
			{ cause: coded("SQLITE_IOERR_SHMSIZE", "disk I/O error") },
		);

		expect(failedStartExitStatus(refusal)).toBe(28);
		expect(
			failedStartExitStatus(new Error("start failed", { cause: refusal })),
		).toBe(28);
	});

	it("is 28 for a write that found no space, at any depth", () => {
		expect(failedStartExitStatus(coded("ENOSPC"))).toBe(28);
		expect(failedStartExitStatus(coded("EDQUOT"))).toBe(28);
		expect(failedStartExitStatus(coded("SQLITE_FULL"))).toBe(28);
		expect(
			failedStartExitStatus(
				new Error("Database migration failed", {
					cause: new Error("step 12", { cause: coded("SQLITE_FULL") }),
				}),
			),
		).toBe(28);
	});

	it("is 28 when SQLite's text is all that is left of the cause", () => {
		expect(
			failedStartExitStatus(
				new Error("Database migration failed: database or disk is full"),
			),
		).toBe(28);
	});

	it("is 1 for anything else", () => {
		expect(failedStartExitStatus(new Error("port 8080 in use"))).toBe(1);
		expect(failedStartExitStatus(coded("EADDRINUSE"))).toBe(1);
		expect(failedStartExitStatus(undefined)).toBe(1);
		expect(failedStartExitStatus("ENOSPC")).toBe(1);
	});

	it("is 1 for an I/O error, which can mean a failing device", () => {
		// Waiting for space would never end on a disk that is not full.
		expect(failedStartExitStatus(coded("EIO"))).toBe(1);
		expect(
			failedStartExitStatus(coded("SQLITE_IOERR_SHMSIZE", "disk I/O error")),
		).toBe(1);
		expect(failedStartExitStatus(coded("SQLITE_IOERR_WRITE"))).toBe(1);
	});

	it("is the status the runner and the transaction module wait on", () => {
		const runner = readFileSync(
			join(repoRoot, "scripts/run-ccflare-stack.sh"),
			"utf8",
		);
		const transaction = readFileSync(
			join(repoRoot, "scripts/ccflare-deployment-transaction.mjs"),
			"utf8",
		);

		expect(runner).toContain(
			`\nOUT_OF_SPACE_EXIT_STATUS=${OUT_OF_SPACE_EXIT_STATUS}\n`,
		);
		expect(transaction).toContain(
			`\nexport const OUT_OF_SPACE_EXIT_STATUS = ${OUT_OF_SPACE_EXIT_STATUS};\n`,
		);
	});
});

describe("exitOnFailedStart", () => {
	function run(
		error: unknown,
		report?: (line: string, error: unknown) => void,
	) {
		const exits: number[] = [];
		const lines: Array<{ line: string; error: unknown }> = [];
		exitOnFailedStart(error, {
			exit: (code) => {
				exits.push(code);
			},
			report: report ?? ((line, cause) => lines.push({ line, error: cause })),
		});
		return { exits, lines };
	}

	it("says in one line why a start found no space, and exits 28", () => {
		const error = new StartOutOfSpaceError(
			{ dbPath: "/state/router.db", releasedBytes: 0, availableBytes: 4096 },
			{ cause: coded("SQLITE_IOERR_SHMSIZE", "disk I/O error") },
		);

		const { exits, lines } = run(error);

		expect(exits).toEqual([28]);
		expect(lines).toHaveLength(1);
		expect(lines[0].line).toContain("no space left on the disk");
		expect(lines[0].line).toContain("status 28");
		expect(lines[0].line).toContain("StartOutOfSpaceError");
		expect(lines[0].line).toContain("/state/router.db");
		// What the filesystem had left, so the journal shows the open measured
		// it before it called the disk full.
		expect(lines[0].line).toContain("4096 bytes available");
		expect(lines[0].line).toContain("SQLITE_IOERR_SHMSIZE");
		expect(lines[0].line).toContain("disk I/O error");
		expect(lines[0].line).not.toContain("\n");
		// The runner starts the backend again for as long as the disk stays
		// full. Handed the error itself, the compiled build prints a page of
		// its own bundled source under every one of those starts.
		expect(lines[0].error).toBeUndefined();
	});

	it("keeps to one line for a message that has several, and for a thrown value that is not an error", () => {
		const { exits, lines } = run({
			code: "ENOSPC",
			message: "no space left on device\n    while writing the config",
		});

		expect(exits).toEqual([28]);
		expect(lines).toHaveLength(1);
		expect(lines[0].line).toContain(
			"no space left on device while writing the config [ENOSPC]",
		);
		expect(lines[0].line).not.toContain("\n");
		expect(lines[0].error).toBeUndefined();
	});

	it("shows the error and exits 1 for any other failed start", () => {
		const error = new Error("port 8080 in use");

		const { exits, lines } = run(error);

		expect(exits).toEqual([1]);
		expect(lines).toHaveLength(1);
		expect(lines[0].error).toBe(error);
		expect(lines[0].line).toContain("status 1");
	});

	it("still exits when the error cannot be shown", () => {
		// stderr can be a file on the disk that is full.
		const { exits } = run(coded("ENOSPC"), () => {
			throw coded("ENOSPC");
		});

		expect(exits).toEqual([28]);
	});
});
