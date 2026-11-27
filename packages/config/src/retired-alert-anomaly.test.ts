import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function configPath(data: Record<string, unknown>): string {
	const directory = mkdtempSync(join(tmpdir(), "hov-router-retired-anomaly-"));
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

describe("retired anomaly alert settings", () => {
	it("keeps leftover keys out of settings when the sweep was off", () => {
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
	});

	it("ignores enabled and malformed leftovers without validating them", () => {
		for (const value of [true, "{not json", { version: 99 }]) {
			process.env[ENV] = String(value);
			const config = new Config(
				configPath(Object.fromEntries(RETIRED_KEYS.map((key) => [key, value]))),
			);
			for (const key of RETIRED_KEYS)
				expect(key in config.getAllSettings()).toBe(false);
		}
	});
});
