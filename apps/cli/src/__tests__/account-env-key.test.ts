import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const preferred of [false, true]) {
	test(`noninteractive generic API key, preferred override=${preferred}`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "account-env-key-"));
		try {
			const dbPath = join(dir, "test.db");
			const child = Bun.spawn(
				[
					process.execPath,
					"--no-env-file",
					new URL("../main.ts", import.meta.url).pathname,
					"--add-account",
					"synthetic",
					"--mode",
					"deepseek",
					"--priority",
					"1",
					"--api-url",
					"http://127.0.0.1:1",
				],
				{
					cwd: dir,
					env: {
						PATH: process.env.PATH,
						HOME: dir,
						XDG_CONFIG_HOME: dir,
						NODE_ENV: "test",
						HOV_ROUTER_DB_PATH: dbPath,
						HOV_ROUTER_CONFIG_PATH: join(dir, "config.json"),
						API_KEY_SYNTHETIC: "synthetic-generic-key",
						...(preferred
							? { HOV_ROUTER_API_KEY_SYNTHETIC: "synthetic-preferred-key" }
							: {}),
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			// The account is created offline; the separate live-routing report must fail.
			// runner.ts intentionally returns 1 for that specific post-create condition.
			expect(await child.exited).toBe(1);
			expect(stderr.trim()).toBe(
				"Post-create effective routing report is incomplete: the account was persisted, but its authoritative live routing state could not be read.",
			);
			expect(stdout).toContain("Account 'synthetic' added successfully!");
			expect(stdout + stderr).not.toContain("synthetic-generic-key");
			expect(stdout + stderr).not.toContain("synthetic-preferred-key");
			const db = new Database(dbPath, { readonly: true });
			try {
				const row = db
					.query("SELECT api_key FROM accounts WHERE name = 'synthetic'")
					.get() as { api_key: string } | null;
				expect(row?.api_key).toBe(
					preferred ? "synthetic-preferred-key" : "synthetic-generic-key",
				);
			} finally {
				db.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
