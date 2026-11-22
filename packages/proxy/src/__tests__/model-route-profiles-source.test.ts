import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_ROUTE_PROFILES_ENV } from "../model-route-profiles";
import {
	activeModelRouteProfiles,
	loadModelRouteProfiles,
	MODEL_ROUTE_PROFILES_FILE_ENV,
	setActiveModelRouteProfiles,
} from "../model-route-profiles-source";

const ACCOUNT = "df44bdf6-d646-45aa-b3d1-1b2b2cdbf774";

function profilesJson(id: string): string {
	return JSON.stringify([
		{
			id,
			displayName: `${id} route`,
			accountId: ACCOUNT,
			logicalModel: "claude-opus-5",
		},
	]);
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

let dir: string;
let profilesPath: string;
let lastGoodPath: string;

function writeProfiles(text: string, mode = 0o640): void {
	writeFileSync(profilesPath, text);
	chmodSync(profilesPath, mode);
}

function load(env: Record<string, string | undefined>) {
	return loadModelRouteProfiles(env, { lastGoodPath });
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "route-profiles-source-"));
	profilesPath = join(dir, "model-route-profiles.json");
	lastGoodPath = join(dir, "state", "model-route-profiles.last-good.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	setActiveModelRouteProfiles(undefined);
});

describe("loadModelRouteProfiles: environment source", () => {
	it("returns no profiles when neither variable is set", () => {
		const loaded = load({});
		expect(loaded.profiles).toEqual([]);
		expect(loaded.status).toEqual({ source: "none", status: "ok", count: 0 });
	});

	it("keeps the JSON variable working exactly as before", () => {
		const loaded = load({ [MODEL_ROUTE_PROFILES_ENV]: profilesJson("env-a") });
		expect(loaded.profiles.map((p) => p.id)).toEqual(["env-a"]);
		expect(loaded.status).toEqual({ source: "env", status: "ok", count: 1 });
		expect(existsSync(lastGoodPath)).toBe(false);
	});

	it("still refuses a malformed JSON variable", () => {
		expect(() => load({ [MODEL_ROUTE_PROFILES_ENV]: "[" })).toThrow(
			`${MODEL_ROUTE_PROFILES_ENV}: must be valid JSON`,
		);
	});
});

describe("loadModelRouteProfiles: file source", () => {
	it("loads the file, reports its sha256 and keeps a last-good copy", () => {
		const text = profilesJson("file-a");
		writeProfiles(text);
		const loaded = load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath });
		expect(loaded.profiles.map((p) => p.id)).toEqual(["file-a"]);
		expect(loaded.status).toEqual({
			source: "file",
			status: "ok",
			count: 1,
			path: profilesPath,
			sha256: sha256(text),
			fallbackReady: true,
		});
		const record = JSON.parse(readFileSync(lastGoodPath, "utf8"));
		expect(record.path).toBe(profilesPath);
		expect(record.sha256).toBe(sha256(text));
		expect(record.raw).toBe(text);
		expect(statSync(lastGoodPath).mode & 0o777).toBe(0o600);
	});

	it("refuses both variables at once", () => {
		writeProfiles(profilesJson("file-a"));
		expect(() =>
			load({
				[MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath,
				[MODEL_ROUTE_PROFILES_ENV]: profilesJson("env-a"),
			}),
		).toThrow(
			`${MODEL_ROUTE_PROFILES_FILE_ENV} and ${MODEL_ROUTE_PROFILES_ENV} are both set`,
		);
	});

	it("uses the file when the JSON variable is blank", () => {
		writeProfiles(profilesJson("file-a"));
		const loaded = load({
			[MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath,
			[MODEL_ROUTE_PROFILES_ENV]: "  ",
		});
		expect(loaded.status.source).toBe("file");
	});

	it("refuses a relative path", () => {
		expect(() =>
			load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: "model-route-profiles.json" }),
		).toThrow("must be an absolute path");
	});

	it("names the file variable and path in a profile error", () => {
		writeProfiles(JSON.stringify([{ id: "Bad Id" }]));
		expect(() =>
			load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath }),
		).toThrow(`${MODEL_ROUTE_PROFILES_FILE_ENV} (${profilesPath}): profile 0`);
	});

	it("fails a missing file when there is no last-good copy", () => {
		expect(() =>
			load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath }),
		).toThrow(`${MODEL_ROUTE_PROFILES_FILE_ENV} (${profilesPath})`);
	});

	it("treats an empty file as an error rather than as no profiles", () => {
		writeProfiles(" \n");
		expect(() =>
			load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath }),
		).toThrow("is empty");
	});

	it("refuses a file that group or others can write", () => {
		writeProfiles(profilesJson("file-a"), 0o664);
		expect(() =>
			load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath }),
		).toThrow("must not be writable by group or others");
	});

	it("refuses a symlink", () => {
		const target = join(dir, "target.json");
		writeFileSync(target, profilesJson("file-a"));
		chmodSync(target, 0o640);
		symlinkSync(target, profilesPath);
		expect(() =>
			load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath }),
		).toThrow(`${MODEL_ROUTE_PROFILES_FILE_ENV} (${profilesPath})`);
	});

	it.if(process.platform === "linux")(
		"fails a FIFO at the path instead of blocking startup",
		() => {
			const made = Bun.spawnSync(["mkfifo", "-m", "0640", profilesPath]);
			expect(made.exitCode).toBe(0);
			expect(() =>
				load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath }),
			).toThrow("must be a regular file");
		},
		5_000,
	);
});

