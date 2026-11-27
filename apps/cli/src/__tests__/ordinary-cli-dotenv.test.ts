import { expect, it } from "bun:test";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

// Host builds the binary separately. When HOV_ROUTER_TEST_COMPILED_CLI names
// it, the same tests run against the compiled entrypoint instead of treating a
// source-only run as proof.
function cliEntrypoint(): string[] {
	const binary = process.env.HOV_ROUTER_TEST_COMPILED_CLI;
	if (binary) {
		if (!isAbsolute(binary))
			throw new Error("Compiled CLI test path must be absolute");
		return [binary];
	}
	return [
		process.execPath,
		"--no-env-file",
		new URL("../main.ts", import.meta.url).pathname,
	];
}

// Characterize ordinary startup with the real binary (or source runtime), not a
// replacement dotenv parser. --list only opens an empty synthetic local database.
for (const scenario of [
	{
		name: "default development",
		nodeEnv: undefined,
		files: [".env", ".env.development", ".env.production"],
		winner: "development",
	},
	{ name: "base", nodeEnv: "production", files: [".env"], winner: "base" },
	{
		name: "production",
		nodeEnv: "production",
		files: [".env", ".env.production"],
		winner: "production",
	},
	{
		name: "local",
		nodeEnv: "production",
		files: [".env", ".env.production", ".env.local"],
		winner: "local",
	},
	{
		name: "development",
		nodeEnv: "development",
		files: [".env", ".env.development"],
		winner: "development",
	},
	{
		name: "test ignores local",
		nodeEnv: "test",
		files: [".env", ".env.test", ".env.local"],
		winner: "test",
	},
	{
		name: "process wins",
		nodeEnv: "production",
		files: [".env", ".env.production", ".env.local"],
		winner: "process",
	},
]) {
	it(`ordinary CLI preserves dotenv precedence and expansion: ${scenario.name}`, async () => {
		const directory = mkdtempSync(join(tmpdir(), "ordinary-cli-dotenv-"));
		try {
			for (const file of scenario.files) {
				const label = file === ".env" ? "base" : file.slice(5);
				writeFileSync(
					join(directory, file),
					`SYNTHETIC_STEM=${label}\nHOV_ROUTER_DB_PATH="$SYNTHETIC_DIRECTORY/\${SYNTHETIC_STEM}.db"\n`,
				);
			}
			const entrypoint = process.env.HOV_ROUTER_TEST_COMPILED_CLI
				? cliEntrypoint()
				: [process.execPath, new URL("../main.ts", import.meta.url).pathname];
			const child = Bun.spawn([...entrypoint, "--list"], {
				cwd: directory,
				env: {
					HOME: directory,
					XDG_CONFIG_HOME: directory,
					TMPDIR: directory,
					PATH: process.env.PATH ?? "",
					NODE_ENV: scenario.nodeEnv,
					SYNTHETIC_DIRECTORY: directory,
					...(scenario.winner === "process"
						? { HOV_ROUTER_DB_PATH: join(directory, "process.db") }
						: {}),
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(child.stdout).text();
			const stderr = await new Response(child.stderr).text();
			expect({ exit: await child.exited, stdout, stderr }).toMatchObject({
				exit: 0,
			});
			expect(stdout).toContain("No accounts configured");
			expect(existsSync(join(directory, `${scenario.winner}.db`))).toBe(true);
		} finally {
			rmSync(directory, { recursive: true });
		}
	});
}

it.skipIf(!process.env.HOV_ROUTER_TEST_COMPILED_CLI)(
	"compiled ordinary CLI preserves project dotenv fallback",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "ordinary-cli-fallback-"));
		try {
			const cwd = join(directory, "work", "cwd");
			mkdirSync(cwd, { recursive: true });
			const executable = cliEntrypoint()[0];
			if (!executable) throw new Error("Compiled CLI required");
			const database = join(directory, "synthetic.db");
			writeFileSync(
				join(directory, ".env"),
				`HOV_ROUTER_DB_PATH=${database}\n`,
			);
			const ordinary = Bun.spawn([executable, "--list"], {
				cwd,
				env: {
					HOME: directory,
					XDG_CONFIG_HOME: directory,
					TMPDIR: directory,
					PATH: process.env.PATH ?? "",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(ordinary.stdout).text();
			const stderr = await new Response(ordinary.stderr).text();
			expect({ exit: await ordinary.exited, stdout, stderr }).toMatchObject({
				exit: 0,
			});
			expect(stdout).toContain("No accounts configured");
			expect(existsSync(database)).toBe(true);
		} finally {
			rmSync(directory, { recursive: true });
		}
	},
);

it("ordinary CLI finds dotenv beside its physical executable or source entrypoint; removed quality controls exit 2 without opening it", async () => {
	const directory = mkdtempSync(join(tmpdir(), "ordinary-cli-exec-fallback-"));
	try {
		const app = join(directory, "app");
		const cwd = join(directory, "work", "cwd");
		mkdirSync(app);
		mkdirSync(cwd, { recursive: true });
		const binary = process.env.HOV_ROUTER_TEST_COMPILED_CLI;
		let entrypoint: string[];
		if (binary) {
			const executable = join(app, "arbitrary-cli-name");
			copyFileSync(binary, executable);
			entrypoint = [executable];
		} else {
			const script = join(app, "source-entry.ts");
			writeFileSync(
				script,
				`const { startCli } = await import(${JSON.stringify(new URL("../main.ts", import.meta.url).pathname)}); startCli();`,
			);
			entrypoint = [process.execPath, "--no-env-file", script];
		}
		const database = join(directory, "physical-directory.db");
		writeFileSync(
			join(app, ".env"),
			`HOV_ROUTER_DB_PATH=${database}\nSYNTHETIC_INFERENCE_KEY=synthetic-file-secret\n`,
		);
		const env = {
			HOME: directory,
			XDG_CONFIG_HOME: directory,
			TMPDIR: directory,
			PATH: process.env.PATH ?? "",
		};
		// The parser ignores unknown flags; without the tombstone these would fall
		// through to another command (#816).
		for (const action of ["status", "retry-preferred"]) {
			const removed = Bun.spawn(
				[
					...entrypoint,
					`--quality-routing-${action}`,
					"synthetic-session",
					"--origin",
					"http://127.0.0.1:1",
					"--credential-env",
					"SYNTHETIC_INFERENCE_KEY",
				],
				{ cwd, env, stdout: "pipe", stderr: "pipe" },
			);
			const stdout = await new Response(removed.stdout).text();
			const stderr = await new Response(removed.stderr).text();
			expect(await removed.exited).toBe(2);
			expect(stdout).toBe("");
			expect(stderr).toContain(
				"The --quality-routing-* commands were removed with the Auto quality lane.",
			);
			expect(stdout + stderr).not.toContain("synthetic-file-secret");
			expect(existsSync(database)).toBe(false);
		}
		const ordinary = Bun.spawn([...entrypoint, "--list"], {
			cwd,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(ordinary.stdout).text();
		const stderr = await new Response(ordinary.stderr).text();
		expect({ exit: await ordinary.exited, stdout, stderr }).toMatchObject({
			exit: 0,
		});
		expect(stdout).toContain("No accounts configured");
		expect(existsSync(database)).toBe(true);
	} finally {
		rmSync(directory, { recursive: true });
	}
}, 30000);
