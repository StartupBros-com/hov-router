import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { COMMAND_NAMES } from "../../../packages/core/src/product-identity";

const root = resolve(import.meta.dir, "../../..");
const reference = readFileSync(join(root, "docs/reference.md"), "utf8");
const releaseGuide = readFileSync(
	join(root, "docs/hov-router-releases.md"),
	"utf8",
);
const migrationGuide = readFileSync(
	join(root, "docs/hov-router-migration.md"),
	"utf8",
);
const releaseDigest =
	"08115d81588c7ae79fd89188396fb091cce36c0c468a3945ce21971658762a55";
const releaseUrl =
	"https://github.com/StartupBros-com/hov-router/releases/download/v6.2.0/better-ccflare-linux-amd64";
const sourceSha = "f21d5c9ac5ee8a0f9e3fd9a1cdb6346b8c6d4dd8";
const historicalDigest =
	"b01a4989323ecf4e2d0a68394b45828741430d89eb35288f7318a28c45b4c9d7";
const historicalSha = "5d7b2a888a9b61d87916332b414e46606498d896";
// Synthetic downloads only: this is not proof of the real published releases.
// Only the expected digests are substituted; Bash and sha256sum remain real.
function syntheticBinary(display: string, version: string, sha: string) {
	return `#!/bin/sh
printf 'executed\\n' >> "$HOME/executed"
case "$1" in
  --help) printf '${display}\\n';;
  --version) printf '${display} v${version}\\n';;
  --git-sha) printf '${sha}\\n';;
esac
`;
}
const payload = syntheticBinary("HoV Router", "6.2.0", sourceSha);
const historicalPayload = syntheticBinary(
	"wstack Router",
	"3.6.2",
	historicalSha,
);
// The earlier HoV Router release. Its guide installed it under hov-router/6.1.0
// and created only COMMAND_NAMES, without wstack-router.
const previousPayload = syntheticBinary(
	"HoV Router",
	"6.1.0",
	"157f4bc0e7c3b29dffae48ab777ad05225848069",
);
const sha256 = (bytes: string | Buffer) =>
	createHash("sha256").update(bytes).digest("hex");
// Releases signed before the repository moved to StartupBros-com on 2026-11-20.
// GitHub no longer finds their attestations by repository, so each documented
// block fetches the bundle committed under docs/provenance and verifies it under
// the repository and certificate the release was signed with.
const currentHome = "StartupBros-com/hov-router";
const bundleBase =
	"https://raw.githubusercontent.com/StartupBros-com/hov-router/refs/heads/main/docs/provenance/";
const release371Sha = "6b88f789e30c3a86ee918d35a6673e7be12f9243";
const provenanceReleases = [
	{
		marker: "router-release-provenance",
		tag: "v6.2.0",
		signer: "StartupBros/hov-router",
		binary: ".local/lib/hov-router/6.2.0/hov-router",
		sha: sourceSha,
		digest: releaseDigest,
		manifestDigest:
			"9a5837384e7ee616c45f80b6ee518b114b74932522cb7f5a0924778fb41641b4",
		payload,
	},
	{
		marker: "router-release-provenance-v3.7.1",
		tag: "v3.7.1",
		signer: "StartupBros/hov-router",
		binary: ".local/lib/hov-router/3.7.1/hov-router",
		sha: release371Sha,
		digest: "f6e6ee137d0766eb6df9d6c76d264603e9696c12797e1570b8ad6b9648d0b12c",
		manifestDigest:
			"5e88ab1d8376fe783da736003c40f34a0207db4c71be5f6a5c328d1c30881d0c",
		payload: syntheticBinary("HoV Router", "3.7.1", release371Sha),
	},
	{
		marker: "router-release-provenance-v3.6.2",
		tag: "v3.6.2",
		signer: "StartupBros/wstack-router",
		binary: ".local/lib/wstack-router/3.6.2/wstack-router",
		sha: historicalSha,
		digest: historicalDigest,
		manifestDigest:
			"a90aa5f71ba5ae9f4b255e487c2afc80f39d44bc70a6193da43d83f4b05dc60b",
		payload: historicalPayload,
	},
].map((release) => ({
	...release,
	fixtureDigest: sha256(release.payload),
	bundleUrl: `${bundleBase}${release.tag}.jsonl`,
	runLine: `"$HOME/${release.binary}" --help\n`,
}));
// Guides for 3.6.2 through 3.7.1 created all three names; new installs create
// COMMAND_NAMES only, and upgrades repoint an existing wstack-router link.
const earlierGuideAliases = [
	"hov-router",
	"wstack-router",
	"better-ccflare",
] as const;
const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

