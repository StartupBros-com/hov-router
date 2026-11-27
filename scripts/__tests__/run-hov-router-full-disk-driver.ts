/**
 * The real runner on a filesystem with no free block (#827). Started by
 * run-hov-router-full-disk.test.ts inside a private mount namespace:
 *
 *   bun run <this file> --dir <mount> --scratch <dir> \
 *     --variant <runtime-directory|fallback> --deadline-ms <n> \
 *     [--scenario <restarts|no-record>]
 *
 * `--dir` is a small tmpfs mounted for this run. The runner's HOME, its
 * handoff directory, its pin and its TMPDIR are on it. `--scratch` is not:
 * the stub backend and what it records are there.
 *
 *   runtime-directory  the runner is given a runtime directory off the full
 *                      filesystem, as systemd gives the unit one on /run;
 *   fallback           it is given none, so its control directory is on the
 *                      full filesystem, as on an install whose unit has not
 *                      been deployed again since.
 *
 * What the run holds the runner to, written before the first run:
 *   - with the filesystem full, a backend that goes down is started again:
 *     the runner does not exit, the stack is ready, nothing staged is left
 *     beside the ownership record, and the record names the new backend;
 *   - starts the backend refuses for lack of space are waited out past the
 *     circuit's cap, and the stack is ready once the backend starts again;
 *   - after a stop on the full filesystem, `recover` says `start`;
 *   - a runner started while the filesystem is still full comes up when it
 *     has a runtime directory. With none it starts nothing, waits, leaves at
 *     most one control directory, and comes up once space returns.
 *
 * `--scenario no-record` is the deploy listener with nothing to write over.
 * The listener starts once the stack is ready and writes `runtime.json`, the
 * record a deploy finds it by. It can write over the last listener's record
 * without a block, but an install whose disk fills before the first record
 * is written has none. The run holds the runner to this:
 *   - the stack that came up stays up: the listener waits for space, says so
 *     once, and nothing counts toward the circuit;
 *   - once space is back the record names the running backend and the
 *     listener listens, with no restart in between;
 *   - a stop while the listener waits is a clean stop, with nothing staged
 *     and no process left.
 *
 * Prints one JSON report; `failures` is empty when all of that held. Exits 2
 * for a harness error and 3, with no report, at the deadline. Whatever
 * started the run may be unable to stop it, so it stops itself.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import {
	assertDedicatedSmallMount,
	blockCounts,
	fillToZero,
} from "../../apps/server/src/disk-full-support";
import {
	processesNaming,
	type RunnerFixture,
	startRunner,
} from "./runner-transaction-fixture";

const READY = "hov-router stack ready";
const WAITING = "waiting for space instead of opening the restart circuit";
const CIRCUIT_OPEN = "restart circuit open";
const CHILD_EXITED = "hov-router stack child exited";
const LISTENER_WAITING = "no space to record the deploy listener";
const LISTENER_RECORDED = "the deploy listener is recorded";
const OUT_OF_SPACE_EXIT_STATUS = 28;
const STOPPED_EXIT_STATUS = 143;
const DEADLINE_EXIT_CODE = 3;
/** The circuit's cap for these runners; the waits go well past it. */
const MAX_FAILURES = 3;
const WAITS = MAX_FAILURES + 2;
/**
 * Longer than three stack restarts take here. A listener that exits instead
 * of waiting takes the stack down each time, and the third opens the circuit.
 */
const HOLD_MS = 3_000;

type Variant = "runtime-directory" | "fallback";
type Scenario = "restarts" | "no-record";

function argument(name: string): string {
	const at = process.argv.indexOf(name);
	const value = at === -1 ? undefined : process.argv[at + 1];
	if (!value) {
		console.error(`runner full-disk driver: ${name} is required`);
		process.exit(2);
	}
	return value;
}

const mount = argument("--dir");
const scratch = argument("--scratch");
const variant = argument("--variant") as Variant;
const deadlineMs = Number(argument("--deadline-ms"));
const scenario = (
	process.argv.includes("--scenario") ? argument("--scenario") : "restarts"
) as Scenario;

try {
	if (variant !== "runtime-directory" && variant !== "fallback")
		throw new Error(`unknown variant ${variant}`);
	if (scenario !== "restarts" && scenario !== "no-record")
		throw new Error(`unknown scenario ${scenario}`);
	if (!Number.isInteger(deadlineMs) || deadlineMs < 1)
		throw new Error("--deadline-ms must be a positive whole number");
	assertDedicatedSmallMount(mount);
	if (statSync(scratch).dev === statSync(mount).dev)
		throw new Error(`${scratch} is on the filesystem that will be filled`);
} catch (error) {
	console.error(`runner full-disk driver harness error: ${error}`);
	process.exit(2);
}

