import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "@hov-router/config";
import { CLAUDE_MODEL_IDS, LATEST_MODEL_BY_FAMILY } from "@hov-router/core";
import { BunSqlAdapter, ensureSchema } from "@hov-router/database";
import type {
	AlertEvent,
	AlertsConfigPayload,
	RequestResponse,
} from "@hov-router/types";
import { CACHE_HEALTH_INTERVAL_MS } from "@hov-router/types";
import {
	AlertService,
	buildCodexRouteRoleUnavailableAlert,
	buildModelRoutingDriftAlerts,
	buildRequestTokenAlert,
	buildStalePolicyDriftAlert,
	buildThresholdAlertId,
	buildUnknownModelDriftAlert,
	buildUnknownModelDriftAlerts,
	buildUsageWindowAlertId,
	isAlertTypeAllowedForWebhook,
	shouldFireAlert,
} from "../alerts";

const CONFIG: AlertsConfigPayload = {
	dailySpendUsd: 10,
	tokensPerHour: 100_000,
	requestTokens: 50_000,
	usageWindowThresholdPercent: 90,
	cooldownMinutes: 60,
	webhookUrl: "",
};

describe("alert threshold helpers", () => {
	test("buildThresholdAlertId is stable for the cooldown bucket", () => {
		expect(buildThresholdAlertId("request_tokens", "req-1", 123_456, 60)).toBe(
			buildThresholdAlertId("request_tokens", "req-1", 3_600_000 - 1, 60),
		);
		expect(
			buildThresholdAlertId("request_tokens", "req-1", 3_600_000, 60),
		).not.toBe(
			buildThresholdAlertId("request_tokens", "req-1", 3_600_000 - 1, 60),
		);
	});

	test("shouldFireAlert respects disabled and threshold values", () => {
		expect(shouldFireAlert(0, 50)).toBe(false);
		expect(shouldFireAlert(10, 9)).toBe(false);
		expect(shouldFireAlert(10, 10)).toBe(true);
		expect(shouldFireAlert(10, 11)).toBe(true);
	});

	test("buildRequestTokenAlert returns null below threshold", () => {
		expect(
			buildRequestTokenAlert(
				{
					id: "req-1",
					timestamp: "2026-06-10T10:00:00.000Z",
					method: "POST",
					path: "/v1/messages",
					accountUsed: "acct",
					statusCode: 200,
					success: true,
					errorMessage: null,
					responseTimeMs: 100,
					failoverAttempts: 0,
					totalTokens: 49_999,
				},
				CONFIG,
			),
		).toBeNull();
	});

	test("buildRequestTokenAlert emits a critical alert at threshold", () => {
		const alert = buildRequestTokenAlert(
			{
				id: "req-2",
				timestamp: "2026-06-10T10:00:00.000Z",
				method: "POST",
				path: "/v1/messages",
				accountUsed: "acct",
				statusCode: 200,
				success: true,
				errorMessage: null,
				responseTimeMs: 100,
				failoverAttempts: 0,
				model: "model-a",
				project: "proj",
				totalTokens: 50_000,
			},
			CONFIG,
		) as AlertEvent;

		expect(alert.type).toBe("request_tokens");
		expect(alert.severity).toBe("critical");
		expect(alert.value).toBe(50_000);
		expect(alert.threshold).toBe(50_000);
		expect(alert.requestId).toBe("req-2");
		expect(alert.model).toBe("model-a");
		expect(alert.project).toBe("proj");
		expect(alert.acknowledged).toBe(false);
	});
});

