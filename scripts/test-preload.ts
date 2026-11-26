// Bun test preload (see bunfig.toml). Production runs on the same host and
// user as developers and shares os.tmpdir() paths (pricing cache, model
// catalog cache, app.log), so tests must never write there. Give each test
// process its own tmpdir, which covers every tmpdir() consumer in-process.
// tmpdir() reads TMPDIR (then TMP, TEMP) on POSIX but TEMP/TMP on Windows, so
// all three are set. The two log/cache overrides are pinned too, so a shell
// that exports them cannot redirect tests at real locations. Subprocesses see
// these only when spawned with `env: process.env`: Bun (1.3) hands a child the
// startup environment by default, not later process.env changes.
//
// XDG_CONFIG_HOME is pinned for the same reason: the default config directory,
// and the default database inside it, is production's on this host, and a test
// that forgets to set its own DB or config path would otherwise open it.
// getPlatformConfigDir() reads XDG_CONFIG_HOME on every call.
//
// HOME is pinned for children only: Bun caches os.homedir() at startup, so
// in-process code still sees the real home. A spawned CLI or server would
// otherwise read the developer's home directory, and since 8.0.0 refuses to
// start where it finds a directory with a pre-8.0.0 name.
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hov-router-test-"));
process.env.TMPDIR = dir;
process.env.TEMP = dir;
process.env.TMP = dir;
process.env.XDG_CONFIG_HOME = join(dir, "config");
process.env.HOME = join(dir, "home");
mkdirSync(process.env.HOME);
process.env.HOV_ROUTER_LOG_DIR = join(dir, "logs");
process.env.HOV_ROUTER_MODELS_CACHE_DIR = join(dir, "models-cache");

function cleanup(): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort cleanup
	}
}

// bun test can exit without emitting "exit", so also clean up after the file.
process.on("exit", cleanup);
afterAll(cleanup);
