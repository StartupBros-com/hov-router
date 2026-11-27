import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
 symlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";

// Rehearses scripts/hov-router-cutover.sh on a disposable host shaped like a
// 7.x one: the old unit with quoted, multi-assignment and single-quoted
// drop-ins, environment files holding secrets, the storage directories, and a
// checkout whose origin/main carries the cutover. sudo, systemctl, curl, fuser,
// bun and the deploy are stubs on PATH that record what they were asked to do.

const repoRoot = join(import.meta.dir, "..", "..");
const cutoverSource = join(repoRoot, "scripts", "hov-router-cutover.sh");
const libSource = join(repoRoot, "scripts", "deploy-hov-router-lib.sh");
const tempDirs: string[] = [];
const user = userInfo().username;

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function write(path: string, text: string, mode = 0o644): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	chmodSync(path, mode);
}

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(
		[
			"git",
			"-c",
			"user.name=Cutover Test",
			"-c",
			"user.email=cutover-test@example.invalid",
			...args,
		],
		{ cwd, stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString().trim();
}

const STUBS: Record<string, string> = {
	sudo: `#!/usr/bin/env bash
set -u
[[ "\${1:-}" == "-n" ]] && shift
printf '%s\\n' "$*" >>"$STUB_STATE/sudo.log"
if [[ -n "\${STUB_FAIL_WORKER_PREFLIGHT:-}" && "$1" == true && "\${HOV_ROUTER_CUTOVER_LOCK_INHERITED:-}" == 1 ]]; then exit 1; fi
if [[ -n "\${STUB_FAIL_SUDO:-}" && "$*" == *"$STUB_FAIL_SUDO"* ]]; then
	echo "stub sudo: injected failure" >&2
	exit 1
fi
if [[ -n "\${STUB_PARTIAL_COPY:-}" && "$1" == cp && "$*" == *secrets.env* ]]; then
 printf partial >"\${@: -1}"
 exit 1
fi
if [[ "$1" == install ]]; then
	args=()
	skip=0
	for arg in "\${@:2}"; do
		if ((skip)); then skip=0; continue; fi
		case "$arg" in
			-o | -g) skip=1 ;;
			*) args+=("$arg") ;;
		esac
	done
	exec install "\${args[@]}"
fi
exec "$@"
`,
	systemctl: `#!/usr/bin/env bash
set -u
state="$STUB_STATE"
printf '%s\\n' "$*" >>"$state/systemctl.log"
if [[ -n "\${STUB_FAIL_SYSTEMCTL:-}" && "$*" == "$STUB_FAIL_SYSTEMCTL" ]]; then
	echo "stub systemctl: injected failure" >&2
	exit 1
fi
command="$1"
shift
units="$HOV_ROUTER_CUTOVER_ETC/systemd/system"
case "$command" in
	show)
		if [[ "$*" == *--property=DropInPaths* ]]; then printf '%s\\n' "\${STUB_DROPIN_PATHS:-}"; exit 0; fi
		[[ -f "$units/$1" ]] && printf '%s\\n' "$STUB_USER"
		exit 0
		;;
	is-active)
		if [[ -e "$state/active-$1" ]]; then echo active; exit 0; fi
		echo inactive
		exit 3
		;;
	start | restart)
		[[ -f "$units/$1" ]] || { echo "Unit $1 not found." >&2; exit 5; }
		if [[ "$1" == ccflare-stack.service ]]; then
			# The old unit runs only if what its pin names is where the pin says.
			pin="$units/ccflare-stack.service.d/50-pinned-build.conf"
			for target in $(sed -n -E 's/^Environment=(CCFLARE_BIN|GUARD_SCRIPT)=//p; s/^ExecStart=(.+)$/\\1/p' "$pin"); do
				[[ -e "$target" ]] || { echo "stub systemctl: $target is missing" >&2; exit 1; }
			done
		fi
		touch "$state/active-$1"
		;;
	stop) rm -f "$state/active-$1" ;;
	enable) touch "$state/enabled-$1" ;;
	disable) rm -f "$state/enabled-$1" ;;
	daemon-reload) ;;
	*) echo "stub systemctl: unexpected $command" >&2; exit 2 ;;
esac
`,
	curl: `#!/usr/bin/env bash
for unit in hov-router.service ccflare-stack.service; do
	if [[ -e "$STUB_STATE/active-$unit" ]]; then
		printf '{"status":"ok","git_sha":"%s"}' "$(cat "$STUB_STATE/health-$unit" 2>/dev/null)"
		exit 0
	fi
done
exit 7
`,
	fuser: `#!/usr/bin/env bash
[[ -n "\${STUB_HELD_FILE:-}" && "\${@: -1}" == "$STUB_HELD_FILE" ]] && exit 0
exit 1
`,
	bun: `#!/usr/bin/env bash
printf '%s %s\\n' "$PWD" "$*" >>"$STUB_STATE/bun.log"
if [[ -n "\${STUB_PAUSE_BUILD:-}" ]]; then
 touch "$STUB_STATE/build-paused"
 while [[ ! -e "$STUB_STATE/build-release" ]]; do sleep 0.05; done
fi
[[ -z "\${STUB_FAIL_BUN:-}" ]]
`,
	deploy: `#!/usr/bin/env bash
set -u
state="$STUB_STATE"
units="$HOV_ROUTER_CUTOVER_ETC/systemd/system"
pin="$units/hov-router.service.d/50-pinned-build.conf"
echo "cwd=$PWD" >>"$state/deploy.log"
# The real deploy's refusal of a host still on the 7.x unit.
source "$PWD/scripts/deploy-hov-router-lib.sh"
if reason="$(legacy_unit_host_reason "$units/ccflare-stack.service" "$pin" "$(systemctl is-active ccflare-stack.service || true)")"; then
	echo "refused: $reason" >>"$state/deploy.log"
	exit 1
fi
validate_deploy_owned_systemd_pin "$pin" || exit 1
case "\${STUB_DEPLOY:-ok}" in
	fail) echo "stub deploy: build failed" >&2; exit 1 ;;
	recreate)
		mkdir -p "$HOV_ROUTER_CUTOVER_HOME/.config/better-ccflare"
		echo stray >"$HOV_ROUTER_CUTOVER_HOME/.config/better-ccflare/stray.txt"
		exit 1
		;;
	# A deploy that removed the 7.x binary, which the old pin still names.
	prune)
		rm -f "$HOV_ROUTER_CUTOVER_HOME/.config/hov-router/better-ccflare-v7.0.0-abc"
		exit 1
		;;
	# The deploy verified and exited 0, but the unit is not running.
	silent) exit 0 ;;
	# origin/main moved after the cutover read it; the deploy shipped the newer tip.
	newer) printf 0badc0de >"$state/health-hov-router.service" ;;
	*) printf '%s' "$STUB_TARGET_SHORT" >"$state/health-hov-router.service" ;;
esac
mkdir -p "$HOV_ROUTER_CUTOVER_HOME/.config/hov-router/handoff"
echo '{}' >"$HOV_ROUTER_CUTOVER_HOME/.config/hov-router/handoff/runtime.json"
sudo -n systemctl restart hov-router.service
`,
};

type Host = ReturnType<typeof createHost>;

function createHost(options: { originHasCutover?: boolean } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "hov-router-cutover-")));
	tempDirs.push(root);
	const etc = join(root, "etc");
	const home = join(root, "home");
	const stubs = join(root, "stubs");
	const stubState = join(root, "stub-state");
	const state = join(root, "state");
	mkdirSync(stubState, { recursive: true });

	// The checkout: origin/main first gains the library, then the cutover.
	const origin = join(root, "origin.git");
	const checkout = join(root, "checkout");
	mkdirSync(origin);
	mkdirSync(checkout);
	git(origin, "init", "--bare", "--quiet");
	git(checkout, "init", "--quiet", "-b", "main");
	write(join(checkout, "scripts", "deploy-hov-router-lib.sh"), readFileSync(libSource, "utf8"));
	write(
		join(checkout, "packages", "database", "src", "migrations.ts"),
		"export const schema = 1;\n",
	);
	git(checkout, "add", "scripts", "packages");
	git(checkout, "commit", "--quiet", "-m", "prior");
	const priorShort = git(checkout, "rev-parse", "--short=8", "HEAD");
	const script = join(checkout, "scripts", "hov-router-cutover.sh");
	copyFileSync(cutoverSource, script);
	if (options.originHasCutover !== false) {
		git(checkout, "add", "scripts/hov-router-cutover.sh");
		git(checkout, "commit", "--quiet", "-m", "cutover");
	}
	git(checkout, "remote", "add", "origin", origin);
	git(checkout, "push", "--quiet", "origin", "refs/heads/main:refs/heads/main");
	const targetSha = git(checkout, "rev-parse", "HEAD");
	const targetShort = git(checkout, "rev-parse", "--short=8", "HEAD");

	const units = join(etc, "systemd", "system");
	const dropins = join(units, "ccflare-stack.service.d");
	write(
		join(units, "ccflare-stack.service"),
		[
			"[Unit]",
			"Description=better-ccflare gateway",
			"After=network-online.target",
			"",
			"[Service]",
			`User=${user}`,
			`WorkingDirectory=${home}`,
			`Environment=HOME=${home}`,
			`ExecStart=${home}/.config/better-ccflare/run-ccflare-stack.sh`,
			"Restart=always",
			"",
			"[Install]",
			"WantedBy=multi-user.target",
			"",
		].join("\n"),
	);
	write(
		join(dropins, "10-upstream.conf"),
		"# Points ccflare's upstream elsewhere.\n[Service]\nEnvironment=FIXTURE_UPSTREAM_URL=http://127.0.0.1:9000\n",
	);
	write(
		join(dropins, "50-pinned-build.conf"),
		[
			"# BEGIN better-ccflare managed deployment",
			"[Service]",
			`Environment=CCFLARE_BIN=${home}/.config/better-ccflare/better-ccflare-v7.0.0-abc`,
			"Environment=GUARD_ACCEPTED_CAP_MS=1234567",
			`Environment=GUARD_SCRIPT=${home}/.config/better-ccflare/guards/abc/ccflare-guard.mjs`,
			`Environment=CCFLARE_FIXTURE_EXTRA=keep "CCFLARE_PIN_PATH=${dropins}/50-pinned-build.conf"`,
			"RuntimeDirectory=ccflare-stack",
			"ExecStart=",
			`ExecStart=${home}/.config/better-ccflare/runners/abc/run-ccflare-stack.sh`,
			"# END better-ccflare managed deployment",
			"",
		].join("\n"),
	);
	write(join(dropins, "50-pinned-build.conf.bak-20261125"), "Environment=CCFLARE_STALE=1\n");
	write(
		join(dropins, "55-secrets.conf"),
		`[Service]\nEnvironmentFile=${etc}/better-ccflare/secrets.env\n`,
	);
	write(
		join(dropins, "70-paths.conf"),
		`[Service]\nEnvironment="CCFLARE_CODEX_TRACE_DIR=${home}/.config/better-ccflare/traces" CCFLARE_CACHE_PACING_MS=5\n`,
	);
	write(
		join(dropins, "85-commented.conf"),
		"# Read by ccflare-stack.service at start.\n[Service]\nEnvironment=CCFLARE_ANTHROPIC_ROUTE_SUPPRESSION_MS=60000\n",
	);
	write(
		join(dropins, "91-quoted-json.conf"),
		`[Service]\nEnvironment='FIXTURE_ROUTES_JSON={"route": "a b", "account": "00000000-0000-4000-8000-000000000001"}'\n`,
	);
	write(
		join(dropins, "94-optional-env.conf"),
		`[Service]\nEnvironmentFile=-${etc}/better-ccflare/optional.env\n`,
	);
	write(
		join(dropins, "97-flags.conf"),
		"[Service]\nEnvironment=BETTER_CCFLARE_FIXTURE_FLAG=1 BETTER_CCFLARE_GIT_SHA=abc1234\n",
	);
	write(
		join(etc, "systemd", "system.control", "ccflare-stack.service.d", "50-CPUWeight.conf"),
		"# This is a drop-in unit file extension, created via \"systemctl set-property\"\n[Service]\nCPUWeight=50\n",
	);

	const oldEtc = join(etc, "better-ccflare");
	write(join(oldEtc, "secrets.env"), "CCFLARE_FIXTURE_SECRET=fixture-secret-value\n", 0o600);
	write(
		join(oldEtc, "optional.env"),
		"# optional settings\nFIXTURE_WEBHOOK_URL=https://hooks.example.invalid/fixture-webhook-secret\nexport FIXTURE_SIGNING_SECRET=fixture-signing-secret\n",
		0o600,
	);
	write(join(oldEtc, "unloaded.env"), "CCFLARE_FIXTURE_UNLOADED={}\n", 0o600);
	write(join(oldEtc, "notes.json"), '{"note": "see better-ccflare#370."}\n', 0o640);
	write(join(oldEtc, "backups", "2026", "70.conf"), "Environment=CCFLARE_OLD=1\n");
	chmodSync(join(oldEtc, "backups", "2026"), 0o700);

	const oldConfig = join(home, ".config", "better-ccflare");
	write(join(oldConfig, "better-ccflare.db"), "db\n", 0o600);
	write(join(oldConfig, "better-ccflare.db-wal"), "wal\n", 0o600);
	write(join(oldConfig, "better-ccflare.json"), "{}\n", 0o600);
	write(join(oldConfig, "better-ccflare.json.backup-1"), "{}\n", 0o600);
	write(join(oldConfig, "better-ccflare-v7.0.0-abc"), "binary\n", 0o755);
	write(join(oldConfig, "handoff", "runtime.json"), "{}\n", 0o600);
	chmodSync(join(oldConfig, "handoff"), 0o700);
	write(join(oldConfig, "traces", "trace.json"), "{}\n");
	write(join(oldConfig, "guards", "abc", "ccflare-guard.mjs"), "// guard\n");
	write(join(oldConfig, "runners", "abc", "run-ccflare-stack.sh"), "#!/bin/sh\n", 0o755);
	write(join(oldConfig, "state.json"), "{}\n");
	write(join(home, ".better-ccflare", "workspaces.json"), "[]\n");

	for (const [name, text] of Object.entries(STUBS)) {
		write(join(stubs, name), text, 0o755);
	}
	writeFileSync(join(stubState, "active-ccflare-stack.service"), "");
	writeFileSync(join(stubState, "enabled-ccflare-stack.service"), "");
	writeFileSync(join(stubState, "health-ccflare-stack.service"), priorShort);

	return {
		root,
		etc,
		home,
		units,
		dropins,
		state,
		stubState,
		checkout,
		script,
		priorShort,
		targetSha,
		targetShort,
		env: {
			...process.env,
			PATH: `${stubs}:${process.env.PATH}`,
			HOV_ROUTER_CUTOVER_ETC: etc,
			HOV_ROUTER_CUTOVER_HOME: home,
			HOV_ROUTER_CUTOVER_STATE_DIR: state,
			HOV_ROUTER_CUTOVER_DEPLOY: join(stubs, "deploy"),
			HOV_ROUTER_CUTOVER_HEALTH_TIMEOUT_S: "3",
			STUB_STATE: stubState,
			STUB_USER: user,
			STUB_TARGET_SHORT: targetShort,
		} as Record<string, string | undefined>,
	};
}

