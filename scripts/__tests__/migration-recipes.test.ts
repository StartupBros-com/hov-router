import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const document = readFileSync(join(import.meta.dir, "../../docs/hov-router-migration.md"), "utf8");
const recipes = document.split("```bash\n").slice(1).map(block => block.split("```")[0] ?? "").filter(block => block.includes("mv -T --update=none-fail"));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function snapshot(root: string): Record<string, string> {
	const result: Record<string, string> = {};
	function visit(path: string, relative: string) {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) result[relative] = `link:${readlinkSync(path)}`;
		else if (stat.isDirectory()) {
			result[relative] = "directory";
			for (const name of readdirSync(path)) visit(join(path, name), `${relative}/${name}`);
		} else result[relative] = readFileSync(path).toString("base64");
	}
	visit(root, "");
	return result;
}

for (const direction of [0, 1]) {
	for (const location of ["file", "directory", "workspace"]) {
		for (const dangling of [false, true]) {
			test(`migration recipe ${direction} refuses ${location} collision, symlink=${dangling}, before any move`, () => {
				expect(recipes).toHaveLength(2);
				const home = mkdtempSync(join(tmpdir(), "migration-recipe-"));
				roots.push(home);
				const from = direction === 0 ? "better-ccflare" : "hov-router";
				const to = direction === 0 ? "hov-router" : "better-ccflare";
				const base = join(home, "xdg");
				const source = join(base, from);
				mkdirSync(source, { recursive: true });
				mkdirSync(join(home, `.${from}`));
				for (const suffix of ["db", "db-wal", "db-shm", "json"]) writeFileSync(join(source, `${from}.${suffix}`), `${suffix}:original\n`);
				writeFileSync(join(home, `.${from}`, "workspaces.json"), "[]\n");
				const collision = location === "file" ? join(source, `${to}.json`) : location === "directory" ? join(base, to) : join(home, `.${to}`);
				if (dangling) symlinkSync("missing", collision);
				else writeFileSync(collision, "preserve existing bytes\n");
				const before = snapshot(home);
				const result = Bun.spawnSync(["bash"], {
					cwd: home,
					env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: base, LC_ALL: "C" },
					stdin: Buffer.from(recipes[direction] ?? ""), stdout: "pipe", stderr: "pipe",
				});
				expect(result.exitCode).not.toBe(0);
				// Preflight must fail before invoking mv, including on older GNU mv.
				expect(result.stderr.toString()).toBe("");
				expect(snapshot(home)).toEqual(before);
			});
		}
	}
}
