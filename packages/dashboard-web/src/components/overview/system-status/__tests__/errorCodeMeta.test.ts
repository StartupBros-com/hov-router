import { describe, expect, test } from "bun:test";
import { getErrorMeta } from "../errorCodeMeta";

const FALLBACK_DESCRIPTION =
	"No additional context is available for this error code.";

// Every value the router writes to `requests.error_message`, which is what
// Recent Errors groups by (#918). Sources: the local terminal kinds recorded in
// packages/proxy/src/proxy.ts (recordLocalRoutingTerminal, including
// `force_route_${reason}` and `server_tool_${reason}`), the attempt-cause
// rewrite of route_unavailable in packages/proxy/src/routing-terminal-recorder.ts,
// response-handler.ts (midstream errors, EOF, downstream cancel, raw transport
// text), usage-collector.ts (`responses_${terminal}`), anthropic-precommit-rescue.ts,
// and upstream-error-observability.ts (`upstream_http_<status>`).
const ROUTER_CODES = [
	// Local terminal kinds.
	"route_unavailable",
	"pool_exhausted",
	"model_pool_exhausted",
	"selection_timeout",
	"inventory_failed",
	"predictive_throttle",
	"physical_attempt_budget_exhausted",
	"count_tokens_unsupported",
	"combo_session_fallback_disabled",
	"force_model_denied",
	// Last-attempt causes that replace route_unavailable.
	"accepted_request_deadline",
	"meaningful_progress_timeout",
	"semantic_timeout",
	"buffer_limit",
	"provider_cancelled",
	"maintenance_retired",
	"context_length_exceeded",
	"upstream_error",
	"transport_error",
	"client_cancelled",
	// Stream outcomes.
	"downstream_cancelled",
	"anthropic_incomplete_eof",
	"anthropic_rescue_commitment_deadline",
	"anthropic_rescue_non_sse_response",
	"anthropic_rescue_routing_error",
	"responses_error",
	"responses_truncated",
	"responses_client_cancelled",
	"anthropic_midstream_error:api_error",
	"anthropic_midstream_error:internal_server_error",
	"anthropic_midstream_error:invalid_request_error",
	"anthropic_midstream_error:overloaded_error",
	"anthropic_midstream_error:upstream_stream_read_error",
	"anthropic_midstream_error:unknown_error",
	// ForceRouteUnavailableReason (packages/proxy/src/handlers/account-selector.ts).
	"force_route_account_capacity_exhausted",
	"force_route_catalog_role_mismatch",
	"force_route_catalog_role_unavailable",
	"force_route_conflicting_force_route",
	"force_route_lookup_failed",
	"force_route_model_capacity_exhausted",
	"force_route_model_mapping_mismatch",
	"force_route_not_found",
	"force_route_paused",
	"force_route_provider_excluded",
	"force_route_provider_mismatch",
	"force_route_rate_limited_or_unavailable",
	// ServerToolRoutingErrorReason (packages/proxy/src/server-tool-routing-errors.ts).
	"server_tool_invalid_requirement",
	"server_tool_unsupported_requirement",
	"server_tool_no_implementation",
	"server_tool_replay_unavailable",
	"server_tool_temporary_unavailable",
	"server_tool_forced_incapable",
	"server_tool_forced_structurally_incapable",
	"server_tool_advisor_declaration_unavailable",
	"server_tool_advisor_history_unavailable",
	// Written only by the retired Auto quality lane; old rows still carry it.
	"quality_route_unavailable",
	// Forwarded provider failures, as stored in production.
	"upstream_http_403 type=api_error",
	"upstream_http_503",
	"upstream_http_400 type=invalid_request_error",
	"upstream_http_400 type=invalid_request_error code=cyber_policy",
	"upstream_http_502 type=upstream_stream_read_error",
	"upstream_http_529 type=overloaded_error",
	"upstream_http_504",
	"upstream_http_500",
	"upstream_http_529 type=overloaded_error code=server_is_overloaded",
	"upstream_http_503 type=no_db_connection code=503",
	// Raw runtime text from a stream that failed after it started.
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
	"The connection was closed.",
] as const;

