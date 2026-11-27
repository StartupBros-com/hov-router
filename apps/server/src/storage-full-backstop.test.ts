import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	installStorageFullBackstop,
	STORAGE_FULL_REPORT_INTERVAL_MS,
} from "./storage-full-backstop";

function enospc(): Error {
	return Object.assign(new Error("ENOSPC: no space left on device, write"), {
		code: "ENOSPC",
		errno: -28,
		syscall: "write",
	});
}

function harness() {
	const target = new EventEmitter();
	const exits: number[] = [];
	const reports: Array<{ line: string; error: unknown }> = [];
	let now = 1_000_000;
	const backstop = installStorageFullBackstop({
		target,
		exit: (code) => {
			exits.push(code);
		},
		report: (line, error) => {
			reports.push({ line, error });
		},
		now: () => now,
	});
	return {
		target,
		exits,
		reports,
		backstop,
		advance: (ms: number) => {
			now += ms;
		},
		now: () => now,
	};
}

describe("storage-full backstop", () => {
	it("keeps the process running after an uncaught storage-full exception and counts it", () => {
		const h = harness();

		h.target.emit("uncaughtException", enospc());

		expect(h.exits).toEqual([]);
		expect(h.backstop.status()).toEqual({
			count: 1,
			lastError: "ENOSPC",
			lastErrorAt: h.now(),
		});
		expect(h.reports).toHaveLength(1);
		expect(h.reports[0]?.line).toContain("uncaughtException");
		expect(h.reports[0]?.line).toContain("no space left");
	});

	it("shows the error's code and keeps its message for stderr", () => {
		// /health serves the status to anyone, and a message can name a path.
		const h = harness();
		const error = Object.assign(
			new Error(
				"ENOSPC: no space left on device, open '/home/someone/.config/hov-router/secret.json'",
			),
			{ code: "ENOSPC" },
		);

		h.target.emit("uncaughtException", error);
		expect(h.backstop.status().lastError).toBe("ENOSPC");
		// The whole error still reaches the report, which goes to stderr.
		expect(h.reports[0]?.error).toBe(error);

		// SQLite's full-disk text with its code lost in a rethrow.
		h.target.emit("unhandledRejection", new Error("database or disk is full"));
		expect(h.backstop.status()).toMatchObject({
			count: 2,
			lastError: "SQLITE_FULL",
		});
	});

	it("keeps the process running after a storage-full unhandled rejection", () => {
		const h = harness();

		h.target.emit(
			"unhandledRejection",
			Object.assign(new Error("database or disk is full"), {
				code: "SQLITE_FULL",
			}),
		);

		expect(h.exits).toEqual([]);
		expect(h.backstop.status().count).toBe(1);
		expect(h.reports[0]?.line).toContain("unhandledRejection");
	});

	it("ends the process with code 1 on any other uncaught exception, after reporting it", () => {
		const h = harness();
		const error = new TypeError("undefined is not a function");

		h.target.emit("uncaughtException", error);

		expect(h.exits).toEqual([1]);
		expect(h.backstop.status().count).toBe(0);
		expect(h.reports).toHaveLength(1);
		expect(h.reports[0]?.error).toBe(error);
	});

	it("ends the process with code 1 on any other unhandled rejection", () => {
		const h = harness();

		h.target.emit("unhandledRejection", "a rejected string");

		expect(h.exits).toEqual([1]);
		expect(h.backstop.status().count).toBe(0);
	});

	it("does not survive an I/O error, which can mean a failing device", () => {
		const h = harness();

		h.target.emit(
			"uncaughtException",
			Object.assign(new Error("disk I/O error"), {
				code: "SQLITE_IOERR_SHMSIZE",
			}),
		);
		h.target.emit(
			"uncaughtException",
			Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" }),
		);

		expect(h.exits).toEqual([1, 1]);
		expect(h.backstop.status().count).toBe(0);
	});

	it("reports a burst once and then says how many it left out", () => {
		const h = harness();

		for (let i = 0; i < 50; i++) h.target.emit("uncaughtException", enospc());
		expect(h.backstop.status().count).toBe(50);
		expect(h.reports).toHaveLength(1);

		h.advance(STORAGE_FULL_REPORT_INTERVAL_MS);
		h.target.emit("uncaughtException", enospc());

		expect(h.backstop.status().count).toBe(51);
		expect(h.reports).toHaveLength(2);
		expect(h.reports[1]?.line).toContain("49 more");
	});

	it("still exits on another error when the report itself cannot be written", () => {
		const target = new EventEmitter();
		const exits: number[] = [];
		const backstop = installStorageFullBackstop({
			target,
			exit: (code) => {
				exits.push(code);
			},
			report: () => {
				throw enospc();
			},
		});

		target.emit("uncaughtException", enospc());
		target.emit("uncaughtException", new Error("boom"));

		expect(backstop.status().count).toBe(1);
		expect(exits).toEqual([1]);
	});

	it("takes both handlers off again when uninstalled", () => {
		const h = harness();
		expect(h.target.listenerCount("uncaughtException")).toBe(1);
		expect(h.target.listenerCount("unhandledRejection")).toBe(1);

		h.backstop.uninstall();

		expect(h.target.listenerCount("uncaughtException")).toBe(0);
		expect(h.target.listenerCount("unhandledRejection")).toBe(0);
	});
});

/**
 * The same, in a real process with the real runtime: what reaches the
 * handlers, and what the process does afterwards, is the runtime's to decide.
 */
describe("storage-full backstop in a real process", () => {
	const fixture = join(import.meta.dir, "storage-full-backstop.fixture.ts");

	async function run(
		provoke: string,
		backstop: "backstop" | "no-backstop" = "backstop",
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const child = Bun.spawn(
			[process.execPath, "run", fixture, provoke, backstop],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { exitCode, stdout, stderr };
	}

	function lastReport(stdout: string): {
		alive: boolean;
		status: { count: number; lastError: string | null } | null;
	} {
		const line = stdout.trim().split("\n").at(-1) ?? "";
		return JSON.parse(line);
	}

	// /dev/full fails every write with ENOSPC: the runtime's own error, from a
	// stream nobody listens to, which is how the 2026-11-14 outage began.
	const devFull = existsSync("/dev/full");

	it.skipIf(!devFull)(
		"without the backstop, a write stream on a full device ends the process",
		async () => {
			const result = await run("stream-on-full-device", "no-backstop");

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("ENOSPC");
			expect(result.stdout).not.toContain('"alive":true');
		},
	);

	it.skipIf(!devFull)(
		"with it, the same write is counted and the process carries on",
		async () => {
			const result = await run("stream-on-full-device");

			expect(result.exitCode).toBe(0);
			const report = lastReport(result.stdout);
			expect(report.alive).toBe(true);
			expect(report.status?.count).toBe(1);
			expect(report.status?.lastError).toBe("ENOSPC");
			expect(result.stderr).toContain("no space left");
		},
	);

	it("carries on after a rejected promise nobody handled that says the database is full", async () => {
		const result = await run("reject-database-full");

		expect(result.exitCode).toBe(0);
		expect(lastReport(result.stdout).status?.count).toBe(1);
	});

	it("still ends the process with code 1 on any other uncaught exception", async () => {
		const result = await run("throw-other");

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("not a storage problem");
		expect(result.stdout).not.toContain('"alive":true');
	});

	it("still ends the process with code 1 on any other unhandled rejection", async () => {
		const result = await run("reject-other");

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("not a storage problem");
		expect(result.stdout).not.toContain('"alive":true');
	});
});
