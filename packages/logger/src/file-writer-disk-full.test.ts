import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
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

			expect(sink.status().lastError).toContain("ENOSPC");
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
});
