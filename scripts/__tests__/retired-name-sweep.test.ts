import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// Release 8.0.0 (#1056) renamed every name inherited from better-ccflare, and
// startup refuses the old ones. This sweep keeps the tracked tree from growing
// them back, for example through a cherry-picked upstream fix: code may name
// ccflare only to point at upstream, and current docs may not tell anyone to
// set an old variable, header, path or unit. AGENTS.md ("Names") lists what
// keeps the old name on purpose; each exemption here is one of those.

const repoRoot = join(import.meta.dir, "../..");

/** Upstream's own names, which every file may cite. */
const UPSTREAM_IDENTITY =
	/tombii\/better-ccflare|tombii%2Fbetter-ccflare|snipeship\/ccflare|zenprocess\/better-ccflare|ccflare#\d+/i;

/** Dated pages that record what was true when they were written. */
const HISTORY_PREFIXES = [
	"docs/plans/",
	"docs/ideation/",
	"docs/reports/",
	"docs/superpowers/",
	// Published commit text the release parser is tested against.
	"scripts/__tests__/fixtures/squash-parse/",
];
const HISTORY_FILES = ["CHANGELOG.md", "docs/migration-v2-to-v3.md"];

/** Code and config that must name the old names, by reason. */
const CODE_EXEMPTIONS: Record<string, string> = {
	"packages/config/src/retired-names.ts": "the refusal",
	"packages/config/src/retired-names.test.ts": "the refusal",
	"apps/server/src/retired-names-server.test.ts": "the refusal",
	"apps/cli/__tests__/cli.test.ts": "the refusal",
	"scripts/run-hov-router.sh": "the refusal",
	"scripts/__tests__/run-hov-router.test.ts": "the refusal",
	"packages/core/src/product-identity.test.ts": "checks the old command is gone",
	"packages/database/src/__tests__/postgres-url-refusal.test.ts":
		"checks an old ccflare.db is never opened",
	"scripts/deploy-hov-router.sh": "refuses a host still on the 7.x unit",
	"scripts/deploy-hov-router-lib.sh": "refuses a host still on the 7.x unit",
	"scripts/__tests__/deploy-hov-router.test.ts":
		"refuses a host still on the 7.x unit",
	"scripts/hov-router-cutover.sh": "the one-time host move",
	"scripts/__tests__/hov-router-cutover.test.ts": "the one-time host move",
	"scripts/__tests__/migration-recipes.test.ts": "the documented one-time storage move",
	"apps/cli/build-provenance.ts": "published releases and their provenance",
	"apps/cli/router-artifacts.ts": "published releases and their provenance",
	"apps/cli/__tests__/build-multi-arch.test.ts":
		"published releases and their provenance",
	"apps/cli/__tests__/prepare-router-release.test.ts":
		"published releases and their provenance",
	"apps/cli/__tests__/binary-install.test.ts":
		"published releases and their provenance",
	"packages/core/src/router-repository.test.ts":
		"published releases and their provenance",
	"packages/providers/src/server-tools/replay-envelope.ts":
		"key-derivation label for data already sealed",
	"packages/providers/src/server-tools/replay-envelope.test.ts":
		"key-derivation label for data already sealed",
	"packages/proxy/src/server-tool-replay-runtime.test.ts":
		"counter identity for data already sealed",
	"packages/database/src/repositories/__tests__/server-tool-replay-issuance.repository.test.ts":
		"key-derivation label for data already sealed",
	"packages/proxy/src/handlers/pending-rotation-slots.ts":
		"key-derivation label for data already sealed",
	"packages/http-api/src/handlers/version.ts":
		"upgrade commands shown to upstream builds",
	"packages/http-api/src/handlers/version.test.ts":
		"upgrade commands shown to upstream builds",
	"packages/dashboard-web/src/components/navigation.test.tsx":
		"upgrade commands shown to upstream builds",
	"scripts/__tests__/retired-name-sweep.test.ts": "this sweep",
};

/** Current docs that name old variables, headers, paths or units, by reason. */
const DOC_EXEMPTIONS: Record<string, string> = {
	"AGENTS.md": "lists what keeps the old name",
	"docs/hov-router-migration.md": "how to move an install",
	"docs/docker.md": "how to move a Docker install",
	"docs/acknowledgements.md": "credits contributions by their original names",
	// Remove in the docs repin after 8.0.0 publishes (#1056), with the 7.0.0 install notes.
	"docs/reference.md": "7.0.0 install notes",
};

/** An old variable, header, storage path or unit a reader could act on. */
const RETIRED_FORM =
	/\b(?:BETTER_)?CCFLARE_[A-Z]|x-better-ccflare-|\.config\/better-ccflare|\/etc\/better-ccflare|\.better-ccflare\b|better-ccflare\.(?:db|json)|ccflare-stack/;

interface Hit {
	readonly path: string;
	readonly line: number;
	readonly text: string;
}

function trackedHits(): Hit[] {
	const result = Bun.spawnSync(
		["git", "grep", "-n", "-I", "-i", "-z", "--full-name", "-F", "ccflare"],
		{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
	);
	// git grep exits 1 when nothing matches, and higher on an error.
	if (result.exitCode !== 0 && result.exitCode !== 1) {
		throw new Error(`git grep failed: ${result.stderr.toString()}`);
	}
	return result.stdout
		.toString()
		.split("\n")
		.filter(Boolean)
		.map((record) => {
			const [path = "", line = "0", ...text] = record.split("\0");
			return { path, line: Number(line), text: text.join("\0") };
		});
}

function isHistory(path: string): boolean {
	return (
		HISTORY_FILES.includes(path) ||
		HISTORY_PREFIXES.some((prefix) => path.startsWith(prefix))
	);
}

function isDoc(path: string): boolean {
	return /\.(?:md|html)$/.test(path) || path.startsWith("docs/");
}

const format = (hit: Hit) => `${hit.path}:${hit.line}: ${hit.text.trim()}`;

describe("retired better-ccflare names", () => {
	const hits = trackedHits();

	test("the sweep reads the tree", () => {
		// The refusal names the old names, so an empty result means git grep found nothing to read.
		expect(hits.some((hit) => hit.path === "packages/config/src/retired-names.ts")).toBe(true);
	});

	test("code and config name ccflare only to point at upstream", () => {
		const leftovers = hits.filter(
			(hit) =>
				!isDoc(hit.path) &&
				!isHistory(hit.path) &&
				!Object.hasOwn(CODE_EXEMPTIONS, hit.path) &&
				!UPSTREAM_IDENTITY.test(hit.text),
		);
		expect(leftovers.map(format)).toEqual([]);
	});

	test("current docs do not tell anyone to use an old variable, header, path or unit", () => {
		const leftovers = hits.filter(
			(hit) =>
				isDoc(hit.path) &&
				!isHistory(hit.path) &&
				!Object.hasOwn(DOC_EXEMPTIONS, hit.path) &&
				RETIRED_FORM.test(hit.text),
		);
		expect(leftovers.map(format)).toEqual([]);
	});

	test("every exemption still names a file that needs one", () => {
		const needing = new Set(hits.map((hit) => hit.path));
		const stale = [...Object.keys(CODE_EXEMPTIONS), ...Object.keys(DOC_EXEMPTIONS)].filter(
			(path) => !needing.has(path),
		);
		expect(stale).toEqual([]);
	});
});
