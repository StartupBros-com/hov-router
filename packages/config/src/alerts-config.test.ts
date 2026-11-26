import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@hov-router/logger";
import { Config } from "./index";

const ENV_KEYS = [
	"ALERT_DAILY_SPEND_USD",
	"ALERT_TOKENS_PER_HOUR",
	"ALERT_REQUEST_TOKENS",
	"ALERT_USAGE_WINDOW_THRESHOLD_PERCENT",
	"ALERT_COOLDOWN_MINUTES",
	"ALERT_WEBHOOK_URL",
	"ALERT_WEBHOOK_TYPES",
	"MEMBER_NOTICE_WEBHOOK_URL",
	"MEMBER_NOTICE_SIGNING_SECRET",
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
	ORIGINAL_ENV[key] = process.env[key];
}

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("alert config settings", () => {
	afterEach(() => {
		for (const key of ENV_KEYS) {
			const original = ORIGINAL_ENV[key];
			if (original === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = original;
			}
		}
	});

	it("returns defaults when nothing is configured", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getAlertDailySpendUsd()).toBe(0);
			expect(config.getAlertTokensPerHour()).toBe(0);
			expect(config.getAlertRequestTokens()).toBe(0);
			expect(config.getAlertUsageWindowThresholdPercent()).toBe(90);
			expect(config.getAlertCooldownMinutes()).toBe(60);
			expect(config.getAlertWebhookUrl()).toBe("");
			expect(config.getAlertWebhookTypes()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("honors environment variable overrides", () => {
		process.env.ALERT_DAILY_SPEND_USD = "25.5";
		process.env.ALERT_TOKENS_PER_HOUR = "500000";
		process.env.ALERT_REQUEST_TOKENS = "200000";
		process.env.ALERT_USAGE_WINDOW_THRESHOLD_PERCENT = "75";
		process.env.ALERT_COOLDOWN_MINUTES = "120";
		process.env.ALERT_WEBHOOK_URL = "https://example.com/hook";
		process.env.ALERT_WEBHOOK_TYPES = "auth_failure, model_routing_drift";
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getAlertDailySpendUsd()).toBe(25.5);
			expect(config.getAlertTokensPerHour()).toBe(500000);
			expect(config.getAlertRequestTokens()).toBe(200000);
			expect(config.getAlertUsageWindowThresholdPercent()).toBe(75);
			expect(config.getAlertCooldownMinutes()).toBe(120);
			expect(config.getAlertWebhookUrl()).toBe("https://example.com/hook");
			expect(config.getAlertWebhookTypes()).toEqual([
				"auth_failure",
				"model_routing_drift",
			]);
		} finally {
			cleanup();
		}
	});

	it("clamps out-of-range environment values", () => {
		process.env.ALERT_DAILY_SPEND_USD = "-5";
		process.env.ALERT_TOKENS_PER_HOUR = "9999999999";
		process.env.ALERT_REQUEST_TOKENS = "-100";
		process.env.ALERT_USAGE_WINDOW_THRESHOLD_PERCENT = "150";
		process.env.ALERT_COOLDOWN_MINUTES = "0";
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getAlertDailySpendUsd()).toBe(0);
			expect(config.getAlertTokensPerHour()).toBe(1_000_000_000);
			expect(config.getAlertRequestTokens()).toBe(0);
			expect(config.getAlertUsageWindowThresholdPercent()).toBe(100);
			expect(config.getAlertCooldownMinutes()).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("clamps out-of-range config-file values via setters", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			config.setAlertDailySpendUsd(2_000_000);
			expect(config.getAlertDailySpendUsd()).toBe(1_000_000);

			config.setAlertUsageWindowThresholdPercent(150);
			expect(config.getAlertUsageWindowThresholdPercent()).toBe(100);

			config.setAlertUsageWindowThresholdPercent(-10);
			expect(config.getAlertUsageWindowThresholdPercent()).toBe(0);

			config.setAlertCooldownMinutes(0);
			expect(config.getAlertCooldownMinutes()).toBe(1);
		} finally {
			cleanup();
		}
	});

	it("persists setter values readable by getters", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			config.setAlertDailySpendUsd(50);
			config.setAlertTokensPerHour(1_000_000);
			config.setAlertRequestTokens(300_000);
			config.setAlertUsageWindowThresholdPercent(80);
			config.setAlertCooldownMinutes(45);
			config.setAlertWebhookUrl("https://hooks.example.com/alert");

			expect(config.getAlertDailySpendUsd()).toBe(50);
			expect(config.getAlertTokensPerHour()).toBe(1_000_000);
			expect(config.getAlertRequestTokens()).toBe(300_000);
			expect(config.getAlertUsageWindowThresholdPercent()).toBe(80);
			expect(config.getAlertCooldownMinutes()).toBe(45);
			expect(config.getAlertWebhookUrl()).toBe(
				"https://hooks.example.com/alert",
			);
		} finally {
			cleanup();
		}
	});

	it("accepts an empty webhook URL (disabled) and rejects invalid ones", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			expect(() => config.setAlertWebhookUrl("")).not.toThrow();
			expect(config.getAlertWebhookUrl()).toBe("");

			expect(() => config.setAlertWebhookUrl("not-a-url")).toThrow();
			expect(() => config.setAlertWebhookUrl("ftp://example.com")).toThrow();
			expect(() =>
				config.setAlertWebhookUrl("http://example.com/hook"),
			).not.toThrow();
		} finally {
			cleanup();
		}
	});

	it("includes alert settings in getAllSettings()", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			const settings = config.getAllSettings();
			expect(settings.alert_daily_spend_usd).toBe(0);
			expect(settings.alert_tokens_per_hour).toBe(0);
			expect(settings.alert_request_tokens).toBe(0);
			expect(settings.alert_usage_window_threshold_percent).toBe(90);
			// Retired in 7.0.0 (#1012): the anomaly sweep settings are not listed.
			expect(
				Object.keys(settings).filter((key) => key.startsWith("alert_anomaly_")),
			).toEqual([]);
			expect(settings.alert_cooldown_minutes).toBe(60);
			expect(settings.alert_webhook_url).toBe("");
			expect(settings.alert_webhook_types).toBe("");
		} finally {
			cleanup();
		}
	});
});

