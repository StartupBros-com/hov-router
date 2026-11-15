/**
 * The runner on a full disk (#827). On 2026-11-14 the disk filled, the
 * backend exited, and the runner could not start another: it could not make
 * its control directory or write the ownership record. After three tries it
 * gave up, systemd's start limit did the rest, and the unit stayed down until
 * someone restarted it by hand.
 *
 * What these hold the runner to:
 *   - nothing it must do to start a backend needs a new block on the disk;
 *   - a start that fails because the disk is full is waited out, not counted
 *     toward the restart circuit;
 *   - it never leaves an ownership record that holds the next runner start.
 *
 * The first group runs in ordinary directories and makes each failure happen
 * by hand. The second runs the same runner on a filesystem with no free block.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	processesNaming,
	type RunnerFixture,
	type RunnerLayout,
	startRunner,
} from "./runner-transaction-fixture";

const READY = "ccflare stack ready";
const WAITING = "waiting for space instead of opening the restart circuit";
const CIRCUIT_OPEN = "restart circuit open";
/** The runner's status when its restart circuit opens. */
const CIRCUIT_EXIT_STATUS = 75;
/** The runner's status after a stop it was asked for. */
const STOPPED_EXIT_STATUS = 143;
/** The errno of ENOSPC: what a start that found no space exits with. */
const OUT_OF_SPACE_EXIT_STATUS = 28;

const roots: string[] = [];
const runners: RunnerFixture[] = [];

afterEach(async () => {
	for (const runner of runners.splice(0)) runner.destroy();
	for (const root of roots.splice(0)) {
		// A killed process is gone a moment later, not at once.
		const gone = Date.now() + 5_000;
		while (processesNaming(root).length > 0 && Date.now() < gone)
			await Bun.sleep(50);
		rmSync(root, { recursive: true, force: true });
	}
});

/** Scratch, state and TMPDIR under one new directory; TMPDIR exists. */
function layout(): RunnerLayout & { root: string } {
	const root = mkdtempSync(join(tmpdir(), "ccflare-runner-full-disk-"));
	roots.push(root);
	const made = {
		root,
		scratch: join(root, "scratch"),
		state: join(root, "state"),
		tmp: join(root, "tmp"),
	};
	for (const dir of [made.scratch, made.state, made.tmp]) mkdirSync(dir);
	return made;
}

async function start(
	where: RunnerLayout,
	env: Record<string, string> = {},
): Promise<RunnerFixture> {
	const runner = await startRunner(where, env);
	runners.push(runner);
	return runner;
}

function lifecycle(runner: RunnerFixture): string[] {
	const path = join(runner.capture, "lifecycle.log");
	return existsSync(path)
		? readFileSync(path, "utf8").trim().split("\n")
		: [];
}

interface Runtime {
	controlDir: string;
	deploymentPid: number;
	oldPid: number;
}

/** The listener's record, once it names a listener other than `not`. */
async function runtimeRecord(
	runner: RunnerFixture,
	not?: number,
): Promise<Runtime> {
	const path = join(runner.handoff, "runtime.json");
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			const record = JSON.parse(readFileSync(path, "utf8")) as Runtime;
			if (record.deploymentPid !== not) return record;
		} catch {
			// Not written yet.
		}
		await Bun.sleep(20);
	}
	throw new Error(`no new runtime.json:\n${runner.output().slice(-3000)}`);
}

const controlDirsIn = (dir: string) =>
	readdirSync(dir).filter((name) => name.startsWith("ccflare-control."));

/**
 * The listener writes its record before it listens, so its socket can
 * follow the record by a moment.
 */
async function appears(path: string): Promise<boolean> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (existsSync(path)) return true;
		await Bun.sleep(20);
	}
	return false;
}

