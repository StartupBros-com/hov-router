/**
 * Runs the full-disk scenario (disk-full-scenario.ts) as a test: the real
 * server on a 64 MB filesystem of its own that is filled to zero free blocks
 * and kept there (#827). "Serving and starting never need a successful disk
 * write" is the claim; a regression in any write on those paths fails here.
 *
 * The filesystem is a tmpfs mounted in a private mount namespace, and the run
 * has loopback as its only network interface, so it cannot fill the host's
 * disk or reach a provider (disk-full-mount.ts has the two ways to get
 * that). Where neither works the tests are skipped, except in CI, where they
 * fail: a gate that quietly stops running is worse than none.
 *
 * The same file runs twice in CI. In the main suite it drives the server from
 * source. With HOV_ROUTER_TEST_COMPILED_CLI set it drives that binary
 * instead, which is what production runs.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findMountStrategy, inPrivateFilesystem } from "./disk-full-mount";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SCENARIO = join(import.meta.dir, "disk-full-scenario.ts");
const COMPILED_CLI = process.env.HOV_ROUTER_TEST_COMPILED_CLI || null;
const FILESYSTEM = "size=64m";

const strategy = findMountStrategy();

interface Start {
	healthy: boolean;
	freeBeforeStart: number;
	requests: { sent: number; served: number };
	oauthSlot: { slots: unknown[]; tempFiles: number; saidNoSpace: boolean };
}

interface Report {
	mode: string;
	failures: string[];
	serverOutput: string[];
	oauthRow?: {
		slotsAfterStartWithSpace: { slots: Array<{ bytes: number }> };
		slotsAtFill: { slots: unknown[] };
	};
	full: {
		requests: { sent: number; served: number };
		afterSoak: { sent: number; served: number };
		alive: boolean;
		soakHealthFailures: number;
		freeBytes: number;
	};
	restarts: Record<string, Start>;
	restartLoop?: { requested: number; completed: number };
	schemaBehind?: {
		healthy: boolean;
		freeBeforeStart: number;
		exit: { exitCode: number | null } | null;
		refusal: string[];
		reserveArmedWhileFull: boolean | null;
		indexBackAfterSpace: boolean | null;
	};
	recovery: { recordingResumed: boolean; logResumed: boolean };
}

/**
 * Other processes whose command line or environment names `needle`. Every
 * process of a run has the mount directory in one or the other.
 */
function processesNaming(
	needle: string,
): Array<{ pid: number; inCommandLine: boolean }> {
	const found: Array<{ pid: number; inCommandLine: boolean }> = [];
	for (const entry of readdirSync("/proc")) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || pid === process.pid) continue;
		const names = (file: string): boolean => {
			try {
				return readFileSync(`/proc/${entry}/${file}`, "utf8").includes(needle);
			} catch {
				// Gone already, or not ours to read.
				return false;
			}
		};
		if (names("cmdline")) found.push({ pid, inCommandLine: true });
		else if (names("environ")) found.push({ pid, inCommandLine: false });
	}
	return found;
}

const mounts: string[] = [];

afterAll(() => {
	for (const mount of mounts) rmSync(mount, { recursive: true, force: true });
});

/** The scenario's own exit code for "stopped at `--deadline-ms`". */
const DEADLINE_EXIT_CODE = 3;

function startScenario(args: string[]) {
	if (!strategy) throw new Error("no way to mount a private filesystem");
	const mount = mkdtempSync(join(tmpdir(), "hov-router-disk-full-"));
	mounts.push(mount);
	const child = Bun.spawn(
		inPrivateFilesystem(strategy, mount, FILESYSTEM, [
			process.execPath,
			"run",
			SCENARIO,
			"--dir",
			mount,
			...(COMPILED_CLI ? ["--binary", resolve(COMPILED_CLI)] : []),
			...args,
		]),
		{ cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
	);
	const finished = Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));
	return { mount, finished };
}

/**
 * Runs the scenario to its report. `deadlineMs` must be below the test's own
 * timeout: a test that times out does not stop what it started, and under
 * sudo it could not, so the scenario stops itself first.
 */
async function runScenario(
	args: string[],
	deadlineMs: number,
): Promise<Report> {
	const { finished } = startScenario([
		...args,
		"--deadline-ms",
		String(deadlineMs),
	]);
	const { stdout, stderr, exitCode } = await finished;
	if (exitCode !== 0) {
		throw new Error(
			`the scenario did not run (exit ${exitCode}): ${stderr.slice(-2000)}`,
		);
	}
	const report = JSON.parse(stdout) as Report;
	if (report.failures.length > 0) {
		// The server's last lines are what explains a failure.
		console.error(report.serverOutput.slice(-60).join("\n"));
	}
	return report;
}

const mode = COMPILED_CLI ? "the compiled binary" : "source";

