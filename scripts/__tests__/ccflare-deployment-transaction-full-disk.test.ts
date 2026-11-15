/**
 * The runner writes two records on every start: who owns the database
 * (`owner.json`) and what the deploy listener serves (`runtime.json`). Each
 * was written as a new file and renamed into place, which needs a free block,
 * so on a full disk the runner could not start a backend at all (#827).
 *
 * These cover the write that needs no new block, and the three things that
 * keep it honest: it is taken only for a full disk, it never leaves a record
 * the next start cannot read, and it never leaves the ownership record saying
 * a backend may be starting once that backend has been reaped.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	durableWrite,
	OUT_OF_SPACE_EXIT_STATUS,
	processExists,
	recordBackendOwner,
	recordReapedBackendOwner,
	recoverTransaction,
} from "../ccflare-deployment-transaction.mjs";
import { resolveNodeExecutable } from "./node-runtime";

const transactionModule = fileURLToPath(
	new URL("../ccflare-deployment-transaction.mjs", import.meta.url),
);

const dirs: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "ccflare-transaction-full-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function failure(code: string): Error {
	return Object.assign(new Error(`${code}: write`), { code });
}
/** The staged file is made, and then its write finds no space. */
const noSpace = {
	write: () => {
		throw failure("ENOSPC");
	},
};
const staged = (dir: string) =>
	readdirSync(dir).filter((name) => name.includes(".new-"));
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("a record write on a full disk", () => {
	test("removes the staged file it made when the write fails", () => {
		const dir = scratch();
		const path = join(dir, "intent.json");
		durableWrite(path, { phase: "prepared" });

		expect(() => durableWrite(path, { phase: "draining" }, noSpace)).toThrow(
			"ENOSPC",
		);
		// The outage left seventeen of these, each an inode on a full disk.
		expect(staged(dir)).toEqual([]);
		expect(read(path)).toEqual({ phase: "prepared" });
	});

	test("is not overwritten in place unless the caller asks for that", () => {
		// A deploy's own records stay all-or-nothing: a deploy on a full disk
		// should fail, not half-write its intent.
		const dir = scratch();
		const path = join(dir, "intent.json");
		durableWrite(path, { phase: "prepared" });
		const before = statSync(path).ino;

		expect(() => durableWrite(path, { phase: "draining" }, noSpace)).toThrow();
		expect(statSync(path).ino).toBe(before);
		expect(read(path)).toEqual({ phase: "prepared" });
	});

	test("overwrites the record in place when asked and the disk is full", () => {
		const dir = scratch();
		const path = join(dir, "owner.json");
		durableWrite(path, { phase: "running", pid: 4_194_304, start: "987654321" });
		const before = statSync(path);

		const how = durableWrite(
			path,
			{ phase: "spawning" },
			{ ...noSpace, overwriteWhenFull: true },
		);

		expect(how).toBe("in-place");
		expect(staged(dir)).toEqual([]);
		// Same file, so no block was asked for, and nothing of the longer
		// record it replaced is left after the new one.
		expect(statSync(path).ino).toBe(before.ino);
		expect(statSync(path).size).toBe(before.size);
		expect(read(path)).toEqual({ phase: "spawning" });
		expect(readFileSync(path, "utf8").trimEnd()).toBe('{"phase":"spawning"}');
	});

	test("reports a staged write as staged", () => {
		const dir = scratch();
		expect(
			durableWrite(join(dir, "owner.json"), { phase: "spawning" }, {
				overwriteWhenFull: true,
			}),
		).toBe("staged");
	});

	test("fails as before when there is no record to overwrite", () => {
		const dir = scratch();
		const path = join(dir, "owner.json");

		expect(() =>
			durableWrite(path, { phase: "spawning" }, {
				...noSpace,
				overwriteWhenFull: true,
			}),
		).toThrow("ENOSPC");
		expect(existsSync(path)).toBe(false);
		expect(staged(dir)).toEqual([]);
	});

	test("fails rather than grow the record past the blocks it already has", () => {
		// Growing needs a block, and a write that runs out halfway leaves a
		// record nothing can read.
		const dir = scratch();
		const path = join(dir, "runtime.json");
		durableWrite(path, { note: "short" });
		const before = readFileSync(path, "utf8");
		const room = statSync(path).blocks * 512;

		expect(() =>
			durableWrite(path, { note: "x".repeat(room) }, {
				...noSpace,
				overwriteWhenFull: true,
			}),
		).toThrow("ENOSPC");
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	test("takes the in-place path for a full disk only", () => {
		// An I/O error can mean a failing device. Writing over the only good
		// copy of the record there would be the wrong answer.
		const dir = scratch();
		const path = join(dir, "owner.json");
		durableWrite(path, { phase: "running", pid: 999_998, start: "2" });
		const before = readFileSync(path, "utf8");

		expect(() =>
			durableWrite(path, { phase: "spawning" }, {
				overwriteWhenFull: true,
				write: () => {
					throw failure("EIO");
				},
			}),
		).toThrow("EIO");
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(staged(dir)).toEqual([]);
	});
});

describe("backend ownership on a full disk", () => {
	test("the second ownership write is as certain as the first", () => {
		// A start writes "spawning", then "running". If only the first got
		// through, the record would say a backend may be starting, and every
		// later start would be held until someone removed it by hand.
		const dir = scratch();
		recordBackendOwner(dir, "spawning");

		expect(recordBackendOwner(dir, "running", 999_998, "2", noSpace)).toBe(
			"in-place",
		);

		expect(read(join(dir, "owner.json"))).toEqual({
			phase: "running",
			pid: 999_998,
			start: "2",
		});
		expect(recoverTransaction(dir, () => false).action).toBe("start");
		expect(recoverTransaction(dir, () => true).action).toBe("hold");
	});

	test("a start can be recorded over the record of the backend before it", () => {
		const dir = scratch();
		recordBackendOwner(dir, "running", 999_998, "2");

		expect(recordBackendOwner(dir, "spawning", undefined, undefined, noSpace)).toBe(
			"in-place",
		);
		expect(recoverTransaction(dir, () => false)).toEqual({
			action: "hold",
			reason: "unreaped_or_ambiguous_owner",
		});
	});

	test("a reaped backend's record lets the next start go ahead", async () => {
		// The backend was spawned, its own record could not be written, and
		// the runner stopped it and reaped it. "spawning" must not outlive
		// that, or the runner's next start holds for good.
		const dir = scratch();
		recordBackendOwner(dir, "spawning");
		const child = spawn(resolveNodeExecutable(), ["-e", ""], { stdio: "ignore" });
		const pid = child.pid as number;
		await new Promise((resolve) => child.on("exit", resolve));

		recordReapedBackendOwner(dir, pid);

		// Read with the real process table, as the next start reads it.
		expect(recoverTransaction(dir, processExists)).toEqual({ action: "start" });
	});

	test("a reaped backend's record is one the previous module also accepts", () => {
		// A rollback puts the older runner back, and its recover knows only
		// "running" with a pid and a start time.
		const dir = scratch();
		recordBackendOwner(dir, "spawning");
		recordReapedBackendOwner(dir, 999_998, "12345");
		expect(read(join(dir, "owner.json"))).toEqual({
			phase: "running",
			pid: 999_998,
			start: "12345",
		});

		recordReapedBackendOwner(dir, 999_997);
		const owner = read(join(dir, "owner.json"));
		expect(owner.phase).toBe("running");
		expect(owner.pid).toBe(999_997);
		expect(owner.start).toMatch(/^(0|[1-9]\d{0,19})$/);
	});

	test("a reaped backend's record still holds for a process that is there", () => {
		// With the start time the runner read, a wrong claim that the backend
		// was reaped cannot hand the database to a second owner.
		const dir = scratch();
		const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
		const start = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];

		recordReapedBackendOwner(dir, process.pid, start);

		expect(recoverTransaction(dir, processExists).action).toBe("hold");
	});

	test("refuses a reaped record without a real pid", () => {
		const dir = scratch();
		expect(() => recordReapedBackendOwner(dir, 0)).toThrow(
			"invalid backend ownership receipt",
		);
		expect(() => recordReapedBackendOwner(dir, 999_998, "soon")).toThrow(
			"invalid backend ownership receipt",
		);
	});
});

describe("the ownership commands", () => {
	const run = (...args: string[]) =>
		spawnSync(resolveNodeExecutable(), [transactionModule, ...args], {
			encoding: "utf8",
		});

	test("owner-reaped writes the record recover starts from", () => {
		const dir = scratch();
		expect(run("owner-spawning", dir).status).toBe(0);
		expect(run("recover", dir).status).toBe(70);

		expect(run("owner-reaped", dir, "999998").status).toBe(0);

		const recovered = run("recover", dir);
		expect(recovered.status).toBe(0);
		expect(JSON.parse(recovered.stdout)).toEqual({ action: "start" });
	});

	test("a write refused for any reason but a full disk still exits 70", () => {
		const dir = scratch();
		const handoff = join(dir, "handoff");
		mkdirSync(handoff);
		chmodSync(handoff, 0o500);
		try {
			const result = run("owner-spawning", handoff);
			// Root ignores the mode, and then the write simply works.
			if (process.getuid?.() === 0) return;
			expect(result.status).toBe(70);
			expect(result.status).not.toBe(OUT_OF_SPACE_EXIT_STATUS);
			expect(result.stderr).toContain("backend transaction held: EACCES");
		} finally {
			chmodSync(handoff, 0o700);
		}
	});

	test("the status for a full disk is the errno, and no status the runner already reads", () => {
		expect(OUT_OF_SPACE_EXIT_STATUS).toBe(28);
		// 66 memory recycle, 67 deployment, 70 held, 75 circuit open.
		expect([66, 67, 70, 75, 143]).not.toContain(OUT_OF_SPACE_EXIT_STATUS);
	});
});

describe("the deploy listener's start", () => {
	const runtime = (control: string, pin: string) => ({
		generation: 1,
		oldPid: 999_999,
		oldStartTime: "1",
		pinPath: pin,
		controlDir: control,
	});

	async function listening(
		args: string[],
		env: Record<string, string>,
		control: string,
		handoff: string,
	) {
		const child = spawn(resolveNodeExecutable(), [transactionModule, ...args], {
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, ...env },
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		let exitCode: number | null | undefined;
		child.on("exit", (code) => {
			exitCode = code;
		});
		const deadline = Date.now() + 10_000;
		while (
			exitCode === undefined &&
			Date.now() < deadline &&
			!(
				existsSync(join(control, "deploy.sock")) &&
				existsSync(join(handoff, "runtime.json"))
			)
		) {
			await Bun.sleep(20);
		}
		return {
			up: exitCode === undefined && existsSync(join(control, "deploy.sock")),
			exitCode: () => exitCode,
			stderr: () => stderr,
			stop: () => child.kill("SIGKILL"),
		};
	}

	test("takes what it serves from the environment, with no file written for it", async () => {
		// The runner used to write this to a file first, one more write a
		// full disk could refuse.
		const dir = scratch();
		const control = join(dir, "control");
		const handoff = join(dir, "handoff");
		mkdirSync(control);
		writeFileSync(join(dir, "pin"), "pin");

		const listener = await listening(
			["serve", handoff],
			{
				CCFLARE_DEPLOYMENT_RUNTIME: JSON.stringify(
					runtime(control, join(dir, "pin")),
				),
			},
			control,
			handoff,
		);
		try {
			expect(listener.stderr()).toBe("");
			expect(listener.up).toBe(true);
			expect(read(join(handoff, "runtime.json"))).toMatchObject({
				generation: 1,
				controlDir: control,
			});
			expect(readdirSync(handoff).sort()).toEqual(["runtime.json"]);
		} finally {
			listener.stop();
		}
	});

	test("says what is missing when it is given neither a file nor the environment", async () => {
		const dir = scratch();
		const control = join(dir, "control");
		const handoff = join(dir, "handoff");
		mkdirSync(control);
		const env = { ...process.env };
		delete env.CCFLARE_DEPLOYMENT_RUNTIME;

		const result = spawnSync(
			resolveNodeExecutable(),
			[transactionModule, "serve", handoff],
			{ encoding: "utf8", env },
		);

		expect(result.status).toBe(70);
		expect(result.stderr).toContain("CCFLARE_DEPLOYMENT_RUNTIME");
	});

	test("writes its credential over the one already there", async () => {
		// A runner that keeps its control directory keeps the last listener's
		// credential file. Writing over it needs no block; making it again
		// does.
		const dir = scratch();
		const control = join(dir, "control");
		const handoff = join(dir, "handoff");
		mkdirSync(control);
		writeFileSync(join(dir, "pin"), "pin");
		const credential = join(control, "deploy-credential");
		const stale = "s".repeat(43);
		writeFileSync(credential, stale, { mode: 0o600 });
		const before = statSync(credential).ino;

		const listener = await listening(
			["serve", handoff],
			{
				CCFLARE_DEPLOYMENT_RUNTIME: JSON.stringify(
					runtime(control, join(dir, "pin")),
				),
			},
			control,
			handoff,
		);
		try {
			expect(listener.up).toBe(true);
			const now = readFileSync(credential, "utf8");
			expect(now).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(now).not.toBe(stale);
			expect(statSync(credential).ino).toBe(before);
			expect(statSync(credential).mode & 0o777).toBe(0o600);
		} finally {
			listener.stop();
		}
	});

	test("replaces a credential file of any other length", async () => {
		const dir = scratch();
		const control = join(dir, "control");
		const handoff = join(dir, "handoff");
		mkdirSync(control);
		writeFileSync(join(dir, "pin"), "pin");
		const credential = join(control, "deploy-credential");
		writeFileSync(credential, "too-short-and-then-some-left-over-bytes-past-43-characters", {
			mode: 0o644,
		});

		const listener = await listening(
			["serve", handoff],
			{
				CCFLARE_DEPLOYMENT_RUNTIME: JSON.stringify(
					runtime(control, join(dir, "pin")),
				),
			},
			control,
			handoff,
		);
		try {
			expect(listener.up).toBe(true);
			expect(readFileSync(credential, "utf8")).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(statSync(credential).mode & 0o777).toBe(0o600);
		} finally {
			listener.stop();
		}
	});
});
