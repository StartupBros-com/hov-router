import type {
	RateLimitReason,
	RoutingAttemptCause,
} from "@better-ccflare/types";

export type ErrorSeverity = "warning" | "error";

export interface ErrorMeta {
	title: string;
	description: string;
	suggestion: string;
	severity: ErrorSeverity;
}

export interface ErrorContext {
	provider?: string | null;
	otherAccountsAvailable?: boolean;
}

const KNOWN_ERROR_META: Record<
	Exclude<RateLimitReason, "model_fallback_429">,
	ErrorMeta
> = {
	upstream_429_with_reset: {
		title: "Provider rate limit",
		description: "The upstream provider returned 429 with a known reset time.",
		suggestion: "The account will recover automatically at the reset time.",
		severity: "warning",
	},
	upstream_429_no_reset_probe_cooldown: {
		title: "Provider rate limit (no reset)",
		description:
			"The upstream provider returned 429 without a reset header; entering probe cooldown.",
		suggestion:
			"Cooldown defaults to 60s. Set `CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS` in your environment to change it.",
		severity: "warning",
	},
	upstream_402_payment_required: {
		title: "Account payment required",
		description:
			"The upstream provider returned 402 for this account. The proxy applies a bounded probe cooldown and fails over without disabling the account.",
		suggestion:
			"Restore this account's billing or credits; other eligible accounts remain available for traffic.",
		severity: "error",
	},
	upstream_429_no_reset_default_5h: {
		title: "Provider rate limit (legacy 5h ban)",
		description:
			"Legacy ban from better-ccflare ≤ v3.5.x, before HoV Router. No longer emitted by current code.",
		suggestion: "Historical record — no action needed.",
		severity: "warning",
	},
	all_models_exhausted_429: {
		title: "All fallback models rate-limited",
		description: "Every fallback model also returned 429.",
		suggestion: "Wait for cooldown, or add more diverse fallback models.",
		severity: "error",
	},
	model_scoped_429: {
		title: "Model family capacity exhausted",
		description:
			"Fresh Anthropic usage evidence proved this 429 is limited to the attempted model family. The account remains available for other families.",
		suggestion:
			"No action needed — matching traffic will fail over until the scoped reset or evidence expiry, while other models continue using this account.",
		severity: "warning",
	},
	upstream_529_overloaded_with_reset: {
		title: "Provider overload",
		description:
			"The upstream provider returned 529 (overloaded) with a Retry-After header. Account temporarily cooled down for that duration.",
		suggestion:
			"No action needed — the account will recover automatically. Traffic will shift to other configured accounts in the meantime.",
		severity: "warning",
	},
	upstream_529_overloaded_no_reset: {
		title: "Provider overload (no Retry-After)",
		description:
			"The upstream provider returned 529 (overloaded) without a Retry-After header; entering probe cooldown. This also covers mid-stream overloaded_error detections, which never carry a Retry-After header — HTTP headers were already sent before the error occurred in that path.",
		suggestion:
			"Cooldown defaults to 10s and pairs with a single-flight recovery probe (only one request re-probes the account once it expires, as long as another account is available to defer to — if every account is currently suppressed, the request runs ungated instead). Set `CCFLARE_OVERLOAD_COOLDOWN_MS` in your environment to change it.",
		severity: "warning",
	},
	out_of_credits: {
		title: "Account out of credits",
		description:
			"Anthropic returned 429 with `overage-disabled-reason: out_of_credits` — credits/overage for a specific model/beta (e.g. context-1m) is depleted. This is model-scoped, so the account stays in rotation for other models and the request fails over automatically.",
		suggestion:
			"Top up the account's credits or raise its overage allowance. Meanwhile, traffic for other models continues to use this account, and the rejected model shifts to other accounts.",
		severity: "error",
	},
	windowless_429: {
		title: "Request rejected (no rate-limit window)",
		description:
			"Anthropic returned 429 with `x-should-retry: true` and no rate-limit " +
			"window: no `retry-after` and no `anthropic-ratelimit-*` header. The " +
			"same account kept serving other requests, so the router does not " +
			"bench it. No other subscription account accepted a request rejected " +
			"this way (0 of 16,016 between 2026-10-16 and 2026-11-20), so the " +
			"router stops trying the request on them; other providers and API-key " +
			"accounts are still tried. The cause is not known. These arrive in " +
			"bursts across accounts and unrelated conversations.",
		suggestion:
			"No action needed on the accounts: they stay in rotation. Claude Code " +
			"retries the request itself, and in the 7 days to 2026-11-20, 2,603 " +
			"of 3,490 runs of these in a session were followed by a success " +
			"within 2 minutes. Adding accounts does not help.",
		severity: "warning",
	},
	extra_usage_exhausted: {
		title: "Extra usage credits depleted",
		description:
			"Anthropic returned 400 invalid_request_error: this OAuth account's " +
			"extra-usage credit balance is $0. Anthropic bills third-party-app " +
			"traffic on Claude OAuth accounts from a separate extra-usage pool, " +
			"not the plan's included quota — Haiku requests may still succeed " +
			"since routing/exemption can differ by model.",
		suggestion:
			"Add credits or enable auto-reload at claude.ai/settings/usage. This " +
			"is an Anthropic billing state, not a proxy failure — the account " +
			"stays in rotation and the request is passed through unchanged.",
		severity: "error",
	},
	xai_capacity_402: {
		title: "xAI capacity exhausted",
		description:
			"xAI returned 402 (Grok Build credits exhausted) on this account. " +
			"XaiProvider classifies this distinctly from a generic 429 so it " +
			"cannot be mistaken for a Retry-After rate limit; the account is " +
			"cooled down and the request fails over to another account.",
		suggestion:
			"Add Grok Build credits or raise the account's spending limit at " +
			"console.x.ai/team/billing. The account stays in rotation and " +
			"recovers automatically on the next successful request.",
		severity: "error",
	},
	org_permission_denied: {
		title: "Organization denied this account",
		description:
			"Anthropic returned 403 permission_error for this account. Nothing " +
			"about its own quota is wrong — the organization that owns it " +
			"forbids the request: after a failed payment, or because an admin " +
			"disabled OAuth apps or Claude Code subscription access. The account " +
			"is benched and the request fails over to another account.",
		suggestion:
			"Check the account's billing on claude.ai first: a failed payment " +
			"causes this, and the denial clears once the payment goes through " +
			"(on 2026-11-16 an account served again with no router action). " +
			"Otherwise an organization admin has to re-enable OAuth app or Claude " +
			"Code access. The router keeps retrying the account on its own, so " +
			"nothing needs resetting here once the cause is fixed.",
		severity: "error",
	},
};