describe("usage-window alert helpers", () => {
	test("buildUsageWindowAlertId is stable for the same window cycle regardless of poll timestamp", () => {
		const first = buildUsageWindowAlertId(
			"usage_window_threshold",
			"acct-1",
			"five_hour",
			1_800_000_000_000,
		);
		const second = buildUsageWindowAlertId(
			"usage_window_threshold",
			"acct-1",
			"five_hour",
			1_800_000_000_000,
		);
		expect(first).toBe(second);
	});

	test("buildUsageWindowAlertId re-arms when resets_at changes (new window cycle)", () => {
		const cycleOne = buildUsageWindowAlertId(
			"usage_window_threshold",
			"acct-1",
			"five_hour",
			1_800_000_000_000,
		);
		const cycleTwo = buildUsageWindowAlertId(
			"usage_window_threshold",
			"acct-1",
			"five_hour",
			1_800_018_000_000, // +5h
		);
		expect(cycleOne).not.toBe(cycleTwo);
	});

	test("buildUsageWindowAlertId distinguishes account, window, and alert type", () => {
		const base = buildUsageWindowAlertId(
			"usage_window_threshold",
			"acct-1",
			"five_hour",
			1_800_000_000_000,
		);
		expect(
			buildUsageWindowAlertId(
				"usage_window_threshold",
				"acct-2",
				"five_hour",
				1_800_000_000_000,
			),
		).not.toBe(base);
		expect(
			buildUsageWindowAlertId(
				"usage_window_threshold",
				"acct-1",
				"seven_day",
				1_800_000_000_000,
			),
		).not.toBe(base);
		expect(
			buildUsageWindowAlertId(
				"usage_window_exhaustion_projected",
				"acct-1",
				"five_hour",
				1_800_000_000_000,
			),
		).not.toBe(base);
	});
});

function baseRequest(
	overrides: Partial<RequestResponse> = {},
): RequestResponse {
	return {
		id: "req-drift",
		timestamp: "2026-07-24T10:00:00.000Z",
		method: "POST",
		path: "/v1/messages",
		accountUsed: "acct",
		statusCode: 200,
		success: true,
		errorMessage: null,
		responseTimeMs: 100,
		failoverAttempts: 0,
		...overrides,
	};
}

const DRIFT_TIMESTAMP = 1_800_000_000_000;

describe("model_routing_drift: stale_policy (Opus 5 incident)", () => {
	test("fires when the stored policy pins the family's current latest model away from itself", () => {
		const request = baseRequest({
			comboModelOverride: {
				// Must be whatever is CURRENTLY the latest opus: the predicate
				// under test only fires when `from` is the family's latest, so
				// pinning a released ID here silently stops testing anything
				// the next time LATEST_MODEL_BY_FAMILY advances.
				from: LATEST_MODEL_BY_FAMILY.opus,
				to: CLAUDE_MODEL_IDS.OPUS_4_8,
			},
		});
		const alert = buildStalePolicyDriftAlert(
			request,
			CONFIG,
			DRIFT_TIMESTAMP,
		) as AlertEvent;

		expect(alert).not.toBeNull();
		expect(alert.type).toBe("model_routing_drift");
		// warning, not critical: this predicate also matches a deliberate
		// pinned-fallback slot, so critical would fire on supported config.
		expect(alert.severity).toBe("warning");
		expect(alert.id).toBe(
			buildThresholdAlertId(
				"model_routing_drift",
				`stale_policy:opus:${CLAUDE_MODEL_IDS.OPUS_4_8}`,
				DRIFT_TIMESTAMP,
				CONFIG.cooldownMinutes,
			),
		);
		expect(alert.message).toContain(
			`opus routing policy rewrites ${LATEST_MODEL_BY_FAMILY.opus} -> ${CLAUDE_MODEL_IDS.OPUS_4_8}`,
		);
		expect(alert.message).toContain(
			`${LATEST_MODEL_BY_FAMILY.opus} is the current latest opus model`,
		);
		// The message must NOT assert staleness as fact: a deliberate pinned
		// fallback slot produces this exact shape, so the wording has to offer
		// both readings (severity is asserted above).
		expect(alert.message).toContain(
			"If this combo is meant to track the latest model",
		);
		expect(alert.message).toContain("deliberate pin, no action is needed");
		expect(alert.message).toContain("'opus' alias");
		expect(alert.model).toBe(CLAUDE_MODEL_IDS.OPUS_4_8);
		expect(alert.requestId).toBe(request.id);
		expect(alert.acknowledged).toBe(false);
	});

	test("is silent for a healthy upgrade (rewrite lands ON the family's latest)", () => {
		const request = baseRequest({
			comboModelOverride: {
				from: CLAUDE_MODEL_IDS.OPUS_4_8,
				to: CLAUDE_MODEL_IDS.OPUS_5,
			},
		});
		expect(
			buildStalePolicyDriftAlert(request, CONFIG, DRIFT_TIMESTAMP),
		).toBeNull();
		expect(
			buildModelRoutingDriftAlerts(request, CONFIG, DRIFT_TIMESTAMP),
		).toEqual([]);
	});

	test("is silent for an intentional cross-family fallback from latest Fable to Opus", () => {
		const request = baseRequest({
			comboModelOverride: {
				from: CLAUDE_MODEL_IDS.FABLE_5,
				to: CLAUDE_MODEL_IDS.OPUS_5,
			},
		});

		expect(
			buildStalePolicyDriftAlert(request, CONFIG, DRIFT_TIMESTAMP),
		).toBeNull();
		expect(
			buildModelRoutingDriftAlerts(request, CONFIG, DRIFT_TIMESTAMP),
		).toEqual([]);
	});

	test("is silent for agent-preference rewrites (comboModelOverride null) even when original/applied differ", () => {
		const request = baseRequest({
			comboModelOverride: null,
			originalModel: CLAUDE_MODEL_IDS.SONNET_5,
			appliedModel: CLAUDE_MODEL_IDS.OPUS_5,
			model: CLAUDE_MODEL_IDS.OPUS_5,
		});
		expect(
			buildModelRoutingDriftAlerts(request, CONFIG, DRIFT_TIMESTAMP),
		).toEqual([]);
	});
});

