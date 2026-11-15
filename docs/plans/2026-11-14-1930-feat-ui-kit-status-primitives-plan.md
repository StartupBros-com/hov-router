---
title: "feat: UI kit status primitives, Accounts first (PR 1 of 5)"
issue: 823
refs: [821, 823]
base: 7535ddc4
date: 2026-11-14
status: ready
---

# UI kit PR 1: status primitives, Accounts first

Work spec: StartupBros/hov-router#823 (Refs #821). Dashboard presentation only. Routing, API
responses, storage, provider behaviour and the "Needs attention" predicate do not change.

All paths below are relative to `packages/dashboard-web/` unless they start with `packages/`.

## Settled decisions

| # | Decision | Source |
|---|---|---|
| D1 | Provider mark sits in a 16 px leading column beside the name; the provider word stays on the meta line. | operator, #823 |
| D2 | Extend `src/components/ui`; Accounts adopts first. | operator, #823 |
| D3 | `--warning-solid` is amber-500 / amber-400, the same hue as Accounts' severity dot and throttled bar. The Overview pool bar's warning band shifts yellow → amber until PR 4 removes the band. | #823 "one warning hue" and "move the raw palette classes onto the tokens": a yellow `-solid` would either recolour Accounts' amber dot and bar or leave two hues. The band is the only `-solid` user (PoolUsageRow.tsx:45–49). |
| D4 | Tokens are plain CSS variables used as `text-(--warning)`, `bg-(--warning-soft)`. `--color-success` / `--color-warning` are **not** registered in `@theme`, because Tailwind would then emit `.bg-success` as a utility that overrides the legacy base class (green-100) with the text colour (green-700). | `styles/globals.css` |
| D5 | Two reset times count as the same when they are within 60 s **and adjacent in display order**. The first window of the run keeps the time; each later one shows `same reset`. Non-adjacent equal times both show, so `same reset` always sits directly below its time. | #823 item 5; adjacency keeps the repeat next to the time it refers to, and the real weekly/scoped pairs are adjacent. |
| D6 | The reset presenter lives in `packages/ui-common/src/reset-time.ts` (pure, no dashboard imports), as #823 says. | `packages/ui-common/package.json` |
| D7 | Clock times use one formatter: same local day `7:09 PM`; other day `Nov 15, 7:09 PM`. Relative reset times keep `formatRelativeReset` (`in 2d 2h`). | #823 item 5 |

## Units, in order

### U1 Colour tokens (`styles/globals.css`, `src/components/ui/badge.tsx`)

Add to `:root` and `.dark`. The values are Tailwind 4 palette colours. Every oklch value below
was checked against `node_modules/tailwindcss/theme.css` (installed 4.2.2) and matches it.
A compile with that version generates `text-(--warning)`, `bg-(--warning-soft)` and
`hover:bg-(--success-solid)/80` as plain `var()` declarations.

| Token | Light | Dark |
|---|---|---|
| `--success` | green-700 `oklch(52.7% 0.154 150.069)` | green-400 `oklch(79.2% 0.209 151.711)` |
| `--success-soft` | green-100 `oklch(96.2% 0.044 156.743)` | green-900 at 20% `oklch(39.3% 0.095 152.535 / 0.2)` |
| `--success-solid` | green-600 `oklch(62.7% 0.194 149.214)` | green-500 `oklch(72.3% 0.219 149.579)` |
| `--success-solid-foreground` | green-950 `oklch(26.6% 0.065 152.934)` | same |
| `--warning` | amber-700 `oklch(55.5% 0.163 48.998)` | amber-400 `oklch(82.8% 0.189 84.429)` |
| `--warning-soft` | amber-500 at 10% `oklch(76.9% 0.188 70.08 / 0.1)` | same |
| `--warning-solid` | amber-500 `oklch(76.9% 0.188 70.08)` | amber-400 `oklch(82.8% 0.189 84.429)` |
| `--warning-solid-foreground` | amber-950 `oklch(27.9% 0.077 45.635)` | same |
| `--info` | blue-700 `oklch(48.8% 0.243 264.376)` | blue-400 `oklch(70.7% 0.165 254.624)` |
| `--info-soft` | blue-500 at 10% `oklch(62.3% 0.214 259.815 / 0.1)` | same |
| `--danger` | red-700 `oklch(50.5% 0.213 27.518)` | red-400 `oklch(70.4% 0.191 22.216)` |
| `--danger-soft` | `color-mix(in oklab, var(--destructive) 10%, transparent)` | same |
| `--danger-solid` | red-500 `oklch(63.7% 0.237 25.331)` | red-400 `oklch(70.4% 0.191 22.216)` |

