import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@better-ccflare/logger";
import { Config } from "./index";

// The anomaly alert sweep was removed in 7.0.0 (#1012). Any install that saved
// alert settings holds its four keys, usually with the sweep off; they must be
// inert, stay out of the settings listing, and stay on disk.
const ENV = "ALERT_ANOMALY_ENABLED";
const RETIRED_KEYS = [
	"alert_anomaly_enabled",
	"alert_anomaly_interval_minutes",
	"alert_anomaly_baseline_window_minutes",
	"alert_anomaly_loop_min_requests",
] as const;
const savedEnv = process.env[ENV];
const directories: string[] = [];
let warn: ReturnType<typeof spyOn>;

function configPath(data: Record<string, unknown>): string {
	const directory = mkdtempSync(join(tmpdir(), "ccflare-retired-anomaly-"));
	directories.push(directory);
	const path = join(directory, "config.json");
	writeFileSync(path, JSON.stringify(data));
	return path;
}

function retiredWarnings(): string[] {
	return warn.mock.calls
		.map((call) => String(call[0]))
		.filter((message) => message.includes("anomaly alert sweep"));
}

beforeEach(() => {
	delete process.env[ENV];
	warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warn.mockRestore();
	if (savedEnv === undefined) delete process.env[ENV];
	else process.env[ENV] = savedEnv;
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

// The warning is logged once per process, so the silent cases run first.
describe("retired anomaly alert settings", () => {
	it("keeps leftover keys out of settings, with no warning, when the sweep was off", () => {
		process.env[ENV] = "false";
		const settings = new Config(
			configPath({
				alert_anomaly_enabled: false,
				alert_anomaly_interval_minutes: 15,
				alert_anomaly_baseline_window_minutes: 1440,
				alert_anomaly_loop_min_requests: 25,
				lb_strategy: "session",
			}),
		).getAllSettings();
		for (const key of RETIRED_KEYS) expect(key in settings).toBe(false);
		expect(settings.lb_strategy).toBe("session");
		expect(retiredWarnings()).toEqual([]);
	});

	it("leaves the leftover keys on disk when other settings are saved", () => {
		const path = configPath({
			alert_anomaly_enabled: false,
			alert_anomaly_loop_min_requests: 25,
		});
		new Config(path).setAlertCooldownMinutes(45);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.alert_anomaly_enabled).toBe(false);
		expect(saved.alert_anomaly_loop_min_requests).toBe(25);
		expect(saved.alert_cooldown_minutes).toBe(45);
		expect(retiredWarnings()).toEqual([]);
	});

	it("warns once, naming both sources, when the sweep was turned on", () => {
		process.env[ENV] = "1";
		const path = configPath({ alert_anomaly_enabled: true });
		new Config(path);
		new Config(path);
		const warnings = retiredWarnings();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("alert_anomaly_enabled in the config file");
		expect(warnings[0]).toContain(ENV);
	});
});
