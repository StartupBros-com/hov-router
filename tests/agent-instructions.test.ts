import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const agentEntrypoints = ["AGENTS.md", "CLAUDE.md"] as const;
const incrementalVacuumWorker =
	"packages/database/src/inline-incremental-vacuum-worker.ts";

function readRepositoryFile(path: string): string {
	return readFileSync(join(repositoryRoot, path), "utf8");
}

function activeGitignoreEntries(): string[] {
	return readRepositoryFile(".gitignore")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

function isIgnoredByGit(path: string): boolean {
	const result = Bun.spawnSync(
		["git", "check-ignore", "--no-index", "--quiet", "--", path],
		{
			cwd: repositoryRoot,
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	if (result.exitCode === 0) return true;
	if (result.exitCode === 1) return false;

	throw new Error(
		`git check-ignore failed for ${path} (${result.exitCode}): ${result.stderr.toString().trim()}`,
	);
}

describe("repository agent instructions", () => {
	test("Claude imports the canonical agent instructions", () => {
		expect(readRepositoryFile("CLAUDE.md")).toBe("@AGENTS.md\n");
	});

	test("the active ignore entries do not list either agent entrypoint", () => {
		const ignoredEntrypoints = activeGitignoreEntries().filter((entry) =>
			agentEntrypoints.includes(entry as (typeof agentEntrypoints)[number]),
		);

		expect(ignoredEntrypoints).toEqual([]);
	});

	test("Git does not ignore either agent entrypoint", () => {
		const ignoredEntrypoints = agentEntrypoints.filter(isIgnoredByGit);

		expect(ignoredEntrypoints).toEqual([]);
	});

	test("the canonical instructions document every generated inline worker", () => {
		const generatedInlineWorkers = activeGitignoreEntries().filter(
			(entry) =>
				!entry.startsWith("!") &&
				/(^|\/)inline-[^/]*worker\.ts$/.test(entry),
		);

		expect(generatedInlineWorkers.length).toBeGreaterThan(0);
		expect(generatedInlineWorkers).toContain(incrementalVacuumWorker);

		const instructions = readRepositoryFile("AGENTS.md");
		for (const workerPath of generatedInlineWorkers) {
			expect(instructions).toContain(`\`${workerPath}\``);
		}
	});

	test("native CLI print mode preserves the subscription-account boundary", () => {
		// The native-client boundary applies beyond testing; headless Claude Code
		// is supported without allowing arbitrary clients or paid overage.
		const instructions = readRepositoryFile("AGENTS.md");

		expect(instructions).toContain("`claude` account");
		expect(instructions).toContain(
			"Never send an Anthropic-backed account a request that does not come from Claude Code",
		);
		expect(instructions).toMatch(/no curl, test harness, SDK script/);
		expect(instructions).not.toMatch(/CRITICAL: Testing Restrictions/);
		expect(instructions).not.toContain("must only be used through a real interactive");
		expect(instructions).toContain("headless `claude -p`");
		expect(instructions).toContain("Nothing here authorizes paid overage");
		expect(instructions).toContain("`x-hov-router-account-id`");
		// A 7.x server ignores the new header, so the rule must say to check first.
		expect(instructions).toContain("`/health` `version` is 8.0.0 or later");
	});

	test("the canonical instructions omit stale repository guidance", () => {
		const instructions = readRepositoryFile("AGENTS.md").toLowerCase();
		const staleGuidance = [
			"Codex-oauth",
			"port 8082",
			"auto-updated by pre-push hook",
			"/home/tom/git_repos/qwen-code",
		];

		for (const staleText of staleGuidance) {
			expect(instructions).not.toContain(staleText.toLowerCase());
		}
	});
});