function getModelFallbackMeta(context?: ErrorContext): ErrorMeta {
	const provider = context?.provider ?? null;
	const otherAccountsAvailable = context?.otherAccountsAvailable;

	const isOAuthOnlyProvider = provider === "anthropic" || provider === "codex";

	const suggestion = isOAuthOnlyProvider
		? "No action needed — Claude/Codex accounts only serve their native models, so the proxy will use the next account until this one recovers."
		: 'To retry on the same account before failing over, open this account\'s More actions → Model Mappings and add comma-separated alternates (e.g. "primary, fallback-1").';

	const baseDescription =
		"This account hit a 429 with only one model configured, so the proxy failed over to the next account in priority order.";

	if (otherAccountsAvailable === false) {
		return {
			title: "Account rate-limited — no in-account fallback",
			description: `No other accounts are available — requests will fail until this account recovers. ${baseDescription}`,
			suggestion,
			severity: "error",
		};
	}

	return {
		title: "Account rate-limited — no in-account fallback",
		description: baseDescription,
		suggestion,
		severity: "warning",
	};
}

/*
 * Recent Errors groups requests by their stored error (`requests.error_message`),
 * and the router writes its own codes there, not RateLimitReasons (#918). When
 * a request ends in the generic route_unavailable terminal after at least one
 * upstream attempt, the last attempt's cause replaces it
 * (packages/proxy/src/routing-terminal-recorder.ts), so those causes are keyed
 * by RoutingAttemptCause. `unknown` never replaces route_unavailable, and
 * `routing_rejected` needs zero attempts, so neither is ever stored.
 */
const ATTEMPT_CAUSE_META: Record<
	Exclude<RoutingAttemptCause, "unknown" | "routing_rejected">,
	ErrorMeta