The legacy classes in `@layer base` keep their names and read the tokens:
`.text-success` → `--success`, `.text-warning` → `--warning`, `.bg-success` → `--success-soft`,
`.bg-warning` → `--warning-soft`, `.bg-success-solid` → `--success-solid`,
`.bg-warning-solid` → `--warning-solid`. Their 10 users keep working; the visible changes are
listed under Deviations.

Badge: `success` → `border-transparent bg-(--success-solid) text-(--success-solid-foreground) shadow hover:bg-(--success-solid)/80`;
`warning` → same shape with the warning tokens. Badge `success` has no users today.

### U2 `StatusPill` (`src/components/ui/status-pill.tsx`)

- `cva` base = today's `STATUS_PILL_CLASS`:
  `inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium`.
- `tone`: `neutral` (`bg-muted text-foreground`), `success`, `warning`, `danger`, `info`
  (`bg-(--x-soft) text-(--x)`), `secondary` (`bg-secondary text-secondary-foreground`),
  `primary` (`bg-primary/10 text-foreground`). Default `neutral`.
- Renders a `<span data-tone={tone}>`, forwards `className` (merged with `cn`), `title` and the
  other span props.
- `src/components/accounts/status-tones.ts` keeps `StatusTone` and gains
  `STATUS_PILL_TONE: Record<StatusTone, PillTone>` (`ok→success`, `warning→warning`,
  `bad→danger`, `muted→neutral`). `STATUS_PILL_CLASS` and `STATUS_TONE_CLASS` are removed; all
  seven users are in Accounts and move in this PR.

Adopters (each becomes `<StatusPill>`):

| Where | Today | Tone |
|---|---|---|
| `AccountListItem.tsx:474` plan pill | `rounded-full bg-secondary …` | `secondary` |
| `AccountListItem.tsx:482` Primary | `rounded-full bg-primary/10 …` | `primary` |
| `AccountListItem.tsx:640` status label | `STATUS_PILL_CLASS + STATUS_TONE_CLASS[tone]` | mapped |
| `AccountListItem.tsx:665` Possible stale cooldown | warning classes | `warning` |
| `AccountListItem.tsx:678` Serving from purchased credits | pill classes | as today's tone |
| `AccountListItem.tsx:935,939` `Badge variant="warning"` | solid Badge | `warning` |
| `BankedResetsSummary.tsx:108` `rounded-2xl` box | bordered box | `neutral`, holds `Banked resets {N}` only |
| `BankedResetsSummary.tsx:139` includes last known | toned text | `warning`, copy `Last known` |
| `BankedResetsStatus.tsx:155` Last known | bare toned text | `warning` |
| `BankedResetsStatus.tsx:205` Last known | pill | `warning` |
| Peak pills / any other `STATUS_TONE_CLASS` user | | mapped |

### U3 State components (`src/components/ui/state.tsx`) and the OAuth spinner

- `LoadingState({ label, rows = 3 })`: `role="status"`, `aria-label={label}`, a visible
  `{label}…` line and `rows` Skeleton bars.
- `ErrorState({ title, message, onRetry, retryLabel = "Retry" })`: `role="alert"`; renders a
  `Button variant="outline" size="touch"` with `retryLabel` **only** when `onRetry` is given.
