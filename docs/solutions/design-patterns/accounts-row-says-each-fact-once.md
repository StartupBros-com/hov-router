---
title: The collapsed Accounts row says each fact once
date: 2026-11-17
category: design-patterns
module: dashboard-accounts
problem_type: design_pattern
component: frontend
severity: medium
applies_when:
  - Adding a status, limit, hold, notice or control to the collapsed Accounts row
  - Changing what the Accounts header counts as needing attention
  - Writing row heights or other layout measurements into a dashboard PR description
root_cause: incorrect_assumption
resolution_type: code_fix
related_components:
  - account status classifier
  - combo routing states
  - Accounts attention summary
tags:
  - dashboard
  - accounts-page
  - account-row
  - routing-notices
  - say-once
  - row-height
  - layout-measurement
---

# The collapsed Accounts row says each fact once

## Context

The collapsed row on the dashboard's Accounts page shows an account's name, status, usage bars and actions. In the less than a day between PR #879 and PR #897, four changes gave it a line or a control for something it already showed, and each one was cut back:

- **Extra usage.** PR #879 printed "Extra usage at Anthropic: off · read 6:05 AM · Change it at Anthropic" on every Claude row. The operator named it as the clutter the page was moving away from. PR #883 cut it to an "Extra usage on" pill, shown only while the setting reads on, plus one muted line per hold. The state, the link and each hold's cause and end moved to Details > Settings.
- **Spent windows, first pass.** PR #887 removed two repeats of a spent window but kept every routing notice, because the header's routing-notice count pointed at them. To avoid naming a spent family twice, it hid the "at limit" line when a plain "<Family>: Model exhausted" notice was present, with three exceptions: no notice, a notice for another family, or a notice carrying an Action required or Managed route prefix.
- **Spent windows, second pass.** The notices then carried the repeat. A row already reading "Usage exhausted" with red bars still printed one orange "Fable: Model exhausted" line per spent family, and the operator reported that the line "extends the rows vertically in an unpleasant way". PR #897 kept the notice line for decisions made in Combos only, named a skipped family once in the status column, and moved the header count. It reversed #887's choice.
- **Row controls.** PR #892 put Refresh usage on the usage bars, outside the action column, and rendered Clear cooldown in two places that swapped between widths. An interface review found five problems in it. PR #896 put Refresh usage first in the action column, beside Pause, Details and More, and showed each remedy once beside the status it clears: Clear cooldown beside the retry time, Re-authenticate beside "Reconnect required".

Two operator rulings frame later changes. The page was getting "too smart", so when two designs tie, the one with fewer rules wins. And the page keeps rows: a tile layout was prototyped and dropped. Setting routing priority by dragging rows in an edit mode is issue #898, open and not started as of this writing.

## Guidance

Each fact has one home on the collapsed row, and Details holds the full record. The homes as of PR #897:

| Fact | Home on the row | Code |
| --- | --- | --- |
| Whether the account takes requests | The status pill, one reason | `classifyAccountStatus` in `packages/ui-common/src/account-status.ts` |
| Which families are out when the account takes no requests | Nowhere: every family is out with the account | `ACCOUNT_BLOCKED_STATUS` (reauth, paused, refused, cooldown, exhausted, hard-limit) in `packages/dashboard-web/src/components/accounts/AccountListItem.tsx` |
| A window or family spent while the account still routes | One "<A>, <B> at limit" line under the pill | `fullWindowLabels` and `spentFamilyLabels`, joined as `atLimitLabels`, in `AccountListItem.tsx` |
| How full each window is | Its bar, numeral and colour | `RateLimitProgress.tsx` |
| A routing decision the operator makes in Combos | The orange routing-notice line | `routingNeedsReview` in `account-routing.ts`: reason `ambiguous` or `new_billing_class`, or `managedRouteAvailable` |
| Every family's routing state | Details only | The Details routing section, which lists every entry in `routingStates` |
| Controls | The action column: Refresh usage, Pause, Details, More | `AccountListItem.tsx`; a remedy sits beside the status it clears (Clear cooldown, Re-authenticate) |

A skipped family is left off the at-limit line when its own weekly bar already shows it full or held. The match is by window id (`seven_day_<family>`), never by label text.

Before adding anything to the row, ask these in order and stop at the first yes:

1. Does the row already say it? Check the pill, the bars, the at-limit line and the hold cues. Add nothing to the row; put any detail in Details or a tooltip.
2. Does it change whether the account takes requests? It is a status reason in the classifier, not a new line.
3. Is it a limit on part of the account? It joins the at-limit line.
4. Is it a decision the operator must make? Only then is it a notice line.
5. Otherwise it belongs in Details.

