import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

// The Auto quality lane was removed (#816). Installs that enrolled it still
// carry its policy in the config file or the environment; both must be inert.
const ENV = "HOV_ROUTER_QUALITY_ROUTING_POLICY_JSON";
const savedEnv = process.env[ENV];
const directories: string[] = [];

// The shape an enrolled install holds on disk, with placeholder ids.
const leftoverPolicy = {
	version: 1,
	assignments: [
		{ line: "claude-fable", lane: "fable", priority: 0, upgrade: "none" },
	],
	accounts: [
		{
			accountId: "placeholder-account",
			provider: "anthropic",
			lines: ["claude-fable"],
			priority: 0,
		},
	],
	fallbacks: [{ from: "fable", to: "opus" }],
	spendGrants: [],
	workerFlagshipFallback: false,
};

function configPath(data: Record<string, unknown>): string {
	const directory = mkdtempSync(join(tmpdir(), "hov-router-retired-quality-"));
	directories.push(directory);
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(data));
	return path;
}

beforeEach(() => {
	delete process.env[ENV];
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env[ENV];
	else process.env[ENV] = savedEnv;
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("retired quality routing policy", () => {
	it("starts with a leftover policy object and keeps it out of settings", () => {
		const path = configPath({
			quality_routing_policy: leftoverPolicy,
			lb_strategy: "session",
		});
		const config = new Config(path);
		const settings = config.getAllSettings();
		expect("quality_routing_policy" in settings).toBe(false);
		expect(settings.lb_strategy).toBe("session");
	});

	it("starts with malformed leftovers that the old binary refused", () => {
		for (const value of ["{not json", { version: 99 }, "[]"]) {
			const path = configPath({ quality_routing_policy: value });
			expect(() => new Config(path)).not.toThrow();
		}
		process.env[ENV] = "{not json";
		expect(() => new Config(configPath({}))).not.toThrow();
	});

	it("leaves the leftover policy on disk when other settings are saved", () => {
		const path = configPath({ quality_routing_policy: leftoverPolicy });
		const config = new Config(path);
		config.set("data_retention_days", 7);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.quality_routing_policy).toEqual(leftoverPolicy);
		expect(saved.data_retention_days).toBe(7);
	});
});
