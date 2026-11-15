import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	closeSync,
	constants,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEvent } from "@better-ccflare/types";
import { LogFileWriter } from "./file-writer";

// /dev/full accepts open() and fails every write() with ENOSPC, which is
// exactly what a log file on a full filesystem does once its last allocated
// block is used up.
const hasDevFull = existsSync("/dev/full");
// A named pipe takes writes while something has it open for reading and
// fails them once nothing does, so a test can make an open log file fail and
// work again as often as it likes.
const hasMkfifo = Bun.which("mkfifo") !== null;

function openForReading(path: string): number {
	return openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
}

/** Everything waiting in the pipe, or "" when it is empty. */
function readWaiting(fd: number): string {
	const buffer = Buffer.alloc(64 * 1024);
	try {
		return buffer
			.subarray(0, readSync(fd, buffer, 0, buffer.length, null))
			.toString();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EAGAIN") return "";
		throw error;
	}
}

function event(msg: string): LogEvent {
	return { ts: Date.now(), level: "ERROR", msg };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for the log sink");
}

describe("LogFileWriter on storage that cannot be written", () => {
	let logDir: string;
	let savedLogDir: string | undefined;
	let writer: LogFileWriter | null = null;
	let uncaught: unknown[] = [];
	const onUncaught = (error: unknown) => {
		uncaught.push(error);
	};

	beforeEach(() => {
		savedLogDir = process.env.BETTER_CCFLARE_LOG_DIR;
		logDir = mkdtempSync(join(tmpdir(), "better-ccflare-logger-full-"));
		process.env.BETTER_CCFLARE_LOG_DIR = logDir;
		uncaught = [];
		process.on("uncaughtException", onUncaught);
	});

	afterEach(() => {
		process.off("uncaughtException", onUncaught);
		writer?.close();
		writer = null;
		if (savedLogDir === undefined) delete process.env.BETTER_CCFLARE_LOG_DIR;
		else process.env.BETTER_CCFLARE_LOG_DIR = savedLogDir;
		rmSync(logDir, { recursive: true, force: true });
	});

	it.skipIf(!hasDevFull)(
		"suspends the sink instead of raising an uncaught error when a write hits ENOSPC",
		async () => {
			symlinkSync("/dev/full", join(logDir, "app.log"));
			writer = new LogFileWriter({ retryBaseMs: 60_000 });
			const sink = writer;

			expect(() => sink.write(event("first"))).not.toThrow();
			await waitFor(() => sink.status().suspended);

			// The code, not the message: /health shows this without an API key.
			expect(sink.status().lastError).toBe("ENOSPC");
			expect(sink.status().failures).toBe(1);

			for (let i = 0; i < 5; i++) sink.write(event(`dropped ${i}`));
			expect(sink.status().dropped).toBeGreaterThanOrEqual(5);
			// Give a stray stream error time to surface before asserting silence.
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(uncaught).toEqual([]);
		},
	);

	it.skipIf(!hasDevFull)(
		"resumes on its own once the file is writable and says how much it dropped",
		async () => {
			const logFile = join(logDir, "app.log");
			symlinkSync("/dev/full", logFile);
			writer = new LogFileWriter({ retryBaseMs: 20 });
			const sink = writer;

			sink.write(event("lost to the full disk"));
			await waitFor(() => sink.status().suspended);
			sink.write(event("dropped while suspended"));

			// Space returns.
			unlinkSync(logFile);
			await new Promise((resolve) => setTimeout(resolve, 40));
			sink.write(event("after recovery"));
			await waitFor(
				() =>
					existsSync(logFile) &&
					readFileSync(logFile, "utf8").includes("after recovery"),
			);

			const lines = readFileSync(logFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as LogEvent);
			expect(lines.at(-1)?.msg).toBe("after recovery");
			expect(lines[0]?.level).toBe("WARN");
			expect(lines[0]?.msg).toContain("Log file sink resumed");
			expect(lines[0]?.msg).toContain("ENOSPC");
			expect(sink.status().suspended).toBe(false);
			expect(sink.status().dropped).toBe(0);
			expect(uncaught).toEqual([]);
		},
	);

	it("does not throw when the log directory cannot be created", async () => {
		// A regular file where the directory should be: mkdir fails with ENOTDIR
		// or EEXIST, the same way it fails with ENOSPC when no block is free.
		const blocker = join(logDir, "blocker");
		writeFileSync(blocker, "not a directory");
		process.env.BETTER_CCFLARE_LOG_DIR = join(blocker, "logs");

		expect(() => {
			writer = new LogFileWriter({ retryBaseMs: 20 });
		}).not.toThrow();
		const sink = writer as unknown as LogFileWriter;
		expect(() => sink.write(event("nowhere to go"))).not.toThrow();
		expect(sink.status().suspended).toBe(true);
		// The message names the directory. The status must not.
		expect(["ENOTDIR", "EEXIST"]).toContain(sink.status().lastError as string);

		// The directory becomes creatable later: the sink creates it and resumes.
		unlinkSync(blocker);
		await new Promise((resolve) => setTimeout(resolve, 40));
		sink.write(event("directory is back"));
		const logFile = join(blocker, "logs", "app.log");
		await waitFor(
			() =>
				existsSync(logFile) &&
				readFileSync(logFile, "utf8").includes("directory is back"),
		);
		expect(uncaught).toEqual([]);
	});

	it("reopens the file once when many lines arrive before the first write is confirmed", async () => {
		const blocker = join(logDir, "blocker");
		writeFileSync(blocker, "not a directory");
		process.env.BETTER_CCFLARE_LOG_DIR = join(blocker, "logs");
		writer = new LogFileWriter({ retryBaseMs: 20 });
		const sink = writer;
		expect(sink.status().suspended).toBe(true);

		unlinkSync(blocker);
		await new Promise((resolve) => setTimeout(resolve, 40));
		// Whether the reopened file takes a write is only known a moment
		// later. Every line that arrives in that moment must go to the one
		// stream, not open another and announce the resume again.
		for (let i = 0; i < 50; i++) sink.write(event(`burst ${i}`));
		await waitFor(() => !sink.status().suspended);
		sink.write(event("after the burst"));
		const logFile = join(blocker, "logs", "app.log");
		await waitFor(
			() =>
				existsSync(logFile) &&
				readFileSync(logFile, "utf8").includes("after the burst"),
		);

		const messages = readFileSync(logFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as LogEvent).msg);
		expect(
			messages.filter((msg) => msg.includes("Log file sink resumed")),
		).toHaveLength(1);
		expect(messages[0]).toContain("Log file sink resumed");
		expect(messages.slice(1)).toEqual([
			...Array.from({ length: 50 }, (_, i) => `burst ${i}`),
			"after the burst",
		]);
		expect(sink.status().failures).toBe(1);
		expect(uncaught).toEqual([]);
	});

	it.skipIf(!hasMkfifo)(
		"keeps its longer delay when the file fails again soon after resuming, and starts over once it has worked for a while",
		async () => {
			const logFile = join(logDir, "app.log");
			expect(Bun.spawnSync(["mkfifo", logFile]).exitCode).toBe(0);
			let clock = 1_000_000;
			let reader = openForReading(logFile);
			writer = new LogFileWriter({
				retryBaseMs: 1_000,
				retryResetAfterMs: 60_000,
				now: () => clock,
			});
			const sink = writer;
			// The sink's next write fails: nothing has the pipe open for reading.
			const failNextWrite = async () => {
				const failures = sink.status().failures;
				closeSync(reader);
				sink.write(event("into a pipe nobody reads"));
				await waitFor(() => sink.status().failures === failures + 1);
				reader = openForReading(logFile);
			};
			const resume = async () => {
				const dropped = sink.status().dropped;
				sink.write(event("try again"));
				// The line was not dropped: it went to a reopened file.
				expect(sink.status().dropped).toBe(dropped);
				await waitFor(() => !sink.status().suspended);
				readWaiting(reader);
			};
			try {
				sink.write(event("first"));
				await waitFor(() => readWaiting(reader).includes("first"));

				// First failure: retry after the base delay.
				await failNextWrite();
				clock += 1_000;
				await resume();

				// It fails again 10 ms after resuming. A disk that is still full
				// lets the odd write through, and going back to the base delay
				// each time would retry, and say so, every second for as long as
				// it stays full. The delay carries on from where it was: 2 s.
				clock += 10;
				await failNextWrite();
				clock += 1_500;
				sink.write(event("too early"));
				expect(sink.status().dropped).toBe(1);
				expect(sink.status().suspended).toBe(true);
				clock += 500;
				await resume();

				// This time it works for a minute before failing. That is a new
				// problem, and the retry starts at the base delay again.
				clock += 60_000;
				await failNextWrite();
				clock += 1_000;
				await resume();
				expect(sink.status().failures).toBe(3);
				expect(uncaught).toEqual([]);
			} finally {
				closeSync(reader);
			}
		},
	);
});