function block(marker: string) {
	const document = marker.startsWith("router-release-provenance")
		? releaseGuide
		: reference;
	const sections = document.split(`<!-- ${marker} -->`);
	expect(sections, `reference block ${marker}`).toHaveLength(2);
	return sections[1]
		.split(`<!-- /${marker} -->`)[0]
		.split("```bash\n")[1]
		.split("```")[0];
}

function fixture(mode = "ok") {
	const home = mkdtempSync(join(tmpdir(), "hov-binary-install-"));
	homes.push(home);
	const tools = join(home, "tools");
	mkdirSync(tools);
	writeFileSync(join(home, "payload"), payload);
	// The bundles committed in this repository, byte for byte: the documented
	// blocks check them against their pinned SHA-256 before gh sees them.
	mkdirSync(join(home, "served"));
	for (const release of provenanceReleases)
		writeFileSync(
			join(home, "served", `${release.tag}.jsonl`),
			readFileSync(join(root, "docs/provenance", `${release.tag}.jsonl`)),
		);
	for (const profile of [".profile", ".bashrc", ".zshrc"])
		writeFileSync(join(home, profile), "keep profile\n");
	// This stand-in is transport. Record every request and honor --output;
	// no network, provider requests, credential environment, or fake checksum pass.
	writeFileSync(
		join(tools, "curl"),
		`#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$HOME/downloads"
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift ;;
    https://*) url="$1" ;;
  esac
  shift
done
case "$url" in
  "${bundleBase}"*)
    case "$DOWNLOAD_MODE" in
      bundle-fail) exit 22 ;;
      bad-bundle) printf 'corrupt\\n' > "$output" ;;
      *) cp "$HOME/served/\${url#"${bundleBase}"}" "$output" ;;
    esac
    ;;
  *)
    case "$DOWNLOAD_MODE" in
      fail) exit 22 ;;
      corrupt) printf 'corrupt\\n' > "$output" ;;
      *) cp "$HOME/payload" "$output" ;;
    esac
    ;;
esac
`,
		{ mode: 0o755 },
	);
	// A strict policy stand-in, not a cryptographic verifier. The real checksums
	// and extracted documentation run unchanged except for the fixture digests.
	// It refuses an attestation lookup: each documented release verifies the
	// committed bundle the block fetched, under its signer's exact identity.
	const subjects = provenanceReleases
		.map(
			(release) =>
				`  "$HOME/${release.binary}") tag=${release.tag} repo=${release.signer} sha=${release.sha} digest=${release.fixtureDigest} ;;`,
		)
		.join("\n");
	writeFileSync(
		join(tools, "gh"),
		`#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$HOME/attestations"
[ "$#" -gt 2 ] && [ "$1 $2" = 'attestation verify' ] || exit 93
[ "$DOWNLOAD_MODE" != attestation-fail ] || exit 1
subject="$3"
case "$subject" in
${subjects}
  *) exit 94 ;;
esac
expected=(attestation verify "$subject" --repo "$repo"
  --source-digest "$sha" --source-ref "refs/tags/$tag"
  --cert-identity "https://github.com/$repo/.github/workflows/router-release-artifacts.yml@refs/tags/$tag"
  --signer-digest "$sha" --deny-self-hosted-runners --bundle)
[ "$#" -eq "$(( \${#expected[@]} + 1 ))" ] || exit 92
for arg in "\${expected[@]}"; do [ "$1" = "$arg" ] || exit 92; shift; done
case "$1" in "$TMPDIR"/router-provenance.*/"$tag.jsonl") ;; *) exit 95 ;; esac
cmp "$HOME/served/$tag.jsonl" "$1"
printf '%s  %s\\n' "$digest" "$subject" | sha256sum --check --strict -
`,
		{ mode: 0o755 },
	);
	const binDir = join(home, ".local/bin");
	const historicalBinary = join(
		home,
		".local/lib/wstack-router/3.6.2/wstack-router",
	);
	const previousBinary = join(home, ".local/lib/hov-router/6.1.0/hov-router");
	return {
		home,
		binary: join(home, ".local/lib/hov-router/6.2.0/hov-router"),
		versionDir: join(home, ".local/lib/hov-router/6.2.0"),
		historicalBinary,
		previousBinary,
		binDir,
		// Plant the layout that earlier versions of this guide produced for 3.6.2.
		installHistorical(aliases: readonly string[] = earlierGuideAliases) {
			mkdirSync(dirname(historicalBinary), { recursive: true });
			writeFileSync(historicalBinary, historicalPayload, { mode: 0o755 });
			mkdirSync(binDir, { recursive: true });
			for (const name of aliases)
				symlinkSync(historicalBinary, join(binDir, name));
		},
		// Plant the layout that the 6.1.0 version of this guide produced.
		installPrevious(aliases: readonly string[] = COMMAND_NAMES) {
			mkdirSync(dirname(previousBinary), { recursive: true });
			writeFileSync(previousBinary, previousPayload, { mode: 0o755 });
			mkdirSync(binDir, { recursive: true });
			for (const name of aliases)
				symlinkSync(previousBinary, join(binDir, name));
		},
		// Plant a release's binary at its documented path, without aliases.
		install(release: (typeof provenanceReleases)[number]) {
			const path = join(home, release.binary);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, release.payload, { mode: 0o755 });
			return path;
		},
		run(
			marker: string,
			rewrite = (script: string) => script,
			then: string | false = false,
		) {
			let script = block(marker);
			for (const release of provenanceReleases)
				script = script.replaceAll(release.digest, release.fixtureDigest);
			script = rewrite(script);
			return spawnSync(
				"/bin/bash",
				[
					"--noprofile",
					"--norc",
					"-eu",
					"-c",
					script + (then ? `\n${then}` : ""),
				],
				{
					cwd: home,
					env: {
						HOME: home,
						TMPDIR: home,
						PATH: `${tools}:/usr/bin:/bin`,
						DOWNLOAD_MODE: mode,
					},
					encoding: "utf8",
					timeout: 10000,
				},
			);
		},
	};
}