> = {
	upstream_error: {
		title: "Refused by the last account tried",
		description:
			"The last account tried refused this request with an error the router " +
			"recognises, or its stream broke while the router was checking it, " +
			"and no other account could take the request. The refusals include a " +
			"windowless 429 from an Anthropic subscription account, after which " +
			"the router skips the other subscription accounts for that request; " +
			"a 429 scoped to a model, family or account; a 403 organization " +
			"denial; a 402 payment required; and an empty extra-usage balance. " +
			"This code does not say which one it was.",
		suggestion:
			"See Routing attempts on the Routing card for the reason each account " +
			"gave; each reason there has its own explanation. A windowless 429 " +
			"needs no action: Claude Code retries the request itself.",
		severity: "error",
	},
	transport_error: {
		title: "Could not reach the provider",
		description:
			"The attempt on the last account tried ended with an error that was " +
			"not a timeout, a cancellation or a recognised refusal, for example a " +
			"refused or dropped connection, and no other account could take the " +
			"request. This code does not keep the error text.",
		suggestion:
			"An occasional one is network noise. If they keep coming from one " +
			"account, check that provider's status and the network path to it.",
		severity: "error",
	},
	meaningful_progress_timeout: {
		title: "No output before the deadline",
		description:
			"The provider kept the stream open but sent no real content before the " +
			"request's meaningful-progress deadline, so the router ended the " +
			"attempt, and no other account could take the request.",
		suggestion:
			"A few are normal on slow providers. Many in a row point at an account " +
			"that accepts requests and then stalls. " +
			"`CCFLARE_ANTHROPIC_MEANINGFUL_PROGRESS_TIMEOUT_MS` sets the deadline.",
		severity: "error",
	},
	semantic_timeout: {
		title: "Provider stream went silent",
		description:
			"The provider's stream sent nothing valid for the whole idle window, so " +
			"the router ended the attempt, and no other account could take the " +
			"request.",
		suggestion:
			"If they repeat on one account, check that provider. " +
			"`CCFLARE_ANTHROPIC_PRECOMMIT_TIMEOUT_MS` sets the idle window " +
			"(120 seconds by default).",
		severity: "error",
	},
	buffer_limit: {
		title: "Stream over the size limit",
		description:
			"The provider's stream grew past a size limit the router enforces " +
			"before passing a response on (the pre-commit buffer, or the Codex " +
			"stream limit), so the attempt was stopped, and no other account could " +
			"take the request.",
		suggestion:
			"`CCFLARE_ANTHROPIC_PRECOMMIT_MAX_BUFFER_BYTES` sets the pre-commit " +
			"buffer limit. Repeated ones on ordinary requests are worth reporting " +
			"as a bug.",
		severity: "error",
	},
	provider_cancelled: {
		title: "Provider cancelled the stream",
		description:
			"The provider ended its stream with a cancellation before the response " +
			"reached the client, and no other account could take the request. The " +
			"provider did not say why.",
		suggestion:
			"An occasional one needs no action. If they repeat on one account, " +
			"check that provider's status.",
		severity: "error",
	},
	maintenance_retired: {
		title: "Ended by a backend restart",
		description:
			"The guard was replacing the router's backend and ended this request " +
			"while the router was still checking the provider's reply, before " +
			"any of it was passed to the client.",
		suggestion:
			"No action needed. These appear around deploys and restarts, and the " +
			"client can send the request again.",
		severity: "warning",
	},
	context_length_exceeded: {
		title: "Prompt too long for the model",
		description:
			"The provider reported that the request is longer than the model's " +
			"context window.",
		suggestion:
			"Compact or shorten the conversation, or use a model with a larger " +
			"context window.",
		severity: "warning",
	},
	accepted_request_deadline: {
		title: "Ran past the request time limit",
		description:
			"The guard gives every request it accepts a fixed amount of time. This " +
			"one used all of it before finishing, so the router ended it.",
		suggestion:
			"An occasional long request can hit this. Many at once point at slow " +
			"providers; check the request history for where the time went.",
		severity: "error",
	},
	client_cancelled: {
		title: "Client cancelled the request",
		description:
			"The client closed the request before it finished, for example when " +
			"someone interrupts Claude Code.",
		suggestion: "No action needed.",
		severity: "warning",
	},
};

