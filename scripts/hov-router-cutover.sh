#!/usr/bin/env bash
#
# Move a host from ccflare-stack.service (7.x) to hov-router.service (8.0.0),
# once. Release 8.0.0 renamed the unit, its storage and its settings and refuses
# the old names at startup, so scripts/deploy-hov-router.sh refuses a host that
# is still on the old unit.
#
#   scripts/hov-router-cutover.sh --check   Report what --apply would do; change nothing.
#   scripts/hov-router-cutover.sh --apply   Check, then run the move in the background and
#                                           print where its log and result file are.
#   scripts/hov-router-cutover.sh --revert  Put the 7.x unit and names back.
#
# Options: --foreground runs --apply in this shell; --no-prebuild skips the
# build of origin/main that --apply runs before the stop.
#
# --apply builds origin/main once while the old unit still serves, so a build
# that fails costs no downtime. Then it:
#   1. stops ccflare-stack.service;
#   2. moves ~/.config/better-ccflare to ~/.config/hov-router, renames its
#      better-ccflare.* files hov-router.* and sets handoff/ aside as
#      handoff.pre-8.0.0, so the first deploy is a full restart;
#   3. moves /etc/better-ccflare to /etc/hov-router and renames the keys in each
#      loaded EnvironmentFile there, keeping each original with .pre-8.0.0 appended;
#   4. moves ~/.better-ccflare to ~/.hov-router;
#   5. writes hov-router.service and its drop-ins from the old ones with keys and
#      paths renamed, plus a seed pin that the deploy replaces, then disables the
#      old unit (left in place for --revert) and enables the new one;
#   6. runs scripts/deploy-hov-router.sh and waits for /health to report the
#      deployed origin/main commit.
# The router is down from step 1 until the deploy's restart, which comes after
# the deploy's own build. A failure after step 1 runs the revert, which brings
# the old unit back on the old names. Clients of this router cannot reach it
# meanwhile, so --apply runs detached and writes the outcome to a result file.
#
# It renames keys and paths only on lines that are not comments, and refuses
# before changing anything when a renamed file would still name ccflare outside
# a comment. Other files keep their contents.
#
# The *_CUTOVER_* environment variables below exist for the rehearsal test.
set -Eeuo pipefail

SCRIPT_PATH="$(realpath "${BASH_SOURCE[0]}")"
REPO_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd -P)"
# shellcheck source=deploy-hov-router-lib.sh
source "$REPO_ROOT/scripts/deploy-hov-router-lib.sh"

ETC="${HOV_ROUTER_CUTOVER_ETC:-/etc}"
OLD_UNIT=ccflare-stack.service
NEW_UNIT=hov-router.service
OLD_UNIT_FILE="$ETC/systemd/system/$OLD_UNIT"
NEW_UNIT_FILE="$ETC/systemd/system/$NEW_UNIT"
OLD_DROPINS="$OLD_UNIT_FILE.d"
NEW_DROPINS="$NEW_UNIT_FILE.d"
OLD_CONTROL="$ETC/systemd/system.control/$OLD_UNIT.d"
NEW_CONTROL="$ETC/systemd/system.control/$NEW_UNIT.d"
OLD_ETC="$ETC/better-ccflare"
NEW_ETC="$ETC/hov-router"
PIN_NAME=50-pinned-build.conf
HEALTH_URL=http://127.0.0.1:8788/health
HEALTH_TIMEOUT_S="${HOV_ROUTER_CUTOVER_HEALTH_TIMEOUT_S:-180}"
DEPLOY="${HOV_ROUTER_CUTOVER_DEPLOY:-$REPO_ROOT/scripts/deploy-hov-router.sh}"
ENV_BACKUP_SUFFIX=.pre-8.0.0

usage() {
	sed -n '3,14p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'
}

MODE=""
FOREGROUND=0
PREBUILD=1
for arg in "$@"; do
	case "$arg" in
		--check | --apply | --revert)
			[[ -z "$MODE" ]] || {
				echo "choose one of --check, --apply and --revert" >&2
				exit 2
			}
			MODE="${arg#--}"
			;;
		--foreground) FOREGROUND=1 ;;
		--no-prebuild) PREBUILD=0 ;;
		-h | --help)
			usage
			exit 0
			;;
		*)
			echo "unknown argument: $arg" >&2
			usage >&2
			exit 2
			;;
	esac
done
[[ -n "$MODE" ]] || {
	usage >&2
	exit 2
}

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
refuse() {
	echo "refusing the cutover: $*" >&2
	exit 1
}

SERVICE_USER="$(systemctl show "$OLD_UNIT" --property=User --value 2>/dev/null || true)"
if [[ -n "${HOV_ROUTER_CUTOVER_HOME:-}" ]]; then
	HOME_DIR="$HOV_ROUTER_CUTOVER_HOME"
elif [[ -n "$SERVICE_USER" ]]; then
	HOME_DIR="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
else
	HOME_DIR=""
fi
OLD_CFG="$HOME_DIR/.config/better-ccflare"
NEW_CFG="$HOME_DIR/.config/hov-router"
OLD_DOT="$HOME_DIR/.better-ccflare"
NEW_DOT="$HOME_DIR/.hov-router"
STATE_DIR="${HOV_ROUTER_CUTOVER_STATE_DIR:-$HOME_DIR/.local/state/hov-router-cutover}"
LOG="$STATE_DIR/cutover.log"
RESULT="$STATE_DIR/result"
STARTED="$STATE_DIR/started"
PRIOR_SHA_FILE="$STATE_DIR/prior-git-sha"