describe("documented binary install (synthetic downloads)", () => {
	it("offers the full pinned provenance policy before the first run", () => {
		const link =
			"hov-router-releases.md#optional-consumer-provenance-verification";
		expect(reference.indexOf(link)).toBeGreaterThan(0);
		expect(reference.indexOf(link)).toBeLessThan(
			reference.indexOf("<!-- router-release-run -->"),
		);
		const policy = block("router-release-provenance");
		// This checks documented policy, not live GitHub signatures or authenticity.
		for (const pin of [
			'binary="$HOME/.local/lib/hov-router/6.2.0/hov-router"',
			`source_sha=${sourceSha}`,
			`digest=${releaseDigest}`,
			`${bundleBase}v6.2.0.jsonl`,
			'gh attestation verify "$binary"',
			"--repo StartupBros/hov-router",
			'--source-digest "$source_sha"',
			"--source-ref refs/tags/v6.2.0",
			"--cert-identity https://github.com/StartupBros/hov-router/.github/workflows/router-release-artifacts.yml@refs/tags/v6.2.0",
			'--signer-digest "$source_sha"',
			"--deny-self-hosted-runners",
			'--bundle "$bundle"',
		])
			expect(policy).toContain(pin);
		// The current release must not borrow the historical signing identity.
		expect(policy).not.toContain("wstack-router");
		// The former names are recorded in the migration guide's move history.
		const history = migrationGuide.replace(/\s+/g, " ");
		expect(history).toContain(
			"renamed from `StartupBros/wstack-router` on 2026-10-21",
		);
		expect(history).toContain(
			"moved to the `StartupBros-com` organization on 2026-11-20",
		);
		for (const document of [reference, releaseGuide, migrationGuide]) {
			expect(document).toContain(`\`${currentHome}\``);
			expect(document).toContain("1278801682");
			expect(document).not.toContain("Before the repository rename");
			// The organization move happened; no guide may still call it pending.
			for (const pending of [
				"is moving",
				"Until the move",
				"tracked in [#911]",
			])
				expect(document).not.toContain(pending);
		}
		for (const document of [reference, releaseGuide])
			expect(document).toContain("hov-router-migration.md#repository-move");
	});

	it("downloads one pinned binary, verifies it, and waits for a separate run step", () => {
		const commands = block("router-release-install");
		expect(commands).not.toMatch(/\b(gh|node|bun)\b/);
		expect(commands.trim().split("\n").length).toBeLessThanOrEqual(15);
		expect(commands).toContain(releaseDigest);
		expect(commands).toContain(releaseUrl);
		const f = fixture();
		const result = f.run("router-release-install");
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("hov-router: OK");
		expect(readFileSync(f.binary, "utf8")).toBe(payload);
		expect(statSync(f.binary).mode & 0o100).toBe(0o100);
		expect(
			readFileSync(join(f.home, "downloads"), "utf8").trim().split("\n"),
		).toHaveLength(1);
		expect(readFileSync(join(f.home, "downloads"), "utf8")).toContain(
			releaseUrl,
		);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
		expect(existsSync(f.binDir)).toBe(false);
		expect(f.run("router-release-run").status).toBe(0);
		expect(readFileSync(join(f.home, "executed"), "utf8")).toBe("executed\n");
	});

	it("rejects corrupt bytes before granting executable permissions", () => {
		const f = fixture("corrupt");
		const result = f.run("router-release-install");
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("hov-router: FAILED");
		expect(statSync(f.binary).mode & 0o111).toBe(0);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
	});

	it("stops when the download fails", () => {
		const f = fixture("fail");
		const result = f.run("router-release-install");
		expect(result.status).toBe(22);
		expect(result.stdout).not.toContain("OK");
		expect(existsSync(f.binary)).toBe(false);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
	});

	it.each([
		"directory",
		"symlink",
		"broken symlink",
		"file",
	])("preserves an existing version path (%s) without downloading", (kind) => {
		const f = fixture();
		mkdirSync(join(f.home, ".local/lib/hov-router"), { recursive: true });
		const target = join(f.home, "previous-install");
		mkdirSync(target);
		writeFileSync(join(target, "sentinel"), "keep");
		if (kind === "directory") {
			mkdirSync(f.versionDir);
			writeFileSync(join(f.versionDir, "sentinel"), "keep");
		} else if (kind === "file") {
			writeFileSync(f.versionDir, "keep");
		} else {
			symlinkSync(
				kind === "symlink" ? target : `${target}-missing`,
				f.versionDir,
			);
		}
		const before = lstatSync(f.versionDir);
		expect(f.run("router-release-install").status).not.toBe(0);
		expect(lstatSync(f.versionDir).ino).toBe(before.ino);
		if (kind === "directory")
			expect(readFileSync(join(f.versionDir, "sentinel"), "utf8")).toBe("keep");
		else if (kind === "file")
			expect(readFileSync(f.versionDir, "utf8")).toBe("keep");
		else
			expect(readlinkSync(f.versionDir)).toBe(
				kind === "symlink" ? target : `${target}-missing`,
			);
		expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("keep");
		expect(existsSync(join(target, "hov-router"))).toBe(false);
		expect(existsSync(join(f.home, "downloads"))).toBe(false);
	});

	it("leaves an earlier 3.6.2 install untouched", () => {
		const f = fixture();
		f.installHistorical();
		expect(f.run("router-release-install").status).toBe(0);
		expect(readFileSync(f.historicalBinary, "utf8")).toBe(historicalPayload);
		for (const name of earlierGuideAliases)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.historicalBinary);
	});

	it("creates both optional command aliases to the same verified binary without running it", () => {
		const f = fixture();
		expect(f.run("router-release-install").status).toBe(0);
		expect(f.run("router-release-path").status).toBe(0);
		for (const name of COMMAND_NAMES) {
			expect(readlinkSync(join(f.binDir, name))).toBe(f.binary);
			expect(readFileSync(join(f.binDir, name), "utf8")).toBe(payload);
		}
		expect(readdirSync(f.binDir).sort()).toEqual([...COMMAND_NAMES].sort());
		expect(() => lstatSync(join(f.binDir, "wstack-router"))).toThrow();
		for (const profile of [".profile", ".bashrc", ".zshrc"])
			expect(readFileSync(join(f.home, profile), "utf8")).toBe(
				"keep profile\n",
			);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
	});

	it("leaves an existing wstack-router entry alone, since new installs no longer create it", () => {
		const f = fixture();
		expect(f.run("router-release-install").status).toBe(0);
		mkdirSync(f.binDir, { recursive: true });
		const earlier = join(f.binDir, "wstack-router");
		writeFileSync(earlier, "keep");
		const result = f.run("router-release-path");
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(earlier, "utf8")).toBe("keep");
		for (const name of COMMAND_NAMES)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.binary);
	});

	it("reports the release display and source SHA through both installed aliases (fixture)", () => {
		expect(reference).toContain("HoV Router v6.2.0");
		const f = fixture();
		expect(f.run("router-release-install").status).toBe(0);
		expect(f.run("router-release-path").status).toBe(0);
		for (const name of COMMAND_NAMES) {
			for (const [flag, output] of [
				["--version", "HoV Router v6.2.0\n"],
				["--git-sha", `${sourceSha}\n`],
			]) {
				const result = spawnSync(join(f.binDir, name), [flag], {
					cwd: f.home,
					env: { HOME: f.home, PATH: "/usr/bin:/bin" },
					encoding: "utf8",
					timeout: 10000,
				});
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toBe(output);
			}
		}
	});

	for (const name of COMMAND_NAMES) {
		it.each([
			"file",
			"symlink",
			"broken symlink",
			"directory",
		])(`refuses an existing ${name} (%s) before creating any missing alias`, (kind) => {
			const f = fixture();
			expect(f.run("router-release-install").status).toBe(0);
			mkdirSync(f.binDir, { recursive: true });
			const collision = join(f.binDir, name);
			if (kind === "file") writeFileSync(collision, "keep");
			else if (kind === "symlink") symlinkSync(f.binary, collision);
			else if (kind === "broken symlink")
				symlinkSync("missing-command", collision);
			else {
				mkdirSync(collision);
				writeFileSync(join(collision, "sentinel"), "keep");
			}
			const before = lstatSync(collision);
			const result = f.run("router-release-path");
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("Refusing existing command:");
			expect(lstatSync(collision).ino).toBe(before.ino);
			if (kind === "file") expect(readFileSync(collision, "utf8")).toBe("keep");
			else if (kind === "symlink")
				expect(readlinkSync(collision)).toBe(f.binary);
			else if (kind === "broken symlink")
				expect(readlinkSync(collision)).toBe("missing-command");
			else {
				expect(readFileSync(join(collision, "sentinel"), "utf8")).toBe("keep");
				expect(readdirSync(collision)).toEqual(["sentinel"]);
			}
			for (const other of COMMAND_NAMES.filter((alias) => alias !== name))
				expect(() => lstatSync(join(f.binDir, other))).toThrow();
			expect(readFileSync(f.binary, "utf8")).toBe(payload);
		});
	}
});