- `EmptyState({ title, description, action })`: plain block, no role.
- `AccountsTab.tsx`: the hand-made loading markup becomes `<LoadingState label="Loading accounts" />`;
  the error card becomes `<ErrorState title="Accounts could not load" message={…existing message…} onRetry={() => void loadAccounts()} />`.
  `loadAccounts` is the `refetch` already bound at `AccountsTab.tsx:256`.
- `src/components/OAuthTokenStatus.tsx`: add `TokenStatus` value `"unknown"`. The fallback effect
  sets `"unknown"` and message `OAuth token status unavailable` when `getTokenHealth()` throws,
  returns `success: false`, or has no row for the account. The view keeps the spinner for
  `"error"` (fallback in flight) and shows a static `AlertTriangle` in `text-muted-foreground`,
  title `OAuth token status unknown`, sr-only `OAuth token status unknown`, for `"unknown"`.
  Icon colours move to tokens: warning `text-(--warning)`, critical/expired `text-(--danger)`,
  default `text-muted-foreground`, spinner `text-muted-foreground`.

### U4 Touch size (`src/components/ui/button.tsx`)

- New sizes: `touch: "min-h-11 px-5 py-2"` (default size at 44 px),
  `"touch-sm": "min-h-11 rounded-md px-3 text-xs"` (sm at 44 px),
  `"touch-icon": "h-11 w-11"`.
  Row buttons move from `size="sm" className="min-h-11 …"` to `size="touch-sm"`, so their padding
  and text size do not change (tailwind-merge would otherwise turn `px-3 text-xs` into
  `px-4 text-sm`). Icon buttons move from `size="sm" className="h-11 w-11 p-0"` to
  `size="touch-icon"`.
- Export `touchTargetClass = "inline-flex min-h-11 items-center"` from `button.tsx`. The
  `<summary>` toggles (`AccountList.tsx:261`, `BankedResetsSummary.tsx:78,108`,
  `BankedResetsStatus.tsx:148`) and the raw `<button>`s (`AccountList.tsx:119,240`) use it in
  place of their typed `min-h-11`.
- Every Accounts `DialogFooter` button uses `size="touch"`, and the five footers that type
  `[&>button]:min-h-11` drop it: `AccountCustomEndpointDialog:138`,
  `AccountModelMappingsDialog:322`, `AccountPriorityDialog:115`, `DeleteConfirmationDialog:79`,
  `RenameAccountDialog:115`, plus the plain ones `AnthropicReauthDialog:164`,
  `CodexReauthDialog:166`, `QwenReauthDialog:166`, `PublicValueDialog:87`, `UseResetDialog:139`.
- `PublicValueControl`'s Edit button (`AccountListItem.tsx:~256`) becomes `size="touch-icon"`.

### U5 Reset presenter (`packages/ui-common/src/reset-time.ts`)

```ts
export const SAME_RESET_TOLERANCE_MS = 60_000;
/** For each reset, the index of the earlier adjacent reset it repeats, or null. */
export function sameResetKeepers(
  resets: ReadonlyArray<string | number | null | undefined>,
  toleranceMs?: number,
): Array<number | null>;
/** "7:09 PM" on the same local day as `now`, else "Nov 15, 7:09 PM". */
export function formatClockTime(
  ms: number,
  now: number,
  opts?: { locale?: string; timeZone?: string },
): string;
```

Rules for `sameResetKeepers`: compare each reset to the **keeper** of the current run (not to
its neighbour), so a chain of 50 s steps cannot drift; a null, unparsable or non-finite reset
never joins a run and ends the current one. Export both from the ui-common barrel.

Adoption:
- `RateLimitProgress.tsx` compact rows: compute keepers over `usages` in display order. A
  repeated window renders `<time dateTime={iso} title={toLocaleString()}>` with sr-only
  `{toLocaleString()} local time; resets with {keeper label}` and visible `same reset`. The
  sort-key highlight stays on its own window.
- Full (Details) view: a repeated window prints `Same reset as {keeper label}` in place of its
  countdown and `Resets …` line. The kept window drops the trailing ` · in …` after
  `Resets {date} (local)`, because the live countdown above it already shows it.
