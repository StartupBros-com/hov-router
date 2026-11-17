---
title: A send-time check must read its on/off state from storage, not from the account the selector handed over
date: 2026-11-17
category: architecture-patterns
module: routing
problem_type: architecture_pattern
component: proxy
severity: high
applies_when:
  - Adding a per-login condition that must stop a send, not only steer selection (an extra-usage hold, a spend cap)
  - Adding a fast path or early return to a check inside runCacheAwareProviderAttempt
  - Changing the 529 in-place retry or any other path that resends on an account already selected
root_cause: incorrect_assumption
resolution_type: code_fix
related_components:
  - account selection
  - extra-usage holds
  - overload retry
tags:
  - extra-usage
  - send-time-check
  - overload-retry
  - stale-state
  - account-selection
  - billing
---

# A send-time check must read its on/off state from storage, not from the account the selector handed over

## Context

The Claude extra-usage switch (PR #879, work spec #876) stops the router sending a Claude login any request an extra-usage hold covers, so Anthropic does not bill that request as extra usage. The implementation plan (`docs/plans/2026-11-16-0508-feat-claude-extra-usage-switch-plan.md`) checks holds twice: when the selector picks a login (`evaluateCandidateCapacity`, `packages/proxy/src/handlers/account-selector.ts:1593`), and again just before each send (its KTD12, `assertNoExtraUsageHold`). The second check exists because a hold can be written after selection.

The send-time check as first built still missed that case. Its first line read the switch from the `Account` object the selector had handed over, and returned before any stored read when the switch was off:

```ts
if (
	account.provider !== "anthropic" ||
	!account.auto_pause_on_overage_enabled
)
	return;
```

That object is a snapshot taken at selection, and the request keeps it for every physical attempt on that login. The attempt function sends through `executeCacheAwareProviderAttempt` from eight call sites, all with the same `account` (`packages/proxy/src/handlers/proxy-operations.ts:5135-7628`), including the 529 in-place retry (`proxy-operations.ts:7074-7177`), which clones the transformed request and resends it after a jittered backoff (750 ms base, 3 s cap by default, `packages/core/src/constants.ts:314-315`). So the failing case was:

1. The selector picks a login whose switch is off.
2. While the first attempt is in flight, the member turns the switch on and a usage reading writes a hold covering the request's model.
3. Anthropic answers 529, and the retry goes through the send-time check.
4. The early return fires on the stale `false`; the stored hold is never read, and the retry is sent into a spent limit.

The PR's `/pro-gate` review (a ChatGPT Pro pass) found it as a P1, and it was fixed before merge. The plan had the same blind spot. Before the fix amended it, KTD12 reread holds only "for an `anthropic` login whose switch is on", and the U6 test scenarios said "With the switch off, no hold read happens and the request is sent as today."

## Guidance

A check at the send boundary exists to see what changed after selection, so every input that decides whether it blocks must come from storage. That includes the on/off flag that decides whether to look at all. Take only the login's identity (`account.id`, `account.provider`) from the selected object.

The shipped check, `assertNoExtraUsageHold` (`packages/proxy/src/handlers/proxy-operations.ts:880-935`):

- keeps only `if (account.provider !== "anthropic") return;` from the selected object;
- reads the switch, holds, pause state and billed-hold fields in one row through `getExtraUsageHoldInputs` (`packages/database/src/repositories/account.repository.ts:715-745`, a primary-key `SELECT` on `accounts`), and decides on the stored switch;
- uses the selected object's state only when that read throws, and logs that it did;
- runs inside `runCacheAwareProviderAttempt` (`proxy-operations.ts:4398-4434`), which every transport attempt passes, retries included, next to the native-quota admission veto.

The cost is one indexed single-row read per Claude send, including sends on logins whose switch is off. That read was chosen over a free flag check that is wrong in exactly the case the check exists for.

Two sources hold a login's state on the send path: the selected `Account` snapshot and the stored row. A send-boundary accessor that always returns stored gate fields would remove the choice for the next check. That is a product-code change and has not been made.

## Why This Matters

Read alone, each of the two checks looks correct, and the pair looks redundant. The defect sits in the gap between them: a value cached at selection short-circuits the reread. Here that value gates money, because a request sent inside a hold is billed to the member as extra usage. The plan had a send-time check designed for this race and still got it wrong, so "we check again before send" does not by itself show the race is closed. Check where each input of the send-time check comes from.

## When to Apply

- A new per-login condition that must stop a send. The next likely one is a dollar cap on pay-per-use accounts (idea S3 in `docs/ideation/2026-11-14-similar-ai-routers-ideation.html`). Its spent total changes with every response, so a value read at selection is stale by design.
- A fast path added to `assertNoExtraUsageHold`, or to any sibling check in `runCacheAwareProviderAttempt`.
- A new path that resends on an account already selected, like the 529 in-place retry or the zai 1305 retry (`proxy-operations.ts:5209`).

## Examples

Before, the selected object decides whether to reread:

```ts
if (account.provider !== "anthropic" || !account.auto_pause_on_overage_enabled) return;
const stored = await ctx.dbOps.getExtraUsageHoldInputs(account.id);
```

After, the stored row decides:

```ts
if (account.provider !== "anthropic") return;
let stored: ExtraUsageHoldInputs | null;
try {
	stored = await ctx.dbOps.getExtraUsageHoldInputs(account.id);
} catch (error) {
	log.warn(`Could not reread extra-usage holds for ${account.name}; checking the state it was selected with`, error);
	stored = { /* the selected object's switch, holds and pause */ };
}
if (!stored || stored.provider !== "anthropic" || !stored.switchOn) return;
```

The regression test builds a login selected with the switch off and no holds, stores the switch on with a covering Opus hold, and expects nothing sent: "a switch turned on after selection is read at send time, and its stored hold stops the send" in `packages/proxy/src/handlers/__tests__/proxy-operations-extra-usage-hold.test.ts`. Its pair, "with the switch off in the store, the request is sent as today", keeps the reread from blocking logins whose switch really is off, and "when the switch was turned off after selection, the stored hold is ignored" covers the opposite flip. A new send-time gate needs the same three tests: selected off and stored on blocks, stored off sends, and selected on and stored off sends.

## Related

- `docs/solutions/architecture-patterns/commit-bound-routing.md`, rule 6: revalidate the exact hosted-tool proof immediately before transport. This doc applies the same boundary to per-login conditions.
- `docs/solutions/rate-limit-scope-and-duration.md`: a hold must name the scope, duration and evidence it rests on; an extra-usage hold is one more hold kind that depends on fresh stored state.
- #678, closed as not planned: upstream 5xx replies are forwarded to the client, not retried, which leaves the reset-less 529 retry as the router's only in-place retry for Anthropic. That retry resends on the login the request was selected with.
- #876 and PR #879: the extra-usage switch and the review fix this lesson comes from.
- `CONCEPTS.md`: Extra-usage hold, In-place retry.