describe("loadModelRouteProfiles: last-good fallback", () => {
	function loadGood(id: string): string {
		const text = profilesJson(id);
		writeProfiles(text);
		load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath });
		return text;
	}

	it("serves the last good profiles when the file turns invalid", () => {
		const good = loadGood("file-a");
		writeProfiles("[");
		const loaded = load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath });
		expect(loaded.profiles.map((p) => p.id)).toEqual(["file-a"]);
		expect(loaded.status.source).toBe("file");
		expect(loaded.status.status).toBe("last_good");
		expect(loaded.status.sha256).toBe(sha256(good));
		expect(loaded.status.error).toContain(
			`${MODEL_ROUTE_PROFILES_FILE_ENV} (${profilesPath}): must be valid JSON`,
		);
	});

	it("serves the last good profiles when the file disappears", () => {
		loadGood("file-a");
		rmSync(profilesPath);
		const loaded = load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath });
		expect(loaded.status.status).toBe("last_good");
		expect(loaded.profiles.map((p) => p.id)).toEqual(["file-a"]);
	});

	it("serves the last good profiles when the file becomes group-writable", () => {
		loadGood("file-a");
		chmodSync(profilesPath, 0o666);
		const loaded = load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath });
		expect(loaded.status.status).toBe("last_good");
	});

	it("replaces the last-good copy after a newer good load", () => {
		loadGood("file-a");
		const newer = loadGood("file-b");
		writeProfiles("not json");
		const loaded = load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath });
		expect(loaded.profiles.map((p) => p.id)).toEqual(["file-b"]);
		expect(loaded.status.sha256).toBe(sha256(newer));
	});

	it("ignores a last-good copy recorded for a different path", () => {
		loadGood("file-a");
		const otherPath = join(dir, "other.json");
		expect(() => load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: otherPath })).toThrow(
			`${MODEL_ROUTE_PROFILES_FILE_ENV} (${otherPath})`,
		);
	});

	it("ignores a corrupt last-good copy and reports the file error", () => {
		loadGood("file-a");
		writeFileSync(lastGoodPath, "{");
		writeProfiles("[");
		expect(() =>
			load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath }),
		).toThrow("must be valid JSON");
	});

	it("never writes a last-good copy from a fallback load", () => {
		loadGood("file-a");
		const before = readFileSync(lastGoodPath, "utf8");
		writeProfiles("[");
		load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath });
		expect(readFileSync(lastGoodPath, "utf8")).toBe(before);
	});

	it("ignores a last-good copy that group or others can read", () => {
		loadGood("file-a");
		chmodSync(lastGoodPath, 0o644);
		writeProfiles("[");
		expect(() =>
			load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath }),
		).toThrow("no last-good copy to fall back to");
	});

	it("ignores a last-good copy reached through a symlink", () => {
		loadGood("file-a");
		const planted = join(dir, "planted.json");
		writeFileSync(planted, readFileSync(lastGoodPath));
		chmodSync(planted, 0o600);
		rmSync(lastGoodPath);
		symlinkSync(planted, lastGoodPath);
		writeProfiles("[");
		expect(() =>
			load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath }),
		).toThrow("no last-good copy to fall back to");
	});

	it("reports fallbackReady false when the copy cannot be saved", () => {
		// A file where the copy's directory should be makes the save fail.
		writeFileSync(join(dir, "state"), "not a directory");
		writeProfiles(profilesJson("file-a"));
		const loaded = load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath });
		expect(loaded.status.status).toBe("ok");
		expect(loaded.status.fallbackReady).toBe(false);
	});
});

describe("activeModelRouteProfiles", () => {
	it("returns the profiles the server registered at start", () => {
		writeProfiles(profilesJson("file-a"));
		const loaded = load({ [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath });
		setActiveModelRouteProfiles(loaded.profiles);
		expect(activeModelRouteProfiles().map((p) => p.id)).toEqual(["file-a"]);
	});

	it("falls back to the JSON variable when nothing was registered", () => {
		const previous = process.env[MODEL_ROUTE_PROFILES_ENV];
		process.env[MODEL_ROUTE_PROFILES_ENV] = profilesJson("env-a");
		try {
			expect(activeModelRouteProfiles().map((p) => p.id)).toEqual(["env-a"]);
		} finally {
			if (previous === undefined) delete process.env[MODEL_ROUTE_PROFILES_ENV];
			else process.env[MODEL_ROUTE_PROFILES_ENV] = previous;
		}
	});
});