describe("getErrorMeta: router codes (#918)", () => {
	test.each([
		...ROUTER_CODES,
	])("%s has a plain title and its own description", (code: string) => {
		const meta = getErrorMeta(code);
		expect(meta.title).not.toBe(code);
		expect(meta.title).not.toBe("Unknown error");
		expect(meta.title).not.toMatch(/_/);
		expect(meta.description).not.toBe(FALLBACK_DESCRIPTION);
		expect(meta.suggestion.length).toBeGreaterThan(0);
	});

	test("an unlisted member of each code family still gets a plain title", () => {
		for (const code of [
			"force_route_some_new_reason",
			"server_tool_some_new_reason",
			"anthropic_midstream_error:some_new_type",
			"responses_some_new_terminal",
			"upstream_http_418",
		]) {
			const meta = getErrorMeta(code);
			expect(meta.title).not.toBe(code);
			expect(meta.title).not.toMatch(/_/);
			expect(meta.description).not.toBe(FALLBACK_DESCRIPTION);
		}
	});

	test("an upstream_http value is read as a provider reply, not raw text", () => {
		const meta = getErrorMeta("upstream_http_403 type=api_error");
		expect(meta.title).toContain("403");
		expect(meta.description).toContain("api_error");
		expect(meta.description).not.toContain("upstream_http_403 type=api_error");
	});

	test("an upstream_http value names its provider code when one was stored", () => {
		const meta = getErrorMeta(
			"upstream_http_400 type=invalid_request_error code=cyber_policy",
		);
		expect(meta.description).toContain("invalid_request_error");
		expect(meta.description).toContain("cyber_policy");
	});

	test("an upstream_http value names the field the provider rejected (#324)", () => {
		const meta = getErrorMeta(
			"upstream_http_400 type=invalid_request_error code=unsupported_value param=input[0].type",
		);
		expect(meta.title).toContain("400");
		expect(meta.description).toContain("unsupported_value");
		expect(meta.description).toContain("rejected field input[0].type");
	});

	test("a midstream error names the stream's error type", () => {
		const meta = getErrorMeta("anthropic_midstream_error:overloaded_error");
		expect(meta.description).toContain("overloaded_error");
	});

	test("raw runtime text is quoted in the description", () => {
		const meta = getErrorMeta("The connection was closed.");
		expect(meta.description).toContain("The connection was closed.");
	});

	test("upstream_error names the windowless 429 and points at routing attempts", () => {
		const meta = getErrorMeta("upstream_error");
		const text = `${meta.description} ${meta.suggestion}`;
		// After #916 a windowless 429 usually ends here: the last account refused.
		expect(text).toContain("windowless 429");
		expect(text).toContain("Routing attempts");
	});

	// Each case below pins a producer fact the first #918 copy got wrong.
	test("upstream_error's title names the last account, not every account", () => {
		// The cause is the last attempt's (routing-terminal-recorder.ts); earlier
		// attempts may have failed some other way.
		const { title } = getErrorMeta("upstream_error");
		expect(title.toLowerCase()).not.toContain("every account");
		expect(title.toLowerCase()).toContain("last account");
	});

	test("maintenance_retired names the pre-commit abort and not a deploy", () => {
		// Recorded only from the pre-commit gate's abort with
		// GUARD_RECYCLE_UNAVAILABLE (anthropic-semantic-preflight.ts,
		// routing-attempt-ledger.ts); nothing ties the recycle to a deploy.
		const { description } = getErrorMeta("maintenance_retired");
		expect(description.toLowerCase()).not.toContain("deploy");
		expect(description).toContain("checking the provider's reply");
	});

	test("route_unavailable allows the circuit-open reopen time", () => {
		// routing-terminal.ts adds next_available_at when every candidate is
		// circuit-open with a known reopen time.
		const { description } = getErrorMeta("route_unavailable");
		expect(description).toContain("circuit-open");
	});

	test("combo_session_fallback_disabled says native quota combos never fall back", () => {
		// isComboFallbackDisabled is true whenever a native quota context
		// exists, whatever the Combo Session Fallback switch says.
		const { suggestion } = getErrorMeta("combo_session_fallback_disabled");
		expect(suggestion).toContain("Wait for native Claude quota");
	});

	test("responses_error's title does not claim the provider reported it", () => {
		// usage-collector.ts also writes it for a failure with no recorded reason.
		const { title } = getErrorMeta("responses_error");
		expect(title.toLowerCase()).not.toContain("reported");
	});

	test("the advisor suggestion scopes the native-account advice to advisor on its own", () => {
		// proxy.ts also refuses advisor beside another server tool or with an
		// unknown advisor type, which no account fixes.
		const { suggestion } = getErrorMeta(
			"server_tool_advisor_declaration_unavailable",
		);
		expect(suggestion).toContain("on its own");
	});

	test("cancellations and Claude Code-recoverable refusals are warnings", () => {
		for (const code of [
			"client_cancelled",
			"downstream_cancelled",
			"responses_client_cancelled",
			"server_tool_advisor_declaration_unavailable",
			"server_tool_advisor_history_unavailable",
		]) {
			expect(getErrorMeta(code).severity).toBe("warning");
		}
	});

	test("object prototype names fall back like any unknown code", () => {
		for (const code of [
			"constructor",
			"toString",
			"__proto__",
			"hasOwnProperty",
		]) {
			const meta = getErrorMeta(code);
			expect(meta.title).toBe(code);
			expect(meta.description).toBe(FALLBACK_DESCRIPTION);
		}
	});

	test("an unknown snake_case code keeps its raw title", () => {
		expect(getErrorMeta("some_future_router_code").title).toBe(
			"some_future_router_code",
		);
	});
});