/** Terminals the router builds itself, and stream outcomes it records. */
const ROUTER_ERROR_META: Record<string, ErrorMeta> = {
	route_unavailable: {
		title: "No account could take the request",
		description:
			"The router could not find an account to send this request to, for " +
			"example because every compatible account was paused, cooling down, " +
			"unable to serve the requested model or excluded by its route. Usually " +
			"no account has a known time when it will be free again; when every " +
			"candidate is circuit-open, the reply gives the time it reopens.",
		suggestion:
			"On the Accounts page, look for paused, cooling or reauth-needed " +
			"accounts, and check that an account serves the requested model. The " +
			"reply to the client usually lists each account with a short reason.",
		severity: "error",
	},
	pool_exhausted: {
		title: "All accounts busy for now",
		description:
			"Every compatible account that is not paused was rate-limited, cooling " +
			"down or out of capacity, and each has a known time when it can serve " +
			"again. The reply tells the client the earliest of those times.",
		suggestion:
			"Usually nothing to do: the first account comes back at that time. " +
			"More accounts shorten these waits.",
		severity: "warning",
	},
	model_pool_exhausted: {
		title: "No capacity left for this model",
		description:
			"Every account that serves the requested model has used up its limit " +
			"for that model or model family. Those accounts can still serve other " +
			"models.",
		suggestion:
			"Wait for the model's limit to reset, switch models, or add an account " +
			"that serves this model.",
		severity: "warning",
	},
	selection_timeout: {
		title: "Account selection timed out",
		description:
			"Choosing an account for this request took longer than the selection " +
			"deadline, so the router stopped before sending it anywhere.",
		suggestion:
			"Occasional ones point at a busy host. " +
			"`CCFLARE_ACCOUNT_SELECTION_TIMEOUT_MS` sets the deadline (20 seconds " +
			"by default).",
		severity: "error",
	},
	inventory_failed: {
		title: "Could not load the account list",
		description:
			"Reading the account list for routing failed, so the request could not " +
			"be routed.",
		suggestion:
			"Check the server log for the underlying error and the database's " +
			"health.",
		severity: "error",
	},
	predictive_throttle: {
		title: "Held back by usage throttling",
		description:
			"Usage throttling held back every candidate account because its use " +
			"of a 5-hour or weekly window was running ahead of an even pace for " +
			"that window, so the router turned the request away before sending it " +
			"and told the client to retry after 60 seconds.",
		suggestion:
			"This is the Usage Throttling card at work: turn off its 5-hour window " +
			"or weekly window switch, whichever applies, or add accounts.",
		severity: "warning",
	},
	physical_attempt_budget_exhausted: {
		title: "Stopped after too many attempts",
		description:
			"This request was sent upstream 32 times (retries on the same route do " +
			"not count). That is the router's fixed safety limit, so it stopped.",
		suggestion:
			"The server log line `physical_attempt_budget_exhausted` shows the " +
			"attempt count, how many routes were tried and the next account it " +
			"would have used. The limit is not a setting.",
		severity: "error",
	},
	count_tokens_unsupported: {
		title: "Token counting not supported",
		description:
			"The client asked to count a message's tokens, and the provider that " +
			"would serve it has no token-counting support.",
		suggestion:
			"No action needed: only the token count failed, not a model request.",
		severity: "warning",
	},
	combo_session_fallback_disabled: {
		title: "Combo ran out of accounts",
		description:
			"Every account in the combo for this model was unavailable or failed, " +
			"and Combo Session Fallback is off, so the request stopped instead of " +
			"going to an account outside the combo.",
		suggestion:
			"Fix or add accounts in the combo, or turn on Combo Session Fallback " +
			"on the Advanced card to let these requests use the whole pool. A " +
			"combo family set to Wait for native Claude quota never falls back, " +
			"whatever that switch says.",
		severity: "error",
	},
	force_model_denied: {
		title: "No account serves the exact model",
		description:
			"Force Account Model is on, and no account was left to serve the " +
			"requested model as written, so the router refused instead of sending " +
			"a different model.",
		suggestion:
			"Add an account that serves this model, or turn off Force Account " +
			"Model on the Advanced card.",
		severity: "error",
	},
	downstream_cancelled: {
		title: "Client disconnected early",
		description:
			"The client closed the connection before the response finished, so " +
			"the rest of it was not delivered.",
		suggestion:
			"No action needed: the client went away, for example when someone " +
			"interrupted Claude Code.",
		severity: "warning",
	},
	anthropic_incomplete_eof: {
		title: "Stream ended early",
		description:
			"The provider's stream closed before its final `message_stop` event, " +
			"so the client got an incomplete response.",
		suggestion:
			"Occasional ones are network or provider hiccups. Many from one " +
			"account point at that provider.",
		severity: "error",
	},
	anthropic_rescue_commitment_deadline: {
		title: "No route answered in time",
		description:
			"The first route was slow to start, so the router kept the client's " +
			"connection alive with pings while it kept routing the request. " +
			"Nothing produced output before the request's deadline (14 minutes " +
			"for Claude Code, 150 seconds for other clients), so the router " +
			"closed the stream with an error.",
		suggestion:
			"Many in a row point at accounts that accept requests and then stall; " +
			"see Routing attempts on the Routing card. " +
			"`CCFLARE_ANTHROPIC_MEANINGFUL_PROGRESS_TIMEOUT_MS` sets the deadline.",
		severity: "error",
	},
	anthropic_rescue_routing_error: {
		title: "Routing failed during a held stream",
		description:
			"The router was keeping the client's connection alive with pings while " +
			"it routed the request, and routing ended in an error before the " +
			"deadline. The client got an error event in the stream.",
		suggestion: "Check the server log around this time for the routing error.",
		severity: "error",
	},
	anthropic_rescue_non_sse_response: {
		title: "Late reply was not a stream",
		description:
			"The router was keeping the client's connection alive with pings while " +
			"it routed the request, and the reply that came back was not a " +
			"successful stream (an error reply, for example). The router could " +
			"not pass it on, so it closed the stream with an error.",
		suggestion:
			"Check the request history for the account that answered and what it " +
			"returned.",
		severity: "error",
	},
	responses_error: {
		title: "Codex stream failed",
		description:
			"A Codex Responses stream ended with an error or failed event, or " +
			"failed without a recorded reason. The provider's message is not " +
			"stored.",
		suggestion:
			"Occasional ones need no action. If they repeat on one account, check " +
			"that provider.",
		severity: "error",
	},
	responses_truncated: {
		title: "Provider stream cut short",
		description:
			"A Codex Responses stream ended without a clean completion: it " +
			"stopped early, reported an incomplete response, or ended with data " +
			"the router could not read.",
		suggestion:
			"Occasional ones need no action. If they repeat on one account, check " +
			"that provider for early closes.",
		severity: "error",
	},
	responses_client_cancelled: {
		title: "Provider cancelled the response",
		description: "A Codex Responses stream reported its response as cancelled.",
		suggestion: "No action needed for an occasional one.",
		severity: "warning",
	},
	quality_route_unavailable: {
		title: "Quality route unavailable (retired)",
		description:
			"Written by the Auto quality lane, which has since been retired. " +
			"Current builds never write this code, so these rows come from an " +
			"older build.",
		suggestion: "No action needed.",
		severity: "warning",
	},
};

