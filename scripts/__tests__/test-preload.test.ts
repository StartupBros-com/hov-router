import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { getPlatformConfigDir } from "@hov-router/config";
import { resolveDbPath } from "@hov-router/database";

// Guards bunfig.toml's [test] preload: without it tests share /tmp paths with
// the production service (pricing cache, model catalog cache, app.log), and a
// test that sets no DB path opens the default database, production's on this host.
describe("bun test preload", () => {
	test("tmpdir() is a per-process directory", () => {
		expect(basename(tmpdir()).startsWith("hov-router-test-")).toBe(true);
		expect(dirname(tmpdir())).not.toBe(tmpdir());
	});

	test("every variable tmpdir() may read points at the per-process dir", () => {
		// Windows reads TEMP/TMP, not TMPDIR.
		expect(process.env.TMPDIR).toBe(tmpdir());
		expect(process.env.TEMP).toBe(tmpdir());
		expect(process.env.TMP).toBe(tmpdir());
	});

	test("log and model-cache overrides resolve under the per-process dir", () => {
		const root = tmpdir() + sep;
		expect(process.env.BETTER_CCFLARE_LOG_DIR?.startsWith(root)).toBe(true);
		expect(process.env.BETTER_CCFLARE_MODELS_CACHE_DIR?.startsWith(root)).toBe(
			true,
		);
		expect(join(tmpdir(), "x").startsWith(root)).toBe(true);
	});

	test("the default config directory and database resolve under the per-process dir", () => {
		const root = tmpdir() + sep;
		const saved = {
			BETTER_CCFLARE_DB_PATH: process.env.BETTER_CCFLARE_DB_PATH,
			ccflare_DB_PATH: process.env.ccflare_DB_PATH,
		};
		delete process.env.BETTER_CCFLARE_DB_PATH;
		delete process.env.ccflare_DB_PATH;
		try {
			expect(process.env.XDG_CONFIG_HOME?.startsWith(root)).toBe(true);
			if (process.platform !== "win32") {
				expect(getPlatformConfigDir().startsWith(root)).toBe(true);
				expect(resolveDbPath().startsWith(root)).toBe(true);
			}
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});