describe("getErrorMeta", () => {
	test("unknown code returns fallback meta with the code as title", () => {
		const meta = getErrorMeta("totally_unknown_code");
		expect(meta.title).toBe("totally_unknown_code");
		expect(meta.severity).toBe("error");
	});

	test("org_permission_denied points at billing before org settings", () => {
		const meta = getErrorMeta("org_permission_denied");
		expect(meta.description).toContain("payment");
		expect(meta.suggestion).toContain("billing");
		expect(meta.suggestion).toContain("Claude Code access");
	});

	test("org_permission_denied no longer says waiting cannot clear it (#918)", () => {
		const meta = getErrorMeta("org_permission_denied");
		const text = `${meta.description} ${meta.suggestion}`;
		// 2026-11-16: the denial cleared once the payment went through, with no
		// router action.
		expect(text).not.toContain("does not clear it");
		expect(text).toContain("clears once the payment goes through");
	});

	test("windowless_429 states only what production measured (#918)", () => {
		const meta = getErrorMeta("windowless_429");
		const text = `${meta.description} ${meta.suggestion}`.toLowerCase();
		// Claude Code's own retry succeeded for most of these within 2 minutes.
		expect(text).not.toContain("neither retrying");
		expect(text).not.toContain("has to start a new request");
		expect(text).toContain("retries");
		// No measured evidence ties these to the request's size or timing.
		expect(text).not.toContain("payload");
		expect(text).not.toContain("start-up");
		expect(text).not.toContain("session start");
		expect(text).toContain("cause is not known");
		// What did hold: no other subscription account accepted one.
		expect(text).toContain("adding accounts does not help");
	});

	test("model_fallback_429 with no context defaults to a warning that points at Model Mappings", () => {
		const meta = getErrorMeta("model_fallback_429");
		expect(meta.severity).toBe("warning");
		expect(meta.suggestion).toContain("Model Mappings");
	});

	test("model_fallback_429 with anthropic provider replaces the suggestion with the OAuth-friendly copy", () => {
		const meta = getErrorMeta("model_fallback_429", { provider: "anthropic" });
		expect(meta.suggestion).toContain("No action needed");
	});

	test("model_fallback_429 with anthropic provider and no other accounts upgrades severity and prefixes description", () => {
		const meta = getErrorMeta("model_fallback_429", {
			provider: "anthropic",
			otherAccountsAvailable: false,
		});
		expect(meta.severity).toBe("error");
		expect(meta.description.startsWith("No other accounts are available")).toBe(
			true,
		);
	});

	test("model_fallback_429 with multi-model provider keeps default suggestion and warning severity", () => {
		const meta = getErrorMeta("model_fallback_429", {
			provider: "zai",
			otherAccountsAvailable: true,
		});
		expect(meta.severity).toBe("warning");
		expect(meta.suggestion).toContain("Model Mappings");
	});

	test("upstream_429_with_reset entry stays unchanged", () => {
		const meta = getErrorMeta("upstream_429_with_reset");
		expect(meta.title).toBe("Provider rate limit");
		expect(meta.severity).toBe("warning");
	});

	test("upstream_402_payment_required explains account-scoped billing failover", () => {
		const meta = getErrorMeta("upstream_402_payment_required");
		expect(meta.title).toBe("Account payment required");
		expect(meta.severity).toBe("error");
		expect(meta.description).toContain("402");
		expect(meta.description).toContain("bounded probe cooldown");
		expect(meta.description).toContain("fails over");
		expect(meta.description).toContain("without disabling");
		expect(meta.suggestion).toContain("billing or credits");
	});

	test("upstream_529_overloaded_with_reset returns provider overload warning", () => {
		const meta = getErrorMeta("upstream_529_overloaded_with_reset");
		expect(meta.title).toBe("Provider overload");
		expect(meta.severity).toBe("warning");
		expect(meta.description).toContain("529");
		// Since commit 657ea702, the mid-stream sniffer routes overloaded_error
		// through upstream_529_overloaded_no_reset (no synthetic resetTime) —
		// this reason's only remaining producer is a real Retry-After header
		// from response-processor.ts, so the description must NOT claim a
		// mid-stream path it can no longer produce.
		expect(meta.description).not.toContain("mid-stream");
		expect(meta.suggestion).toContain("automatically");
	});

	test("upstream_529_overloaded_no_reset returns provider overload (no Retry-After) warning", () => {
		const meta = getErrorMeta("upstream_529_overloaded_no_reset");
		expect(meta.title).toBe("Provider overload (no Retry-After)");
		expect(meta.severity).toBe("warning");
		expect(meta.description).toContain("529");
		// This reason now covers the mid-stream overloaded_error path too (see
		// above) — the description must acknowledge it so a dashboard reader
		// doesn't assume this code is only about a headerless HTTP 529.
		expect(meta.description).toContain("mid-stream");
		// This path is the 10s single-flight probe cooldown
		// (CCFLARE_OVERLOAD_COOLDOWN_MS), not the 429 no-reset default
		// (CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS, 60s) — a prior revision named
		// the wrong env var and duration here.
		expect(meta.suggestion).toContain("CCFLARE_OVERLOAD_COOLDOWN_MS");
		expect(meta.suggestion).not.toContain(
			"CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS",
		);
	});

	test("out_of_credits surfaces model-scoped credit depletion as an error", () => {
		const meta = getErrorMeta("out_of_credits");
		expect(meta.title).toBe("Account out of credits");
		expect(meta.severity).toBe("error");
		expect(meta.description).toContain("out_of_credits");
		expect(meta.suggestion).toContain("credits");
	});

	test("xai_capacity_402 surfaces native xAI capacity exhaustion with recovery guidance (R5-R10)", () => {
		const meta = getErrorMeta("xai_capacity_402");
		expect(meta.title).not.toBe("xai_capacity_402");
		expect(meta.severity).toBe("error");
		expect(meta.description.toLowerCase()).toContain("402");
		expect(meta.suggestion.length).toBeGreaterThan(0);
	});
});