describe("alert webhook type allowlist", () => {
	afterEach(() => {
		for (const key of ENV_KEYS) {
			const original = ORIGINAL_ENV[key];
			if (original === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = original;
			}
		}
	});

	it("defaults to delivering all types (empty allowlist)", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getAlertWebhookTypes()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("persists a setter value readable by the getter, normalized and de-duplicated", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			config.setAlertWebhookTypes(
				"Auth_Failure, model_routing_drift,auth_failure",
			);
			expect(config.getAlertWebhookTypes()).toEqual([
				"auth_failure",
				"model_routing_drift",
			]);
		} finally {
			cleanup();
		}
	});

	it("clearing to an empty string re-enables delivering all types", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			config.setAlertWebhookTypes("auth_failure");
			expect(config.getAlertWebhookTypes()).toEqual(["auth_failure"]);

			config.setAlertWebhookTypes("");
			expect(config.getAlertWebhookTypes()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("reads and saves again a list that names the retired anomaly types, without a warning", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		// The shape an install saved before 7.0.0: every type it could name,
		// including the four the removed anomaly sweep raised.
		const saved = [
			"daily_spend",
			"tokens_per_hour",
			"request_tokens",
			"anomaly_token_outlier",
			"anomaly_output_blowup",
			"anomaly_runaway_loop",
			"anomaly_model_misrouting",
			"auth_failure",
			"model_routing_drift",
			"usage_window_value_drop",
			"cache_efficiency_low",
			"cache_efficiency_critical",
			"cache_telemetry_gap",
			"cache_efficiency_recovered",
			"org_permission_denied",
		];
		const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
		const path = join(dir, "config.json");
		writeFileSync(
			path,
			JSON.stringify({ alert_webhook_types: saved.join(",") }),
		);
		const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
		try {
			const config = new Config(path);
			expect(config.getAlertWebhookTypes()).toEqual(saved);
			expect(() => config.setAlertWebhookTypes(saved.join(","))).not.toThrow();
			expect(config.getAlertWebhookTypes()).toEqual(saved);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects an unknown alert type name", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			expect(() =>
				config.setAlertWebhookTypes("auth_failure,not_a_real_alert_type"),
			).toThrow();
			// The rejected write must not have partially applied.
			expect(config.getAlertWebhookTypes()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("rejects an oversized list containing an unknown type instead of silently allowing all", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			// 65 comma-separated tokens (one past the internal 64-token cap),
			// padded with a valid, repeated type plus one unknown name. The
			// write path must still fail loudly on the unknown name rather
			// than silently short-circuiting the oversized list to "deliver
			// all" (the getter's safe fallback, not the setter's contract).
			const tokens = Array.from({ length: 64 }, () => "auth_failure");
			tokens.push("not_a_real_alert_type");
			expect(() => config.setAlertWebhookTypes(tokens.join(","))).toThrow();
			// The rejected write must not have partially applied.
			expect(config.getAlertWebhookTypes()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	it("env var overrides the file value, including an explicit empty override", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			config.setAlertWebhookTypes("auth_failure");
			process.env.ALERT_WEBHOOK_TYPES = "model_routing_drift";
			expect(config.getAlertWebhookTypes()).toEqual(["model_routing_drift"]);

			process.env.ALERT_WEBHOOK_TYPES = "";
			expect(config.getAlertWebhookTypes()).toEqual([]);
		} finally {
			cleanup();
		}
	});
});

describe("member notice address and signing secret", () => {
	const MEMBER_URL =
		"https://brobot.example.com/api/internal/ai-alerts/router-events";
	const SECRET = "router-signing-secret-7f3a";

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const original = ORIGINAL_ENV[key];
			if (original === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = original;
			}
		}
	});

	it("is empty when neither the environment nor the config file sets it", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			expect(config.getMemberNoticeWebhookUrl()).toBe("");
			expect(config.getMemberNoticeSigningSecret()).toBe("");
		} finally {
			cleanup();
		}
	});

	it("reads the signing secret from the config key, and the environment variable wins over it", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			config.set("member_notice_signing_secret", SECRET);
			expect(config.getMemberNoticeSigningSecret()).toBe(SECRET);

			process.env.MEMBER_NOTICE_SIGNING_SECRET = "from-the-environment";
			expect(config.getMemberNoticeSigningSecret()).toBe(
				"from-the-environment",
			);

			process.env.MEMBER_NOTICE_SIGNING_SECRET = "";
			expect(config.getMemberNoticeSigningSecret()).toBe("");
		} finally {
			cleanup();
		}
	});

	it("reads the config key, and the environment variable wins over it", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			config.set("member_notice_webhook_url", MEMBER_URL);
			expect(config.getMemberNoticeWebhookUrl()).toBe(MEMBER_URL);

			process.env.MEMBER_NOTICE_WEBHOOK_URL =
				"https://example.com/hooks/member";
			expect(config.getMemberNoticeWebhookUrl()).toBe(
				"https://example.com/hooks/member",
			);

			process.env.MEMBER_NOTICE_WEBHOOK_URL = "";
			expect(config.getMemberNoticeWebhookUrl()).toBe("");
		} finally {
			cleanup();
		}
	});

	it("never appears in getAllSettings()", () => {
		for (const key of ENV_KEYS) {
			delete process.env[key];
		}
		const { config, cleanup } = makeConfig();

		try {
			config.set("member_notice_webhook_url", MEMBER_URL);
			config.set("member_notice_signing_secret", SECRET);
			process.env.MEMBER_NOTICE_WEBHOOK_URL = MEMBER_URL;
			process.env.MEMBER_NOTICE_SIGNING_SECRET = SECRET;
			const serialized = JSON.stringify(config.getAllSettings());
			expect(serialized).not.toContain("member_notice_webhook_url");
			expect(serialized).not.toContain("member_notice_signing_secret");
			expect(serialized).not.toContain("brobot.example.com");
			expect(serialized).not.toContain(SECRET);
		} finally {
			cleanup();
		}
	});
});