describe("documented upgrade of an earlier binary install (synthetic)", () => {
	const currentBinaryLine =
		'binary="$HOME/.local/lib/hov-router/6.2.0/hov-router"';
	const toHistorical = (script: string) =>
		script.replace(
			currentBinaryLine,
			'binary="$HOME/.local/lib/wstack-router/3.6.2/wstack-router"',
		);
	const previousBinaryPath = "$HOME/.local/lib/hov-router/6.1.0/hov-router";
	const toPrevious = (script: string) =>
		script.replace(currentBinaryLine, `binary="${previousBinaryPath}"`);

	it("only links, renames, and checks; it never deletes or forces", () => {
		const commands = block("router-release-upgrade");
		expect(commands).toContain(currentBinaryLine);
		expect(commands).not.toMatch(/\b(rm|gh|node|bun|sudo)\b/);
		expect(commands).not.toMatch(/\b(ln|mv) -[A-Za-z]*f/);
		expect(toHistorical(commands)).not.toBe(commands);
	});

	it("repoints 3.6.2 aliases to the verified release, keeps 3.6.2, and rolls back", () => {
		const f = fixture();
		f.installHistorical();
		expect(f.run("router-release-install").status).toBe(0);
		const upgraded = f.run("router-release-upgrade");
		expect(upgraded.status, upgraded.stderr).toBe(0);
		expect(upgraded.stderr).toBe("");
		for (const name of earlierGuideAliases)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.binary);
		expect(readdirSync(f.binDir).sort()).toEqual(
			[...earlierGuideAliases].sort(),
		);
		expect(readFileSync(f.historicalBinary, "utf8")).toBe(historicalPayload);
		for (const profile of [".profile", ".bashrc", ".zshrc"])
			expect(readFileSync(join(f.home, profile), "utf8")).toBe(
				"keep profile\n",
			);
		expect(existsSync(join(f.home, "executed"))).toBe(false);

		const rolledBack = f.run("router-release-upgrade", toHistorical);
		expect(rolledBack.status, rolledBack.stderr).toBe(0);
		for (const name of earlierGuideAliases)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.historicalBinary);

		expect(f.run("router-release-upgrade").status).toBe(0);
		for (const name of earlierGuideAliases)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.binary);
		expect(readdirSync(f.binDir).sort()).toEqual(
			[...earlierGuideAliases].sort(),
		);
	});

	it("repoints 6.1.0 aliases to the verified release, keeps 6.1.0, and rolls back", () => {
		const f = fixture();
		f.installPrevious();
		expect(f.run("router-release-install").status).toBe(0);
		const upgraded = f.run("router-release-upgrade");
		expect(upgraded.status, upgraded.stderr).toBe(0);
		expect(upgraded.stderr).toBe("");
		for (const name of COMMAND_NAMES)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.binary);
		expect(readdirSync(f.binDir).sort()).toEqual([...COMMAND_NAMES].sort());
		expect(() => lstatSync(join(f.binDir, "wstack-router"))).toThrow();
		expect(readFileSync(f.previousBinary, "utf8")).toBe(previousPayload);
		expect(existsSync(join(f.home, "executed"))).toBe(false);

		const rolledBack = f.run("router-release-upgrade", toPrevious);
		expect(rolledBack.status, rolledBack.stderr).toBe(0);
		for (const name of COMMAND_NAMES)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.previousBinary);
		// The guide's rollback example names the path this rollback used, not
		// that of a release before it.
		expect(reference).toContain(`such as \`${previousBinaryPath}\` or`);
	});

	it("creates missing aliases while repointing the rest, but never creates wstack-router", () => {
		const f = fixture();
		f.installHistorical([COMMAND_NAMES[0]]);
		expect(f.run("router-release-install").status).toBe(0);
		const upgraded = f.run("router-release-upgrade");
		expect(upgraded.status, upgraded.stderr).toBe(0);
		for (const name of COMMAND_NAMES)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.binary);
		expect(readdirSync(f.binDir).sort()).toEqual([...COMMAND_NAMES].sort());
		expect(() => lstatSync(join(f.binDir, "wstack-router"))).toThrow();
	});

	it("refuses before the new release is installed", () => {
		const f = fixture();
		f.installHistorical();
		expect(f.run("router-release-upgrade").status).not.toBe(0);
		for (const name of earlierGuideAliases)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.historicalBinary);
	});

	it("refuses a leftover temporary link before changing any alias", () => {
		const f = fixture();
		f.installHistorical();
		expect(f.run("router-release-install").status).toBe(0);
		const last = COMMAND_NAMES[COMMAND_NAMES.length - 1];
		const leftover = join(f.binDir, `.${last}.new`);
		writeFileSync(leftover, "keep");
		const result = f.run("router-release-upgrade");
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Refusing leftover file:");
		expect(readFileSync(leftover, "utf8")).toBe("keep");
		for (const name of earlierGuideAliases)
			expect(readlinkSync(join(f.binDir, name))).toBe(f.historicalBinary);
	});

	for (const name of earlierGuideAliases) {
		it.each([
			"file",
			"directory",
			"symlink elsewhere",
			"broken symlink",
		])(`refuses a foreign ${name} (%s) before changing any alias`, (kind) => {
			const f = fixture();
			f.installHistorical(
				earlierGuideAliases.filter((alias) => alias !== name),
			);
			expect(f.run("router-release-install").status).toBe(0);
			const collision = join(f.binDir, name);
			// Ends in the command name but sits outside this guide's install roots.
			const elsewhere = join(f.home, ".local/lib/other/3.7.1/hov-router");
			if (kind === "file") writeFileSync(collision, "keep");
			else if (kind === "directory") {
				mkdirSync(collision);
				writeFileSync(join(collision, "sentinel"), "keep");
			} else if (kind === "symlink elsewhere")
				symlinkSync(elsewhere, collision);
			else symlinkSync("missing-command", collision);
			const before = lstatSync(collision);
			const result = f.run("router-release-upgrade");
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("Refusing ");
			expect(lstatSync(collision).ino).toBe(before.ino);
			if (kind === "file") expect(readFileSync(collision, "utf8")).toBe("keep");
			else if (kind === "directory")
				expect(readdirSync(collision)).toEqual(["sentinel"]);
			else
				expect(readlinkSync(collision)).toBe(
					kind === "symlink elsewhere" ? elsewhere : "missing-command",
				);
			for (const other of earlierGuideAliases.filter((alias) => alias !== name))
				expect(readlinkSync(join(f.binDir, other))).toBe(f.historicalBinary);
			expect(
				readdirSync(f.binDir).filter((entry) => entry.endsWith(".new")),
			).toEqual([]);
		});
	}
});