# Renames keys and paths in a systemd unit or drop-in (`unit`), an
# EnvironmentFile (`env`), or only the Environment= keys of a unit (`keys`).
# Reads the text on stdin and writes it to stdout. Reports on stderr, by name
# and line number only and never a value: `key NAME` for each key it sees,
# `rename OLD NEW`, `comment FILE:LINE` for a comment that still says ccflare,
# and `leftover FILE:LINE DIRECTIVE` for a line outside a comment that still
# does, which makes it exit 3.
RENAME_JS="$(
	cat <<'NODE'
const fs = require("node:fs");
const [mode, etc, home, label] = process.argv.slice(1);
const lines = fs.readFileSync(0, "utf8").split("\n");
const say = (line) => process.stderr.write(`${line}\n`);
// The same mapping packages/config/src/retired-names.ts refuses at startup.
const renameKey = (key) => {
	if (key === "BETTER_CCFLARE_GIT_SHA") return "HOV_ROUTER_HEALTH_GIT_SHA";
	for (const prefix of ["BETTER_CCFLARE_", "CCFLARE_", "ccflare_"]) {
		if (key.startsWith(prefix)) return `HOV_ROUTER_${key.slice(prefix.length)}`;
	}
	return key;
};
const noteKey = (key) => {
	const renamed = renameKey(key);
	if (renamed !== key) say(`rename ${key} ${renamed}`);
	say(`key ${renamed}`);
	return renamed;
};
// A directory rename applies to a whole path component only.
const pathRules = [
	[`${etc}/better-ccflare`, `${etc}/hov-router`],
	[`${home}/.config/better-ccflare`, `${home}/.config/hov-router`],
	[`${home}/.better-ccflare`, `${home}/.hov-router`],
];
const renamePaths = (text) => {
	for (const [from, to] of pathRules) {
		let out = "";
		let at = 0;
		for (;;) {
			const found = text.indexOf(from, at);
			if (found < 0) break;
			const next = text[found + from.length];
			const whole = next === undefined || /[/\s"':]/.test(next);
			out += text.slice(at, found) + (whole ? to : from);
			at = found + from.length;
		}
		text = out + text.slice(at);
	}
	return text;
};
// Environment= takes words separated by whitespace, each optionally quoted, and
// each word is one assignment whose key runs to the first "=".
const renameEnvironmentWords = (value) => {
	let out = "";
	let i = 0;
	while (i < value.length) {
		if (/\s/.test(value[i])) {
			out += value[i++];
			continue;
		}
		const start = i;
		let quote = "";
		while (i < value.length && (quote || !/\s/.test(value[i]))) {
			const c = value[i];
			if (c === "\\" && quote !== "'") i += 2;
			else {
				if (quote && c === quote) quote = "";
				else if (!quote && (c === '"' || c === "'")) quote = c;
				i++;
			}
		}
		const word = value.slice(start, Math.min(i, value.length));
		const match = /^(["']?)([A-Za-z_][A-Za-z0-9_]*)=/.exec(word);
		if (!match) {
			out += word;
			continue;
		}
		out += match[1] + noteKey(match[2]) + word.slice(match[1].length + match[2].length);
	}
	return out;
};
let leftovers = 0;
const output = lines.map((line, index) => {
	const where = `${label}:${index + 1}`;
	if (/^\s*[#;]/.test(line)) {
		if (/ccflare/i.test(line)) say(`comment ${where}`);
		return line;
	}
	let next = line;
	const environment = /^(\s*Environment=)(.*)$/.exec(next);
	if (mode === "env") {
		const assignment = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=/.exec(next);
		if (assignment) {
			next = assignment[1] + noteKey(assignment[2]) + next.slice(assignment[0].length - 1);
		}
	} else if (environment) {
		next = environment[1] + renameEnvironmentWords(environment[2]);
	}
	if (mode === "keys") return next;
	next = renamePaths(next);
	if (mode === "unit") {
		next = next.replaceAll("ccflare-stack.service", "hov-router.service");
		next = next.replaceAll("run-ccflare-stack.sh", "run-hov-router.sh");
		next = next.replace(/^(\s*RuntimeDirectory=)ccflare-stack\s*$/, "$1hov-router");
		if (/^\s*Description=/.test(next)) next = next.replaceAll("better-ccflare", "HoV Router");
	}
	if (/ccflare/i.test(next)) {
		const directive = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)/.exec(next)?.[1] ?? "?";
		say(`leftover ${where} ${directive}`);
		leftovers++;
	}
	return next;
});
process.stdout.write(output.join("\n"));
process.exitCode = leftovers ? 3 : 0;
NODE
)"

rename_names() {
	node -e "$RENAME_JS" "$1" "$ETC" "$HOME_DIR" "$2"
}

# The seed pin passes the deploy's ownership check and carries only what its
# renderer reads from the previous pin: GUARD_ACCEPTED_CAP_MS and Environment=
# assignments the deploy does not own. Its ExecStart exits 78, which the unit's
# RestartPreventExitStatus keeps stopped, so a unit started on the seed (the
# deploy's rollback restores it) stays down instead of running anything stale.
write_seed_pin() {
	local old_pin="$1" out="$2" report="$3" keyed preserved cap
	keyed="$(mktemp "$(dirname "$out")/keyed-pin.XXXXXX")" || return 1
	# 7.x marked its block "better-ccflare"; the library reads only a block
	# marked "hov-router".
	rename_names keys "$PIN_NAME" <"$old_pin" 2>/dev/null \
		| sed -e 's/^# BEGIN better-ccflare managed deployment$/# BEGIN hov-router managed deployment/' \
			-e 's/^# END better-ccflare managed deployment$/# END hov-router managed deployment/' \
			>"$keyed" || return 1
	preserved="$(preserve_unmanaged_systemd_environment "$keyed")" || {
		echo "could not read the Environment= assignments in $old_pin" >>"$report"
		return 1
	}
	cap="$(configured_systemd_environment_value "$keyed" GUARD_ACCEPTED_CAP_MS 2>/dev/null || true)"
	rm -f "$keyed"
	{
		echo "# BEGIN hov-router managed deployment"
		echo "# Seeded by scripts/hov-router-cutover.sh. The first deploy replaces this"
		echo "# block; a unit started on it exits 78 and stays stopped."
		echo "[Service]"
		[[ -z "$preserved" ]] || printf '%s\n' "$preserved"
		[[ -z "$cap" ]] || printf 'Environment=GUARD_ACCEPTED_CAP_MS=%s\n' "$cap"
		echo "RestartPreventExitStatus=143 78"
		echo "ExecStart="
		echo "ExecStart=/bin/sh -c 'echo \"hov-router.service is on the cutover seed pin; run scripts/deploy-hov-router.sh\" >&2; exit 78'"
		echo "# END hov-router managed deployment"
	} | rename_names unit "$PIN_NAME (seed)" >"$out" 2>>"$report"
}

# Writes the renamed unit, drop-ins, control drop-ins and seed pin under
# $1/systemd and the rename report to $1/report. Environment files are read
# through sudo, renamed in memory and discarded: --apply renames them in place.
stage_files() {
	local stage="$1" report="$1/report" status=0 file name
	mkdir -p "$stage/systemd/dropins" "$stage/systemd/control" || return 1
	: >"$report" || return 1
	discover_inputs "$stage" || return 1
	loaded_env_files "$stage" | sort -u >"$stage/loaded-env-files" || return 1
	rename_names unit "$OLD_UNIT" <"$OLD_UNIT_FILE" >"$stage/systemd/unit" 2>>"$report" || status=1
	for file in "$OLD_DROPINS"/*.conf; do
		[[ -f "$file" ]] || continue
		name="${file##*/}"
		[[ "$name" != "$PIN_NAME" ]] || continue
		rename_names unit "$name" <"$file" >"$stage/systemd/dropins/$name" 2>>"$report" || status=1
	done
	for file in "$OLD_CONTROL"/*.conf; do
		[[ -f "$file" ]] || continue
		name="${file##*/}"
		rename_names unit "control/$name" <"$file" >"$stage/systemd/control/$name" 2>>"$report" || status=1
	done
	: >"$stage/env-files" || return 1
	while IFS= read -r file; do
		if [[ "$file" == "$OLD_ETC"/* ]]; then
			[[ -f "$file" ]] || continue
			local pattern
			while IFS= read -r pattern; do
				pattern="${pattern:1}"
				# Compare against every effective glob, including optional patterns with no current match.
				# shellcheck disable=SC2254
				case "$file$ENV_BACKUP_SUFFIX" in
					$pattern) refuse "EnvironmentFile pattern would also load a retired-key backup" ;;
				esac
			done <"$stage/env-patterns"
			local reserved
			for reserved in "$file$ENV_BACKUP_SUFFIX" "$file.cutover-tmp" "$file.cutover-backup-tmp"; do
				[[ ! -e "$reserved" && ! -L "$reserved" ]] || refuse "$reserved already exists"
			done
			printf '%s\n' "${file#"$OLD_ETC"/}" >>"$stage/env-files"
			sudo -n cat "$file" | rename_names env "${file##*/}" >/dev/null 2>>"$report" || status=1
		elif sudo -n grep -q -E '^[[:space:]]*(export[[:space:]]+)?(BETTER_CCFLARE_|CCFLARE_|ccflare_)' "$file" 2>/dev/null; then
			echo "outside $file sets a retired key and is not under $OLD_ETC" >>"$report"
			status=1
		fi
	done <"$stage/loaded-env-files"
	write_seed_pin "$OLD_DROPINS/$PIN_NAME" "$stage/systemd/seed" "$report" || status=1
	return "$status"
}

# Resolve effective directives before stopping anything. Control drop-ins win
# over ordinary drop-ins of the same name. Unsupported syntax fails closed.
discover_inputs() {
	node - "$OLD_UNIT_FILE" "$OLD_DROPINS" "$OLD_CONTROL" "$HOME_DIR" "$1" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [unit, ordinary, control, home, stage] = process.argv.slice(2);
const selected = new Map();
for (const dir of [ordinary, control]) {
	if (!fs.existsSync(dir)) continue;
	for (const name of fs.readdirSync(dir)) {
		if (name.endsWith(".conf")) selected.set(name, path.join(dir, name));
	}
}
let env = [], workdir = "/";
function parse(raw, directive) {
	let value = raw.trim();
	if (/[\\%$\n\r]/.test(value)) throw new Error(`unsupported ${directive} syntax`);
	if (value.startsWith('"') || value.startsWith("'")) {
		if (value.length < 2 || !value.endsWith(value[0])) throw new Error(`unsupported ${directive} quoting`);
		value = value.slice(1, -1);
	} else if (/\s/.test(value)) throw new Error(`unsupported ${directive} words`);
	if (/["']/.test(value)) throw new Error(`unsupported ${directive} quoting`);
	return value;
}
try {
	for (const file of [unit, ...[...selected.keys()].sort().map(name => selected.get(name))]) {
		let section = "";
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			if (/^\s*[#;]/.test(line)) continue;
			const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
			if (header) { section = header[1]; continue; }
			if (section !== "Service") continue;
			const match = /^\s*(EnvironmentFile|WorkingDirectory)\s*=(.*)$/.exec(line);
			if (!match) continue;
			const key = match[1];
			let value = parse(match[2], key);
			if (key === "EnvironmentFile" && !value) { env = []; continue; }
			const optional = value.startsWith("-");
			if (optional) value = value.slice(1);
			if (key === "WorkingDirectory" && value === "~") value = home;
			if (!value && key === "WorkingDirectory") value = "/";
			if (!path.isAbsolute(value)) throw new Error(`unsupported ${key} path`);
			value = path.normalize(value);
			if (key === "WorkingDirectory") {
				if (/[*?\[]/.test(value)) throw new Error("unsupported WorkingDirectory pattern");
				workdir = value;
			} else env.push({value, optional});
		}
	}
	fs.writeFileSync(path.join(stage, "env-patterns"), env.map(({value, optional}) => `${optional ? "-" : "+"}${value}\n`).join(""));
	fs.writeFileSync(path.join(stage, "workdir"), workdir);
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
}
NODE
}

loaded_env_files() {
	local pattern file optional matched
	while IFS= read -r pattern; do
		optional="${pattern:0:1}"
		pattern="${pattern:1}"
		matched=0
		while IFS= read -r file; do
			[[ -f "$file" ]] || continue
			if [[ "$file" == "$OLD_ETC"/* ]]; then
				[[ ! -L "$file" && "$(realpath "$file")" == "$OLD_ETC"/* ]] || refuse "environment file is symlinked or outside the directory being moved: $file"
			fi
			realpath "$file" || return 1
			matched=1
		done < <(compgen -G "$pattern" || true)
		if ((matched == 0)) && [[ "$optional" != - ]]; then
			echo "required EnvironmentFile has no readable match" >&2
			return 1
		fi
	done <"$1/env-patterns"
}

startup_dotenv_files() {
	local workdir
	workdir="$(cat "$1/workdir")"
	printf '%s\n' "${workdir%/}/.env" "$(realpath -m "$workdir/../..")/.env" "$OLD_CFG/.env" | sort -u
}

# What the old pin starts: its binary, guard and runner.
old_pin_targets() {
	local pin="$OLD_DROPINS/$PIN_NAME"
	sed -n -E 's/^Environment=(CCFLARE_BIN|GUARD_SCRIPT)=//p' "$pin"
	sed -n -E 's/^ExecStart=[-@:+!]*([^[:space:]]+).*$/\1/p' "$pin" | tail -n 1
}

health_git_sha() {
	local body
	body="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null)" || return 1
	node -e '
		try {
			const value = JSON.parse(process.argv[1])?.git_sha;
			process.stdout.write(typeof value === "string" ? value : "");
		} catch { process.exit(1); }
	' "$body"
}

# The build embeds `git rev-parse --short`, so /health reports an abbreviation
# of the commit; $2 may be the full commit or the abbreviation itself.
sha_matches() {
	local reported="$1" wanted_sha="$2"
	[[ -n "$reported" ]] || return 1
	[[ "$reported" == "$wanted_sha" ]] && return 0
	((${#reported} >= 7)) && [[ "$wanted_sha" == "$reported"* ]]
}

# Waits for /health to answer, and to report $1 when it is not empty.
wait_for_health() {
	local wanted_sha="$1" deadline=$((SECONDS + HEALTH_TIMEOUT_S)) sha
	while ((SECONDS < deadline)); do
		if sha="$(health_git_sha)" && { [[ -z "$wanted_sha" ]] || sha_matches "$sha" "$wanted_sha"; }; then
			return 0
		fi
		sleep 1
	done
	return 1
}

# Every check that needs no change. Stages into $1 and prints the plan.
preflight() {
	local stage="$1" report renames comments leftovers file count prior target
	[[ "$(id -u)" != 0 ]] || refuse "run it as the service's user, not as root; it uses sudo where it must"
	sudo -n true 2>/dev/null || refuse "sudo needs a password; this runs unattended, so it needs sudo -n"
	[[ -f "$OLD_UNIT_FILE" ]] || refuse "$OLD_UNIT_FILE does not exist, so this host is not on the 7.x unit"
	[[ -n "$SERVICE_USER" ]] || refuse "$OLD_UNIT names no User="
	[[ "$(id -un)" == "$SERVICE_USER" ]] || refuse "$OLD_UNIT runs as $SERVICE_USER; run this as that user"
	[[ -n "$HOME_DIR" && -d "$HOME_DIR" ]] || refuse "no home directory for $SERVICE_USER"
	[[ -f "$OLD_DROPINS/$PIN_NAME" ]] || refuse "$OLD_DROPINS/$PIN_NAME does not exist"
	[[ -d "$OLD_CFG" ]] || refuse "$OLD_CFG does not exist"
	local effective_dropins
	local -a dropin_paths=()
	effective_dropins="$(systemctl show "$OLD_UNIT" --property=DropInPaths --value)" || refuse "could not discover the loaded drop-ins"
	read -r -a dropin_paths <<<"$effective_dropins"
	for file in "${dropin_paths[@]}"; do
		case "$file" in
			"$OLD_DROPINS"/*.conf | "$OLD_CONTROL"/*.conf) ;;
			*) refuse "loaded drop-in is outside the directories this cutover handles: $file" ;;
		esac
		[[ -f "$file" ]] || refuse "loaded drop-in is no longer available: $file"
	done
	for file in "$NEW_UNIT_FILE" "$NEW_DROPINS" "$NEW_CONTROL" "$NEW_CFG" "$NEW_ETC" "$NEW_DOT"; do
		[[ ! -e "$file" && ! -L "$file" ]] || refuse "$file already exists"
	done
	for file in "$OLD_CFG"/hov-router.* "$OLD_CFG/handoff.pre-8.0.0"; do
		[[ ! -e "$file" && ! -L "$file" ]] || refuse "$file already exists beside the files it would be renamed from"
	done

	local stage_status=0
	report="$stage/report"
	stage_files "$stage" || stage_status=$?
	leftovers="$(grep '^leftover ' "$report" || true)"
	if [[ -n "$leftovers" ]]; then
		while IFS= read -r line; do printf '  %s\n' "${line#leftover }"; done <<<"$leftovers" >&2
		refuse "these lines would still name ccflare outside a comment (file:line directive); rename them by hand first"
	fi
	if ((stage_status != 0)) || grep -q -v -E '^(key|rename|comment) ' "$report"; then
		grep -v -E '^(key|rename|comment|leftover) ' "$report" >&2 || true
		refuse "renaming the unit's files failed"
	fi
	local keys
	while IFS= read -r file; do
		[[ -f "$file" ]] || continue
		keys="$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?((BETTER_CCFLARE_|CCFLARE_|ccflare_)[A-Za-z0-9_]*)=.*$/\2/p' "$file" | sort -u | paste -sd' ' -)" \
			|| refuse "could not read $file"
		[[ -z "$keys" ]] || refuse "$file sets $keys; the router reads that file at startup and stops on an old name, so rename them there first"
	done < <(startup_dotenv_files "$stage")
	if grep -q -x -E 'key (HOV_ROUTER_DB_PATH|HOV_ROUTER_CONFIG_PATH|XDG_CONFIG_HOME)' "$report"; then
		refuse "the unit sets a database, config or XDG_CONFIG_HOME path, so its storage may live outside $OLD_CFG; move it by hand"
	fi

	git -C "$REPO_ROOT" fetch origin refs/heads/main:refs/remotes/origin/main --quiet \
		|| refuse "could not fetch origin/main"
	target="$(git -C "$REPO_ROOT" rev-parse refs/remotes/origin/main)"
	prior="$(health_git_sha || true)"

	renames="$(grep '^rename ' "$report" | sort -u | sed 's/^rename \([^ ]*\) \([^ ]*\)$/  \1 -> \2/')"
	comments="$(grep -c '^comment ' "$report" || true)"
	echo "==> Cutover plan for $OLD_UNIT -> $NEW_UNIT (user $SERVICE_USER)"
	echo "live:    $(systemctl is-active "$OLD_UNIT" 2>/dev/null || true), /health git_sha ${prior:-unavailable}"
	echo "target:  origin/main ${target:0:12}"
	if [[ -n "$prior" ]] && git -C "$REPO_ROOT" cat-file -e "$prior^{commit}" 2>/dev/null; then
		count="$(git -C "$REPO_ROOT" diff "$prior" "$target" -- packages/database/src/migrations.ts | grep -c -E '^[-+][^-+].*(CREATE|ALTER|DROP) (TABLE|INDEX|COLUMN)|^[-+][^-+].*ADD COLUMN' || true)"
		echo "schema:  $count changed schema statement lines in migrations.ts since the live build (a revert runs the old build on the database 8.0.0 opened)"
	else
		echo "schema:  the live build's commit is not in this checkout, so migrations.ts was not compared"
	fi
	count=0
	for file in "$OLD_CFG"/better-ccflare.*; do
		if [[ -e "$file" ]]; then count=$((count + 1)); fi
	done
	local handoff=""
	if [[ -e "$OLD_CFG/handoff" ]]; then handoff="; handoff/ set aside"; fi
	echo "move:    $OLD_CFG -> $NEW_CFG ($count better-ccflare.* files renamed hov-router.*$handoff)"
	if [[ -d "$OLD_ETC" ]]; then
		count="$(grep -c . "$stage/env-files" || true)"
		echo "move:    $OLD_ETC -> $NEW_ETC (keys renamed in the $count environment files the unit loads, originals kept with $ENV_BACKUP_SUFFIX; other files unchanged)"
	fi
	if [[ -e "$OLD_DOT" ]]; then echo "move:    $OLD_DOT -> $NEW_DOT"; fi
	count=0
	for file in "$stage/systemd/dropins"/* "$stage/systemd/control"/*; do
		if [[ -f "$file" ]]; then count=$((count + 1)); fi
	done
	echo "systemd: writes $NEW_UNIT_FILE, $count drop-ins and a seed pin; disables $OLD_UNIT and leaves it for --revert"
	echo "keys:    $(grep -c . <<<"$renames" || true) renamed"
	if [[ -n "$renames" ]]; then printf '%s\n' "$renames"; fi
	echo "notes:   $comments comment lines still say ccflare; nothing reads them"
	echo "outage:  from the stop until the deploy's restart, which follows the deploy's build"

	git -C "$REPO_ROOT" cat-file -e refs/remotes/origin/main:scripts/hov-router-cutover.sh 2>/dev/null \
		|| refuse "origin/main does not have the 8.0.0 rename yet, so the deploy would ship a build that reads the old names"
}

# Never rotate the directory containing the lock: every invocation must contend
# on the same inode, including the launcher while its worker is still building.
acquire_lock() {
	local lock="$STATE_DIR.lock"
	mkdir -p "$(dirname "$STATE_DIR")"
	if [[ "${HOV_ROUTER_CUTOVER_LOCK_INHERITED:-}" == 1 ]] && [[ /proc/$$/fd/8 -ef "$lock" ]]; then
		flock -n 8 || refuse "another cutover holds $lock"
		return
	fi
	exec 8>"$lock"
	flock -n 8 || refuse "another cutover holds $lock"
}

start_detached() {
	local stage
	stage="$(mktemp -d "${TMPDIR:-/tmp}/hov-router-cutover-check.XXXXXX")"
	preflight "$stage"
	rm -rf "$stage"
	if [[ -e "$STATE_DIR" ]]; then
		if [[ -e "$STARTED" && ! -s "$RESULT" ]]; then
			refuse "$STATE_DIR records a cutover with no result; read $LOG, then run $SCRIPT_PATH --revert"
		fi
		mv -T "$STATE_DIR" "$STATE_DIR.$(date -u +%Y%m%dT%H%M%SZ)"
	fi
	mkdir -p "$STATE_DIR"
	chmod 0700 "$STATE_DIR"
	local args=(--apply --foreground)
	((PREBUILD)) || args+=(--no-prebuild)
	HOV_ROUTER_CUTOVER_LOCK_INHERITED=1 setsid -f bash "$SCRIPT_PATH" "${args[@]}" </dev/null >>"$LOG" 2>&1
	echo "==> Started. Log: $LOG"
	echo "    The outcome is the first line of $RESULT: ok, failed, reverted or revert-failed."
}

prebuild() {
	local sha parent snapshot began status=0
	sha="$(git -C "$REPO_ROOT" rev-parse refs/remotes/origin/main)"
	parent="$(mktemp -d "${TMPDIR:-/tmp}/hov-router-cutover-build.XXXXXX")"
	snapshot="$parent/source"
	create_verified_source_snapshot "$REPO_ROOT" "$snapshot" "$sha"
	began=$SECONDS
	log "building origin/main ${sha:0:12} while $OLD_UNIT still serves"
	(cd "$snapshot" && bun install --frozen-lockfile && bun run build) || status=$?
	remove_verified_source_snapshot "$REPO_ROOT" "$snapshot" || true
	rmdir "$parent" 2>/dev/null || true
	((status == 0)) || refuse "the build of origin/main failed (exit $status) before anything changed"
	log "built in $((SECONDS - began))s; the deploy builds again after the stop"
}

write_result() {
	printf '%s\n' "$*" >"$RESULT.tmp"
	mv -f "$RESULT.tmp" "$RESULT"
	log "result: $*"
}

CURRENT_STEP=""
on_apply_exit() {
	local status=$?
	trap - EXIT
	trap '' INT TERM HUP
	if [[ ! -e "$STARTED" && "$status" != 0 ]]; then
		write_result "failed: $CURRENT_STEP (exit $status); cutover did not stop $OLD_UNIT"
	elif [[ -e "$STARTED" && ! -s "$RESULT" ]]; then
		log "the cutover failed while ${CURRENT_STEP} (exit $status); reverting"
		if revert_host; then
			write_result "reverted: the cutover failed while ${CURRENT_STEP}; $OLD_UNIT serves again"
		else
			write_result "revert-failed: the cutover failed while ${CURRENT_STEP} and the revert did not finish; read $LOG, then run $SCRIPT_PATH --revert"
		fi
	fi
	exit "$status"
}

install_like() {
	local source="$1" reference="$2" target="$3"
	sudo -n install -o root -g root -m "$(stat -c %a "$reference")" "$source" "$target"
}

run_apply() {
	local stage="$STATE_DIR/stage" file name target prior served deadline
	mkdir -p "$STATE_DIR"
	chmod 0700 "$STATE_DIR"
	[[ ! -e "$STARTED" ]] || refuse "$STATE_DIR already records a cutover; read $LOG"
	CURRENT_STEP=preflight
	trap on_apply_exit EXIT
	trap 'log "interrupted"; exit 130' INT TERM
	trap '' HUP
	rm -f "$RESULT" # A foreground retry can follow a failed preflight or prebuild.
	rm -rf "$stage"
	preflight "$stage"
	health_git_sha >"$PRIOR_SHA_FILE" 2>/dev/null || : >"$PRIOR_SHA_FILE"
	if ((PREBUILD)); then
		CURRENT_STEP=prebuild
		prebuild
	fi
	: >"$STARTED"

	CURRENT_STEP="stopping $OLD_UNIT"
	log "stopping $OLD_UNIT; the router is down from here until the deploy restarts it"
	sudo -n systemctl stop "$OLD_UNIT"
	[[ "$(systemctl is-active "$OLD_UNIT" 2>/dev/null || true)" != active ]]
	for file in "$OLD_CFG"/better-ccflare.db*; do
		[[ -e "$file" ]] || continue
		if fuser -s "$file" 2>/dev/null; then
			log "a process still has $file open"
			false
		fi
	done

	CURRENT_STEP="moving the storage"
	mv -T "$OLD_CFG" "$NEW_CFG"
	if [[ -d "$OLD_ETC" ]]; then sudo -n mv -T "$OLD_ETC" "$NEW_ETC"; fi
	if [[ -e "$OLD_DOT" ]]; then mv -T "$OLD_DOT" "$NEW_DOT"; fi
	for file in "$NEW_CFG"/better-ccflare.*; do
		[[ -e "$file" || -L "$file" ]] || continue
		name="${file##*/}"
		target="$NEW_CFG/hov-router.${name#better-ccflare.}"
		[[ ! -e "$target" && ! -L "$target" ]]
		mv -T "$file" "$target"
	done
	if [[ -e "$NEW_CFG/handoff" ]]; then mv -T "$NEW_CFG/handoff" "$NEW_CFG/handoff.pre-8.0.0"; fi

	CURRENT_STEP="renaming the keys in $NEW_ETC"
	while IFS= read -r name; do
		file="$NEW_ETC/$name"
		sudo -n cp --preserve=all "$file" "$file.cutover-backup-tmp"
		sudo -n mv -T "$file.cutover-backup-tmp" "$file$ENV_BACKUP_SUFFIX"
		sudo -n cp --preserve=all "$file" "$file.cutover-tmp"
		sudo -n cat "$file" | rename_names env "${file##*/}" 2>/dev/null | sudo -n tee "$file.cutover-tmp" >/dev/null
		sudo -n mv -f "$file.cutover-tmp" "$file"
	done <"$stage/env-files"

	CURRENT_STEP="writing $NEW_UNIT"
	install_like "$stage/systemd/unit" "$OLD_UNIT_FILE" "$NEW_UNIT_FILE"
	sudo -n install -d -o root -g root -m 0755 "$NEW_DROPINS"
	for file in "$stage/systemd/dropins"/*; do
		[[ -f "$file" ]] || continue
		install_like "$file" "$OLD_DROPINS/${file##*/}" "$NEW_DROPINS/${file##*/}"
	done
	install_like "$stage/systemd/seed" "$OLD_DROPINS/$PIN_NAME" "$NEW_DROPINS/$PIN_NAME"
	for file in "$stage/systemd/control"/*; do
		[[ -f "$file" ]] || continue
		sudo -n install -d -o root -g root -m 0755 "$NEW_CONTROL"
		install_like "$file" "$OLD_CONTROL/${file##*/}" "$NEW_CONTROL/${file##*/}"
	done
	sudo -n systemctl daemon-reload
	sudo -n systemctl disable "$OLD_UNIT"
	sudo -n systemctl enable "$NEW_UNIT"

	CURRENT_STEP="deploying origin/main"
	log "running $DEPLOY"
	(cd "$REPO_ROOT" && bash "$DEPLOY")

	# The deploy checked /health against the commit it built, which is origin/main
	# as the deploy fetched it; another checkout may fetch a newer main since. So
	# this asks only that the new unit runs and serves a build other than 7.x's.
	CURRENT_STEP="checking /health"
	prior="$(cat "$PRIOR_SHA_FILE")"
	deadline=$((SECONDS + HEALTH_TIMEOUT_S))
	served=""
	while ((SECONDS < deadline)); do
		if served="$(health_git_sha)" && [[ -n "$served" ]] && ! sha_matches "$served" "$prior"; then break; fi
		served=""
		sleep 1
	done
	if [[ -z "$served" ]]; then
		log "/health did not report a build other than ${prior:-the old one} within ${HEALTH_TIMEOUT_S}s"
		false
	fi
	if [[ "$(systemctl is-active "$NEW_UNIT" 2>/dev/null || true)" != active ]]; then
		log "$NEW_UNIT is not active"
		false
	fi
	write_result "ok: $NEW_UNIT serves $served"
}

# Moves $1 to $2, first setting aside anything at $2 that appeared after the
# cutover moved it away. $3 is "sudo" for root-owned paths.
move_back() {
	local from="$1" to="$2" privilege="${3:-}" runner=()
	[[ "$privilege" != sudo ]] || runner=(sudo -n)
	[[ -e "$from" || -L "$from" ]] || return 0
	if [[ -e "$to" || -L "$to" ]]; then
		log "$to appeared during the cutover; setting it aside"
		"${runner[@]}" mv -T "$to" "$to.recreated-$(date -u +%Y%m%dT%H%M%SZ)" || return 1
	fi
	"${runner[@]}" mv -T "$from" "$to" || return 1
}

# Brings the old unit back from whatever state the host is in. Each step reads
# the disk rather than a journal, so a revert that stopped part way can run again.
revert_host() {
	local stamp cfg etc_dir file name prior backup
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	[[ -f "$OLD_UNIT_FILE" ]] || {
		log "$OLD_UNIT_FILE is gone; nothing to revert to"
		return 1
	}
	if [[ -e "$NEW_UNIT_FILE" || -e "$NEW_DROPINS" || -e "$NEW_CONTROL" ]]; then
		sudo -n systemctl stop "$NEW_UNIT" || true
		sudo -n systemctl disable "$NEW_UNIT" || true
		if [[ "$(systemctl is-active "$NEW_UNIT" 2>/dev/null || true)" == active ]]; then
			log "$NEW_UNIT is still active"
			return 1
		fi
		backup="$STATE_DIR/reverted-$stamp"
		mkdir -p "$backup/system" "$backup/system.control" || return 1
		if [[ -e "$NEW_UNIT_FILE" ]]; then sudo -n cp -a "$NEW_UNIT_FILE" "$backup/system/" || return 1; fi
		if [[ -e "$NEW_DROPINS" ]]; then sudo -n cp -a "$NEW_DROPINS" "$backup/system/" || return 1; fi
		if [[ -e "$NEW_CONTROL" ]]; then sudo -n cp -a "$NEW_CONTROL" "$backup/system.control/" || return 1; fi
		sudo -n chown -R "$(id -u):$(id -g)" "$backup" || return 1
		log "kept a copy of the $NEW_UNIT files in $backup"
		sudo -n rm -rf "$NEW_UNIT_FILE" "$NEW_DROPINS" "$NEW_CONTROL" || return 1
	fi
	sudo -n systemctl daemon-reload || return 1

	etc_dir="$NEW_ETC"
	[[ -d "$etc_dir" ]] || etc_dir="$OLD_ETC"
	while IFS= read -r name; do
		file="$etc_dir/$name"
		sudo -n rm -f "$file.cutover-tmp" "$file.cutover-backup-tmp" || return 1
		if [[ -f "$file$ENV_BACKUP_SUFFIX" ]]; then
			sudo -n mv -f "$file$ENV_BACKUP_SUFFIX" "$file" || return 1
		fi
	done <"$STATE_DIR/stage/env-files" || return 1

	cfg="$NEW_CFG"
	[[ -d "$cfg" ]] || cfg="$OLD_CFG"
	for file in "$cfg"/hov-router.db*; do
		[[ -e "$file" ]] || continue
		if fuser -s "$file" 2>/dev/null; then
			log "a process still has $file open"
			return 1
		fi
	done
	if [[ -e "$cfg/handoff.pre-8.0.0" ]]; then
		if [[ -e "$cfg/handoff" ]]; then mv -T "$cfg/handoff" "$cfg/handoff.8.0.0-reverted-$stamp" || return 1; fi
		mv -T "$cfg/handoff.pre-8.0.0" "$cfg/handoff" || return 1
	fi
	for file in "$cfg"/hov-router.*; do
		[[ -e "$file" || -L "$file" ]] || continue
		name="${file##*/}"
		move_back "$file" "$cfg/better-ccflare.${name#hov-router.}" || return 1
	done
	move_back "$NEW_CFG" "$OLD_CFG" || return 1
	move_back "$NEW_ETC" "$OLD_ETC" sudo || return 1
	move_back "$NEW_DOT" "$OLD_DOT" || return 1

	sudo -n systemctl daemon-reload || return 1
	local target
	while IFS= read -r target; do
		[[ -z "$target" || -e "$target" ]] && continue
		log "$OLD_UNIT cannot start: its pin names $target, which does not exist"
		return 1
	done < <(old_pin_targets)
	sudo -n systemctl enable "$OLD_UNIT" || return 1
	sudo -n systemctl start "$OLD_UNIT" || return 1
	prior="$(cat "$PRIOR_SHA_FILE" 2>/dev/null || true)"
	if ! wait_for_health "$prior"; then
		log "$OLD_UNIT did not answer /health${prior:+ with $prior} within ${HEALTH_TIMEOUT_S}s"
		return 1
	fi
	log "$OLD_UNIT is back${prior:+ at $prior}"
}

if [[ "$MODE" != check ]]; then acquire_lock; fi

case "$MODE" in
	check)
		stage="$(mktemp -d "${TMPDIR:-/tmp}/hov-router-cutover-check.XXXXXX")"
		trap 'rm -rf "$stage"' EXIT
		preflight "$stage"
		echo "OK: --apply would proceed."
		;;
	apply)
		if ((FOREGROUND)); then
			run_apply
		else
			start_detached
		fi
		;;
	revert)
		[[ -d "$STATE_DIR" ]] || refuse "$STATE_DIR does not exist, so no cutover ran from this account"
		mkdir -p "$STATE_DIR"
		[[ -e "$STARTED" ]] || refuse "the cutover did not start changing the host; nothing to revert"
		if revert_host; then
			write_result "reverted: by --revert; $OLD_UNIT serves again"
		else
			write_result "revert-failed: --revert did not finish; read $LOG"
			exit 1
		fi
		;;
esac