const layout = {
	scratch,
	state: join(mount, "state"),
	tmp: join(mount, "tmp"),
	runtimeDirectory:
		variant === "runtime-directory" ? join(scratch, "run") : undefined,
};
mkdirSync(layout.state);
mkdirSync(layout.tmp);
if (layout.runtimeDirectory) mkdirSync(layout.runtimeDirectory);
const ballast = join(mount, "ballast");

const runners: RunnerFixture[] = [];
let refill: ReturnType<typeof setInterval> | undefined;
const stopEverything = () => {
	if (refill) clearInterval(refill);
	for (const runner of runners) runner.destroy();
};
setTimeout(() => {
	stopEverything();
	console.error(
		`runner full-disk driver: stopped at its deadline (${deadlineMs} ms)`,
	);
	process.exit(DEADLINE_EXIT_CODE);
}, deadlineMs);

const failures: string[] = [];
const check = (held: boolean, what: string) => {
	if (!held) failures.push(what);
};

interface Runtime {
	controlDir: string;
	deploymentPid: number;
	oldPid: number;
}

async function start(): Promise<RunnerFixture> {
	const runner = await startRunner(layout, {
		RUNNER_RESTART_MAX_FAILURES: String(MAX_FAILURES),
	});
	runners.push(runner);
	return runner;
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
			// Not written yet, or being written.
		}
		await Bun.sleep(20);
	}
	throw new Error("the deploy listener wrote no new runtime.json");
}

async function appears(path: string): Promise<boolean> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (existsSync(path)) return true;
		await Bun.sleep(20);
	}
	return false;
}

/** Files a staged write left beside the record it was for. */
const staged = (runner: RunnerFixture) =>
	readdirSync(runner.handoff).filter((name) => name.includes(".new-"));
const owner = (runner: RunnerFixture) =>
	JSON.parse(readFileSync(join(runner.handoff, "owner.json"), "utf8")) as {
		phase: string;
		pid: number;
	};
const controlDirs = (dir: string) =>
	readdirSync(dir).filter((name) => name.startsWith("hov-router-control."));
const backendStarts = (runner: RunnerFixture) => {
	const path = join(runner.capture, "lifecycle.log");
	return existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("backend-")).length
		: 0;
};
const available = () => blockCounts(mount).available;

/** What every step on the full filesystem must leave true. */
function checkStillStanding(runner: RunnerFixture, step: string) {
	check(runner.exited() === null, `${step}: the runner exited`);
	check(
		runner.count(CIRCUIT_OPEN) === 0,
		`${step}: the restart circuit opened`,
	);
	check(
		staged(runner).length === 0,
		`${step}: staged files were left: ${staged(runner).join(", ")}`,
	);
	check(available() === 0, `${step}: the filesystem had free blocks again`);
}

const report: Record<string, unknown> = { variant, scenario, failures };
let step = "the start with space";
let ballastBytes = 0;
/** Fill the filesystem, and keep a co-tenant taking any block that is let go. */
function keepFull() {
	ballastBytes += fillToZero(ballast);
	refill = setInterval(() => {
		try {
			ballastBytes += fillToZero(ballast);
		} catch {
			// Removed once space is meant to return.
		}
	}, 100);
}
function giveSpaceBack() {
	clearInterval(refill);
	refill = undefined;
	rmSync(ballast);
}