describe("documented provenance for releases signed before the move (synthetic policy fixture, not cryptographic proof)", () => {
	it("verifies the installed 6.2.0 binary from its committed bundle before the separate run step", () => {
		const f = fixture();
		expect(f.run("router-release-install").status).toBe(0);
		const verified = f.run("router-release-provenance");
		expect(verified.status, verified.stderr).toBe(0);
		const calls = readFileSync(join(f.home, "attestations"), "utf8")
			.trim()
			.split("\n");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toStartWith(
			[
				`attestation verify ${f.binary}`,
				"--repo StartupBros/hov-router",
				`--source-digest ${sourceSha}`,
				"--source-ref refs/tags/v6.2.0",
				"--cert-identity https://github.com/StartupBros/hov-router/.github/workflows/router-release-artifacts.yml@refs/tags/v6.2.0",
				`--signer-digest ${sourceSha}`,
				"--deny-self-hosted-runners",
				`--bundle ${f.home}/router-provenance.`,
			].join(" "),
		);
		expect(calls[0]).toEndWith("/v6.2.0.jsonl");
		const downloads = readFileSync(join(f.home, "downloads"), "utf8")
			.trim()
			.split("\n");
		expect(downloads).toHaveLength(2);
		expect(downloads[0]).toContain(releaseUrl);
		expect(downloads[1]).toContain(`${bundleBase}v6.2.0.jsonl`);
		expect(existsSync(join(f.home, "executed"))).toBe(false);
		expect(f.run("router-release-run").status).toBe(0);
		expect(readFileSync(join(f.home, "executed"), "utf8")).toBe("executed\n");
	});

	it("keeps a committed bundle for every documented release, one bundle per file", () => {
		// Bundles are never deleted (older guide copies fetch them from main), so a
		// committed file may outlive its block; each still holds one named bundle.
		const files = readdirSync(join(root, "docs/provenance"));
		for (const release of provenanceReleases)
			expect(files).toContain(`${release.tag}.jsonl`);
		for (const file of files) {
			expect(file).toMatch(/^v\d+\.\d+\.\d+\.jsonl$/);
			const lines = readFileSync(
				join(root, "docs/provenance", file),
				"utf8",
			).split("\n");
			expect(lines, file).toHaveLength(2);
			expect(lines[1], file).toBe("");
			expect(JSON.parse(lines[0]).mediaType, file).toBe(
				"application/vnd.dev.sigstore.bundle.v0.3+json",
			);
		}
	});

	it("pins the release and asset evidence", () => {
		for (const pin of [
			"452492607",
			sourceSha,
			"refs/tags/v6.2.0",
			"771222999",
			"95958496",
			releaseDigest,
			"771223746",
			"9a5837384e7ee616c45f80b6ee518b114b74932522cb7f5a0924778fb41641b4",
			"771222540",
			"5c904ac9fda6d787ce1448fb158e26b35e2802c0530edd5b9e01e674a26e80fb",
		])
			expect(releaseGuide).toContain(pin);
	});

	it("keeps the 3.7.1 evidence for installs that stay on PostgreSQL", () => {
		for (const pin of [
			"423574844",
			"6b88f789e30c3a86ee918d35a6673e7be12f9243",
			"refs/tags/v3.7.1",
			"f6e6ee137d0766eb6df9d6c76d264603e9696c12797e1570b8ad6b9648d0b12c",
		])
			expect(releaseGuide).toContain(pin);
		expect(migrationGuide).toContain(
			"hov-router-releases.md#verify-release-371",
		);
	});

	it("pins historical release and asset evidence independently of the new display name", () => {
		for (const pin of [
			"418096444",
			historicalSha,
			"refs/tags/v3.6.2",
			"658578101",
			"97965536",
			historicalDigest,
			"658578455",
			"a90aa5f71ba5ae9f4b255e487c2afc80f39d44bc70a6193da43d83f4b05dc60b",
			"658577847",
			"dee851d757ec92a28946c838a11919d34bf2fc4755613e67b34bd1e3cdf70b29",
		])
			expect(releaseGuide).toContain(pin);
		expect(releaseGuide).toContain("wstack Router v3.6.2");
		expect(releaseGuide).toContain("v1:startupbros-wstack-router-binary");
	});

	for (const release of provenanceReleases) {
		describe(release.tag, () => {
			const policy = () => block(release.marker);
			const binaryCheck = String.raw`printf '%s  %s\n' "$digest" "$binary" | sha256sum --check --strict -`;
			const fetch = `curl -q --fail --location --proto '=https' --proto-redir '=https'`;
			const bundleCheck = String.raw`printf '%s  %s\n' "$bundle_sha" "$bundle" | sha256sum --check --strict -`;
			const verify = 'gh attestation verify "$binary"';

			it("pins the signer's exact policy and checks each input before using it", () => {
				const text = policy();
				for (const pin of [
					`binary="$HOME/${release.binary}"`,
					`source_sha=${release.sha}`,
					`digest=${release.digest}`,
					binaryCheck,
					fetch,
					release.bundleUrl,
					bundleCheck,
					verify,
					`--repo ${release.signer}`,
					'--source-digest "$source_sha"',
					`--source-ref refs/tags/${release.tag}`,
					`--cert-identity https://github.com/${release.signer}/.github/workflows/router-release-artifacts.yml@refs/tags/${release.tag}`,
					'--signer-digest "$source_sha"',
					"--deny-self-hosted-runners",
					'--bundle "$bundle"',
				])
					expect(text).toContain(pin);
				// The binary's checksum first, then the bundle and its checksum, then gh.
				const order = [binaryCheck, release.bundleUrl, bundleCheck, verify].map(
					(pin) => text.indexOf(pin),
				);
				expect(order).toEqual([...order].sort((a, b) => a - b));
				// No lookup by repository or owner, and no certificate of the new home.
				expect(text).not.toContain("attestation download");
				expect(text).not.toContain(`github.com/${currentHome}/.github`);
			});

			it("commits the bundle its block pins, signed for the release's binary and manifest", () => {
				const bytes = readFileSync(
					join(root, "docs/provenance", `${release.tag}.jsonl`),
				);
				expect(policy()).toContain(`bundle_sha=${sha256(bytes)}`);
				const lines = bytes.toString("utf8").split("\n");
				expect(lines).toHaveLength(2);
				expect(lines[1]).toBe("");
				const bundle = JSON.parse(lines[0]);
				expect(bundle.mediaType).toBe(
					"application/vnd.dev.sigstore.bundle.v0.3+json",
				);
				const statement = JSON.parse(
					Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"),
				);
				expect(statement.predicateType).toBe("https://slsa.dev/provenance/v1");
				expect(statement.subject).toEqual([
					{
						name: "better-ccflare-linux-amd64",
						digest: { sha256: release.digest },
					},
					{
						name: "release-manifest.json",
						digest: { sha256: release.manifestDigest },
					},
				]);
				expect(
					statement.predicate.buildDefinition.externalParameters.workflow,
				).toEqual({
					ref: `refs/tags/${release.tag}`,
					repository: `https://github.com/${release.signer}`,
					path: ".github/workflows/router-release-artifacts.yml",
				});
				expect(releaseGuide).toContain(release.manifestDigest);
			});

			it("verifies the committed bundle under the signer's identity before execution", () => {
				const f = fixture();
				const binary = f.install(release);
				const verified = f.run(release.marker, undefined, release.runLine);
				expect(verified.status, verified.stderr).toBe(0);
				const calls = readFileSync(join(f.home, "attestations"), "utf8")
					.trim()
					.split("\n");
				expect(calls).toHaveLength(1);
				expect(calls[0]).toStartWith(
					`attestation verify ${binary} --repo ${release.signer} `,
				);
				expect(calls[0]).toEndWith(`/${release.tag}.jsonl`);
				const downloads = readFileSync(join(f.home, "downloads"), "utf8")
					.trim()
					.split("\n");
				expect(downloads).toHaveLength(1);
				expect(downloads[0]).toContain(release.bundleUrl);
				expect(readFileSync(join(f.home, "executed"), "utf8")).toBe(
					"executed\n",
				);
			});

			it("rejects changed binary bytes before fetching the bundle", () => {
				const f = fixture();
				writeFileSync(f.install(release), "tampered bytes\n");
				expect(
					f.run(release.marker, undefined, release.runLine).status,
				).not.toBe(0);
				expect(existsSync(join(f.home, "downloads"))).toBe(false);
				expect(existsSync(join(f.home, "attestations"))).toBe(false);
				expect(existsSync(join(f.home, "executed"))).toBe(false);
			});

			for (const mode of ["bundle-fail", "bad-bundle"]) {
				it(`stops on ${mode} before attestation or execution`, () => {
					const f = fixture(mode);
					f.install(release);
					expect(
						f.run(release.marker, undefined, release.runLine).status,
					).not.toBe(0);
					expect(existsSync(join(f.home, "attestations"))).toBe(false);
					expect(existsSync(join(f.home, "executed"))).toBe(false);
				});
			}

			it("stops on a failed attestation before execution", () => {
				const f = fixture("attestation-fail");
				f.install(release);
				expect(
					f.run(release.marker, undefined, release.runLine).status,
				).not.toBe(0);
				expect(
					readFileSync(join(f.home, "attestations"), "utf8").trim().split("\n"),
				).toHaveLength(1);
				expect(existsSync(join(f.home, "executed"))).toBe(false);
			});

			const otherSigner =
				release.signer === "StartupBros/hov-router"
					? "StartupBros/wstack-router"
					: "StartupBros/hov-router";
			const otherRelease =
				provenanceReleases[
					(provenanceReleases.indexOf(release) + 1) % provenanceReleases.length
				];
			for (const [label, from, to] of [
				[
					"the current home as verification repository",
					`--repo ${release.signer}`,
					`--repo ${currentHome}`,
				],
				[
					"another former name as verification repository",
					`--repo ${release.signer}`,
					`--repo ${otherSigner}`,
				],
				[
					"owner-only policy",
					`--repo ${release.signer}`,
					"--owner StartupBros",
				],
				[
					"the current home's certificate",
					`--cert-identity https://github.com/${release.signer}/`,
					`--cert-identity https://github.com/${currentHome}/`,
				],
				[
					"short source SHA",
					'--source-digest "$source_sha"',
					`--source-digest ${release.sha.slice(0, 7)}`,
				],
				[
					"wrong signer SHA",
					'--signer-digest "$source_sha"',
					`--signer-digest ${"b".repeat(40)}`,
				],
				[
					"wrong tag",
					`--source-ref refs/tags/${release.tag}`,
					"--source-ref refs/heads/main",
				],
				["self-hosted runner allowance", "--deny-self-hosted-runners", ""],
				["a lookup without the committed bundle", '--bundle "$bundle"', ""],
				[
					"a different local bundle",
					'--bundle "$bundle"',
					'--bundle "$bundle_dir/other.jsonl"',
				],
				["another release's bundle", release.bundleUrl, otherRelease.bundleUrl],
			] as const) {
				it(`rejects ${label} before execution`, () => {
					const f = fixture();
					f.install(release);
					expect(policy()).toContain(from);
					const result = f.run(
						release.marker,
						(script) => script.replace(from, to),
						release.runLine,
					);
					expect(result.status).not.toBe(0);
					expect(existsSync(join(f.home, "executed"))).toBe(false);
				});
			}
		});
	}
});