type FamilyEntry = Omit<ErrorMeta, "description"> & { detail: string };

const PINNED =
	"This request was pinned, by the `x-better-ccflare-account-id` header or " +
	"a route profile, to one account or to the accounts its route profile " +
	"allows, and ";

/** `force_route_${ForceRouteUnavailableReason}` (packages/proxy/src/proxy.ts). */
const FORCE_ROUTE_META: Record<string, FamilyEntry> = {
	account_capacity_exhausted: {
		title: "Pinned route at its limit",
		detail:
			"the pinned account, or every account the profile allows, has no " +
			"capacity left. A request pinned to one account never moves to " +
			"another.",
		suggestion:
			"Wait for the account to recover, or send the request without the pin.",
		severity: "warning",
	},
	model_capacity_exhausted: {
		title: "Pinned account at its model limit",
		detail:
			"the pinned account has no capacity left for the requested model or " +
			"model family. A request pinned to one account never moves to " +
			"another.",
		suggestion:
			"Wait for the model's limit to reset, or send the request without the " +
			"pin.",
		severity: "warning",
	},
	rate_limited_or_unavailable: {
		title: "Pinned route busy or unavailable",
		detail:
			"the pinned account, or every account the profile allows, cannot take " +
			"it right now: it is cooling down, rate-limited or not eligible for " +
			"this kind of request.",
		suggestion:
			"Check the account on the Accounts page, or send the request without " +
			"the pin.",
		severity: "warning",
	},
	paused: {
		title: "Pinned account paused",
		detail:
			"the pinned account, or every account the profile allows, is paused.",
		suggestion:
			"Resume or re-authenticate the account on the Accounts page. Overage " +
			"and rate-limit-window pauses lift on their own.",
		severity: "error",
	},
	not_found: {
		title: "Pinned account not found",
		detail: "no account with the pinned id exists.",
		suggestion: "Fix the account id in the header or the route profile.",
		severity: "error",
	},
	conflicting_force_route: {
		title: "Conflicting account pins",
		detail:
			"its pins conflict: the header named a different account from the " +
			"route profile, or the header came with a route profile that chooses " +
			"among several accounts. The router refused instead of choosing.",
		suggestion: "Send the header or use the route profile, not both.",
		severity: "error",
	},
	provider_excluded: {
		title: "Pinned account's provider excluded",
		detail: "the pinned account's provider is excluded for this request.",
		suggestion:
			"Pin an account from an allowed provider, or remove the exclusion.",
		severity: "error",
	},
	provider_mismatch: {
		title: "Pinned account is the wrong provider",
		detail:
			"the account's provider does not match the one its route profile " +
			"expects.",
		suggestion: "Point the route profile at an account of the right provider.",
		severity: "error",
	},
	model_mapping_mismatch: {
		title: "Pinned account maps a different model",
		detail:
			"the account's model mapping would send a different model from the " +
			"one its route profile expects.",
		suggestion:
			"Fix the account's model mapping or the route profile's expected model.",
		severity: "error",
	},
	catalog_role_unavailable: {
		title: "Pinned model not in the catalog yet",
		detail:
			"its route follows a model role or line in a Codex account's catalog, " +
			"and the catalog has not named a model for it yet.",
		suggestion:
			"This usually clears once the account's model catalog loads; retry " +
			"shortly.",
		severity: "warning",
	},
	catalog_role_mismatch: {
		title: "Pinned model does not match the catalog",
		detail:
			"its route follows a model role or line in a Codex account's catalog, " +
			"and the account's model mapping does not agree with the catalog's " +
			"model for it, or the catalog lists no model of that line.",
		suggestion:
			"Fix the account's model mapping, or point the route profile at a role " +
			"or line the catalog has.",
		severity: "error",
	},
	lookup_failed: {
		title: "Could not look up the pinned account",
		detail: "reading the accounts from the database failed.",
		suggestion:
			"Check the server log for the database error. For a pin to one " +
			"account, the server console also suggests running `--repair-db`.",
		severity: "error",
	},
};

