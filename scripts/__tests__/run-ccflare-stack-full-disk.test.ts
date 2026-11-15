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
	findMountStrategy,
	inPrivateFilesystem,
} from "../../apps/server/src/disk-full-mount";
import {
	processesNaming,
	type RunnerFixture,
	type RunnerLayout,
	repoRoot,
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

	test("holds the listener's credential file before anything is started", async () => {
		const where = layout();
		const runner = await start(where);
		// No backend comes up, so no listener runs: what is in the directory
		// is what the runner put there.
		runner.refuseBackendStart(OUT_OF_SPACE_EXIT_STATUS);
		await runner.waitForOutput(WAITING, { times: 2 });
		const [name] = controlDirsIn(where.tmp);
		const credentialPath = join(where.tmp, name ?? "", "deploy-credential");

		// The listener starts after the stack is ready. A credential file it
		// had to make then would need a block, and failing for one would take
		// a serving stack down.
		expect(readFileSync(credentialPath, "utf8")).toBe(" ".repeat(43));
		expect(statSync(credentialPath).mode & 0o777).toBe(0o600);
		const inode = statSync(credentialPath).ino;

		// A file that has gone is put back at the next try, not only when
		// the directory is made.
		rmSync(credentialPath);
		const waits = runner.count(WAITING);
		await runner.waitForOutput(WAITING, { times: waits + 2 });
		expect(readFileSync(credentialPath, "utf8")).toBe(" ".repeat(43));
		const replaced = statSync(credentialPath).ino;

		runner.refuseBackendStart(null);
		await runner.waitForOutput(READY);
		const runtime = await runtimeRecord(runner);
		expect(await appears(join(runtime.controlDir, "deploy.sock"))).toBe(true);

		// The same file, so the listener wrote over it: the length the runner
		// holds is the length of the credential.
		expect(runtime.controlDir).toBe(join(where.tmp, name ?? ""));
		expect(statSync(credentialPath).ino).toBe(replaced);
		expect(replaced).not.toBe(0);
		expect(inode).not.toBe(0);
		expect(readFileSync(credentialPath, "utf8")).toMatch(
			/^[A-Za-z0-9_-]{43}$/,
		);
		expect((await runner.stop()).code).toBe(STOPPED_EXIT_STATUS);
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

	test("is counted again once the starts stop failing for lack of space", async () => {
		const where = layout();
		const runner = await start(where, {
			RUNNER_RESTART_MAX_FAILURES: "3",
		});
		runner.refuseBackendStart(OUT_OF_SPACE_EXIT_STATUS);
		await runner.waitForOutput(WAITING, { times: 2 });

		// The disk has space again and the backend is simply broken. A wait
		// that outlived its cause would keep the runner trying for ever.
		runner.refuseBackendStart(1);
		const exit = await runner.waitForExit();

		expect(exit.code).toBe(CIRCUIT_EXIT_STATUS);
		expect(runner.count(CIRCUIT_OPEN)).toBe(1);
		// Every refused start was either waited out or counted, and exactly
		// as many were counted as the circuit allows.
		const refused = lifecycle(runner).filter((line) =>
			line.startsWith("backend-refused "),
		).length;
		expect(refused - runner.count(WAITING)).toBe(3);
		// One start can have been under way when the stub changed its answer.
		expect(runner.count(WAITING)).toBeLessThanOrEqual(3);
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

// The second group: the same runner, on a filesystem with no free block. The
// driver does the work inside a private mount namespace (its header has what
// it holds the runner to) and reports what did not hold.
const DRIVER = join(import.meta.dir, "run-ccflare-stack-full-disk-driver.ts");
const FILESYSTEM = "size=16m";
/** The driver's own exit code for "stopped at `--deadline-ms`". */
const DEADLINE_EXIT_CODE = 3;
const strategy = findMountStrategy();

interface DriverReport {
	variant: string;
	failures: string[];
	fill: { available: number };
	refused: { waits: number };
	newRunner: { ready: boolean; waits?: number; controlDirectories?: number };
	/** The `no-record` scenario only. */
	noRecord: { ready: number; waitNotices: number; available: number };
	recorded: { runtime: { oldPid: number }; owner: { pid: number } };
	stop: { exit: { code: number | null }; processesLeft: number[] };
	runnerOutput: string[][];
}

/**
 * Starts the driver on a tmpfs of its own. `deadlineMs` must be below the
 * test's own timeout: a test that times out does not stop what it started,
 * and a runner waiting for space waits for ever.
 */
function startDriver(
	variant: string,
	deadlineMs: number,
	scenario = "restarts",
) {
	if (!strategy) throw new Error("no way to mount a private filesystem");
	const mount = mkdtempSync(join(tmpdir(), "ccflare-runner-full-fs-"));
	const scratch = mkdtempSync(join(tmpdir(), "ccflare-runner-full-scratch-"));
	roots.push(mount, scratch);
	const child = Bun.spawn(
		inPrivateFilesystem(strategy, mount, FILESYSTEM, [
			process.execPath,
			"run",
			DRIVER,
			"--dir",
			mount,
			"--scratch",
			scratch,
			"--variant",
			variant,
			"--deadline-ms",
			String(deadlineMs),
			"--scenario",
			scenario,
		]),
		{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
	);
	const finished = Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));
	return { scratch, finished };
}

async function runDriver(
	variant: string,
	scenario = "restarts",
): Promise<DriverReport> {
	const { stdout, stderr, exitCode } = await startDriver(
		variant,
		150_000,
		scenario,
	).finished;
	if (exitCode !== 0) {
		throw new Error(
			`the driver did not finish (exit ${exitCode}): ${stderr.slice(-3000)}`,
		);
	}
	const report = JSON.parse(stdout) as DriverReport;
	if (report.failures.length > 0) {
		// The runners' last lines are what explains a failure.
		for (const lines of report.runnerOutput) console.error(lines.join("\n"));
	}
	return report;
}

describe.skipIf(strategy === null)(
	"the runner on a filesystem with no free block",
	() => {
		test("restarts a backend, waits out refused starts and starts anew, given a runtime directory", async () => {
			const report = await runDriver("runtime-directory");

			expect(report.failures).toEqual([]);
			expect(report.fill.available).toBe(0);
			expect(report.refused.waits).toBeGreaterThanOrEqual(5);
			// A runner started on the full filesystem came up without a wait.
			expect(report.newRunner).toMatchObject({ ready: true });
		}, 180_000);

		test("restarts a backend and, started anew with no runtime directory, waits for space", async () => {
			const report = await runDriver("fallback");

			expect(report.failures).toEqual([]);
			expect(report.fill.available).toBe(0);
			expect(report.refused.waits).toBeGreaterThanOrEqual(5);
			// Its control directory is on the full filesystem, so it started
			// nothing and waited, past the circuit's cap, until space returned.
			expect(report.newRunner.ready).toBe(false);
			expect(report.newRunner.waits).toBeGreaterThanOrEqual(5);
			// On a tmpfs the directory can be made and only its credential
			// file cannot. It is kept, so each retry has less to find room for.
			expect(report.newRunner.controlDirectories).toBe(1);
		}, 180_000);

		// The deploy listener starts once the stack is ready and writes the
		// record a deploy finds it by. With no earlier record to write over it
		// used to exit, and the runner takes a listener that exits for a stack
		// that failed: three times, and it gave up, with a backend that had
		// started every time.
		for (const variant of ["runtime-directory", "fallback"]) {
			test(`keeps the stack up while the deploy listener has no record to write over (${variant})`, async () => {
				const report = await runDriver(variant, "no-record");

				expect(report.failures).toEqual([]);
				expect(report.fill.available).toBe(0);
				// Ready once after the backend went down and not again: the
				// listener waited, and said so once.
				expect(report.noRecord).toEqual({
					ready: 2,
					waitNotices: 1,
					available: 0,
				});
				// Once space was back, the record named the backend in service.
				expect(report.recorded.runtime.oldPid).toBe(report.recorded.owner.pid);
				// A stop while a listener waited.
				expect(report.stop.exit.code).toBe(143);
				expect(report.stop.processesLeft).toEqual([]);
			}, 180_000);
		}

		test("stops itself at its deadline and leaves no process behind", async () => {
			// The two tests above rely on this: a runner left waiting for
			// space would go on waiting with nothing left to stop it.
			const { scratch, finished } = startDriver("fallback", 4_000);
			let sawRunner = false;
			let exited = false;
			const outcome = finished.finally(() => {
				exited = true;
			});
			while (!exited) {
				// Seeing one while the run is going shows that the search
				// below would find one left behind.
				if (processesNaming(scratch).length > 0) sawRunner = true;
				await Bun.sleep(100);
			}
			const { exitCode, stdout, stderr } = await outcome;

			expect(stderr).toContain("deadline");
			expect(exitCode).toBe(DEADLINE_EXIT_CODE);
			expect(stdout).toBe("");
			expect(sawRunner).toBe(true);
			// A process sent SIGKILL is gone a moment later, not at once.
			const gone = Date.now() + 5_000;
			while (processesNaming(scratch).length > 0 && Date.now() < gone) {
				await Bun.sleep(100);
			}
			expect(processesNaming(scratch)).toEqual([]);
		}, 60_000);
	},
);

// A gate that cannot run must not look like one that passed.
describe.skipIf(strategy !== null || process.env.CI !== "true")(
	"the runner on a full filesystem, in CI",
	() => {
		test("can mount a private filesystem to fill", () => {
			throw new Error(
				"neither `unshare -Urmn` nor `sudo -n unshare -mn` works on this runner, so the runner was not run on a full filesystem",
			);
		});
	},
);
