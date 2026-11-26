import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findRetiredEnvNames,
	findRetiredHeaders,
	findRetiredStorage,
	RETIRED_NAME_EXIT_CODE,
	retiredHeaderResponse,
	retiredNamesMessage,
} from "./retired-names";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function scratch(): { home: string; base: string } {
	const root = mkdtempSync(join(tmpdir(), "hov-retired-names-"));
	roots.push(root);
	const home = join(root, "home");
	const base = join(root, "config");
	mkdirSync(home, { recursive: true });
	mkdirSync(base, { recursive: true });
	return { home, base };
}

describe("findRetiredEnvNames", () => {
	it("maps each retired prefix to its HOV_ROUTER_ name", () => {
		expect(
			findRetiredEnvNames({
				BETTER_CCFLARE_HOST: "127.0.0.1",
				CCFLARE_CODEX_TRACE_DIR: "/x",
				ccflare_DB_PATH: "/db",
				HOV_ROUTER_HOST: "127.0.0.1",
				PATH: "/usr/bin",
			}),
		).toEqual([
			{ name: "BETTER_CCFLARE_HOST", replacement: "HOV_ROUTER_HOST" },
			{
				name: "CCFLARE_CODEX_TRACE_DIR",
				replacement: "HOV_ROUTER_CODEX_TRACE_DIR",
			},
			{ name: "ccflare_DB_PATH", replacement: "HOV_ROUTER_DB_PATH" },
		]);
	});

	it("names the health SHA override separately from the provenance SHA", () => {
		expect(
			findRetiredEnvNames({
				BETTER_CCFLARE_GIT_SHA: "a",
				CCFLARE_GIT_SHA: "b",
			}),
		).toEqual([
			{
				name: "BETTER_CCFLARE_GIT_SHA",
				replacement: "HOV_ROUTER_HEALTH_GIT_SHA",
			},
			{ name: "CCFLARE_GIT_SHA", replacement: "HOV_ROUTER_GIT_SHA" },
		]);
	});

	it("counts a set but empty variable, which the old reader also saw", () => {
		expect(
			findRetiredEnvNames({ CCFLARE_DEBUG_CODEX_STREAM: "" }),
		).toHaveLength(1);
	});

	it("ignores names that only contain the old word", () => {
		expect(
			findRetiredEnvNames({ MY_CCFLARE_NOTE: "1", HOV_ROUTER_DB_PATH: "/x" }),
		).toEqual([]);
	});
});