/** `server_tool_${ServerToolRoutingErrorReason}` (packages/proxy/src/proxy.ts). */
const SERVER_TOOL_META: Record<string, ErrorMeta> = {
	advisor_declaration_unavailable: {
		title: "Advisor not available on this route",
		description:
			"The request declared Claude Code's advisor tool, and it cannot be " +
			"served here: no native Anthropic account could take the request, " +
			"advisor was declared beside another server tool, or its advisor type " +
			"is not recognised. The refusal is worded so that Claude Code drops " +
			"the advisor tool and retries.",
		suggestion:
			"No action needed. To use advisor on its own, keep a native Anthropic " +
			"account available for these requests.",
		severity: "warning",
	},
	advisor_history_unavailable: {
		title: "Advisor history not supported here",
		description:
			"The conversation holds advisor tool results that the remaining route " +
			"cannot process. The refusal is worded so that Claude Code strips that " +
			"history and retries.",
		suggestion: "No action needed.",
		severity: "warning",
	},
	forced_incapable: {
		title: "Pinned account can't run the server tool",
		description:
			"The request was pinned to one account and uses a server tool, such as " +
			"web search, that this account cannot provide as asked.",
		suggestion:
			"Pin an account that supports the tool, or send the request without " +
			"the pin.",
		severity: "error",
	},
	forced_structurally_incapable: {
		title: "Pinned route lacks the server tool",
		description:
			"The request was pinned to a route whose provider does not implement " +
			"the server tool it asks for, so retrying the same request cannot work.",
		suggestion:
			"Change the route or the routing headers, or set `webSearchHelper` on " +
			"an eligible route profile.",
		severity: "error",
	},
	invalid_requirement: {
		title: "Invalid server tool options",
		description:
			"The request's server tool options failed validation, so the router " +
			"refused it before routing.",
		suggestion:
			"The client has to fix the request; retrying it unchanged cannot work.",
		severity: "warning",
	},
	unsupported_requirement: {
		title: "Unsupported server tool options",
		description:
			"The request asks for server tool behaviour the router does not " +
			"support, so it refused the request before routing.",
		suggestion:
			"The client has to change the tool declaration; retrying it unchanged " +
			"cannot work.",
		severity: "warning",
	},
	no_implementation: {
		title: "No route provides this server tool",
		description:
			"No account in the pool has a proven way to run the server tool the " +
			"request declares, including when every candidate's capability check " +
			"failed before sending.",
		suggestion:
			"Add an account that provides the tool, such as a native Anthropic " +
			"account for web search.",
		severity: "error",
	},
	replay_unavailable: {
		title: "Server tool replay unavailable",
		description:
			"The router could not set up the server tool replay this request " +
			"needs, and no native route could serve the tool directly.",
		suggestion:
			"Keep a native Anthropic account available for server tool requests.",
		severity: "error",
	},
	temporary_unavailable: {
		title: "Server tool route busy",
		description:
			"The router could not find an account to run this server tool for the " +
			"request right now: the accounts that support it were busy or " +
			"unavailable, or the selection step failed.",
		suggestion: "This often clears on its own; the client can retry.",
		severity: "warning",
	},
};