- Clock times through `formatClockTime`: `formatThrottledUntil` (keeps its round-up to the
  minute and `Less than 1 minute`), `Usage refresh delayed — retry after {clock}`, compact and
  full pacing `Until {clock}`, full-view `Resets {clock} (local)`, Router retry
  (`AccountListItem.tsx:654–664`, visible `Router retry {clock}`, title `toLocaleString()`), and
  `BankedResetsSummary.tsx:31` (`Expires {clock} (your local time)`).

### U6 Accounts row

1. **Leading mark column.** The identity block becomes
   `grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 gap-y-1`: `ProviderMark` in row 1 column 1,
   vertically centred on the name line; the name line (name + OAuth icon) in row 1 column 2; the
   meta line in row 2 column 2. The meta line keeps the provider word, without the mark.
2. **Phone name line.** Below `sm`, the identity block takes the full row (`basis-full`), so the
   actions wrap to the next line; from `sm` up the current `flex-[1_1_8rem]` stays.
3. **No "·" text in any Accounts component** (exact strings below).
4. **Visible window marker.** The aria-hidden `•` / `!` becomes visible text after the label:
   `limiting` (`text-muted-foreground`, `font-medium`) or `exhausted` (`text-(--danger)`,
   `font-medium`). The sr-only text and the `title` stay. The full view's uppercase red
   `limiting` (`RateLimitProgress.tsx:~589`) becomes the same marker.
5. **One chevron size.** `BankedResetsStatus.tsx:163` goes from `h-3 w-3` to `h-4 w-4`.
6. **Raw palette classes onto tokens** in Accounts components: `amber-700` → `text-(--warning)`,
   `green-700`/`green-800` → `text-(--success)`, `red-700` → `text-(--danger)`,
   `amber-500/400` fills and `severityIndicatorClass` → `bg-(--warning-solid)` /
   `bg-(--danger-solid)`, tooltip red/green → `text-(--danger)` / `text-(--success)`,
   `blue-*` notices → `--info` / `--info-soft`. This covers `RateLimitProgress.tsx`,
   `AccountListItem.tsx`, `AccountAddForm.tsx` (40 classes, `:1357–1574`) and
   `DeviceSetupJobCoordinator.tsx:59`. Dark variants collapse into the token.

## Copy table (verbatim)

| Where | Before | After |
|---|---|---|
| `AccountList.tsx:254` xl header | `Usage · resets in` | `Usage and resets` |
| `RateLimitProgress.tsx:322` compact label | `Usage · resets in` | `Usage and resets` |
| `AccountList.tsx:103–116` reasons | `2 to reconnect · 1 limited or paced` | each reason its own `<span>` in a `flex flex-wrap gap-x-3` row; wording unchanged |
| `rate-limit-helpers.ts:344` | `Allowed · warning` | `Allowed with warning` |
| `rate-limit-helpers.ts:347` | `${label} · resets in ${d}` | `${label}, resets in ${d}` |
| `BankedResetsSummary.tsx` summary | `Banked resets 2 · next Nov 17 (in 3d) · includes last known` | pill `Banked resets 2`, then `next Nov 17 (in 3d)`, then warning pill `Last known` |
| same, zero | `Banked resets 0 · none held` | pill `Banked resets 0`, then `none held` |
| same, no expiry | `· expiry not reported` | `expiry not reported` |
| `BankedResetsSummary.tsx:78` | `Banked resets · Not tracked` / `· not read yet` | `Banked resets`, then `Not tracked` / `not read yet` as a separate span |
| `BankedResetsStatus.tsx:157–162` | `2 banked · Expires …` | `2 banked`, then the expiry chunk as a separate span |
| `AccountListItem.tsx:859–884` session | `Session: 12 req · ↑34k in · ✦1.2k cache↑ · ✦56k cache↓ · ↓7.8k out · $1.23 plan · $0.40 api` | `Session` (font-medium), then spans `12 requests`, `34k in`, `1.2k cache write`, `56k cache read`, `7.8k out`, `$1.23 plan`, `$0.40 API`, in a `flex flex-wrap gap-x-3` row |
| `RateLimitProgress.tsx:702` full reset | `Resets 7:09 PM (local) · in 2d 2h` | `Resets 7:09 PM (local)` |
| `RateLimitProgress.tsx:709` | `Data unavailable · Reset unknown` | `Data unavailable` and `Reset unknown` as two spans |
| compact repeated reset | `in 2d 2h` | `same reset` |
| full repeated reset | countdown + `Resets …` | `Same reset as {keeper label}` |
| compact marker | `Weekly•` | `Weekly limiting` / `Weekly exhausted` |
| full marker | `LIMITING` (red uppercase) | `limiting` / `exhausted` (same marker) |
| Router retry | `Router retry: 07:38:43 PM` | `Router retry 7:39 PM` |
| `AccountRoutingPreviewPanel.tsx:112–121` | `·`-joined preview items | separate spans, wording unchanged |

