/**
 * The runner fixture's `stop` (#859). Bash 5.2 can drop a stop's handler when
 * the signal lands while the shell parses a command substitution, and the
 * runner parses one right after it says it is ready. A stop sent on "ready"
 * then ended the runner with status 2 instead of 143, in 2 of 33 CI runs.
 * So `stop` waits for the deploy listener the runner starts next.
 */
import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
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
/** The runner's status after a stop it was asked for. */
const STOPPED_EXIT_STATUS = 143;

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

function layout(): RunnerLayout {
	const root = mkdtempSync(join(tmpdir(), "ccflare-runner-fixture-"));
	roots.push(root);
	const made = {
		scratch: join(root, "scratch"),
		state: join(root, "state"),
		tmp: join(root, "tmp"),
	};
	for (const dir of [made.scratch, made.state, made.tmp]) mkdirSync(dir);
	return made;
}

test("stop waits until the runner has started its deploy listener", async () => {
	const where = layout();
	// Hold the listener's start back well past "ready". A stop sent at once
	// would end the runner, and the listener with it, before it started.
	const capture = join(where.scratch, "capture");
	mkdirSync(capture, { recursive: true });
	writeFileSync(join(capture, "delay-command-serve"), "2");
	const runner = await startRunner(where);
	runners.push(runner);

	await runner.waitForOutput(READY);
	const exit = await runner.stop();

	const started = join(capture, "started-commands.log");
	const commands = existsSync(started)
		? readFileSync(started, "utf8").split("\n")
		: [];
	expect(commands).toContain("serve");
	expect(exit.code).toBe(STOPPED_EXIT_STATUS);
}, 30_000);

test("a runner's stop ignores listener starts from an earlier runner on the same layout", async () => {
	const where = layout();
	const first = await startRunner(where);
	runners.push(first);
	await first.waitForOutput(READY);
	expect((await first.stop()).code).toBe(STOPPED_EXIT_STATUS);

	const started = join(first.capture, "started-commands.log");
	const serves = () =>
		readFileSync(started, "utf8")
			.split("\n")
			.filter((command) => command === "serve").length;
	expect(serves()).toBe(1);
	writeFileSync(join(first.capture, "delay-command-serve"), "2");
	const second = await startRunner(where);
	runners.push(second);
	await second.waitForOutput(READY);
	expect(serves()).toBe(1);

	// Assert at signal time: the EXIT path can wait long enough for a
	// delayed listener to start after an incorrectly early signal.
	const kill = second.child.kill.bind(second.child);
	let servesAtTerm: number | undefined;
	second.child.kill = (signal) => {
		if (signal === "SIGTERM") servesAtTerm = serves();
		return kill(signal);
	};
	const exit = await second.stop();
	expect(servesAtTerm).toBe(2);
	expect(exit.code).toBe(STOPPED_EXIT_STATUS);
}, 30_000);