describe("the runner's control directory", () => {
	test("starts nothing when the directory cannot be made", async () => {
		const where = layout();
		rmSync(where.tmp, { recursive: true });
		const runner = await start(where);

		const exit = await runner.waitForExit();

		// Before, the runner carried on with no directory and started a
		// backend whose listener then wrote its credential to the working
		// directory.
		expect(runner.output()).toContain("control directory could not be made");
		expect(runner.count("starting better-ccflare upstream")).toBe(0);
		expect(lifecycle(runner)).toEqual([]);
		// The disk is not full here, so this is an ordinary failure: counted.
		expect(runner.count(WAITING)).toBe(0);
		expect(exit.code).toBe(CIRCUIT_EXIT_STATUS);
	}, 30_000);

	test("goes in the unit's runtime directory when systemd made one", async () => {
		const where = layout();
		const runtimeDirectory = join(where.root, "run");
		mkdirSync(runtimeDirectory);
		const runner = await start({ ...where, runtimeDirectory });

		await runner.waitForOutput(READY);
		const runtime = await runtimeRecord(runner);

		expect(runtime.controlDir.startsWith(`${runtimeDirectory}/`)).toBe(true);
		expect(controlDirsIn(runtimeDirectory)).toHaveLength(1);
		expect(controlDirsIn(where.tmp)).toEqual([]);
		expect(existsSync(join(runtime.controlDir, "control.sock"))).toBe(true);
		expect(await appears(join(runtime.controlDir, "deploy.sock"))).toBe(true);

		expect((await runner.stop()).code).toBe(STOPPED_EXIT_STATUS);
		expect(readdirSync(runtimeDirectory)).toEqual([]);
	}, 30_000);

	test("takes the first of several runtime directories", async () => {
		const where = layout();
		const first = join(where.root, "run-a");
		const second = join(where.root, "run-b");
		mkdirSync(first);
		mkdirSync(second);
		const runner = await start({
			...where,
			runtimeDirectory: `${first}:${second}`,
		});

		await runner.waitForOutput(READY);

		expect(controlDirsIn(first)).toHaveLength(1);
		expect(controlDirsIn(second)).toEqual([]);
		expect((await runner.stop()).code).toBe(STOPPED_EXIT_STATUS);
	}, 30_000);

	test("goes where it always went when the runtime directory is not there", async () => {
		const where = layout();
		const runner = await start({
			...where,
			runtimeDirectory: join(where.root, "never-made"),
		});

		await runner.waitForOutput(READY);

		expect(controlDirsIn(where.tmp)).toHaveLength(1);
		expect((await runner.stop()).code).toBe(STOPPED_EXIT_STATUS);
		expect(controlDirsIn(where.tmp)).toEqual([]);
	}, 30_000);

	test("is kept, with its credential file, when the stack is started again", async () => {
		const where = layout();
		const runner = await start(where);
		await runner.waitForOutput(READY);
		const before = await runtimeRecord(runner);
		const credentialPath = join(before.controlDir, "deploy-credential");
		const credential = readFileSync(credentialPath, "utf8");
		const inode = statSync(credentialPath).ino;

		runner.crashBackend();
		await runner.waitForOutput(READY, { times: 2 });
		const after = await runtimeRecord(runner, before.deploymentPid);

		// A new directory for every start needed a free block exactly when a
		// full disk had brought the stack down, and removing the old one
		// first gave that block to whatever else was writing.
		expect(after.controlDir).toBe(before.controlDir);
		expect(controlDirsIn(where.tmp)).toHaveLength(1);
		expect(after.oldPid).not.toBe(before.oldPid);
		// The new listener has a new credential, written over the old one.
		expect(statSync(credentialPath).ino).toBe(inode);
		expect(readFileSync(credentialPath, "utf8")).not.toBe(credential);
		expect(readFileSync(credentialPath, "utf8")).toMatch(
			/^[A-Za-z0-9_-]{43}$/,
		);
		expect(statSync(credentialPath).mode & 0o777).toBe(0o600);

		expect((await runner.stop()).code).toBe(STOPPED_EXIT_STATUS);
		expect(controlDirsIn(where.tmp)).toEqual([]);
	}, 30_000);

	test("hands the listener what it serves without writing a file for it", async () => {
		const where = layout();
		const runner = await start(where);
		await runner.waitForOutput(READY);
		await runtimeRecord(runner);

		expect(existsSync(join(runner.handoff, "runtime-input.json"))).toBe(false);
		expect((await runner.stop()).code).toBe(STOPPED_EXIT_STATUS);
	}, 30_000);
});

describe("the ownership record after a start that was never recorded", () => {
	test("is closed once that backend is reaped, so the next runner start is not held", async () => {
		const where = layout();
		const runner = await start(where, {
			RUNNER_RESTART_MAX_FAILURES: "2",
		});
		// Not a full disk: any failure to record the started backend used to
		// leave "spawning" behind, which holds every later start.
		runner.refuseCommand("owner-started", 70);

		const exit = await runner.waitForExit();

		expect(exit.code).toBe(CIRCUIT_EXIT_STATUS);
		// The runner stops each backend before the stub has got as far as
		// noting its own start, so the pids come from the runner.
		const started = [
			...runner
				.output()
				.matchAll(/stopping better-ccflare upstream pid=(\d+)/g),
		].map((match) => Number(match[1]));
		expect(started.length).toBeGreaterThanOrEqual(1);
		const owner = JSON.parse(
			readFileSync(join(runner.handoff, "owner.json"), "utf8"),
		);
		expect(owner.phase).toBe("running");
		expect(started).toContain(owner.pid);
		expect(existsSync(`/proc/${owner.pid}`)).toBe(false);
		expect(runner.recover()).toMatchObject({
			status: 0,
			stdout: '{"action":"start"}',
		});
		// Refused for a reason other than space: counted, not waited out.
		expect(runner.count(WAITING)).toBe(0);
	}, 30_000);
});