describe("model_routing_drift: unknown_model (day-0 catalog gap)", () => {
	test("fires for a plausibly-shaped model missing from CLAUDE_MODEL_IDS", () => {
		const request = baseRequest({ model: "claude-opus-6" });
		const alert = buildUnknownModelDriftAlert(
			request,
			CONFIG,
			DRIFT_TIMESTAMP,
		) as AlertEvent;

		expect(alert).not.toBeNull();
		expect(alert.type).toBe("model_routing_drift");
		expect(alert.severity).toBe("warning");
		expect(alert.message).toContain(
			"clients are requesting claude-opus-6 (family opus)",
		);
		expect(alert.message).toContain("missing from the bundled model catalog");
		// Well-formed ids get the pass-through wording, but it must not overclaim:
		// a cross-family fallback slot or a version-pinned account can still send
		// an older model instead of this one (see PR #362 review finding).
		expect(alert.message).toContain(
			"a same-family bare-alias route now passes a well-formed id like this straight through",
		);
		expect(alert.message).toContain(
			"a cross-family fallback slot or a version-pinned account can still send an older model instead",
		);
		expect(alert.message).not.toContain(
			"routing already passes this id straight through to the account",
		);
		expect(alert.message).toContain(
			"offline pricing, list-price eras, and pickers don't recognize it yet",
		);
		expect(alert.message).toContain(
			"bump CLAUDE_MODEL_IDS/LATEST_* in packages/core/src/models.ts and deploy",
		);
		expect(alert.model).toBe("claude-opus-6");
	});

	test("malformed id does not claim pass-through occurred (PR #362 review finding)", () => {
		// claude-opus-6-preview fires the (looser) CLAUDE_MODEL_SHAPE_RE alert
		// trigger but fails isWellFormedConcreteClaudeModelId, so the
		// pass-through feature itself still rewrites it to LATEST_MODEL_BY_FAMILY
		// — the alert text must say so, not claim the id reaches the account
		// unmodified.
		const request = baseRequest({ model: "claude-opus-6-preview" });
		const alert = buildUnknownModelDriftAlert(
			request,
			CONFIG,
			DRIFT_TIMESTAMP,
		) as AlertEvent;

		expect(alert).not.toBeNull();
		expect(alert.message).toContain(
			"clients are requesting claude-opus-6-preview (family opus)",
		);
		expect(alert.message).toContain("missing from the bundled model catalog");
		expect(alert.message).not.toContain(
			"routing already passes this id straight through to the account",
		);
		expect(alert.message).not.toContain("passes a well-formed id");
		expect(alert.message).toContain(
			"doesn't match the pass-through shape guard",
		);
		expect(alert.message).toContain(
			"a bare-alias route can still silently rewrite it to the family's latest model",
		);
		expect(alert.message).toContain(
			"bump CLAUDE_MODEL_IDS/LATEST_* in packages/core/src/models.ts and deploy",
		);
	});

	test("dedupes distinct unknown model strings in the same family into one cooldown bucket", () => {
		const requestA = buildUnknownModelDriftAlert(
			baseRequest({ id: "req-a", model: "claude-opus-6" }),
			CONFIG,
			DRIFT_TIMESTAMP,
		) as AlertEvent;
		const requestB = buildUnknownModelDriftAlert(
			baseRequest({ id: "req-b", model: "claude-opus-6-preview" }),
			CONFIG,
			DRIFT_TIMESTAMP,
		) as AlertEvent;

		expect(requestA).not.toBeNull();
		expect(requestB).not.toBeNull();
		// Scope is the family alone (not the literal requested string), so a
		// misbehaving client appending random suffixes cannot flood alerts.
		expect(requestA.id).toBe(requestB.id);
		expect(requestA.id).toBe(
			buildThresholdAlertId(
				"model_routing_drift",
				"unknown_model:opus",
				DRIFT_TIMESTAMP,
				CONFIG.cooldownMinutes,
			),
		);
	});

	test("uses the pre-override (client-requested) model when a rewrite occurred", () => {
		const request = baseRequest({
			model: CLAUDE_MODEL_IDS.OPUS_5,
			originalModel: "claude-opus-6",
			appliedModel: CLAUDE_MODEL_IDS.OPUS_5,
		});
		const alert = buildUnknownModelDriftAlert(
			request,
			CONFIG,
			DRIFT_TIMESTAMP,
		) as AlertEvent;
		expect(alert).not.toBeNull();
		expect(alert.model).toBe("claude-opus-6");
	});

	test("never fires for a known CLAUDE_MODEL_IDS value", () => {
		const request = baseRequest({ model: CLAUDE_MODEL_IDS.OPUS_5 });
		expect(
			buildUnknownModelDriftAlert(request, CONFIG, DRIFT_TIMESTAMP),
		).toBeNull();
		const request2 = baseRequest({ model: CLAUDE_MODEL_IDS.SONNET_4_5 });
		expect(
			buildUnknownModelDriftAlert(request2, CONFIG, DRIFT_TIMESTAMP),
		).toBeNull();
		const request3 = baseRequest({ model: "claude-fable-5-1" });
		expect(
			buildUnknownModelDriftAlert(request3, CONFIG, DRIFT_TIMESTAMP),
		).toBeNull();
	});

	test("never fires for a garbage string that merely contains a family substring", () => {
		// getModelFamily() is a substring match and would say "opus" here;
		// the shape guard (CLAUDE_MODEL_SHAPE_RE) must reject it first.
		const request = baseRequest({ model: "my-opus-experiment" });
		expect(
			buildUnknownModelDriftAlert(request, CONFIG, DRIFT_TIMESTAMP),
		).toBeNull();
	});

	test("fires for an unknown served model when the requested one is known", () => {
		const alerts = buildUnknownModelDriftAlerts(
			baseRequest({
				originalModel: CLAUDE_MODEL_IDS.OPUS_5,
				model: "claude-opus-6",
			}),
			CONFIG,
			DRIFT_TIMESTAMP,
		);
		expect(alerts).toHaveLength(1);
		const [alert] = alerts as [AlertEvent];
		expect(alert.model).toBe("claude-opus-6");
		expect(alert.message).toContain(
			"responses report claude-opus-6 (family opus)",
		);
		expect(alert.message).toContain(
			"bump CLAUDE_MODEL_IDS/LATEST_* in packages/core/src/models.ts and deploy",
		);
	});

	test("fires for an unknown advisor model on an otherwise known request", () => {
		// The 2026-11-09 case: the Claude Code advisor called a new Fable model
		// before it was registered, and its cost went unrecorded.
		const request = baseRequest({
			model: CLAUDE_MODEL_IDS.OPUS_5,
			advisorModels: ["claude-fable-6"],
		});
		const alerts = buildUnknownModelDriftAlerts(
			request,
			CONFIG,
			DRIFT_TIMESTAMP,
		);
		expect(alerts.map((a) => a.model)).toEqual(["claude-fable-6"]);
		expect(alerts[0]?.message).toContain(
			"advisor calls use claude-fable-6 (family fable)",
		);
		expect(
			buildModelRoutingDriftAlerts(request, CONFIG, DRIFT_TIMESTAMP).map(
				(a) => a.id,
			),
		).toEqual(alerts.map((a) => a.id));
	});

	test("reports one alert per family across requested, served and advisor models", () => {
		const alerts = buildUnknownModelDriftAlerts(
			baseRequest({
				originalModel: "claude-opus-6",
				model: "claude-opus-6-preview",
				advisorModels: ["claude-fable-6", "claude-fable-6"],
			}),
			CONFIG,
			DRIFT_TIMESTAMP,
		);
		expect(alerts.map((a) => [a.model, a.id])).toEqual([
			[
				"claude-opus-6",
				buildThresholdAlertId(
					"model_routing_drift",
					"unknown_model:opus",
					DRIFT_TIMESTAMP,
					CONFIG.cooldownMinutes,
				),
			],
			[
				"claude-fable-6",
				buildThresholdAlertId(
					"model_routing_drift",
					"unknown_model:fable",
					DRIFT_TIMESTAMP,
					CONFIG.cooldownMinutes,
				),
			],
		]);
	});

	test("fires for a Claude model in a family this build does not know", () => {
		const alert = buildUnknownModelDriftAlert(
			baseRequest({ model: "claude-mythos-6" }),
			CONFIG,
			DRIFT_TIMESTAMP,
		) as AlertEvent;
		expect(alert).not.toBeNull();
		expect(alert.id).toBe(
			buildThresholdAlertId(
				"model_routing_drift",
				"unknown_model:other",
				DRIFT_TIMESTAMP,
				CONFIG.cooldownMinutes,
			),
		);
		expect(alert.message).toContain(
			"clients are requesting claude-mythos-6, a Claude model family this build does not recognize",
		);
		expect(alert.message).not.toContain("family's latest model");
	});

	test("never fires for route-profile and quality-auto picker ids", () => {
		// About 200k production requests a week carry these as originalModel;
		// a looser shape gate would raise an hourly unknown_model:other alert.
		for (const model of [
			"claude-bccf-route-pro-primary-sol",
			"claude-bccf-route-glm-5-2-bounded-v1",
			"claude-bccf-route-codex-pool-astra",
			"claude-bccf-quality-auto",
		]) {
			expect(
				buildUnknownModelDriftAlerts(
					baseRequest({ originalModel: model, model: CLAUDE_MODEL_IDS.OPUS_5 }),
					CONFIG,
					DRIFT_TIMESTAMP,
				),
			).toEqual([]);
		}
	});
});