describe("findRetiredStorage", () => {
	it("finds a retired config directory that was never moved", () => {
		const { home, base } = scratch();
		mkdirSync(join(base, "better-ccflare"));
		expect(findRetiredStorage({ env: {}, home, configBase: base })).toEqual([
			{
				path: join(base, "better-ccflare"),
				replacement: join(base, "hov-router"),
			},
		]);
	});

	it("accepts a moved directory even when the old one is still present", () => {
		const { home, base } = scratch();
		mkdirSync(join(base, "better-ccflare"));
		mkdirSync(join(base, "hov-router"));
		expect(findRetiredStorage({ env: {}, home, configBase: base })).toEqual([]);
	});

	it("finds database and config files left under their old names", () => {
		const { home, base } = scratch();
		const dir = join(base, "hov-router");
		mkdirSync(dir);
		writeFileSync(join(dir, "better-ccflare.db"), "");
		writeFileSync(join(dir, "better-ccflare.json"), "{}");
		expect(findRetiredStorage({ env: {}, home, configBase: base })).toEqual([
			{
				path: join(dir, "better-ccflare.json"),
				replacement: join(dir, "hov-router.json"),
			},
			{
				path: join(dir, "better-ccflare.db"),
				replacement: join(dir, "hov-router.db"),
			},
		]);
	});

	it("checks beside an explicit database path, as on a Docker volume", () => {
		const { home, base } = scratch();
		const data = join(base, "data");
		mkdirSync(data);
		writeFileSync(join(data, "better-ccflare.db"), "");
		const env = { HOV_ROUTER_DB_PATH: join(data, "hov-router.db") };
		expect(findRetiredStorage({ env, home, configBase: base })).toEqual([
			{
				path: join(data, "better-ccflare.db"),
				replacement: join(data, "hov-router.db"),
			},
		]);
		writeFileSync(join(data, "hov-router.db"), "");
		expect(findRetiredStorage({ env, home, configBase: base })).toEqual([]);
	});

	it("finds a write-ahead log left behind when only the database was renamed", () => {
		const { home, base } = scratch();
		const dir = join(base, "hov-router");
		mkdirSync(dir);
		writeFileSync(join(dir, "hov-router.db"), "");
		writeFileSync(join(dir, "better-ccflare.db-wal"), "");
		expect(findRetiredStorage({ env: {}, home, configBase: base })).toEqual([
			{
				path: join(dir, "better-ccflare.db-wal"),
				replacement: join(dir, "hov-router.db-wal"),
			},
		]);
	});

	it("accepts an explicit database path that keeps the old file name", () => {
		// Naming the file outright is a choice, not a fallback; its own log
		// sits beside it under the same name.
		const { home, base } = scratch();
		const data = join(base, "data");
		mkdirSync(data);
		writeFileSync(join(data, "better-ccflare.db"), "");
		writeFileSync(join(data, "better-ccflare.db-wal"), "");
		const env = { HOV_ROUTER_DB_PATH: join(data, "better-ccflare.db") };
		expect(findRetiredStorage({ env, home, configBase: base })).toEqual([]);
	});

	it("finds agent workspaces left in the old home directory", () => {
		const { home, base } = scratch();
		mkdirSync(join(home, ".better-ccflare"));
		writeFileSync(join(home, ".better-ccflare", "workspaces.json"), "{}");
		expect(findRetiredStorage({ env: {}, home, configBase: base })).toEqual([
			{
				path: join(home, ".better-ccflare", "workspaces.json"),
				replacement: join(home, ".hov-router", "workspaces.json"),
			},
		]);
	});

	it("finds nothing on a fresh install", () => {
		const { home, base } = scratch();
		expect(findRetiredStorage({ env: {}, home, configBase: base })).toEqual([]);
	});
});

describe("retiredNamesMessage", () => {
	it("lists each rename and never a value", () => {
		const message = retiredNamesMessage(
			[
				{
					name: "BETTER_CCFLARE_ADMIN_API_KEY",
					replacement: "HOV_ROUTER_ADMIN_API_KEY",
				},
			],
			[{ path: "/c/better-ccflare", replacement: "/c/hov-router" }],
		);
		expect(message).toContain(
			"BETTER_CCFLARE_ADMIN_API_KEY -> HOV_ROUTER_ADMIN_API_KEY",
		);
		expect(message).toContain("/c/better-ccflare -> /c/hov-router");
		expect(message).toContain(
			'"Renamed in 8.0.0" in docs/hov-router-migration.md',
		);
		expect(RETIRED_NAME_EXIT_CODE).toBe(78);
	});
});

describe("retired request headers", () => {
	it("finds every x-better-ccflare- header, case-insensitively", () => {
		const headers = new Headers({
			"X-Better-Ccflare-Account-Id": "00000000-0000-4000-8000-000000000001",
			"x-better-ccflare-project": "p",
			"x-hov-router-account-id": "00000000-0000-4000-8000-000000000001",
		});
		expect(findRetiredHeaders(headers)).toEqual([
			"x-better-ccflare-account-id",
			"x-better-ccflare-project",
		]);
	});

	it("answers 400 in the Anthropic error shape and names the new header", async () => {
		const response = retiredHeaderResponse(["x-better-ccflare-account-id"]);
		expect(response.status).toBe(400);
		const body = (await response.json()) as {
			type: string;
			error: { type: string; message: string };
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("invalid_request_error");
		expect(body.error.message).toContain(
			"x-better-ccflare-account-id was renamed to x-hov-router-account-id",
		);
	});
});