describe("a start that fails because the disk is full", () => {
	test("is waited out when the ownership record cannot be written", async () => {
		const where = layout();
		const runner = await start(where, {
			RUNNER_RESTART_MAX_FAILURES: "3",
		});
		runner.refuseCommand("owner-spawning", OUT_OF_SPACE_EXIT_STATUS);

		// Twice the circuit's cap, and still trying.
		await runner.waitForOutput(WAITING, { times: 6 });
		expect(runner.exited()).toBeNull();
		expect(runner.count(CIRCUIT_OPEN)).toBe(0);
		expect(lifecycle(runner)).toEqual([]);
		expect(runner.output()).toContain("step=the ownership record");

		// Space comes back: the next try starts the stack.
		runner.refuseCommand("owner-spawning", null);
		await runner.waitForOutput(READY);
		expect((await runner.stop()).code).toBe(STOPPED_EXIT_STATUS);
		expect(runner.recover()).toMatchObject({
			status: 0,
			stdout: '{"action":"start"}',
		});
	}, 30_000);

	test("is waited out when the backend says its start found no space", async () => {
		const where = layout();
		const runner = await start(where, {
			RUNNER_RESTART_MAX_FAILURES: "3",
		});
		runner.refuseBackendStart(OUT_OF_SPACE_EXIT_STATUS);

		await runner.waitForOutput(WAITING, { times: 6 });
		expect(runner.exited()).toBeNull();
		expect(runner.count(CIRCUIT_OPEN)).toBe(0);
		expect(runner.count(READY)).toBe(0);
		expect(runner.output()).toContain("step=the backend's start");
		expect(
			lifecycle(runner).filter((line) => line.startsWith("backend-refused "))
				.length,
		).toBeGreaterThanOrEqual(6);

		runner.refuseBackendStart(null);
		await runner.waitForOutput(READY);
		expect((await runner.stop()).code).toBe(STOPPED_EXIT_STATUS);
	}, 30_000);

	test("starts its wait over once a stack has come up", async () => {
		const where = layout();
		const runner = await start(where, {
			RUNNER_RESTART_MAX_FAILURES: "3",
			RUNNER_RESTART_BACKOFF_BASE_MS: "10",
			RUNNER_RESTART_BACKOFF_MAX_MS: "1000",
		});
		runner.refuseBackendStart(OUT_OF_SPACE_EXIT_STATUS);
		await runner.waitForOutput(WAITING, { times: 3 });
		runner.refuseBackendStart(null);
		await runner.waitForOutput(READY);

		// A later full disk starts from the first, short wait again.
		runner.refuseBackendStart(OUT_OF_SPACE_EXIT_STATUS);
		runner.crashBackend();
		await runner.waitForOutput(`${WAITING}; step=the backend's start; attempt=1;`, {
			times: 2,
		});
		expect(runner.exited()).toBeNull();
	}, 30_000);
});

describe("a start that fails for any other reason", () => {
	test("still opens the circuit when the backend exits before it is ready", async () => {
		const where = layout();
		const runner = await start(where, {
			RUNNER_RESTART_MAX_FAILURES: "3",
		});
		runner.refuseBackendStart(1);

		const exit = await runner.waitForExit();

		expect(exit.code).toBe(CIRCUIT_EXIT_STATUS);
		expect(runner.count(WAITING)).toBe(0);
		expect(runner.count(CIRCUIT_OPEN)).toBe(1);
	}, 30_000);

	test("still opens the circuit for a backend that exits out of space after the stack was ready", async () => {
		const where = layout();
		const runner = await start(where, {
			RUNNER_RESTART_MAX_FAILURES: "3",
		});

		// Only a start is waited out. A backend that was serving and then
		// went down is a crash, whatever status it left.
		for (const ready of [1, 2, 3]) {
			await runner.waitForOutput(READY, { times: ready });
			runner.crashBackend(OUT_OF_SPACE_EXIT_STATUS);
		}
		const exit = await runner.waitForExit();

		expect(exit.code).toBe(CIRCUIT_EXIT_STATUS);
		expect(runner.count(WAITING)).toBe(0);
		expect(runner.count(CIRCUIT_OPEN)).toBe(1);
	}, 30_000);
});