Two signs that a fact has two homes:

- **A rule that hides one line when another is present.** #887's "drop the at-limit line when a plain notice exists" needed three exceptions, and #897 replaced it within hours. Remove one home instead of adding a suppression rule.
- **A header count that a line exists to satisfy.** `accountAttentionReason` in `account-list-view.ts` counts only what the operator must do: "reconnect" (the Reconnect required pill), "refused" (the Anthropic refused pill and its hint) and "routing" (`routingNeedsReview`, the notice line). A limit, cooldown, pacing or delayed usage poll clears on its own and is not counted; the pill, bars and at-limit line already show it. When a line moves or goes, change its count in the same PR, so no count points at a line the row no longer shows. #887 kept the notices only because the count pointed at them.

## Why This Matters

Each extra line adds height to every row in that state, and the page lists every account. On the synthetic page measured for PR #897 (made-up rows shaped like the live page), the notice line cost 32 px for one family and 56 px for two, at every width from 320 to 1440 px. Removing it took a row blocked with two spent families from 121 to 65 px at 1440 px and from 342 to 286 px at 390 px. After the deploy, a read-only check of the live page measured the four Anthropic rows in that state at 65 px at 1440 px and 286 px at 390 px.

Suppression rules between two homes multiply, and each needs its own tests. A fact with one home needs none. Each earlier change listed under Context shipped and was then redone, which is what skipping question 1 cost.

Not yet seen live as of PR #897: a Ready row's "at limit" family names (no live Ready row had a spent family), and the bordered Clear cooldown button (issue #890 stays open until a cooldown row shows it).

## When to Apply

- Adding any status, limit, hold, notice or control to the collapsed row in `AccountListItem.tsx`, including the priority editing that #898 proposes.
- Changing the attention summary, its count or the list's search and sort in `account-list-view.ts`.
- Adding a routing reason or availability value in `account-routing.ts`: decide whether it is a Combos decision (a notice) or a limit (the at-limit line) before rendering it.

## Examples

Made-up accounts. Before PR #897, an account at 100% weekly with Fable and Opus spent:

```
account-a  Usage exhausted   [Weekly 100%] [Fable 100%]   Refresh  Pause  Details  More
           Fable: Model exhausted
           Opus: Model exhausted
```

After PR #897, the pill and the red bars already say it:

```
account-a  Usage exhausted   [Weekly 100%] [Fable 100%]   Refresh  Pause  Details  More
```

A Ready account whose Opus family the router skips, with no Opus bar to show it:

```
account-b  Ready             [Weekly 64%]                 Refresh  Pause  Details  More
           Opus at limit
```

A Ready account with a Combos decision pending keeps its notice, because it asks the operator to act:

```
account-c  Ready             [Weekly 30%]                 Refresh  Pause  Details  More
           Fable: Action required — New billing class requires review. Review in Combos.
```

## Measure layout before claiming it

PR #896's description said rows without Re-authenticate were "the same height as main from 720px up". A later measurement on the synthetic page, posted on issue #890, showed that held only from 720 to 1240 px. At 1280 px and up most rows were 4 px shorter, a row with Clear cooldown was 4 px taller, and a row with a long provider name such as `anthropic-compatible` could wrap its priority onto a second line at 1440 px, 18 px taller. The squash commit still carries the wrong claim.

Before writing a height or a position into a PR description:

- Render main and the branch from the same synthetic data. The repo has no fixture page for this. The synthetic pages behind #896 and #897 were made-up accounts served by scratch scripts kept outside the repo, so production data never reached a PR.
- Measure each row shape at every width the claim covers: at least 1440, 1280, 1024, 768, 390 and 320 px, plus a sweep across the widths where the layout changes its columns.
- Write the per-width numbers, each labelled synthetic or live, rather than a range. "Same height from 720px up" covered widths nobody had measured.

A related rule for production rates is [Verify fix ancestry before writing a measured production rate into permanent rationale](../workflow-issues/verify-fix-ancestry-before-citing-a-measured-rate.md).

## Related

- PRs #879, #883, #887, #892, #896 and #897.
- Issue #890: Accounts row actions, open as of this writing until a cooldown row is seen live with the bordered Clear cooldown button.
- Issue #898: drag rows to set routing priority, open and not started.
- `docs/combos.md` defines the Combos routing reasons that the notice line reports.
