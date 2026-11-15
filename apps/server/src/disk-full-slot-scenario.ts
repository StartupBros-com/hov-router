#!/usr/bin/env bun
/**
 * Full-filesystem scenario for the rotated-credential store (#827).
 *
 * A rotated refresh token whose database write fails is saved to a slot file
 * per account. This checks the claim the refresh path relies on: once a slot
 * exists, a save needs no new blocks, so it works on a filesystem with none
 * left while another process takes every block the moment one is released.
 *
 * On a size-capped filesystem the caller mounted, it reserves slots, fills the
 * filesystem to zero available blocks, starts a second process that retries a
 * 4 KiB append without pause, and then:
 *   - saves and clears every reserved account for `--rounds` rounds, checking
 *     after each round that no slot changed size, inode or block count;
 *   - checks that an account with no slot can neither be saved nor reserved;
 *   - builds a store over a directory that does not exist, the way a server
 *     starting on the full filesystem would, which must not fail;
 *   - kills a process in the middle of a run of saves and reads the slot back
 *     in a new process;
 *   - reads every slot back in a new process and compares it with what was
 *     saved last.
 *
 * Usage:
 *   bun run apps/server/src/disk-full-slot-scenario.ts --dir <mounted dir>
 *     [--accounts <n>] [--rounds <n>] [--spin-pause-us <n>]
 *
 * Prints one JSON report on stdout. Exit 0 means the scenario ran (read
 * `failures`); exit 2 means the harness itself could not run.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	createPendingRotationStore,
	type PendingRotationStore,
} from "@better-ccflare/proxy/pending-rotation-store";
import {
	assertDedicatedSmallMount,
	blockCounts,
	fillToZero,
	spinForever,
} from "./disk-full-support";

const SECRET = "disk-full-slot-scenario-secret-with-enough-entropy";
/** Saves a killed writer must have reported before it is killed. */
const SAVES_BEFORE_KILL = 40;
/** Longest stored access and refresh tokens on the measured install. */
const ACCESS_TOKEN_CHARS = 1_789;
const REFRESH_TOKEN_CHARS = 211;

interface Args {
	dir: string;
	accounts: number;
	rounds: number;
	spinPauseUs: number;
}

interface SlotIdentity {
	size: number;
	ino: number;
	blocks: number;
}

function parseArgs(argv: string[]): Args {
	const value = (flag: string): string | null => {
		const index = argv.indexOf(flag);
		return index >= 0 ? (argv[index + 1] ?? null) : null;
	};
	const count = (flag: string, fallback: number): number => {
		const raw = value(flag);
		if (raw === null) return fallback;
		const parsed = Number(raw);
		if (!Number.isInteger(parsed) || parsed < 0) {
			throw new Error(`${flag} needs a whole number, got ${raw}`);
		}
		return parsed;
	};
	const dir = value("--dir");
	if (!dir) throw new Error("--dir <mounted dir> is required");
	return {
		dir,
		accounts: count("--accounts", 14),
		rounds: count("--rounds", 50),
		spinPauseUs: count("--spin-pause-us", 0),
	};
}

function padTo(label: string, length: number): string {
	return label.padEnd(length, "x");
}

/** A rotation the size of the largest real one, recognisable by its label. */
function rotation(label: string) {
	return {
		accessToken: padTo(`access-${label}-`, ACCESS_TOKEN_CHARS),
		expiresAt: 2_000_000_000_000,
		refreshToken: padTo(`refresh-${label}-`, REFRESH_TOKEN_CHARS),
		attemptedRefreshToken: padTo(`consumed-${label}-`, REFRESH_TOKEN_CHARS),
		createdAt: 101,
		recordedAt: 1_700_000_000_000,
	};
}

function labelOf(accessToken: string): string | null {
	const match = /^access-(.+?)-x*$/.exec(accessToken);
	return match ? (match[1] as string) : null;
}

function slotIdentities(directory: string): Record<string, SlotIdentity> {
	const identities: Record<string, SlotIdentity> = {};
	for (const name of readdirSync(directory)) {
		if (!name.endsWith(".slot")) continue;
		const stats = statSync(join(directory, name));
		identities[name] = {
			size: stats.size,
			ino: stats.ino,
			blocks: stats.blocks,
		};
	}
	return identities;
}

