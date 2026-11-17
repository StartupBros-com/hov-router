import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

// A date format that cuts a fraction of a second to a width: %3N, %-3N, %_6N.
const widthCutFraction = /%[-_0^#]?\d+N/;

describe("date formats in shell scripts and workflows", () => {
	// uutils date 0.10, the date of Ubuntu 26.04 and so of CI, drops a
	// fraction's leading zeros before cutting it to a width
	// (uutils/coreutils#15697). `date +%s%3N` then reads up to ~900 ms high in
	// the first tenth of each second, and the runner's stop budgets and
	// restart windows ended early on CI that way (#880). GNU date pads first,
	// so running the code on a GNU host never shows it; this keeps the count
	// at zero instead. Bare %N is safe on both. Retire this once Ubuntu's date
	// pads the fraction before cutting it.
	test("never cut a fraction of a second to a width", () => {
		const listed = spawnSync("git", ["ls-files", "-z"], {
			cwd: repoRoot,
			encoding: "utf8",
		});
		expect(listed.status, listed.stderr).toBe(0);
		const offenders: string[] = [];
		let scanned = 0;
		for (const file of listed.stdout.split("\0").filter(Boolean)) {
			const workflow =
				file.startsWith(".github/workflows/") && /\.ya?ml$/.test(file);
			let text: string;
			try {
				text = readFileSync(join(repoRoot, file), "utf8");
			} catch {
				continue;
			}
			const shell =
				file.endsWith(".sh") ||
				/^#!\S*(\/|\s)(env\s+)?(ba)?sh\b/.test(text.slice(0, 120));
			if (!workflow && !shell) continue;
			scanned += 1;
			text.split("\n").forEach((line, index) => {
				if (line.trimStart().startsWith("#")) return;
				if (widthCutFraction.test(line))
					offenders.push(`${file}:${index + 1}: ${line.trim()}`);
			});
		}
		expect(scanned).toBeGreaterThan(10);
		expect(offenders).toEqual([]);
	});
});