describe("cooldown scope encoding", () => {
	// encodeScopePart length-prefixes each part of a cooldown scope and
	// encodes "no value" as length 0. These cases used to ride on the retired
	// anomaly sweep (greptile review follow-ups to #411); a Codex route alert
	// builds its scope from the same encoder.
	const routeAlert = (profileId: string, accountId?: string) =>
		buildCodexRouteRoleUnavailableAlert(
			{
				type: "route_role_unavailable",
				profileId,
				...(accountId === undefined ? {} : { accountId }),
				reason: "catalog_role_unavailable",
			},
			null,
			0,
			60,
		).id;

	test("a missing account does not share a bucket with an account named like a display fallback", () => {
		expect(routeAlert("profile")).not.toBe(routeAlert("profile", "Unknown"));
	});

	test("a missing account does not share a bucket with a NUL character, which a sentinel would alias", () => {
		expect(routeAlert("profile")).not.toBe(routeAlert("profile", "\u0000"));
	});

	test("a separator inside one part cannot alias two different parts", () => {
		// Joined without a length prefix, both read "a:b:".
		expect(routeAlert("a:b")).not.toBe(routeAlert("a", "b:"));
	});

	test("the same parts keep one stable bucket", () => {
		expect(routeAlert("profile", "account")).toBe(
			routeAlert("profile", "account"),
		);
	});
});

