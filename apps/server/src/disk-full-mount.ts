/**
 * How the full-disk tests get a filesystem they may fill: a tmpfs mounted in
 * a private mount namespace, with loopback as the only network interface, so
 * a run cannot fill the host's disk or reach a provider. Two ways to get
 * that, tried in order:
 *   1. an unprivileged user namespace (`unshare -Urmn`);
 *   2. passwordless sudo (`sudo -n unshare -mn`, then back to this user),
 *      for hosts that do not allow unprivileged user namespaces, which
 *      includes GitHub's Ubuntu runners.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type MountStrategy = "userns" | "sudo";

const uid = String(process.getuid?.() ?? "");
const gid = String(process.getgid?.() ?? "");

/** The command that mounts a tmpfs on `mount` and runs `command` beside it. */
export function inPrivateFilesystem(
	strategy: MountStrategy,
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

function works(strategy: MountStrategy, probeDir: string): boolean {
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

/**
 * The way that works on this host, or null when neither does.
 * BETTER_CCFLARE_DISK_FULL_TEST_MOUNT names one to use and no other.
 */
export function findMountStrategy(): MountStrategy | null {
	if (process.platform !== "linux" || uid === "") return null;
	const forced = process.env.BETTER_CCFLARE_DISK_FULL_TEST_MOUNT as
		| MountStrategy
		| undefined;
	const probeDir = mkdtempSync(join(tmpdir(), "ccflare-disk-full-probe-"));
	try {
		if (forced) return works(forced, probeDir) ? forced : null;
		if (works("userns", probeDir)) return "userns";
		if (works("sudo", probeDir)) return "sudo";
		return null;
	} finally {
		rmSync(probeDir, { recursive: true, force: true });
	}
}