/** The error type an Anthropic SSE `error` event carried. */
const MIDSTREAM_TITLES: Record<string, string> = {
	overloaded_error: "Overload error in the stream",
	invalid_request_error: "Request error in the stream",
	upstream_stream_read_error: "Lost the provider stream mid-response",
};

const FORCE_ROUTE_PREFIX = "force_route_";
const SERVER_TOOL_PREFIX = "server_tool_";
const MIDSTREAM_PREFIX = "anthropic_midstream_error:";
const RESPONSES_PREFIX = "responses_";
const UPSTREAM_HTTP_PREFIX = "upstream_http_";

function lookup<T>(table: Record<string, T>, key: string): T | null {
	return Object.hasOwn(table, key) ? table[key] : null;
}

function getForceRouteMeta(reason: string): ErrorMeta {
	const entry = lookup(FORCE_ROUTE_META, reason);
	if (entry) {
		const { detail, ...rest } = entry;
		return { ...rest, description: PINNED + detail };
	}
	return {
		title: "Pinned route refused",
		description: `${PINNED}the router could not use it (reason: ${reason}).`,
		suggestion:
			"Check the route profile and its accounts, or send the request without " +
			"the pin.",
		severity: "error",
	};
}

function getServerToolMeta(reason: string): ErrorMeta {
	return (
		lookup(SERVER_TOOL_META, reason) ?? {
			title: "Server tool request refused",
			description:
				"The router refused the request because of its server tool " +
				`requirements (reason: ${reason}).`,
			suggestion: "Check the request's server tools and the route it used.",
			severity: "error",
		}
	);
}

function getMidstreamMeta(errorType: string): ErrorMeta {
	const codexReadError =
		errorType === "upstream_stream_read_error"
			? " The Codex provider sends this type when it cannot keep reading " +
				"the upstream stream."
			: "";
	return {
		title: lookup(MIDSTREAM_TITLES, errorType) ?? "Error event in the stream",
		description:
			"While the router was passing the response to the client, the stream " +
			`carried an error event of type ${errorType}.${codexReadError} The ` +
			"client sees that error in the stream.",
		suggestion:
			"Occasional ones need no action. If they repeat on one account, check " +
			"that provider's status.",
		severity: errorType === "overloaded_error" ? "warning" : "error",
	};
}