describe("retired anomaly alert types (7.0.0, #1012)", () => {
	const ENV_KEYS = ["ALERT_ANOMALY_ENABLED", "ALERT_WEBHOOK_TYPES"] as const;
	const savedEnv = Object.fromEntries(
		ENV_KEYS.map((key) => [key, process.env[key]]),
	);
	const directories: string[] = [];

	beforeEach(() => {
		for (const key of ENV_KEYS) delete process.env[key];
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		for (const directory of directories.splice(0))
			rmSync(directory, { recursive: true, force: true });
	});

	function realConfig(data: Record<string, unknown>): Config {
		const directory = mkdtempSync(join(tmpdir(), "alerts-retired-anomaly-"));
		directories.push(directory);
		const path = join(directory, "config.json");
		writeFileSync(path, JSON.stringify(data));
		return new Config(path);
	}

	test("an allowlist naming only anomaly types stays non-empty, so it does not deliver every type", () => {
		const allowed = realConfig({
			alert_webhook_types: "anomaly_token_outlier",
		}).getAlertWebhookTypes();
		expect(allowed).toEqual(["anomaly_token_outlier"]);
		expect(isAlertTypeAllowedForWebhook("auth_failure", allowed)).toBe(false);
		expect(isAlertTypeAllowedForWebhook("anomaly_token_outlier", allowed)).toBe(
			true,
		);
	});

	test("a config that still turns the sweep on starts only the cache health timer", async () => {
		process.env.ALERT_ANOMALY_ENABLED = "true";
		const config = realConfig({
			alert_anomaly_enabled: true,
			alert_anomaly_interval_minutes: 5,
		});
		const sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		const service = new AlertService(new BunSqlAdapter(sqlite), config);
		const originalSetInterval = globalThis.setInterval;
		const periods: number[] = [];
		globalThis.setInterval = ((_callback: () => void, ms?: number) => {
			periods.push(ms ?? 0);
			const handle = originalSetInterval(() => {}, 1 << 30);
			handle.unref?.();
			return handle;
		}) as unknown as typeof setInterval;
		try {
			service.start();
			// The removed sweep added a 5-minute timer here.
			expect(periods).toEqual([CACHE_HEALTH_INTERVAL_MS]);
		} finally {
			globalThis.setInterval = originalSetInterval;
			await service.stop();
			sqlite.close();
		}
	});

	test("a stored anomaly alert still lists with its type, and its project is sanitised on the way out", async () => {
		const sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		const adapter = new BunSqlAdapter(sqlite);
		const service = new AlertService(adapter, realConfig({}));
		try {
			await adapter.run(
				`INSERT INTO alerts
					(id, timestamp, type, severity, title, message, value, threshold,
					 account, model, project, request_id, acknowledged)
				 VALUES (?, ?, 'anomaly_runaway_loop', 'warning', 'Possible runaway loop',
					'Stored before 7.0.0', 30, NULL, 'acct', 'model-a', ?, NULL, 0)`,
				[
					"stored-anomaly-alert",
					1_800_000_000_000,
					"repo\u001b[31m-frontend\u0000 \n prompt",
				],
			);
			const alerts = await service.listAlerts();
			expect(alerts).toHaveLength(1);
			expect(alerts[0]?.type).toBe("anomaly_runaway_loop");
			expect(alerts[0]?.project).toBe("repo-frontend prompt");
		} finally {
			await service.stop();
			sqlite.close();
		}
	});
});