describe.skipIf(strategy === null)(`a full disk, with ${mode}`, () => {
	it("keeps serving, restarts and recovers with no free block on the filesystem", async () => {
		// 65 s of soak crosses the once-a-minute WAL checkpoint, which has
		// to cope with the full filesystem too.
		const report = await runScenario(
			["--oauth-row", "--soak-ms", "65000", "--restart-loops", "2"],
			390_000,
		);

		expect(report.failures).toEqual([]);
		expect(report.mode).toBe(COMPILED_CLI ? "compiled" : "source");
		// With space, the start made the rotating account's slot.
		expect(
			report.oauthRow?.slotsAfterStartWithSpace.slots.map((slot) => slot.bytes),
		).toEqual([65_536]);
		expect(report.oauthRow?.slotsAtFill.slots).toEqual([]);
		// Full: every request served, the process alive, health answering.
		expect(report.full.freeBytes).toBe(0);
		expect(report.full.requests).toMatchObject({ sent: 40, served: 40 });
		expect(report.full.afterSoak).toMatchObject({ sent: 10, served: 10 });
		expect(report.full.alive).toBe(true);
		expect(report.full.soakHealthFailures).toBe(0);
		// Every start on the full filesystem came up and served.
		expect(Object.keys(report.restarts)).toEqual([
			"clean-stop",
			"crash",
			"clean-stop-no-log-dir",
		]);
		for (const start of Object.values(report.restarts)) {
			expect(start.freeBeforeStart).toBe(0);
			expect(start.healthy).toBe(true);
			expect(start.requests).toMatchObject({ sent: 5, served: 5 });
			// No slot could be made, and the start said so and left nothing.
			expect(start.oauthSlot).toEqual({
				slots: [],
				tempFiles: 0,
				saidNoSpace: true,
			});
		}
		expect(report.restartLoop).toMatchObject({ requested: 2, completed: 2 });
		// Space returns: recording and the log file resume without a restart.
		expect(report.recovery).toMatchObject({
			recordingResumed: true,
			logResumed: true,
		});
	}, 420_000);

	it("refuses to start, and says why, when the full disk leaves its schema work unfinished", async () => {
		const report = await runScenario(
			["--schema-behind", "--soak-ms", "1000"],
			270_000,
		);

		expect(report.failures).toEqual([]);
		expect(report.schemaBehind).toMatchObject({
			healthy: false,
			freeBeforeStart: 0,
			// 28, not 1: the runner waits for space after this status and
			// counts any other toward the circuit that takes the unit down.
			exit: { exitCode: 28 },
			reserveArmedWhileFull: false,
			indexBackAfterSpace: true,
		});
		expect(report.schemaBehind?.refusal.join("\n")).toContain(
			"the disk has no space left",
		);
		expect(report.schemaBehind?.refusal.join("\n")).toContain(
			"Free space on that filesystem and start again",
		);
		// The start measured what the filesystem had left before it called
		// the disk full. A measurement that failed would say so instead.
		expect(report.schemaBehind?.refusal.join("\n")).toMatch(
			/; \d+ bytes available\)/,
		);
	}, 300_000);

	it("stops itself at its deadline and leaves no process behind", async () => {
		// The two tests above rely on this. A run that outlived its test
		// would keep a server and a full filesystem going with nothing left
		// to stop them.
		const { mount, finished } = startScenario([
			"--soak-ms",
			"120000",
			"--deadline-ms",
			"20000",
		]);
		// The server's command line does not name the mount; its environment
		// does. Seeing it while the run is going shows that the search below
		// would find one left behind.
		let sawServer = false;
		let exited = false;
		const outcome = finished.finally(() => {
			exited = true;
		});
		while (!exited) {
			if (processesNaming(mount).some((found) => !found.inCommandLine)) {
				sawServer = true;
			}
			await Bun.sleep(250);
		}
		const { exitCode, stdout, stderr } = await outcome;

		expect(stderr).toContain("deadline");
		expect(exitCode).toBe(DEADLINE_EXIT_CODE);
		expect(stdout).toBe("");
		expect(sawServer).toBe(true);
		// A process sent SIGKILL is gone a moment later, not at once.
		const gone = Date.now() + 5_000;
		while (processesNaming(mount).length > 0 && Date.now() < gone) {
			await Bun.sleep(100);
		}
		expect(processesNaming(mount)).toEqual([]);
	}, 90_000);
});

// A gate that cannot run must not look like one that passed.
describe.skipIf(strategy !== null || process.env.CI !== "true")(
	"a full disk, in CI",
	() => {
		it("can mount a private filesystem to fill", () => {
			throw new Error(
				"neither `unshare -Urmn` nor `sudo -n unshare -mn` works on this runner, so the full-disk scenario did not run",
			);
		});
	},
);