## Tests first

Codex writes these first and stops. I run each file myself and save the failing output to
`/tmp/ui-kit-b72/run/red-<name>.log` before any implementation starts.

| New or changed test file | Cases |
|---|---|
| `packages/ui-common/src/reset-time.test.ts` (new) | 20 s apart → second repeats first; 30 min apart → both own; equal but non-adjacent → both own; null/invalid breaks a run; 50 s steps compare to the keeper; `formatClockTime` same day `7:09 PM`, other day `Nov 15, 7:09 PM` (locale `en-US`, timeZone `UTC`) |
| `src/components/ui/status-pill.test.tsx` (new) | each tone's `data-tone`; rendered class keeps both `text-xs` and `text-(--warning)` (tailwind-merge does not collapse them); `className` merges |
| `src/components/ui/state.test.tsx` (new) | Loading has `role="status"` and the label; Error has `role="alert"`; Retry renders only with `onRetry`, calls it, has class `min-h-11`; Empty renders title/description/action |
| `src/components/ui/button.test.tsx` (new) | `touch` has `min-h-11 px-5 py-2`; `touch-sm` keeps `px-3 text-xs` and adds `min-h-11`; `touch-icon` is `h-11 w-11` |
| `src/components/OAuthTokenStatus.test.tsx` | fallback failure (throw, `success:false`, missing row) ends at a static icon titled `OAuth token status unknown`, no `animate-spin` |
| `src/components/accounts/RateLimitProgress.test.tsx` | compact: shared reset renders one relative time and `same reset`; 20 s apart merged; 30 min apart both shown; marker text `limiting` / `exhausted` visible; full view: no ` · in ` after `Resets`, repeated window `Same reset as …` |

Tests that pin old markup and change in the same commit (named in the PR):
`BankedResetsSummary.test.tsx` (the `·` strings at 106, 109, 110, 117, 119, 130, 166, 175, 187,
192, 197, 256, 272 and the class strings), `RateLimitProgress.test.tsx` (:155, :228–229, :593,
the class regex), `rate-limit-helpers.test.ts` (:460–474), `AccountListItem.test.tsx` (:26,
:59, :185, :214, :216, :251, :318, :1513, :1585, :1794), `BankedResetsStatus.test.tsx` (:172,
:303, :397, :410), and any `RateLimitProgress.lifecycle.test.tsx`, `AccountRoutingPreviewPanel.test.tsx`
or dialog test that pins a changed string or class. No assertion is weakened: a pinned string
is replaced by the new verbatim string, a pinned class by the token class.

## Verification and predeclared gates

Commands: `bun run lint && bun run typecheck && bun run format` (then `git status` — lint
rewrites unrelated files), each affected suite one file at a time, `bash build-dist.sh after`,
then `bun pr1-check.ts after 8097 before` (synthetic server only).