async function restarts(first: RunnerFixture, withSpace: Runtime) {
	const filledTo = ballastBytes;

	step = "a backend that goes down while the filesystem is full";
	first.crashBackend();
	await first.waitForOutput(READY, { times: 2, timeoutMs: 40_000 });
	const afterCrash = await runtimeRecord(first, withSpace.deploymentPid);
	checkStillStanding(first, step);
	check(
		afterCrash.controlDir === withSpace.controlDir,
		`${step}: the control directory was made again`,
	);
	check(
		owner(first).phase === "running" && owner(first).pid === afterCrash.oldPid,
		`${step}: the ownership record does not name the new backend: ${JSON.stringify(owner(first))}`,
	);
	check(
		await appears(join(afterCrash.controlDir, "deploy.sock")),
		`${step}: the deploy listener is not listening`,
	);
	report.crash = { runtime: afterCrash, owner: owner(first) };

	step = "starts the backend refuses for lack of space";
	first.refuseBackendStart(OUT_OF_SPACE_EXIT_STATUS);
	first.crashBackend();
	await first.waitForOutput(WAITING, { times: WAITS, timeoutMs: 40_000 });
	checkStillStanding(first, step);
	first.refuseBackendStart(null);
	await first.waitForOutput(READY, { times: 3, timeoutMs: 40_000 });
	checkStillStanding(first, `${step}, once it starts again`);
	const beforeStop = await runtimeRecord(first, afterCrash.deploymentPid);
	report.refused = { waits: first.count(WAITING) };

	step = "a stop while the filesystem is full";
	const stopped = await first.stop();
	check(
		stopped.code === STOPPED_EXIT_STATUS,
		`${step}: the runner exited ${JSON.stringify(stopped)}`,
	);
	const recovered = first.recover();
	check(
		recovered.status === 0 && recovered.stdout === '{"action":"start"}',
		`${step}: recover said ${JSON.stringify(recovered)}`,
	);
	check(staged(first).length === 0, `${step}: staged files were left`);
	report.stop = { exit: stopped, recover: recovered };

	step = "a runner started while the filesystem is full";
	// Whatever the stop released is taken before the next runner looks.
	ballastBytes += fillToZero(ballast);
	check(available() === 0, `${step}: the filesystem was not full`);
	const startsBefore = backendStarts(first);
	const second = await start();
	if (variant === "runtime-directory") {
		await second.waitForOutput(READY, { timeoutMs: 40_000 });
		const fresh = await runtimeRecord(second, beforeStop.deploymentPid);
		checkStillStanding(second, step);
		check(
			fresh.controlDir.startsWith(`${layout.runtimeDirectory}/`),
			`${step}: the control directory is not in the runtime directory: ${fresh.controlDir}`,
		);
		check(
			controlDirs(layout.tmp).length === 0,
			`${step}: a control directory was made on the full filesystem`,
		);
		check(second.count(WAITING) === 0, `${step}: the runner had to wait`);
		report.newRunner = { ready: true, runtime: fresh };
	} else {
		await second.waitForOutput(WAITING, { times: WAITS, timeoutMs: 40_000 });
		checkStillStanding(second, step);
		check(
			second.output().includes("step=the control directory"),
			`${step}: the wait was not for the control directory`,
		);
		check(second.count(READY) === 0, `${step}: a stack came up`);
		check(
			backendStarts(second) === startsBefore,
			`${step}: a backend was started`,
		);
		// One where making a directory needs no block (tmpfs); none where it
		// does (ext4) and the runner found none. Never one per attempt.
		const kept = controlDirs(layout.tmp).length;
		check(kept <= 1, `${step}: ${kept} control directories were left`);
		report.newRunner = {
			ready: false,
			waits: second.count(WAITING),
			controlDirectories: kept,
		};
	}
	report.ballastGrowthBytes = ballastBytes - filledTo;

	step = "space coming back";
	giveSpaceBack();
	await second.waitForOutput(READY, { timeoutMs: 40_000 });
	check(second.exited() === null, `${step}: the runner exited`);
	check(second.count(CIRCUIT_OPEN) === 0, `${step}: the circuit opened`);
	const last = await second.stop();
	check(
		last.code === STOPPED_EXIT_STATUS,
		`${step}: the runner exited ${JSON.stringify(last)}`,
	);
	const lastRecover = second.recover();
	check(
		lastRecover.status === 0 && lastRecover.stdout === '{"action":"start"}',
		`${step}: recover said ${JSON.stringify(lastRecover)}`,
	);
}

/** Of these processes, the ones that are a deploy listener. */
function listenersAmong(pids: number[]): number[] {
	return pids.filter((pid) => {
		try {
			const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
			return (
				args.includes("serve") &&
				args.some((arg) => arg.endsWith("hov-router-deployment-transaction.mjs"))
			);
		} catch {
			// Gone already.
			return false;
		}
	});
}

