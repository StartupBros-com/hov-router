import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@hov-router/logger";
import {
	ANTHROPIC_DEGRADED_MODE_DEFAULTS,
	type AnthropicDegradedModeConfig,
	Config,
} from "./index";

const DEGRADED_ENV_NAMES = [
	"HOV_ROUTER_ANTHROPIC_DEGRADED_MODE",
	"HOV_ROUTER_ANTHROPIC_DEGRADED_LARGE_REQUEST_TOKENS",
	"HOV_ROUTER_ANTHROPIC_DEGRADED_LARGE_REQUEST_BYTES",
	"HOV_ROUTER_ANTHROPIC_DEGRADED_EVIDENCE_WINDOW_MS",
	"HOV_ROUTER_ANTHROPIC_DEGRADED_QUORUM",
	"HOV_ROUTER_ANTHROPIC_DEGRADED_RETRY_MIN_MS",
	"HOV_ROUTER_ANTHROPIC_DEGRADED_RETRY_FALLBACK_MS",
	"HOV_ROUTER_ANTHROPIC_DEGRADED_RETRY_MAX_MS",
	"HOV_ROUTER_ANTHROPIC_DEGRADED_RECOVERY_WINDOW_MS",
	"HOV_ROUTER_ANTHROPIC_DEGRADED_PROBE_LEASE_MS",
	"HOV_ROUTER_ANTHROPIC_DEGRADED_MAX_COHORTS",
] as const;

const originalEnv = Object.fromEntries(
	DEGRADED_ENV_NAMES.map((name) => [name, process.env[name]]),
) as Record<(typeof DEGRADED_ENV_NAMES)[number], string | undefined>;

function clearDegradedEnv(): void {
	for (const name of DEGRADED_ENV_NAMES) delete process.env[name];
}

function makeConfig(): { config: Config; cleanup: () => void } {
	const directory = mkdtempSync(
		join(tmpdir(), "hov-router-degraded-mode-config-"),
	);
	return {
		config: new Config(join(directory, "config.json")),
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

describe("Anthropic degraded-mode real configuration getter", () => {
	beforeEach(clearDegradedEnv);

	afterEach(() => {
		clearDegradedEnv();
		for (const name of DEGRADED_ENV_NAMES) {
			const value = originalEnv[name];
			if (value !== undefined) process.env[name] = value;
		}
	});

	it("warns once and atomically returns the complete off defaults for invalid policy input", () => {
		const warning = spyOn(Logger.prototype, "warn").mockImplementation(
			() => undefined,
		);
		const { config, cleanup } = makeConfig();
		try {
			const cases: Array<{
				label: string;
				env: Partial<Record<(typeof DEGRADED_ENV_NAMES)[number], string>>;
			}> = [
				{
					label: "invalid mode",
					env: {
						HOV_ROUTER_ANTHROPIC_DEGRADED_MODE:
							"enforce\noperator-secret-must-not-appear",
					},
				},
				{
					label: "out-of-range value",
					env: {
						HOV_ROUTER_ANTHROPIC_DEGRADED_MODE: "enforce",
						HOV_ROUTER_ANTHROPIC_DEGRADED_LARGE_REQUEST_BYTES: "65535",
					},
				},
				{
					label: "invalid retry relation",
					env: {
						HOV_ROUTER_ANTHROPIC_DEGRADED_MODE: "enforce",
						HOV_ROUTER_ANTHROPIC_DEGRADED_RETRY_MIN_MS: "60000",
						HOV_ROUTER_ANTHROPIC_DEGRADED_RETRY_FALLBACK_MS: "1000",
						HOV_ROUTER_ANTHROPIC_DEGRADED_RETRY_MAX_MS: "60000",
					},
				},
			];

			for (const testCase of cases) {
				clearDegradedEnv();
				Object.assign(process.env, testCase.env);
				warning.mockClear();

				const resolved: AnthropicDegradedModeConfig =
					config.getAnthropicDegradedModeConfig();

				expect(resolved, testCase.label).toEqual(
					ANTHROPIC_DEGRADED_MODE_DEFAULTS,
				);
				expect(resolved.mode, testCase.label).toBe("off");
				expect(warning, testCase.label).toHaveBeenCalledTimes(1);
				const message = String(warning.mock.calls[0]?.[0]);
				expect(message.length, testCase.label).toBeLessThanOrEqual(180);
				expect(message, testCase.label).not.toContain("operator-secret");
				expect(message, testCase.label).toContain(
					"degraded mode is off until configuration is corrected",
				);
			}
		} finally {
			warning.mockRestore();
			cleanup();
		}
	});
});