Baseline: `before` bundle at 386e021a (no dashboard change since; 7535ddc4 touches no
dashboard, ui-common or types file), 69/122 checks pass. Results:
`/tmp/ui-kit-b72/run/before-baseline-results.json`.

The after run passes when:
1. Every #823 Accounts check passes in all six combos (1280/390/320 × light/dark): provider mark
   on its name line, one left edge, no overflow, no control under 44 px in main, no `·` text in
   main, limiting marker visible text, shared reset once, 20 s apart once, 30 min apart both,
   no button on the name line.
2. Details open: no `·`, no control under 44 px, no clipped usage cell, toned contrast passes.
3. Dialogs use-reset, public-value and anthropic-reauth: every footer button at least 44 px.
4. Accounts read failure: visible Retry at least 44 px, and clicking it sends a new
   `/api/accounts` request.
5. Token-health failure: no spinner left after 8 s.
6. Count floors: 19 fixture rows rendered and Details opened 19 times; no detector examines fewer
   elements than at baseline.
7. Overview no worse: low-contrast toned ≤ baseline, low-contrast other ≤ baseline, tints rendered
   ≥ baseline, and the warning pool fill is visible with the new amber value (light
   `oklch(0.769 0.188 70.08)`, dark `oklch(0.828 0.189 84.429)`).
8. Every non-neutral `[data-tone]` pill in main has a non-transparent computed background, and
   its text colour differs from the neutral foreground (so a dead `var()` utility fails).
9. Source gate, for states the fixtures cannot render: `rg -F "·"` and a raw palette grep
   (`(text|bg|border)-(amber|yellow|green|red|blue|gray)-[0-9]`) over the non-test files in
   `src/components/accounts/` and `src/components/OAuthTokenStatus.tsx` both find nothing.

Two RateLimitProgress cases (30 min apart, non-adjacent equal resets) pass before the change.
They are guards against over-merging, not red tests, and the PR names them so.

Expected to stay failing (pre-existing, PR 4): Overview "every bg tone class renders a tint"
(unregistered `bg-warning/10`, `bg-success/10`) and the Overview states-light toned contrast
(RateLimitInfo `07:38:43 PM (local)` on `bg-destructive/10`). Neither may get worse.

Pro gate: one round applies — the diff touches the Anthropic, Codex and Qwen re-auth dialogs.

## Deviations from #823 (disclosed in the PR and on the issue)

1. **Other pages shift with the one warning hue.** `.text-warning` goes yellow-700 → amber-700
   (dark yellow-400 → amber-400); `.bg-warning` yellow-100 / yellow-900 20% → amber-500 10%;
   `.bg-warning-solid` yellow-500/400 → amber-500/400 (Overview pool bar band, removed in PR 4);
   Badge `warning` yellow-500 → amber-500 with amber-950 text on RequestDetailsModal,
   ModelCombobox, RequestsTab and CacheEfficiencyView.
2. **Badge `success`** (no users) changes from white on green-700 to green-950 on green-600, so it
   can sit on the token in both themes.
3. **Extra Button sizes** `touch-sm` and `touch-icon` beside the named `touch`, so row buttons
   keep their padding and text size.
4. **Not changed here:** the Overview `bg-warning/10` / `bg-success/10` tints that render nothing,
   and Overview `RateLimitInfo` "Router retry" (both PR 4). The add-account form and the device
   setup notice are tokenised. The after run tries to open the add form for a screenshot (opening
   it is GET-only); the device setup notice needs a running setup job, so it is not
   browser-verified.
5. **Wording changes beyond removing "·".** The session line spells out `requests`, `cache write`,
   `cache read` and `API` and drops the ↑ ✦ ↓ glyphs; `Allowed · warning` becomes
   `Allowed with warning`; `Usage · resets in` becomes `Usage and resets`; the limiting marker
   reads `limiting` / `exhausted`; Router retry drops its colon and seconds.

## Not claimed

Other pages' layout, page headers, the Overview pool bars, chart colours and Requests/Logs (PRs 2
to 5). No colour-contrast compliance beyond what the browser check measures.
