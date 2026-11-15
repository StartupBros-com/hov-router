/**
 * Runs the full-disk scenario (disk-full-scenario.ts) as a test: the real
 * server on a 64 MB filesystem of its own that is filled to zero free blocks
 * and kept there (#827). "Serving and starting never need a successful disk
 * write" is the claim; a regression in any write on those paths fails here.
 *
 * The filesystem is a tmpfs mounted in a private mount namespace, and the run
 * has loopback as its only network interface, so it cannot fill the host's
 * disk or reach a provider. Two ways to get that, tried in order:
 *   1. an unprivileged user namespace (`unshare -Urmn`);
 *   2. passwordless sudo (`sudo -n unshare -mn`, then back to this user),
 *      for hosts that do not allow unprivileged user namespaces, which
 *      includes GitHub's Ubuntu runners.
 * With neither, the tests are skipped, except in CI, where they fail: a gate
 * that quietly stops running is worse than none.
 *
 * The same file runs twice in CI. In the main suite it drives the server from
 * source. With BETTER_CCFLARE_TEST_COMPILED_CLI set it drives that binary
 * instead, which is what production runs.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SCENARIO = join(import.meta.dir, "disk-full-scenario.ts");
const COMPILED_CLI = process.env.BETTER_CCFLARE_TEST_COMPILED_CLI || null;
const FILESYSTEM = "size=64m";

type Strategy = "userns" | "sudo";

const uid = String(process.getuid?.() ?? "");
const gid = String(process.getgid?.() ?? "");

/** The command that mounts a tmpfs on `mount` and runs `command` beside it. */
function inPrivateFilesystem(
	strategy: Strategy,
	mount: string,
	options: string,
	command: string[],
): string[] {
	if (strategy === "userns") {
		return [
			"unshare",
			"-Urmn",
			"sh",
			"-c",
			'ip link set lo up || exit 96; mount -t tmpfs -o "$2" tmpfs "$1" || exit 97; shift 2; exec "$@"',
			"sh",
			mount,
			options,
			...command,
		];
	}
	// Root makes the namespaces and the mount, owned by this user, and the
	// command then runs as this user again with an environment it names
	// itself: what sudo passes on depends on the host's policy.
	return [
		"sudo",
		"-n",
		"unshare",
		"-mn",
		"sh",
		"-c",
		'ip link set lo up || exit 96; mount -t tmpfs -o "$2,uid=$3,gid=$4,mode=0700" tmpfs "$1" || exit 97; shift 4; exec setpriv --reuid "$UID_TO" --regid "$GID_TO" --init-groups "$@"'
			.replace("$UID_TO", uid)
			.replace("$GID_TO", gid),
		"sh",
		mount,
		options,
		uid,
		gid,
		"env",
		`PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
		`HOME=${process.env.HOME ?? "/tmp"}`,
		...command,
	];
}

const probeDir = mkdtempSync(join(tmpdir(), "ccflare-disk-full-probe-"));

function works(strategy: Strategy): boolean {
	try {
		const result = Bun.spawnSync(
			inPrivateFilesystem(strategy, probeDir, "size=1m", [
				"sh",
				"-c",
				'echo ok > "$1/probe"',
				"sh",
				probeDir,
			]),
			{ stdout: "ignore", stderr: "ignore" },
		);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

const forced = process.env.BETTER_CCFLARE_DISK_FULL_TEST_MOUNT as
	| Strategy
	| undefined;
const strategy: Strategy | null =
	process.platform !== "linux" || uid === ""
		? null
		: forced
			? works(forced)
				? forced
				: null
			: works("userns")
				? "userns"
				: works("sudo")
					? "sudo"
					: null;
rmSync(probeDir, { recursive: true, force: true });

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

const mounts: string[] = [];

afterAll(() => {
	for (const mount of mounts) rmSync(mount, { recursive: true, force: true });
});

async function runScenario(args: string[]): Promise<Report> {
	if (!strategy) throw new Error("no way to mount a private filesystem");
	const mount = mkdtempSync(join(tmpdir(), "ccflare-disk-full-"));
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
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
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
		const report = await runScenario([
			"--oauth-row",
			"--soak-ms",
			"65000",
			"--restart-loops",
			"2",
		]);

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
		const report = await runScenario(["--schema-behind", "--soak-ms", "1000"]);

		expect(report.failures).toEqual([]);
		expect(report.schemaBehind).toMatchObject({
			healthy: false,
			freeBeforeStart: 0,
			exit: { exitCode: 1 },
			reserveArmedWhileFull: false,
			indexBackAfterSpace: true,
		});
		expect(report.schemaBehind?.refusal.join("\n")).toContain(
			"the disk has no space left",
		);
		expect(report.schemaBehind?.refusal.join("\n")).toContain(
			"Free space on that filesystem and start again",
		);
	}, 300_000);
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