async function listenerWithNoRecord(first: RunnerFixture, withSpace: Runtime) {
	const record = join(first.handoff, "runtime.json");
	const socket = join(withSpace.controlDir, "deploy.sock");
	/** Take the record away, and give its block to the co-tenant at once. */
	const removeRecord = () => {
		rmSync(record);
		ballastBytes += fillToZero(ballast);
	};

	step = "a listener with no record to write over";
	removeRecord();
	first.crashBackend();
	await first.waitForOutput(READY, { times: 2, timeoutMs: 40_000 });
	await first.waitForOutput(LISTENER_WAITING, { timeoutMs: 15_000 });
	await Bun.sleep(HOLD_MS);
	checkStillStanding(first, step);
	check(first.count(READY) === 2, `${step}: the stack was restarted`);
	check(
		first.count(CHILD_EXITED) === 1,
		`${step}: a stack child exited besides the backend that went down`,
	);
	check(
		first.count(LISTENER_WAITING) === 1,
		`${step}: the wait was announced ${first.count(LISTENER_WAITING)} times`,
	);
	check(
		!existsSync(record),
		`${step}: a record was written with no space for it`,
	);
	check(!existsSync(socket), `${step}: the listener listens with no record`);
	report.noRecord = {
		ready: first.count(READY),
		waitNotices: first.count(LISTENER_WAITING),
		available: available(),
	};

	step = "space coming back to a listener that waits";
	giveSpaceBack();
	const landed = await runtimeRecord(first);
	await first.waitForOutput(LISTENER_RECORDED, { timeoutMs: 5_000 });
	check(
		landed.oldPid === owner(first).pid,
		`${step}: the record does not name the running backend: ${JSON.stringify(landed)}`,
	);
	check(
		await appears(join(landed.controlDir, "deploy.sock")),
		`${step}: the deploy listener is not listening`,
	);
	check(first.exited() === null, `${step}: the runner exited`);
	check(first.count(READY) === 2, `${step}: the stack was restarted`);
	check(first.count(CIRCUIT_OPEN) === 0, `${step}: the circuit opened`);
	check(
		first.count(LISTENER_RECORDED) === 1,
		`${step}: the record was announced ${first.count(LISTENER_RECORDED)} times`,
	);
	report.recorded = { runtime: landed, owner: owner(first) };

	step = "a stop while a listener waits";
	keepFull();
	removeRecord();
	first.crashBackend();
	await first.waitForOutput(READY, { times: 3, timeoutMs: 40_000 });
	await first.waitForOutput(LISTENER_WAITING, { times: 2, timeoutMs: 15_000 });
	checkStillStanding(first, step);
	// The search that says nothing was left must be able to see what a stop
	// could leave: the listener that is waiting now.
	const seenBefore = processesNaming(first.handoff);
	const listenersBefore = listenersAmong(seenBefore);
	check(
		listenersBefore.length === 1,
		`${step}: the process search sees ${listenersBefore.length} waiting listener(s) among ${seenBefore.join(", ")}`,
	);
	const stopped = await first.stop();
	check(
		stopped.code === STOPPED_EXIT_STATUS,
		`${step}: the runner exited ${JSON.stringify(stopped)}`,
	);
	const recovered = first.recover();
	check(
		recovered.status === 0 && recovered.stdout === '{"action":"start"}',
		`${step}: recover said ${JSON.stringify(recovered)}`,
	);
	check(staged(first).length === 0, `${step}: staged files were left`);
	check(!existsSync(record), `${step}: a record was written`);
	// The runner and all it started carry the handoff directory's path. A
	// child the runner has signalled can take a moment to go.
	const goneBy = Date.now() + 5_000;
	let left = processesNaming(first.handoff);
	while (left.length > 0 && Date.now() < goneBy) {
		await Bun.sleep(50);
		left = processesNaming(first.handoff);
	}
	check(left.length === 0, `${step}: processes were left: ${left.join(", ")}`);
	report.stop = {
		exit: stopped,
		recover: recovered,
		listenersSeenBeforeStop: listenersBefore.length,
		processesLeft: left,
	};
}

try {
	const first = await start();
	await first.waitForOutput(READY);
	const withSpace = await runtimeRecord(first);

	step = "the fill";
	keepFull();
	report.fill = { ballastBytes, available: available() };
	check(available() === 0, "the fill left free blocks");

	if (scenario === "no-record") await listenerWithNoRecord(first, withSpace);
	else await restarts(first, withSpace);
} catch (error) {
	failures.push(`stopped at ${step}: ${error}`);
} finally {
	stopEverything();
}

report.runnerOutput = runners.map((runner) =>
	runner.output().split("\n").slice(-60),
);
console.log(JSON.stringify(report, null, 2));
process.exit(0);