function getUpstreamHttpMeta(value: string): ErrorMeta {
	// describeUpstreamFailure (packages/proxy/src/upstream-error-observability.ts):
	// `upstream_http_<status>`, then ` type=<type>`, ` code=<code>` and
	// ` param=<field>`.
	const [status = "", ...fields] = value.split(" ");
	const field = (name: string) =>
		fields.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
	const type = field("type");
	const code = field("code");
	const param = field("param");
	const statusNumber = Number(status);
	const overloaded = statusNumber === 529 || type === "overloaded_error";
	const serverSide = overloaded || statusNumber >= 500;
	const title = overloaded
		? `Provider overloaded (HTTP ${status})`
		: statusNumber >= 500
			? `Provider server error (HTTP ${status})`
			: statusNumber === 401
				? `Provider rejected the credentials (HTTP ${status})`
				: statusNumber === 403
					? `Provider refused access (HTTP ${status})`
					: statusNumber === 429
						? `Provider rate limit (HTTP ${status})`
						: statusNumber >= 400
							? `Provider rejected the request (HTTP ${status})`
							: `Provider error (HTTP ${status})`;
	const details = [
		...(type ? [`error type ${type}`] : []),
		...(code ? [`code ${code}`] : []),
		...(param ? [`rejected field ${param}`] : []),
	].join(" and ");
	return {
		title,
		description:
			`The provider answered HTTP ${status}` +
			(details ? ` with ${details}` : "") +
			", and the router passed that reply to the client. This error line " +
			"keeps only the status, error type, code and the name of the field " +
			"the provider rejected, never the provider's message text.",
		suggestion: serverSide
			? "This is trouble on the provider's side. Occasional ones need no " +
				"action; if they repeat, check the provider's status page."
			: "The error type, code and rejected field say what the provider " +
				"objected to. Check the request and the account at the provider.",
		severity: overloaded ? "warning" : "error",
	};
}

function getRouterErrorMeta(code: string): ErrorMeta | null {
	const exact =
		lookup<ErrorMeta>(ATTEMPT_CAUSE_META, code) ??
		lookup(ROUTER_ERROR_META, code);
	if (exact) return exact;
	if (code.startsWith(FORCE_ROUTE_PREFIX)) {
		return getForceRouteMeta(code.slice(FORCE_ROUTE_PREFIX.length));
	}
	if (code.startsWith(SERVER_TOOL_PREFIX)) {
		return getServerToolMeta(code.slice(SERVER_TOOL_PREFIX.length));
	}
	if (code.startsWith(MIDSTREAM_PREFIX)) {
		return getMidstreamMeta(code.slice(MIDSTREAM_PREFIX.length));
	}
	if (code.startsWith(UPSTREAM_HTTP_PREFIX)) {
		return getUpstreamHttpMeta(code.slice(UPSTREAM_HTTP_PREFIX.length));
	}
	if (code.startsWith(RESPONSES_PREFIX)) {
		return {
			title: "Provider stream did not complete",
			description: `A Codex Responses stream ended in state ${code.slice(RESPONSES_PREFIX.length)}.`,
			suggestion:
				"If they repeat on one account, check that provider's status.",
			severity: "error",
		};
	}
	// A failed response body stores the runtime's own error text
	// (packages/proxy/src/response-handler.ts). That text contains whitespace;
	// the only router codes with spaces (upstream_http_) are matched above.
	if (/\s/.test(code.trim())) {
		return {
			title: "Connection failed while reading the response",
			description:
				"The connection failed while the router was reading the response, " +
				`with this error from the runtime: "${code}"`,
			suggestion:
				"Occasional ones are dropped connections. Many from one account " +
				"point at that provider or the network path to it.",
			severity: "error",
		};
	}
	return null;
}

export function getErrorMeta(code: string, context?: ErrorContext): ErrorMeta {
	if (code === "model_fallback_429") {
		return getModelFallbackMeta(context);
	}
	const known = lookup<ErrorMeta>(KNOWN_ERROR_META, code);
	if (known) return known;
	const routerMeta = getRouterErrorMeta(code);
	if (routerMeta) return routerMeta;
	return {
		title: code || "Unknown error",
		description: "No additional context is available for this error code.",
		suggestion: "Check the server logs or the original request for details.",
		severity: "error",
	};
}
