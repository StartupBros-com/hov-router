import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	START_RESERVE_BYTES,
	type StartReserveArmResult,
	startReservePath,
} from "@better-ccflare/database";
import {
	createStartReserveKeeper,
	startReserveReleasedMessage,
} from "./start-reserve-keeper";

function recordingLog() {
	const lines: Array<{ level: "info" | "warn"; message: string }> = [];
	return {
		lines,
		log: {
			info: (message: string) => {
				lines.push({ level: "info", message });
			},
			warn: (message: string) => {
				lines.push({ level: "warn", message });
			},
		},
	};
}

describe("start reserve keeper", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ccflare-start-reserve-keeper-"));
		dbPath = join(dir, "router.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes the reserve beside the database", async () => {
		const { log, lines } = recordingLog();
		const check = createStartReserveKeeper({ dbPath, log });

		await check();

		expect(statSync(startReservePath(dbPath)).size).toBe(START_RESERVE_BYTES);
		expect(lines.map((line) => line.level)).toEqual(["info"]);
	});

	it("reports a change of state once, not every check", async () => {
		const { log, lines } = recordingLog();
		const full: StartReserveArmResult = {
			armed: false,
			bytes: 0,
			error: Object.assign(new Error("ENOSPC: no space left on device"), {
				code: "ENOSPC",
			}),
		};
		const whole: StartReserveArmResult = {
			armed: true,
			bytes: START_RESERVE_BYTES,
		};
		const results = [full, full, full, whole, whole, full];
		const seen: string[] = [];
		const check = createStartReserveKeeper({
			dbPath,
			log,
			arm: async (path) => {
				seen.push(path);
				return results.shift() as StartReserveArmResult;
			},
		});

		for (let i = 0; i < 6; i++) await check();

		expect(seen).toEqual(Array(6).fill(dbPath));
		expect(lines.map((line) => line.level)).toEqual(["warn", "info", "warn"]);
		expect(lines[0]?.message).toContain("ENOSPC: no space left on device");
		expect(lines[0]?.message).toContain(`0 of ${START_RESERVE_BYTES} bytes`);
	});

	it("names the failure and the bytes given back when a start spent the reserve", () => {
		const message = startReserveReleasedMessage(
			START_RESERVE_BYTES,
			Object.assign(new Error("disk I/O error"), {
				code: "SQLITE_IOERR_SHMSIZE",
			}),
		);

		expect(message).toContain("disk I/O error");
		expect(message).toContain(`${START_RESERVE_BYTES}-byte start reserve`);
	});
});
