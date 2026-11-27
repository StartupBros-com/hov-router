# Load Balancing in HoV Router

## Table of Contents
1. [Overview](#overview)
2. [Available Strategies](#available-strategies)
3. [Session-Based Strategy](#session-based-strategy)
4. [Account Priorities](#account-priorities)
5. [Configuration](#configuration)
6. [Account Selection Process](#account-selection-process)
7. [Performance Considerations](#performance-considerations)
8. [Strategy Selection and OAuth Safety](#strategy-selection-and-oauth-safety)

## Overview

HoV Router defaults to `session`. The strategy orders eligible routing candidates; it does not grant access to a provider, override model eligibility, or bypass account limits. Choose based on the workload's need for cache locality, capacity use, and failover—not on a claim that one strategy is universally optimal.

The registered values live in [the strategy enum](../packages/types/src/strategy.ts), the default in [core strategy configuration](../packages/core/src/strategy.ts), and the implementations in [load-balancer strategies](../packages/load-balancer/src/strategies/).

## Available Strategies

Select a strategy with `LB_STRATEGY`, the `lb_strategy` configuration key, or the HTTP configuration endpoint.

| Strategy | Routing behavior | Trade-off |
|----------|------------------|-----------|
| `session` (default) | Reuses an eligible account-level session within the best routing class and returns ordered fallbacks. Session duration is configurable, with a five-hour default. | Clients can share one active account rather than retaining independent owners. |
| `least-used` | Orders each request by routing class, account priority, utilization, and a short recent-pick penalty. | Can spread bursts, but does not retain a client owner and may lose prompt-cache locality. |
| `session-affinity` | Keeps a sticky owner per client session or affinity lane, with expiry, failover, and recovery subject to routing policy. | Useful for concurrent multi-turn clients; keeping an owner does not guarantee the provider still has its cached prefix. |
| `session-drain-soonest` | Extends affinity with quota-aware fresh-assignment/failover ordering and the earliest known future all-model weekly reset as a tiebreaker. See [Drain ordering](#drain-ordering). | Tries to use expiring capacity while retaining eligible owners, including provider-specific protection across quota-pressure changes. |
| `session-drain-soonest-strict` | Reconsiders ordering per request. Within the authorized routing class, qualifying auto-fallback precedes future weekly reset order; active sessions then break ties. | Gives reset ordering more weight than ordinary client stickiness. Explicit owner-retention directives and eligibility still apply. |

**Dashboard selector:** All five strategies are selectable unless `LB_STRATEGY` locks the setting. An unrecognized current value remains visible as a disabled “(current)” entry. Neither drain mode is the installation default.

## Session-Based Strategy

`session` uses account session state rather than independent per-client ownership. An active account stays first only while it is available and remains in the best routing class. Otherwise, selection uses candidate ordering and utilization to choose a new account and ordered fallbacks. A qualifying auto-fallback can also change the selection.

This can reduce account switching, but it can concentrate load. It is not evidence that rate limits, latency, or throughput will improve on a particular workload. See [the implementation](../packages/load-balancer/src/strategies/index.ts) instead of a copied version of the algorithm.

## Usage Window Alignment for Anthropic OAuth

Session-window tracking is provider-specific. Anthropic OAuth, Codex OAuth, and Zai currently use fixed-duration session tracking. Anthropic OAuth additionally resets a session when a known `rate_limit_reset` has passed. Account session counters and client/lane affinity are separate state: resetting a counter need not move a conversation.

A five-hour account session is **not** a five-hour prompt-cache TTL. Provider cache retention and the strategy's affinity lifetime are separate constraints.

### Future Extensibility for API-Based Providers

[Provider configuration](../packages/types/src/provider-config.ts) is authoritative for session tracking and billing defaults. Do not infer the billing model from credential syntax: Zai uses an API key but is configured as a plan with session windows. When adding a provider, update that configuration and its tests rather than maintaining another provider table here.

## Account Priorities

Lower numeric account priority means higher preference; the default is `0`. Route profiles and combo slots can supply candidate-specific tiers and fallback rungs, so account priority is not an escape from the outer routing policy.

### How Priorities Work

When comparable candidates have the same preference, utilization can break ties. Utilization reflects the most-used relevant window; an account at 90% weekly usage and 20% short-window usage is constrained by the 90% window. Missing utilization is currently treated as zero. That is a fallback assumption, not proof that the account has unused capacity.

### Setting Account Priorities

```bash
hov-router --add-account myaccount --mode claude-oauth --priority 10
hov-router --set-priority myaccount 20
```

See [CLI account priorities](cli.md#account-priorities) for command details.

### Priority in Load Balancing

Candidate routing classes are considered before ordinary strategy preferences. An active session cannot override a better authorized routing class. Within comparable choices, lower priority values are preferred; utilization and recency tiebreakers depend on the strategy.

### Use Cases for Priorities

Use priorities to express a primary/backup or cost preference within the eligible pool. Confirm the effective route in request diagnostics: a configured priority alone does not establish which account will handle a request.

## Auto-Fallback Feature

Auto-fallback allows supported window-based providers (`anthropic`, `codex`, and `zai`) to return to a preferred account after its usage window resets. It is an account setting, disabled by default, not permission to use an otherwise excluded account.

### How Auto-Fallback Works

Selection checks the account's auto-fallback setting, reset telemetry, availability, and routing policy. The session and affinity implementations apply their own owner/recovery rules; strict drain additionally prefers qualifying auto-fallback candidates before weekly reset order within a routing class.

### Auto-Fallback Logic

Consult [SessionStrategy](../packages/load-balancer/src/strategies/index.ts), [SessionAffinityStrategy](../packages/load-balancer/src/strategies/session-affinity.ts), and [the drain comparator](../packages/load-balancer/src/strategies/session-drain-soonest.ts). A simplified priority-only sort would omit candidate tiers, pressure, and eligibility.

### Enabling Auto-Fallback

Use the dashboard or the [account HTTP API](api-http.md) on the intended instance. Configuration writes require an authorized operator; supply that instance's API key when authentication is enabled.

```bash
curl -X POST http://localhost:8080/api/accounts/00000000-0000-4000-8000-000000000001/auto-fallback \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin-api-key>" \
  -d '{"enabled": 1}'
```

Use `{"enabled": 0}` to disable it. Replace the placeholder account ID with one verified on that instance.

### Auto-Fallback Behavior

An account becoming available is only one input. A higher-tier route, an exclusion, or an open route circuit can still prevent selection. Inspect the resulting candidate order rather than assuming the reset always wins.

### Use Cases for Auto-Fallback

Return to a preferred primary account after a reset without manually changing its priority. Keep fallback accounts available for requests the primary cannot serve.

### Example Scenario

If preferred account A is unavailable, account B can serve as fallback. Once A's reset and availability conditions qualify, auto-fallback can return traffic to A, subject to the strategy and routing class. This is not a guarantee that B's warm cache transfers to A.

### Auto-Fallback Storage

The account's `auto_fallback_enabled` setting is persisted in SQLite. Use the account API or dashboard rather than running schema changes manually.

## Configuration

### Configuration Precedence (highest to lowest)

1. A valid environment override (`LB_STRATEGY`).
2. The file's `lb_strategy` value.
3. The built-in default.

See [configuration precedence](configuration.md#configuration-precedence) and [strategy source handling](../packages/config/src/index.ts).

### Environment Variables

```bash
# Choose a value from Available Strategies above; the default is session.
LB_STRATEGY=session
SESSION_DURATION_MS=18000000
```

The [configuration mapping](configuration.md#configuration-mapping) documents the remaining variables. Setting `LB_STRATEGY` takes precedence over file/runtime changes.

### Configuration File

The default Linux/macOS path is `~/.config/hov-router/hov-router.json`; see [configuration paths](configuration.md#configuration-file-format) for XDG, Windows, and custom-path behavior.

```json
{
  "lb_strategy": "session",
  "session_duration_ms": 18000000
}
```

### Time Constants

The default session duration is five hours. The [configuration options](configuration.md#complete-options-table) describe disabling stickiness and handling invalid values. Do not use this duration as a proxy for an upstream cache TTL.

### Dynamic Configuration

Use the following routes on the intended instance. Add its admin API key when authentication is enabled; these examples do not authorize a production change.

```bash
# Read the effective strategy and its source/lock state.
curl http://localhost:8080/api/config/strategy \
  -H "Authorization: Bearer <admin-api-key>"

# Change strategy only when the operator intends this change.
curl -X POST http://localhost:8080/api/config/strategy \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin-api-key>" \
  -d '{"strategy": "session"}'

# List registered strategies.
curl http://localhost:8080/api/strategies \
  -H "Authorization: Bearer <admin-api-key>"
```

See [the runtime configuration API](configuration.md#runtime-configuration-api) for response shapes and other configuration endpoints.

## Account Selection Process

The strategy setting is only part of selection:

1. The proxy resolves provider/model routes, combo membership, and candidate eligibility, including capacity and account health.
2. The strategy orders those candidates using their fallback rung, tier, pressure metadata, and strategy-specific state.
3. The selector preserves eligibility and applies any provider-specific post-selection cache ordering.
4. The proxy attempts eligible routes and records outcomes. An ordered candidate list is not proof of a successful or completed stream.

The authoritative orchestration is [account-selector.ts](../packages/proxy/src/handlers/account-selector.ts); [cache-affinity-orderer.ts](../packages/proxy/src/cache-affinity-orderer.ts) handles the provider-specific post-selection ordering. Candidates can share an account but differ in combo slot or model, so account IDs alone cannot describe all route changes.

### Session Management

Account-level `session` state is distinct from per-client/lane affinity. Strategies may reset account session counters, retain an owner, use a temporary fallback, or recover a better route. See [affinity lifetime limits](#account-and-client-stickiness) and [Drain ordering](#drain-ordering).

### Session Reset

Provider-specific session tracking determines whether account counters need a reset. An expired usage window does not by itself prove a prompt cache expired or require a sticky-drain conversation to change owner.

### Database Updates

[StrategyStore](../packages/types/src/strategy.ts) supplies session reset, availability/resume, utilization, and optional provider-usage operations. Strategy selection is asynchronous and can update session state. Do not use production account data for an offline comparison.

## Performance Considerations

### Session-Based Performance

Stickiness trades distribution for locality. Compare policies on matched model, provider, workload, and concurrency cohorts. Do not attribute a slow full response to router overhead without separating time-to-first-token, generation time, and retries.

### Session Storage

Account counters (`session_start`, `session_request_count`) and rate-limit state are persisted separately from the process-local affinity map. Restart restoration and its limits are described below.

### Monitoring

Predeclare both the outcome and its countermetrics:

- Completed eligible work and unused allowance at reset—not merely how evenly requests spread.
- Cache-read share with its token denominator and usage-coverage count; extra cache creation on warm continuations is a countermetric.
- Terminal failures separated from client cancellations, plus fallback frequency and time-to-first-token.
- Continuing-lane candidate changes, not just account switches across unrelated conversations. See [the remap measurement guide](solutions/observability/measure-session-remap-cache-cost-from-the-requests-table.md).

### Offline strategy comparison

```bash
bun bench/routing-strategy-comparison.ts
```

This runs the real sticky-drain and affinity `select()` implementations on identical synthetic candidate sequences with isolated state. It compares strategy-stage decisions after supplied eligibility, not the complete proxy or an upstream provider. Its selection and continuation counts can reveal behavioral differences; they cannot establish cache hits, latency, quota savings, or an optimal production policy. No production database or inference endpoint is used.

## Strategy Selection and OAuth Safety

Supported routing choices do not change credential-use permissions. Follow the [repository's account-use rule](../AGENTS.md) and [agent setup guidance](agent-setup.md#claude-automation-and-credentials). No strategy authorizes paid overage.

### Account and client stickiness

- `session` maintains account-level sessions for providers configured to track them.
- `session-affinity` maintains separate client/lane ownership, subject to routing policy, availability, failover, and recovery.
- Sticky drain adds quota-aware fresh assignments and failovers while retaining eligible owners as described below. Strict drain ordinarily reevaluates each request instead.

#### Drain ordering

`session-drain-soonest` does not rank by weekly reset alone. A fresh assignment or failover considers:

1. **Fallback rung**, then **tier**: structural route class remains authoritative.
2. **Weekly pace band**: the required burn rate `(100 - weekly utilization %) / hours until reset`, from fresh usage telemetry. A model-scoped weekly window is used when the request's model family has one; otherwise the all-model weekly window. Bands are `critical` (≥ 4 %/h), `urgent` (≥ 2), `hot` (≥ 1), `warm` (≥ 0.5), `steady` (≥ 0.25), otherwise `cold`. Higher bands sort first, but only comparable provider, billing, window, and model-family cohorts are compared.
3. **Earliest known future all-model weekly reset**, within comparable candidates.
4. Account priority and utilization/recency tiebreakers.

Auto-fallback and explicit owner directives also participate in selection; reset time is not an unconditional first key. Unknown, malformed, or past weekly resets do not supply an expiry preference, so ordinary affinity ordering remains available.

For example, 66% of quota left over 66 hours (`hot`) outranks 7% left over 11 hours (`warm`) within the same structural class, despite the later reset.

When an existing sticky-drain owner is outclassed only by a higher pace band in the same tier and fallback rung:

- **Codex:** an eligible owner or temporary fallback stays sticky, including across usage-window rollover. Account counters still reset when appropriate.
- **Anthropic:** the owner is held while its previous turn was less than five minutes ago, for at most 30 minutes from the first held turn. An idle gap or the hold ceiling allows reassignment. Returning to the owner's band ends the hold episode. A one-hour upstream cache TTL does not extend this five-minute hold rule.
- **Other providers:** the ordinary reassignment behavior applies.

Better-tier/rung recovery, unavailable or excluded owners, and strict mode are not protected by that warm-cache hold. Route-circuit and explicit owner-retention decisions remain authoritative.

Client/lane affinity lives in a bounded process-local map, separate from account counters. Active lanes refresh an idle TTL (five hours by default). Routing records allow best-effort restoration after a backend restart; `/health` reports `routing.affinityRestore`. Restoration covers ordinary and route-profile lanes under affinity and sticky drain, but can stop at its three-second budget or 20,000-record cap. Helper lanes, strategy replacement, expiry, eviction, and changed lane identity can also cause new assignment. Affinity is not a durable account lock or a guarantee of upstream cache retention.

### Per-request spreading

`least-used` intentionally has no per-client owner. Its bounded recent-pick penalty can spread bursts, but utilization is not queue delay or measured throughput. Evaluate it separately for independent requests before applying results to long coding conversations.

### Cache locality and utilization

Compare sticky drain with plain affinity when the question is whether reset-aware ordering earns its extra complexity. Measure unused capacity across complete reset windows and compare warm-continuation cache costs and failures. Keep existing eligibility and credential boundaries fixed. An offline decision comparison alone is not a reason to switch production.

## LoadBalancingStrategy Interface

[LoadBalancingStrategy and RequestMeta](../packages/types/src/context.ts) and [StrategyStore](../packages/types/src/strategy.ts) are the authoritative contracts. `select(accounts, meta)` is asynchronous and orders accounts with their candidate metadata. `peek(accounts)` is a side-effect-free preview without the request's lane metadata; it is not a substitute for exercising the selection path in a comparison.

`SessionDrainSoonestStrategy` implements both drain values through its mode option. See [the shared implementation](../packages/load-balancer/src/strategies/session-drain-soonest.ts); neither mode requires a separate copied implementation.

## Migration Notes

Changing this documentation does not change a deployed strategy. Verify the effective strategy and its source before altering a setting. Session-window behavior remains provider-specific; use [provider configuration](../packages/types/src/provider-config.ts) rather than inferring it from the presence of an API key. For upgrade steps, see the [configuration migration guide](configuration.md#migration-guide).