function run(host: Host, args: string[], env: Record<string, string> = {}) {
	const result = Bun.spawnSync(["bash", host.script, ...args], {
		cwd: host.checkout,
		env: { ...host.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

// Every path under the fixture's /etc and home with its type, mode and content.
function tree(host: Host): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (base: string, label: string, rel: string) => {
		const full = rel ? join(base, rel) : base;
		const stat = lstatSync(full);
		const mode = (stat.mode & 0o7777).toString(8);
		const key = `${label}/${rel}`;
		if (stat.isSymbolicLink()) out[key] = `link ${readlinkSync(full)}`;
		else if (stat.isDirectory()) {
			out[key] = `dir ${mode}`;
			for (const name of readdirSync(full).sort()) walk(base, label, rel ? `${rel}/${name}` : name);
		} else out[key] = `file ${mode} ${readFileSync(full, "utf8")}`;
	};
	walk(host.etc, "etc", "");
	walk(host.home, "home", "");
	return out;
}

function units(host: Host) {
	const has = (name: string) => existsSync(join(host.stubState, name));
	return {
		oldActive: has("active-ccflare-stack.service"),
		oldEnabled: has("enabled-ccflare-stack.service"),
		newActive: has("active-hov-router.service"),
		newEnabled: has("enabled-hov-router.service"),
	};
}

function log(host: Host, name: string): string[] {
	const path = join(host.stubState, name);
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

test("concurrent apply cannot rotate a building worker's state", async () => {
	const host = createHost();
	expect(run(host, ["--apply"], { STUB_PAUSE_BUILD: "1" }).exitCode).toBe(0);
	try {
		for (let i = 0; i < 100 && !existsSync(join(host.stubState, "build-paused")); i++) await Bun.sleep(50);
		expect(existsSync(join(host.stubState, "build-paused"))).toBe(true);
		const inode = lstatSync(host.state).ino;
		const second = run(host, ["--apply"]);
		expect(second.exitCode).toBe(1);
		expect(second.stderr).toContain("another cutover holds");
		expect(lstatSync(host.state).ino).toBe(inode);
		expect(existsSync(join(host.state, "started"))).toBe(false);
	} finally {
		write(join(host.stubState, "build-release"), "");
		for (let i = 0; i < 200 && !existsSync(join(host.state, "result")); i++) await Bun.sleep(50);
	}
	expect(readFileSync(join(host.state, "result"), "utf8")).toStartWith("ok:");
}, 20000);

test("held old WAL refuses the move and permits retry after release", async () => {
	const host = createHost();
	const before = tree(host);
	const held = join(host.home, ".config", "better-ccflare", "better-ccflare.db-wal");
	expect(run(host, ["--apply", "--foreground", "--no-prebuild"], { STUB_HELD_FILE: held }).exitCode).not.toBe(0);
	expect(tree(host)).toEqual(before);
	expect(units(host).oldActive).toBe(true);
	// The launcher archives the completed rollback and retries with no holder.
	expect(run(host, ["--apply", "--no-prebuild"]).exitCode).toBe(0);
	for (let i = 0; i < 200 && !existsSync(join(host.state, "result")); i++) await Bun.sleep(50);
	expect(readFileSync(join(host.state, "result"), "utf8")).toStartWith("ok:");
}, 20000);

test("held new WAL refuses rollback until its holder releases it", () => {
	const host = createHost();
	expect(run(host, ["--apply", "--foreground", "--no-prebuild"]).exitCode).toBe(0);
	const cfg = join(host.home, ".config", "hov-router");
	const held = join(cfg, "hov-router.db-wal");
	expect(run(host, ["--revert"], { STUB_HELD_FILE: held }).exitCode).toBe(1);
	expect(readFileSync(held, "utf8")).toBe("wal\n");
	expect(existsSync(join(host.home, ".config", "better-ccflare"))).toBe(false);
	expect(run(host, ["--revert"]).exitCode).toBe(0);
	expect(units(host).oldActive).toBe(true);
	expect(readFileSync(join(host.home, ".config", "better-ccflare", "better-ccflare.db-wal"), "utf8")).toBe("wal\n");
});

test("broad env glob refuses before it can load rollback backups", () => {
	const host = createHost();
	write(join(host.dropins, "55-secrets.conf"), `[Service]\nEnvironmentFile=${host.etc}/better-ccflare/*\n`);
	const before = tree(host);
	const result = run(host, ["--apply", "--foreground", "--no-prebuild"]);
	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("retired-key backup");
	expect(tree(host)).toEqual(before);
	expect(units(host).oldActive).toBe(true);
});

test("symlinked environment file is refused without replacing the link", () => {
	const host = createHost();
	const file = join(host.etc, "better-ccflare", "linked.env");
	symlinkSync("secrets.env", file);
	write(join(host.dropins, "60-linked.conf"), `[Service]\nEnvironmentFile=${file}\n`);
	const before = tree(host);
	expect(run(host, ["--apply", "--foreground", "--no-prebuild"]).exitCode).toBe(1);
	expect(tree(host)).toEqual(before);
	expect(readlinkSync(file)).toBe("secrets.env");
	expect(units(host).oldActive).toBe(true);
});

test("unhandled runtime drop-in refuses before service stop", () => {
	const host = createHost();
	const before = tree(host);
	const result = run(host, ["--apply", "--foreground", "--no-prebuild"], { STUB_DROPIN_PATHS: "/run/systemd/system/ccflare-stack.service.d/runtime.conf" });
	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("loaded drop-in is outside");
	expect(tree(host)).toEqual(before);
	expect(units(host).oldActive).toBe(true);
});

test("equivalent environment paths keep one original backup through rollback", () => {
	const host = createHost();
	write(join(host.dropins, "60-alias.conf"), `[Service]\nEnvironmentFile=${host.etc}/better-ccflare/./secrets.env\n`);
	const before = tree(host);
	expect(run(host, ["--apply", "--foreground", "--no-prebuild"]).exitCode).toBe(0);
	const backup = join(host.etc, "hov-router", "secrets.env.pre-8.0.0");
	expect(readFileSync(backup, "utf8")).toBe("CCFLARE_FIXTURE_SECRET=fixture-secret-value\n");
	expect(run(host, ["--revert"]).exitCode).toBe(0);
	// New handoff state is intentionally retained separately on rollback.
	expect(readFileSync(join(host.etc, "better-ccflare", "secrets.env"), "utf8")).toBe("CCFLARE_FIXTURE_SECRET=fixture-secret-value\n");
	expect(tree(host)["etc/better-ccflare/secrets.env"]).toBe(before["etc/better-ccflare/secrets.env"]);
});

test("separate optional pattern cannot start loading newly created backups", () => {
	const host = createHost();
	write(join(host.dropins, "60-backups.conf"), `[Service]\nEnvironmentFile=-${host.etc}/better-ccflare/*.pre-8.0.0\n`);
	const before = tree(host);
	const result = run(host, ["--apply", "--foreground", "--no-prebuild"]);
	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("retired-key backup");
	expect(tree(host)).toEqual(before);
	expect(units(host).oldActive).toBe(true);
});

function addLoadedFiles(host: Host) {
	const dir = join(host.etc, "better-ccflare");
	write(join(host.dropins, "60-extra.conf"), `[Service]\nEnvironmentFile=${dir}/secrets\nEnvironmentFile=${dir}/nested/router.conf\n`);
	for (const name of ["secrets", "nested/router.conf"]) write(join(dir, name), "CCFLARE_PORT=9000\n", 0o600);
	write(join(dir, "unloaded.env.pre-8.0.0"), "operator backup\n");
}

function result(host: Host): string {
	return readFileSync(join(host.state, "result"), "utf8").trim();
}

const SECRETS = [
	"fixture-secret-value",
	"fixture-webhook-secret",
	"fixture-signing-secret",
	"00000000-0000-4000-8000-000000000001",
];

describe("cutover --check", () => {
	test("prints the plan, changes nothing and never prints a secret", () => {
		const host = createHost();
		const before = tree(host);
		const check = run(host, ["--check"]);
		expect(check.stderr).toBe("");
		expect(check.exitCode).toBe(0);
		for (const line of [
			"==> Cutover plan for ccflare-stack.service -> hov-router.service",
			`live:    active, /health git_sha ${host.priorShort}`,
			`target:  origin/main ${host.targetSha.slice(0, 12)}`,
			"schema:  0 changed schema statement lines",
			"(4 better-ccflare.* files renamed hov-router.*; handoff/ set aside)",
			"keys renamed in the 2 environment files the unit loads",
			"8 drop-ins and a seed pin",
			"  CCFLARE_FIXTURE_SECRET -> HOV_ROUTER_FIXTURE_SECRET",
			"  BETTER_CCFLARE_GIT_SHA -> HOV_ROUTER_HEALTH_GIT_SHA",
			"  BETTER_CCFLARE_FIXTURE_FLAG -> HOV_ROUTER_FIXTURE_FLAG",
			"notes:   2 comment lines still say ccflare",
			"OK: --apply would proceed.",
		]) {
			expect(check.stdout).toContain(line);
		}
		for (const secret of SECRETS) {
			expect(check.stdout + check.stderr).not.toContain(secret);
		}
		expect(tree(host)).toEqual(before);
		expect(existsSync(host.state)).toBe(false);
		expect(log(host, "systemctl.log").filter((line) => !/^(show|is-active) /.test(line))).toEqual([]);
		expect(log(host, "sudo.log").filter((line) => !/^(true|cat |grep )/.test(line))).toEqual([]);
	});

	test("refuses a line that would still name ccflare, naming the file, line and directive only", () => {
		const host = createHost();
		write(join(host.dropins, "20-extra.conf"), "[Service]\nExecStartPre=/usr/local/bin/ccflare-warmup --secret-flag\n");
		const before = tree(host);
		const check = run(host, ["--check"]);
		expect(check.exitCode).toBe(1);
		expect(check.stderr).toContain("  20-extra.conf:2 ExecStartPre");
		expect(check.stderr).toContain("would still name ccflare outside a comment");
		expect(check.stderr).not.toContain("secret-flag");
		expect(tree(host)).toEqual(before);
	});

	test("refuses a storage path set outside the default directory", () => {
		for (const assignment of ["CCFLARE_DB_PATH=/srv/router.db", "XDG_CONFIG_HOME=/srv/config"]) {
			const host = createHost();
			write(join(host.dropins, "20-storage.conf"), `[Service]\nEnvironment=${assignment}\n`);
			const check = run(host, ["--check"]);
			expect(check.exitCode).toBe(1);
			expect(check.stderr).toContain("sets a database, config or XDG_CONFIG_HOME path");
		}
	});

	test("refuses an environment file outside the old directory that sets a retired key", () => {
		const host = createHost();
		const outside = join(host.root, "elsewhere.env");
		write(outside, "CCFLARE_ELSEWHERE=1\n", 0o600);
		write(join(host.dropins, "20-elsewhere.conf"), `[Service]\nEnvironmentFile=${outside}\n`);
		const check = run(host, ["--check"]);
		expect(check.exitCode).toBe(1);
		expect(check.stderr).toContain(`outside ${outside} sets a retired key`);
	});

	test("refuses a .env the router reads at startup that sets a retired key", () => {
		for (const dir of ["", ".config/better-ccflare"]) {
			const host = createHost();
			const dotenv = join(host.home, dir, ".env");
			write(dotenv, "OTHER=1\nexport CCFLARE_DOTENV_KEY=fixture-dotenv-secret\n", 0o600);
			const before = tree(host);
			const check = run(host, ["--check"]);
			expect(check.exitCode).toBe(1);
			expect(check.stderr).toContain(`${dotenv} sets CCFLARE_DOTENV_KEY; the router reads that file at startup`);
			expect(check.stdout + check.stderr).not.toContain("fixture-dotenv-secret");
			expect(tree(host)).toEqual(before);
		}
	});

	test("refuses to overwrite an existing backup for a loaded file", () => {
		const host = createHost();
		addLoadedFiles(host);
		const path = join(host.etc, "better-ccflare/secrets.pre-8.0.0");
		write(path, "operator backup\n");
		const before = tree(host);
		const check = run(host, ["--check"]);
		expect(check.exitCode).toBe(1);
		expect(check.stderr).toContain(path);
		expect(tree(host)).toEqual(before);
	});

	test("refuses when a renamed path already exists", () => {
		const host = createHost();
		mkdirSync(join(host.home, ".config", "hov-router"));
		const check = run(host, ["--check"]);
		expect(check.exitCode).toBe(1);
		expect(check.stderr).toContain(`${join(host.home, ".config", "hov-router")} already exists`);
	});

	test("refuses until origin/main carries the rename", () => {
		const host = createHost({ originHasCutover: false });
		const check = run(host, ["--check"]);
		expect(check.exitCode).toBe(1);
		expect(check.stdout).toContain("==> Cutover plan");
		expect(check.stderr).toContain("origin/main does not have the 8.0.0 rename yet");
	});

	test("refuses a host that is not on the 7.x unit", () => {
		const host = createHost();
		rmSync(join(host.units, "ccflare-stack.service"));
		const check = run(host, ["--check"]);
		expect(check.exitCode).toBe(1);
		expect(check.stderr).toContain("is not on the 7.x unit");
	});

	test("takes exactly one mode", () => {
		const host = createHost();
		expect(run(host, ["--check", "--apply"]).exitCode).toBe(2);
		expect(run(host, []).exitCode).toBe(2);
		expect(run(host, ["--bogus"]).exitCode).toBe(2);
	});
});

describe("cutover --apply", () => {
	test("moves the host, renames its keys and paths, and leaves the old unit for --revert", () => {
		const host = createHost();
		const before = tree(host);
		const apply = run(host, ["--apply", "--foreground"]);
		expect(apply.exitCode).toBe(0);
		expect(result(host)).toBe(`ok: hov-router.service serves ${host.targetShort}`);
		expect(units(host)).toEqual({ oldActive: false, oldEnabled: false, newActive: true, newEnabled: true });

		// The prebuild ran in a snapshot of origin/main that is gone again.
		const builds = log(host, "bun.log");
		expect(builds.map((line) => line.split(" ").slice(1).join(" "))).toEqual([
			"install --frozen-lockfile",
			"run build",
		]);
		expect(builds[0]?.startsWith(host.checkout)).toBe(false);
		expect(git(host.checkout, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
		expect(log(host, "deploy.log")).toEqual([`cwd=${host.checkout}`]);

		const after = tree(host);
		const config = "home/.config/hov-router";
		expect(after[`${config}/hov-router.db`]).toBe("file 600 db\n");
		expect(after[`${config}/hov-router.db-wal`]).toBe("file 600 wal\n");
		expect(after[`${config}/hov-router.json`]).toBe("file 600 {}\n");
		expect(after[`${config}/hov-router.json.backup-1`]).toBe("file 600 {}\n");
		expect(after[`${config}/better-ccflare-v7.0.0-abc`]).toBe("file 755 binary\n");
		expect(after[`${config}/handoff.pre-8.0.0`]).toBe("dir 700");
		expect(after[`${config}/handoff.pre-8.0.0/runtime.json`]).toBe("file 600 {}\n");
		expect(after["home/.hov-router/workspaces.json"]).toBe("file 644 []\n");
		for (const gone of ["home/.config/better-ccflare", "home/.better-ccflare", "etc/better-ccflare"]) {
			expect(after[gone]).toBeUndefined();
		}

		expect(after["etc/hov-router/secrets.env"]).toBe(
			"file 600 HOV_ROUTER_FIXTURE_SECRET=fixture-secret-value\n",
		);
		expect(after["etc/hov-router/secrets.env.pre-8.0.0"]).toBe(
			before["etc/better-ccflare/secrets.env"],
		);
		expect(after["etc/hov-router/optional.env"]).toBe(before["etc/better-ccflare/optional.env"]);
		// Nothing loads this one, so it moves unchanged and gets no backup.
		expect(after["etc/hov-router/unloaded.env"]).toBe(
			before["etc/better-ccflare/unloaded.env"],
		);
		expect(after["etc/hov-router/unloaded.env.pre-8.0.0"]).toBeUndefined();
		expect(after["etc/hov-router/notes.json"]).toBe(
			before["etc/better-ccflare/notes.json"],
		);
		expect(after["etc/hov-router/backups/2026"]).toBe("dir 700");

		const unit = "etc/systemd/system/hov-router.service";
		const dropins = `${unit}.d`;
		expect(after[unit]).toBe(
			`file 644 ${[
				"[Unit]",
				"Description=HoV Router gateway",
				"After=network-online.target",
				"",
				"[Service]",
				`User=${user}`,
				`WorkingDirectory=${host.home}`,
				`Environment=HOME=${host.home}`,
				`ExecStart=${host.home}/.config/hov-router/run-hov-router.sh`,
				"Restart=always",
				"",
				"[Install]",
				"WantedBy=multi-user.target",
				"",
			].join("\n")}`,
		);
		expect(
			Object.keys(after)
				.filter((key) => key.startsWith(`${dropins}/`))
				.map((key) => key.slice(dropins.length + 1)),
		).toEqual([
			"10-upstream.conf",
			"50-pinned-build.conf",
			"55-secrets.conf",
			"70-paths.conf",
			"85-commented.conf",
			"91-quoted-json.conf",
			"94-optional-env.conf",
			"97-flags.conf",
		]);
		const dropin = (name: string) => after[`${dropins}/${name}`]?.replace(/^file 644 /, "");
		expect(dropin("10-upstream.conf")).toBe(
			readFileSync(join(host.dropins, "10-upstream.conf"), "utf8"),
		);
		expect(dropin("55-secrets.conf")).toBe(
			`[Service]\nEnvironmentFile=${host.etc}/hov-router/secrets.env\n`,
		);
		expect(dropin("70-paths.conf")).toBe(
			`[Service]\nEnvironment="HOV_ROUTER_CODEX_TRACE_DIR=${host.home}/.config/hov-router/traces" HOV_ROUTER_CACHE_PACING_MS=5\n`,
		);
		expect(dropin("85-commented.conf")).toBe(
			"# Read by ccflare-stack.service at start.\n[Service]\nEnvironment=HOV_ROUTER_ANTHROPIC_ROUTE_SUPPRESSION_MS=60000\n",
		);
		expect(dropin("91-quoted-json.conf")).toBe(
			readFileSync(join(host.dropins, "91-quoted-json.conf"), "utf8"),
		);
		expect(dropin("94-optional-env.conf")).toBe(
			`[Service]\nEnvironmentFile=-${host.etc}/hov-router/optional.env\n`,
		);
		expect(dropin("97-flags.conf")).toBe(
			"[Service]\nEnvironment=HOV_ROUTER_FIXTURE_FLAG=1 HOV_ROUTER_HEALTH_GIT_SHA=abc1234\n",
		);
		expect(after["etc/systemd/system.control/hov-router.service.d/50-CPUWeight.conf"]).toBe(
			before["etc/systemd/system.control/ccflare-stack.service.d/50-CPUWeight.conf"],
		);

		// The old unit and its files stay as they were, for --revert.
		for (const [key, value] of Object.entries(before)) {
			if (key.startsWith("etc/systemd/")) expect(after[key]).toBe(value);
		}
		// In the foreground the log is this output.
		for (const secret of SECRETS) {
			expect(apply.stdout + apply.stderr).not.toContain(secret);
		}
	});

	test("seeds a pin the deploy accepts and renders without any old name", () => {
		const host = createHost();
		expect(run(host, ["--apply", "--foreground", "--no-prebuild"]).exitCode).toBe(0);
		const seed = join(host.units, "hov-router.service.d", "50-pinned-build.conf");
		const seedText = readFileSync(seed, "utf8");
		expect(seedText).not.toMatch(/ccflare/i);
		expect(seedText).toContain("Environment=HOV_ROUTER_FIXTURE_EXTRA=keep\n");
		expect(seedText).toContain("Environment=GUARD_ACCEPTED_CAP_MS=1234567\n");
		expect(seedText).toContain("RestartPreventExitStatus=143 78\n");
		expect(seedText).toContain("exit 78'\n");
		expect(seedText).not.toContain("HOV_ROUTER_BIN=");
		expect(seedText).not.toContain("HOV_ROUTER_PIN_PATH=");

		const work = join(host.root, "render");
		for (const name of ["runner.sh", "guard.mjs", "policy.mjs"]) write(join(work, name), `// ${name}\n`);
		const rendered = join(work, "rendered.conf");
		const render = Bun.spawnSync(
			[
				"bash",
				"-c",
				[
					"set -euo pipefail",
					`source ${shellQuote(libSource)}`,
					`validate_deploy_owned_systemd_pin ${shellQuote(seed)}`,
					`render_systemd_pin ${shellQuote(seed)} ${shellQuote(rendered)} /new/bin ${shellQuote(join(work, "runner.sh"))} ${shellQuote(join(work, "guard.mjs"))} abc123 policy-v1 ${shellQuote(join(work, "policy.mjs"))}`,
					// The deploy's next check of the rendered pin, before it swaps the pin in.
					`validate_deployment_timing ${shellQuote(rendered)} >/dev/null`,
				].join("\n"),
			],
			{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
		);
		expect(render.stderr.toString()).toBe("");
		expect(render.exitCode).toBe(0);
		const renderedText = readFileSync(rendered, "utf8");
		expect(renderedText).not.toMatch(/ccflare/i);
		expect(renderedText).toContain("Environment=HOV_ROUTER_FIXTURE_EXTRA=keep\n");
		expect(renderedText).toContain("Environment=GUARD_ACCEPTED_CAP_MS=1234567\n");
		expect(renderedText).toContain("Environment=HOV_ROUTER_BIN=/new/bin\n");
		expect(renderedText).toContain(`ExecStart=${join(work, "runner.sh")}\n`);
		expect(renderedText).not.toContain("exit 78");
	});

	// `aside` names what the revert keeps beside the restored files: an old path
	// the deploy recreated, or the handoff a deploy that started wrote.
	const failures: { name: string; step: string; env: Record<string, string>; aside?: string }[] = [
		{ name: "the stop", step: "stopping ccflare-stack.service", env: { STUB_FAIL_SYSTEMCTL: "stop ccflare-stack.service" } },
		{ name: "the /etc move", step: "moving the storage", env: { STUB_FAIL_SUDO: "mv -T " } },
		{ name: "an environment file rewrite", step: "renaming the keys in", env: { STUB_FAIL_SUDO: "tee " } },
		{ name: "enabling the new unit", step: "writing hov-router.service", env: { STUB_FAIL_SYSTEMCTL: "enable hov-router.service" } },
		{ name: "the deploy", step: "deploying origin/main", env: { STUB_DEPLOY: "fail" } },
		{ name: "a deploy that left the unit stopped", step: "checking /health", env: { STUB_DEPLOY: "silent" } },
		{
			name: "a deploy that recreated an old path",
			step: "deploying origin/main",
			env: { STUB_DEPLOY: "recreate" },
			aside: "home/.config/better-ccflare.recreated-",
		},
	];
	for (const failure of failures) {
		test(`a failure in ${failure.name} puts the 7.x host back`, () => {
			const host = createHost();
			addLoadedFiles(host);
			const before = tree(host);
			const apply = run(host, ["--apply", "--foreground", "--no-prebuild"], failure.env);
			expect(apply.exitCode).not.toBe(0);
			expect(result(host)).toStartWith(`reverted: the cutover failed while ${failure.step}`);
			expect(units(host)).toEqual({ oldActive: true, oldEnabled: true, newActive: false, newEnabled: false });
			const after = tree(host);
			const aside = failure.aside;
			if (aside) {
				const extra = Object.keys(after).filter((key) => key.startsWith(aside));
				expect(extra.length).toBe(2);
				const file = failure.env.STUB_DEPLOY === "recreate" ? "/stray.txt" : "/runtime.json";
				expect(extra.some((key) => key.endsWith(file))).toBe(true);
				for (const key of extra) delete after[key];
			}
			expect(after).toEqual(before);
		});
	}

	test("accepts the build the deploy shipped when origin/main moved during the deploy", () => {
		const host = createHost();
		const apply = run(host, ["--apply", "--foreground", "--no-prebuild"], { STUB_DEPLOY: "newer" });
		expect(apply.exitCode).toBe(0);
		expect(result(host)).toBe("ok: hov-router.service serves 0badc0de");
		expect(units(host)).toEqual({ oldActive: false, oldEnabled: false, newActive: true, newEnabled: true });
	});

	test("does not start the old unit when a file its pin names is gone", () => {
		const host = createHost();
		const apply = run(host, ["--apply", "--foreground", "--no-prebuild"], { STUB_DEPLOY: "prune" });
		expect(apply.exitCode).not.toBe(0);
		expect(result(host)).toStartWith("revert-failed: the cutover failed while deploying origin/main");
		expect(apply.stdout + apply.stderr).toContain(
			`its pin names ${join(host.home, ".config", "better-ccflare", "better-ccflare-v7.0.0-abc")}, which does not exist`,
		);
		expect(log(host, "systemctl.log")).not.toContain("start ccflare-stack.service");
		expect(units(host).oldActive).toBe(false);
	});

	test("a failed prebuild stops before anything changes", () => {
		const host = createHost();
		const before = tree(host);
		const apply = run(host, ["--apply", "--foreground"], { STUB_FAIL_BUN: "1" });
		expect(apply.exitCode).toBe(1);
		expect(apply.stderr).toContain("the build of origin/main failed");
		expect(existsSync(join(host.state, "started"))).toBe(false);
		expect(result(host)).toStartWith("failed: prebuild");
		expect(run(host, ["--revert"]).exitCode).toBe(1);
		expect(units(host)).toEqual({ oldActive: true, oldEnabled: true, newActive: false, newEnabled: false });
		expect(log(host, "systemctl.log").filter((line) => !/^(show|is-active) /.test(line))).toEqual([]);
		expect(tree(host)).toEqual(before);
	});

	for (const [flag, step, reason] of [
		["STUB_FAIL_WORKER_PREFLIGHT", "preflight", "sudo needs a password"],
		["STUB_FAIL_BUN", "prebuild", "the build of origin/main failed"],
	] as const) {
		test(`detached ${step} failure reports without changing the host`, async () => {
			const host = createHost();
			const before = tree(host);
			const apply = run(host, ["--apply"], { [flag]: "1" });
			expect(apply.exitCode).toBe(0);
			for (let i = 0; i < 100 && !existsSync(join(host.state, "result")); i++) await Bun.sleep(50);
			expect(readFileSync(join(host.state, "cutover.log"), "utf8")).toContain(reason);
			expect(result(host)).toStartWith(`failed: ${step}`);
			expect(existsSync(join(host.state, "started"))).toBe(false);
			expect(log(host, "systemctl.log").filter((line) => !/^(show|is-active) /.test(line))).toEqual([]);
			expect(tree(host)).toEqual(before);
		}, 15_000);
	}

	test("runs detached and reports through the result file", async () => {
		const host = createHost();
		const apply = run(host, ["--apply", "--no-prebuild"]);
		expect(apply.stderr).toBe("");
		expect(apply.exitCode).toBe(0);
		expect(apply.stdout).toContain(`==> Started. Log: ${join(host.state, "cutover.log")}`);
		const resultFile = join(host.state, "result");
		for (let waited = 0; waited < 30_000 && !existsSync(resultFile); waited += 100) {
			await Bun.sleep(100);
		}
		expect(result(host)).toBe(`ok: hov-router.service serves ${host.targetShort}`);
		const detachedLog = readFileSync(join(host.state, "cutover.log"), "utf8");
		expect(detachedLog).toContain("stopping ccflare-stack.service");
		for (const secret of SECRETS) {
			expect(detachedLog).not.toContain(secret);
		}
	});

	test("refuses to start over a cutover that left no result", () => {
		const host = createHost();
		write(join(host.state, "started"), "");
		const apply = run(host, ["--apply", "--no-prebuild"]);
		expect(apply.exitCode).toBe(1);
		expect(apply.stderr).toContain("records a cutover with no result");
		expect(units(host).oldActive).toBe(true);
	});
});

describe("cutover --revert", () => {
	test("puts a moved host back, and a second run changes nothing", () => {
		const host = createHost();
		addLoadedFiles(host);
		const before = tree(host);
		expect(run(host, ["--apply", "--foreground", "--no-prebuild"]).exitCode).toBe(0);
		for (const name of ["secrets", "nested/router.conf"]) {
			expect(readFileSync(join(host.etc, "hov-router", name), "utf8")).toBe("HOV_ROUTER_PORT=9000\n");
		}

		const revert = run(host, ["--revert"]);
		expect(revert.exitCode).toBe(0);
		expect(result(host)).toBe("reverted: by --revert; ccflare-stack.service serves again");
		expect(units(host)).toEqual({ oldActive: true, oldEnabled: true, newActive: false, newEnabled: false });
		const after = tree(host);
		// The handoff the 8.0.0 deploy wrote is kept beside the restored one.
		const kept = Object.keys(after).filter((key) =>
			key.startsWith("home/.config/better-ccflare/handoff.8.0.0-reverted-"),
		);
		expect(kept.length).toBe(2);
		for (const key of kept) delete after[key];
		expect(after).toEqual(before);
		// A copy of what it removed stays in the state directory.
		const backups = readdirSync(host.state).filter((name) => name.startsWith("reverted-"));
		expect(backups.length).toBe(1);
		const backup = join(host.state, backups[0] ?? "");
		expect(readdirSync(join(backup, "system")).sort()).toEqual([
			"hov-router.service",
			"hov-router.service.d",
		]);
		expect(readdirSync(join(backup, "system", "hov-router.service.d"))).toContain(
			"50-pinned-build.conf",
		);
		expect(readdirSync(join(backup, "system.control", "hov-router.service.d"))).toEqual([
			"50-CPUWeight.conf",
		]);

		const again = tree(host);
		expect(run(host, ["--revert"]).exitCode).toBe(0);
		expect(tree(host)).toEqual(again);
		expect(units(host)).toEqual({ oldActive: true, oldEnabled: true, newActive: false, newEnabled: false });
	});

	test("refuses where no cutover ran", () => {
		const host = createHost();
		const revert = run(host, ["--revert"]);
		expect(revert.exitCode).toBe(1);
		expect(revert.stderr).toContain("no cutover ran from this account");
	});
});

describe("review regressions", () => {
 test("rewriter drains a large real slow pipe byte for byte", async () => {
  const source = readFileSync(cutoverSource, "utf8");
  const js = source.split("cat <<'NODE'\n")[1]?.split("\nNODE")[0];
  expect(js).toBeDefined();
  const input = `OTHER=${"x".repeat(1024 * 1024)}\nCCFLARE_PORT=9000\n`;
  const child = Bun.spawn(["node", "-e", js!, "env", "/etc", "/home/test", "fixture"], {stdin: new Blob([input]), stdout:"pipe", stderr:"pipe"});
  const chunks: Uint8Array[] = [];
  for await (const chunk of child.stdout) { chunks.push(chunk); await Bun.sleep(5); }
  expect(await child.exited).toBe(0);
  expect(Buffer.concat(chunks).toString()).toBe(input.replace("CCFLARE_PORT", "HOV_ROUTER_PORT"));
 });
 for (const suffix of ["handoff.pre-8.0.0", "hov-router.db"]) {
  for (const dangling of [false, true]) {
   test(`refuses occupied ${suffix}, dangling=${dangling}, before stop`, () => {
    const host = createHost();
    const path = join(host.home, ".config/better-ccflare", suffix);
    if (dangling) symlinkSync("missing", path); else write(join(path, "keep"), "operator bytes");
    const before = tree(host);
    expect(run(host, ["--apply", "--foreground", "--no-prebuild"]).exitCode).toBe(1);
    expect(tree(host)).toEqual(before);
    expect(log(host,"systemctl.log")).not.toContain("stop ccflare-stack.service");
   });
  }
 }
 test("partial backup copy cannot replace the intact original on rollback", () => {
  const host = createHost();
  const before = tree(host);
  const apply = run(host,["--apply","--foreground","--no-prebuild"],{STUB_PARTIAL_COPY:"1"});
  expect(apply.exitCode).not.toBe(0);
  expect(readFileSync(join(host.etc,"better-ccflare/secrets.env"),"utf8")).toBe("CCFLARE_FIXTURE_SECRET=fixture-secret-value\n");
  expect(tree(host)).toEqual(before);
 });
 for (const form of ["quoted", "glob", "control"]) {
  test(`discovers ${form} environment references`, () => {
   const host = createHost();
   const envPath = join(host.etc,"better-ccflare/extra.env");
   write(envPath,"CCFLARE_EXTRA=synthetic\n");
   const dropin = form === "control" ? join(host.etc,"systemd/system.control/ccflare-stack.service.d/90-env.conf") : join(host.dropins,"60-extra.conf");
   write(dropin,`[Service]\nEnvironmentFile=${form === "quoted" ? `"${envPath}"` : form === "glob" ? `${host.etc}/better-ccflare/ex*.env` : envPath}\n`);
   expect(run(host,["--apply","--foreground","--no-prebuild"]).exitCode).toBe(0);
   expect(readFileSync(join(host.etc,"hov-router/extra.env"),"utf8")).toBe("HOV_ROUTER_EXTRA=synthetic\n");
  });
 }
 test("unsupported specifier refuses before mutation", () => {
  const host=createHost(); write(join(host.dropins,"60-extra.conf"),"[Service]\nEnvironmentFile=%h/settings.env\n");
  const before=tree(host);
  expect(run(host,["--apply","--foreground","--no-prebuild"]).exitCode).toBe(1);
  expect(tree(host)).toEqual(before);
  expect(log(host,"systemctl.log")).not.toContain("stop ccflare-stack.service");
 });
});