function errorCode(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : String(error);
}

/** The `--save-loop` child: saves numbered rotations until it is killed. */
async function saveLoop(directory: string, accountId: string): Promise<never> {
	const store = createPendingRotationStore({ directory, secret: SECRET });
	for (let number = 1; ; number++) {
		await store.save(accountId, rotation(`kill-${number}`));
		process.stdout.write(`saved ${number}\n`);
	}
}

/** The `--load` child: what a new process finds in the store. */
async function loadAndPrint(directory: string): Promise<void> {
	const store = createPendingRotationStore({ directory, secret: SECRET });
	const entries = await store.load();
	console.log(
		JSON.stringify(
			entries.map((entry) => ({
				accountId: entry.accountId,
				label: labelOf(entry.rotation.accessToken),
				matches:
					JSON.stringify(entry.rotation) ===
					JSON.stringify(
						rotation(labelOf(entry.rotation.accessToken) ?? "none"),
					),
			})),
		),
	);
}

async function runChild(
	args: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const proc = Bun.spawn([process.execPath, import.meta.path, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode: await proc.exited, stdout, stderr };
}

async function loadInNewProcess(
	directory: string,
): Promise<
	Array<{ accountId: string; label: string | null; matches: boolean }>
> {
	const child = await runChild(["--load", directory]);
	if (child.exitCode !== 0) {
		throw new Error(
			`load in a new process exited ${child.exitCode}: ${child.stderr.trim()}`,
		);
	}
	return JSON.parse(child.stdout);
}

/** Start a run of saves in another process and kill it without warning. */
async function killMidSave(
	directory: string,
	accountId: string,
): Promise<{ lastReported: number; stderr: string }> {
	const proc = Bun.spawn(
		[process.execPath, import.meta.path, "--save-loop", directory, accountId],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const stderr = new Response(proc.stderr).text();
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	let lastReported = 0;
	while (lastReported < SAVES_BEFORE_KILL) {
		const { done, value } = await reader.read();
		if (done) break;
		buffered += decoder.decode(value, { stream: true });
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			const number = Number(line.replace("saved ", ""));
			if (Number.isInteger(number)) lastReported = number;
		}
	}
	proc.kill("SIGKILL");
	await proc.exited;
	return { lastReported, stderr: (await stderr).trim() };
}

async function main(): Promise<void> {
	const spinIndex = process.argv.indexOf("--spin");
	if (spinIndex >= 0) {
		spinForever(
			process.argv[spinIndex + 1] as string,
			Number(process.argv[spinIndex + 2] ?? 0),
		);
	}
	const saveIndex = process.argv.indexOf("--save-loop");
	if (saveIndex >= 0) {
		await saveLoop(
			process.argv[saveIndex + 1] as string,
			process.argv[saveIndex + 2] as string,
		);
	}
	const loadIndex = process.argv.indexOf("--load");
	if (loadIndex >= 0) {
		await loadAndPrint(process.argv[loadIndex + 1] as string);
		return;
	}

	const args = parseArgs(process.argv.slice(2));
	if (!existsSync(args.dir)) throw new Error(`${args.dir} does not exist`);
	assertDedicatedSmallMount(args.dir);
	const directory = join(args.dir, "pending-rotations");
	mkdirSync(directory, { recursive: true });
	// Left unmade until the filesystem is full.
	const lateDirectory = join(args.dir, "pending-rotations-late");
	const ballast = join(args.dir, "ballast.bin");
	const spinFile = join(args.dir, "spin.bin");
	const failures: string[] = [];
	const report: Record<string, unknown> = {
		accounts: args.accounts,
		roundsRequested: args.rounds,
		spinPauseUs: args.spinPauseUs,
	};

	const reserved = Array.from(
		{ length: args.accounts },
		(_, index) => `account-${index + 1}`,
	);
	const unreserved = "account-without-slot";
	const store: PendingRotationStore = createPendingRotationStore({
		directory,
		secret: SECRET,
	});
	for (const accountId of reserved) await store.reserve(accountId);
	const before = slotIdentities(directory);
	report.reservedSlots = Object.keys(before).length;
	if (Object.keys(before).length !== reserved.length) {
		failures.push(
			`reserved ${reserved.length} accounts but found ${Object.keys(before).length} slot files`,
		);
	}

	const filledBytes = fillToZero(ballast);
	const spinner = Bun.spawn(
		[
			process.execPath,
			import.meta.path,
			"--spin",
			spinFile,
			String(args.spinPauseUs),
		],
		{ stdout: "ignore", stderr: "inherit" },
	);
	const refill = setInterval(() => {
		try {
			fillToZero(ballast);
		} catch {
			// The ballast is removed in the recovery phase.
		}
	}, 200);
	await Bun.sleep(500);
	report.fill = { filledBytes, blocksAfterFill: blockCounts(args.dir) };

	try {
		// Save and clear every reserved account, round after round.
		let saves = 0;
		let saveFailures = 0;
		let clears = 0;
		let clearFailures = 0;
		let identityChanges = 0;
		let firstError: string | null = null;
		for (let round = 1; round <= args.rounds; round++) {
			for (const accountId of reserved) {
				try {
					await store.save(accountId, rotation(`round-${round}`));
					saves++;
				} catch (error) {
					saveFailures++;
					firstError ??= `save round ${round} ${accountId}: ${errorCode(error)}`;
				}
			}
			if (round < args.rounds) {
				for (const accountId of reserved) {
					try {
						await store.remove(accountId);
						clears++;
					} catch (error) {
						clearFailures++;
						firstError ??= `clear round ${round} ${accountId}: ${errorCode(error)}`;
					}
				}
			}
			if (
				JSON.stringify(slotIdentities(directory)) !== JSON.stringify(before)
			) {
				identityChanges++;
				firstError ??= `slot size, inode or block count changed in round ${round}`;
			}
		}
		report.rounds = {
			saves,
			saveFailures,
			clears,
			clearFailures,
			identityChanges,
			firstError,
			blocksAfterRounds: blockCounts(args.dir),
		};
		if (saveFailures > 0) failures.push(`${saveFailures} saves failed`);
		if (clearFailures > 0) failures.push(`${clearFailures} clears failed`);
		if (identityChanges > 0) {
			failures.push(
				`a slot changed size, inode or block count in ${identityChanges} rounds`,
			);
		}

		// An account with no slot: the case the refresh path refuses up front.
		const withoutSlot: Record<string, string> = {};
		try {
			await store.save(unreserved, rotation("no-slot"));
			withoutSlot.save = "saved";
			failures.push("a save for an account with no slot succeeded while full");
		} catch (error) {
			withoutSlot.save = errorCode(error);
		}
		try {
			await store.reserve(unreserved);
			withoutSlot.reserve = "reserved";
			failures.push("a reservation succeeded while full");
		} catch (error) {
			withoutSlot.reserve = errorCode(error);
		}
		report.withoutSlot = withoutSlot;

		// A server starting now builds its store over a directory that does not
		// exist. That must not fail the start; a reservation says why it cannot.
		const withoutDirectory: Record<string, unknown> = {};
		const errorsLogged: string[] = [];
		try {
			const late = createPendingRotationStore({
				directory: lateDirectory,
				secret: SECRET,
				log: {
					info: () => {},
					warn: () => {},
					error: (message) => errorsLogged.push(message),
				},
			});
			withoutDirectory.build = "built";
			withoutDirectory.directoryMade = existsSync(lateDirectory);
			withoutDirectory.errorsLogged = errorsLogged.length;
			withoutDirectory.loaded = (await late.load()).length;
			if (withoutDirectory.loaded !== 0) {
				failures.push("a store over a new directory loaded entries");
			}
			try {
				await late.reserve(unreserved);
				withoutDirectory.reserve = "reserved";
				failures.push("a reservation in a new directory succeeded while full");
			} catch (error) {
				withoutDirectory.reserve = errorCode(error);
				if (errorCode(error) !== "ENOSPC") {
					failures.push(
						`a reservation in a new directory failed with ${errorCode(error)}, expected ENOSPC`,
					);
				}
			}
		} catch (error) {
			withoutDirectory.build = errorCode(error);
			failures.push(
				`building a store over a new directory failed while full: ${errorCode(error)}`,
			);
		}
		report.withoutDirectory = withoutDirectory;

		// What a new process finds after the rounds.
		const afterRounds = await loadInNewProcess(directory);
		const wrong = reserved.filter((accountId) => {
			const entry = afterRounds.find((item) => item.accountId === accountId);
			return !entry || entry.label !== `round-${args.rounds}` || !entry.matches;
		});
		report.reloadAfterRounds = {
			entries: afterRounds.length,
			wrong: wrong.length,
		};
		if (wrong.length > 0) {
			failures.push(
				`${wrong.length} accounts did not come back with the last saved rotation: ${wrong.slice(0, 3).join(", ")}`,
			);
		}

		// Kill a writer in the middle of a run of saves.
		const killed = await killMidSave(directory, reserved[0] as string);
		const afterKill = await loadInNewProcess(directory);
		const survivor = afterKill.find((item) => item.accountId === reserved[0]);
		const survivorNumber = survivor?.label?.startsWith("kill-")
			? Number(survivor.label.replace("kill-", ""))
			: null;
		report.kill = {
			lastReportedSave: killed.lastReported,
			restoredSave: survivorNumber,
			restoredMatches: survivor?.matches ?? false,
			writerStderr: killed.stderr.slice(0, 400),
			entriesAfterKill: afterKill.length,
		};
		if (killed.lastReported < SAVES_BEFORE_KILL) {
			failures.push(
				`the writer reported ${killed.lastReported} saves before it stopped, expected ${SAVES_BEFORE_KILL}`,
			);
		}
		if (
			survivorNumber === null ||
			survivorNumber < killed.lastReported ||
			!survivor?.matches
		) {
			failures.push(
				`after the kill the slot held ${survivor?.label ?? "nothing"}, expected save ${killed.lastReported} or later, complete`,
			);
		}
		if (afterKill.length !== reserved.length) {
			failures.push(
				`after the kill ${afterKill.length} of ${reserved.length} accounts were restored`,
			);
		}

		const after = slotIdentities(directory);
		report.slotIdentityUnchanged =
			JSON.stringify(after) === JSON.stringify(before);
		if (!report.slotIdentityUnchanged) {
			failures.push("a slot changed size, inode or block count by the end");
		}
		report.blocksAtEnd = blockCounts(args.dir);
	} finally {
		clearInterval(refill);
		spinner.kill("SIGKILL");
		await spinner.exited;
	}

	// Space returns: the account that had no slot can be reserved and saved.
	rmSync(ballast, { force: true });
	rmSync(spinFile, { force: true });
	const recovery: Record<string, string> = {};
	try {
		// A new store, as after the retry delay: the old one still remembers
		// the reservation that failed.
		const fresh = createPendingRotationStore({ directory, secret: SECRET });
		await fresh.reserve(unreserved);
		await fresh.save(unreserved, rotation("after-space"));
		recovery.outcome = "saved";
	} catch (error) {
		recovery.outcome = errorCode(error);
		failures.push(`reserving after space returned failed: ${errorCode(error)}`);
	}
	// The store over the directory that could not be made works once it can.
	try {
		const late = createPendingRotationStore({
			directory: lateDirectory,
			secret: SECRET,
		});
		await late.reserve(unreserved);
		await late.save(unreserved, rotation("late-directory"));
		const entries = await late.load();
		recovery.lateDirectory =
			entries.length === 1 ? "saved" : `loaded ${entries.length} entries`;
		if (entries.length !== 1) {
			failures.push(
				`the late directory held ${entries.length} entries after a save`,
			);
		}
	} catch (error) {
		recovery.lateDirectory = errorCode(error);
		failures.push(
			`saving in the late directory after space returned failed: ${errorCode(error)}`,
		);
	}
	report.recovery = recovery;

	report.failures = failures;
	console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
	console.error(`disk-full slot scenario harness error: ${String(error)}`);
	process.exit(2);
});
