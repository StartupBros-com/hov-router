# Concepts

Words that mean something specific in this codebase. Definitions here are the shared
vocabulary that `docs/` and `AGENTS.md` can cite without redefining.

## Routing

### Route profile

A named routing choice, offered to the client as a pickable model, that sends a Claude Code
session tree to a chosen account or pool instead of ordinary routing. A pinned profile names
one account; a capability profile admits every account that can serve it (see Root-capable
pool). A profile names a logical model and may also assert the expected provider and physical
model.

Those assertions are checked when an account is selected, against the account's own configured
model mapping. They are not checked against a default the provider fills in later, when it
builds the upstream request. An account that relies on its provider's default model therefore
fails a physical-model assertion even when the model it would send is right, and a family that
turns automatic stops satisfying one. A pinned profile meant to follow a provider's newest model
should assert only the provider; a capability profile meant to follow it names a catalog role
or an approved line instead of a physical model. A catalog role is a position in the catalog; an
approved line names the model, so a profile that should stay on one model, or whose name names
one, follows the line.

What the client is shown follows routing, not configuration. Each offered profile is labelled
with the model it currently serves, so a profile that follows a catalog role is relabelled when
the provider re-ranks its catalog, and one that follows an approved line when a newer supported
model of the line appears. A profile whose accounts are all paused, or can never satisfy
its assertions, is not offered. The operator's configured name shows only while the served model
is still unknown.

A profile can keep former names that still resolve to it, so a client that saved one keeps
working after a rename. Only the current name is offered to the client and recorded on requests.

### Force route

A request's demand that one exact account serve it, carried by the account header or by a
pinned route profile. Selection fails closed: when that account is paused, rate-limited, out of
capacity, or cannot satisfy the profile's model assertions, the request is rejected rather than
routed to any other account, so a forced request never lands on a provider the caller did not
name. The rejection happens before any provider code runs, so it leaves no provider-side trace.

A pinned profile that sets no context or output bound may opt in to one narrow exception for its
web-search helpers (see Trusted internal helper). Those helpers go to approved subscription
accounts whose fresh usage evidence shows allowance left and no billing beyond the plan, with no
further fallback. The session's own requests stay on the pinned account. The account header
allows no exception and switches the opt-in off.

### Logical model

The model a request names in Claude's vocabulary, before any account or provider translates
it. Distinct from the physical model an upstream serves.

### Physical model

The model an upstream provider actually serves for a request, after the account's model
mapping or the provider's default has translated the logical model.

### Catalog role

The physical model an account's own provider catalog currently offers for a logical model
family, derived from how that catalog ranks its models rather than named in any configuration.

A catalog role moves whenever the provider re-ranks or replaces its models, with no
configuration change. A route profile that follows a catalog role admits an account only on
evidence from that account's own catalog, never another account's listing, and refuses an
account with no current evidence for the role rather than guessing a model.

### Bundled model catalog

The list of Claude model identifiers compiled into the proxy. It is distinct from the live
catalog a provider reports for an account (see Catalog role).

Offline pricing, list-price eras, model pickers and each family's latest-model alias all read
the bundled catalog. A model released after the build therefore stays unknown to them until a
new build ships, even while a provider's live catalog already lists it. The model a request is
sent with does not depend on bundled-catalog membership, so a well-formed identifier of a known
family is sent the same way whether or not the catalog lists it (see Same-family pass-through).
Safeguards that key on known models can still skip it. For example, the optional protection
that holds back sends during an Anthropic degradation covers only catalogued models and lets
others through.
When a request names a model that the bundled catalog lacks, the warning it raises reports
catalog freshness, not a routing failure.

### Automatic family

A logical model family on an account that no configuration fixes, so the account serves whatever
its own catalog role resolves to, or, without one, another account's catalog or a built-in
default. Its opposite is a
pinned family, fixed by an account mapping, a fallback list, a custom-endpoint or environment
mapping, or a provider-wide override.
*Avoid:* unmapped family

Turning a pinned family automatic changes what route-profile checks see even when the served
model stays the same (see Route profile).

### Same-family pass-through

A combo slot or managed assignment can store only a family name. When it does, this rule sends
the client's own well-formed model of that family upstream unchanged, instead of rewriting it
to the family's latest bundled model.

Eligibility is decided by the identifier's shape, not by bundled-catalog membership, so a model
released after the build passes through from its first request. The rule applies only on the
live request path and only within one family. A malformed identifier, a cross-family fallback
slot and a version-pinned account still resolve to the family's latest bundled model. A slot
that stores a concrete model keeps sending that model.

### Upstream client identity

The client software version and origin metadata a provider adapter advertises to an
upstream service, distinct from account credentials and the version of any separately
installed command-line client.

Catalog discovery and inference can use different identity formats while sharing the
same version. A model advertised to one client identity is not proof that a request
from another identity will be accepted. The identity follows an installed client only
through explicit configuration, either a version set directly or a verified version
record, never by running or inspecting that client; without either it stays at the
adapter's built-in version.

### Root-capable pool

The accounts admitted by a capability profile because each can serve the profile's root
logical model through its expected provider and physical model, or through the model at the
profile's catalog role, or the newest supported model of its approved line, in that account's
own catalog. Membership establishes the
preferred pool for descendants; it does not force every child family onto the root physical
model.

### Commit-bound routing

A route policy that may walk authorized fallbacks before provider work begins, then preserves
the selected lane once an irreversible dispatch or meaningful response makes replay unsafe.
Availability is flexible while candidates are hypothetical and strict after work may have
happened.

### In-place retry

A bounded resend of the same request to the same login after a short randomized backoff, made
when the upstream reports it is temporarily overloaded, without going back to account
selection.

Each resend reuses the login picked for the request and the account state read when it was
picked, so a condition that must see changes made since then, such as an
[extra-usage hold](#extra-usage-hold), is read again from storage before every send. Each
resend is its own [physical attempt](#physical-attempt-usage). It is distinct from a failover,
which moves the request to another account.

### Windowless 429

A rate-limit refusal from Anthropic that tells the client to retry but carries none of the
headers that name a usage window, so it says nothing about the account's quota.

The router treats it as a refusal of that request, not of the account: it puts no account on
cooldown and marks no model as spent. Once a subscription account has returned one, the request
skips the remaining subscription accounts, while API-key Anthropic accounts and other providers
are still tried. When no account is left, the request fails as an overload or as no route being
available, not as a usage limit, and its [terminal cause](#terminal-cause) is a generic upstream
error from the last account tried rather than the windowless 429 itself.

### Organization refusal

Anthropic refusing an account's whole organization rather than one request: every request and
every usage check on that account gets the same permission error until it lifts, most often
because the subscription payment failed. The account card shows it as *Anthropic refused*.

No local action clears it; it lifts when Anthropic accepts the account again, usually once the
bill is paid. The router hears of it from proxied requests and from its own usage poll. The poll
is the witness that keeps working: a refused account loses its usage readings, and with them its
place in [drain-soonest](#drain-soonest) order, so it can go without traffic until it recovers.
The operator is alerted once when a refusal episode opens and once when it closes, on a request
that succeeds or a usage check that is accepted after the latest refusal. A usage check closes
only an episode in which a usage check was refused too, because the usage endpoint answering
says nothing about requests. Episodes do not survive a restart.

### Terminal cause

The single code the router stores for why a request failed: its own verdict on the request, such
as no usable route, a refused forced route, a broken stream or an upstream error status, or,
when the verdict is that no route was left after accounts were tried upstream, the cause of the
last attempt.

Failure views such as the dashboard's Recent Errors group by it. It is not the error code in the
reply the client received, which is built separately: one failure can reach the client as an
overload while its terminal cause is a generic upstream error, so a code a client saw has to be
traced to the terminal cause before it can be counted. Once stored alongside the record of the
request's routing attempts, it does not change.

### Child route home

The first successful provider, account class, and physical-model lane selected for one child
conversation. Later turns prefer that home for cache and turn continuity; a genuine
availability failure may establish a new home without remapping the parent or siblings.
`session-affinity` and sticky `session-drain-soonest` keep child homes. The default `session`
strategy and `least-used` order every child turn afresh, and so does
`session-drain-soonest-strict`, except while Anthropic degraded mode `enforce` retains a
native Anthropic OAuth owner for that lane.

### Fallback rung

A semantically ordered tier of authorized routes in a capability descendant's candidate plan.

Fresh ranking may reorder candidates within a rung but preserves the order between rungs.
Under a strategy that retains [child route homes](#child-route-home), an authorized, healthy
retained home may lead even from a later rung; the other candidates remain in rung order.
Neither ranking nor retention may add a route that authorization did not admit.

### Agent attribution

The proxy's decision of which agent, if any, a request belongs to, recorded together with how
it was decided: a registered agent matched on the request's system prompt, an explicit agent-id
header, or, when neither matches, the request's own Claude Code session id. That session
fallback exists so per-conversation alerting can key on a conversation; it identifies a
session, not an agent, and is never agent evidence for containment.

### Attributed descendant

A request the Codex provider contains as a subagent: it loses its Agent and Task tool
declarations without entering orchestration election. A request earns this status only from a
real agent identity, meaning a registered agent matched on its prompt, an explicit agent-id
header, or Claude Code's own subagent markers. The proxy's session-id attribution fallback
identifies a session, not an agent, and never confers it.

### Orchestration election

The Codex provider's per-session claim of the single conversation allowed to keep its
orchestration tools. The first eligible request in a session becomes the root; a later request
keeps root when it continues as the same conversation the root already recognizes, or, as a new
conversation, when it shares the root's instructions and continues its lineage; any other later
request is admitted as non-root and loses those tools for that turn. A rejected claim never
renews the root, so the root lapses only when it goes idle past the session TTL, after which a
new claim can win. Attributed descendants and requests that offer no orchestration tools never
enter the election.

### Trusted internal helper

A Claude Code side request, such as WebSearch, whose authenticated caller and session lineage
validate through the same private authority as the parent request even when it carries no
subagent marker. Helper classification grants no capability by itself: the chosen provider
route must still hold an exact reviewed proof.

### Credit drain

A per-account opt-in that lets a subscription account holding purchased provider credits keep
serving client traffic after its plan windows are spent, so the provider bills those credits
instead of the account being refused.

It holds only while fresh evidence from the account's own usage poll says credits are
available. Without that evidence the account gets the normal spent-window refusal, and that
refusal itself needs a fresh usage reading. It lifts only the account-wide short and
multi-day windows (per-model caps are not lifted) and never covers the proxy's own probe traffic.
Accounts without the opt-in
are refused once a plan window reads full even while the provider still reports them as
allowed: the provider's allowed flag can lag its usage percentage, and the request that
crosses the line is billed to credits.

### Extra usage

Paid usage on a Claude subscription: a setting on the subscriber's own Anthropic account that
lets Anthropic keep serving requests after a plan limit is spent and bill them. Anthropic now
calls it usage credits; its response headers and this codebase's identifiers call it overage.

The router reads the setting from the account's usage readings and from response headers, and
never changes it. A request Anthropic reports as served this way is recorded with the billing
label `overage`. It is the Claude counterpart of the purchased credits that credit drain spends
on a Codex account.

### Extra-usage hold

A period in which the router sends a Claude login no request for the models a spent plan limit
covers, so Anthropic does not bill those requests as extra usage. Holds exist only while the
login's "Don't use extra usage on this login" switch is on, and the router checks them both
when it picks a login and just before each send. The check before each send reads the switch
and holds as they are stored at that moment, not as they were when the login was picked, so a
switch turned on or a hold written in between, as during an [in-place retry](#in-place-retry),
still stops the send. Only when that read fails does the check use the state the login was
picked with.

A fresh usage reading that shows a limit spent holds the models that limit covers until the
reset the reading gave. A response Anthropic reports as billed to extra usage holds every model
by pausing the login with reason `overage`; that hold ends when the member resumes the login,
when Return after reset returns it after the stored reset, or when a later reading holds a
limit that covers the billed model. Turning the switch off ends every hold at once.

It is not a warm-owner hold, which delays a drain to keep a prompt cache warm and never stops
a login from serving.

### Banked reset

A free credit a provider grants to an account that, when redeemed, resets the account's usage
windows ahead of schedule. Unlike credit drain, it buys no paid usage; it restores plan
capacity.
*Avoid:* bonus reset

OpenAI calls it a rate limit reset credit. Redeeming one resets the Codex 5-hour window and,
on Pro, the weekly window, and moves the weekly reset date to about 7 days after redemption.
Each credit expires 30 days after its grant. OpenAI also reports an applicable count per
account, but it does not tell whether a redemption will work: an account can read 0 and a
redemption still resets it. The Codex CLI and the router's Use reset both redeem on the held
count alone, and the dashboard shows only that count. Credits arrive in grant waves that reach
many accounts within minutes.

A redemption rolls the windows over early, so the usage-window ledger cannot tell it from a
provider's own early reset (shown as a "bonus reset") unless the redemption is recorded.

### Member notice

A notice for House of Vibe members about a provider event: a banked-reset grant wave, a wave
nearing its expiry, or limits that appear to have reset early. The router detects it and sends
a signed, account-free event to a separate receiver, never to the alert webhook; House of Vibe's
receiver holds it for review, then posts the member-facing message. The event never names an account or carries
per-account counts or fleet totals. Operational alerts are the opposite: they go to the
operator and name accounts.

### Affinity lane

The unit to which session affinity pins an owner account: one client session's traffic for
one protocol, request path, model and set of requested beta features, separated further by
route profile when one applies.

Ordinary and profile lanes (and the client-session fallback) retain their owners across
restarts in session-affinity and sticky drain-soonest mode, restored from finalized request
history within the affinity TTL. Child-home and web-search helper lanes have
process-local identities and do not survive a restart. Strict drain-soonest and strategies
that order every turn afresh do not restore owners.

One session and model can run several lanes at once, each with its own owner, so a
session's successive requests can alternate accounts while no owner moves. It is unrelated to
the physical-model lane, the hosted and native web-search lanes, and the
database's *Reader lane*.

### Drain-soonest

An account order that spends first the multi-day allowance most at risk of expiring unused:
candidates rank by weekly pace band, and the soonest reset only breaks ties within a band.

Structural route class (fallback rung and account priority tier) still outranks the band.
An account with no usage reading has neither a band nor a reset, so it ranks behind every
account in its route class that has a known reset. The order decides fresh assignments and
failovers. In sticky mode, whether an established
session owner moves to a higher-band account depends on the provider: a Codex owner stays
until it becomes unavailable, while an Anthropic owner moves after a warm-owner hold.

### Weekly pace band

The urgency class of an account's multi-day window: the percentage still unused divided by
the hours until that window resets, bucketed so an account that must burn faster to use its
allowance ranks above one that can burn slowly.
*Avoid:* quota pressure band

Bands compare only candidates of the same provider, billing class, window kind, and model
family. When the request's model family has its own multi-day window, that window sets the
band instead of the account-wide one.

### Warm-owner hold

A bounded delay in which an Anthropic session owner, outclassed only by a higher weekly pace
band within the same route class, keeps serving while its prompt cache is certainly warm, so
the drain waits instead of paying a full cache rewrite.

The hold applies only while the owner served the session's previous turn recently enough
that the cache cannot have expired, and each hold episode is capped from its first held turn.
It delays a drain but never blocks it; an unavailable owner, tier or fallback-rung recovery,
and strict mode are never held.

### First-party Anthropic account

An account with provider `anthropic` whose endpoint is the default or exactly
`https://api.anthropic.com`. Gateways that speak the Anthropic wire format, such as
`anthropic-compatible` accounts or `anthropic` accounts with a custom endpoint, are not
first-party, even when they relay to Anthropic.

### Native passthrough tool

A typed Anthropic server tool, currently only Claude Code's advisor, that the proxy neither
executes nor proves. Its declaration and history are forwarded unchanged to a first-party
Anthropic account. Where no such account would serve, the request is refused with text the
client recognizes as "drop this tool and retry", never stripped silently. It is distinct from a
hosted server tool such as WebSearch, which a provider route serves under an exact reviewed proof.

### Native web-search passthrough

The second way to serve `web_search_20250305`, beside hosted WebSearch. `api.anthropic.com`
executes the tool itself, so a first-party Anthropic account serves the request with the
declaration forwarded unchanged, no capability tuple, no proof and no replay envelopes. Hosted
WebSearch is the other lane: a provider such as Codex runs the search under an exact reviewed
tuple and the proxy translates the result. Advisor passthrough (see Native passthrough tool) is
a different mechanism: advisor has no hosted lane, so it only constrains the pool to first-party
accounts, whereas web_search keeps both lanes and one search runs per request. A forced
`web_search` tool choice is demoted to `auto` on this lane for models that reject forced choice.

## Usage measurement

### Cache parity

A sustained cache-reuse verdict for qualified Codex follow-up traffic, requiring the
project's cache-read and hit-rate floors, physical-model checks, a contemporaneous Anthropic
comparison when sufficiently sampled, and non-regressing request outcomes.

A short-window recovery or absence of a degradation alert is not parity. First-observed
turns remain visible but do not determine the follow-up verdict; insufficient evidence is
not success.

### Logical-final usage

Usage attributed to a client request's final accounted result, rather than to every upstream
attempt made while serving it.

Retries and failovers can produce several physical attempts for one logical request, so
logical-final usage and physical-attempt usage are not interchangeable populations.

### Session remap

A change of the account serving a conversation's next turn, judged against that
conversation's own previous turn rather than the session's previous request, made without a
failover; the new account must rewrite the whole cached prompt prefix.

A remap is distinct from a failover (a move forced by a failed attempt), from concurrent
spread (parallel requests of one session landing on different accounts at the same moment),
and from lane interleaving (successive requests of different affinity lanes of one session,
each served by its own owner). Raw same-session account changes are mostly concurrent spread,
and sequential changes within one session and model are mostly lane interleaving. So remap
cost is measured only after matching each request to the conversation turn it continues,
against a baseline drawn from same-account sequential requests after the same idle gap.
A matched pair straddles a start when its two turns were served by different backend
processes, as the `processStartedAt` in each request's routing summary shows; straddling
pairs are counted apart from the rest so the effect of a process start on routing can be read
on its own.

### Physical-attempt usage

Usage reported for one upstream dispatch, including attempts that a retry or failover may
hide from a logical request's final accounted result.

Comparing it with logical-final usage requires matching the populations and respecting each
source's token semantics: a cache-inclusive input total already includes cache reads, while
an additive input count must be combined with the separate cache-read and cache-write counts.

### Advisor usage

The tokens a response spends consulting Claude Code's advisor, the second model Anthropic runs
partway through a response (see Native passthrough tool). They are billed at the advisor
model's own rate.

They are recorded per advisor model and never folded into the serving model's own token
counts. They are counted in full even when the per-consultation detail kept for pricing is
capped. A response that exceeds that cap is marked billing-incomplete rather than
under-reported. An advisor model with no known price keeps its tokens and contributes no
estimated cost, so the response is marked billing-incomplete.

### Canonical usage window

One provider-reported capacity measurement, normalized into the single shape the rest of
the system consumes: which window it describes, how much of it is used as a percentage on
a 0–100 scale, when it resets if it ever does, and whether the provider flags it as active.

Providers disagree wildly about how to express this — some send fractions rather than
percentages, some nest windows inside an array, some name the same window differently, and
some report a balance with no reset at all. Normalization runs through a single shared
function, invoked at each of the several boundaries where a poll result enters the system,
so that adding a provider never means editing persistence, alerting, or display. There is
one implementation of the parsing rules even though there is more than one entry point.
Anything downstream that re-parses a native provider payload is a bug: it means two
components can disagree about the same number.

### Window key

The identifier naming *which* capacity window a measurement describes — a short rolling
window, a multi-day window, a multi-day window narrowed to a single model family, or a
resetless credit balance.

Keys are stable across providers, which is what lets history and alerts compare one
account against another. A key scoped to a model family is not interchangeable with the
account-wide key of the same duration: they can hold very different values at the same
instant, and treating one as the other is how an account gets withheld from lanes it could
still serve.

### Usage snapshot

One poll's worth of canonical usage windows for a single account, recorded as one row per
window against a shared timestamp.

Every successful poll is recorded, with no deduplication of unchanged values. This is
deliberate: both the trend prediction and the chart need a faithful, near-uniform series,
and collapsing flat stretches to a single row makes idle windows fall out of range queries
and biases the fit. Volume is bounded by retention pruning rather than by skipping writes.

### Binding limit

The one capacity window a provider marks as currently constraining an account, in those
provider shapes that express such a thing at all.

Only the shapes reporting an explicit array of limits carry this distinction. There, the
provider marks just the binding entry active and leaves the others inactive *regardless of
their percentages* — an inactive window sitting at high headroom is normal and expected,
not a data error. Every other provider shape marks all of its windows active by default,
so an active flag is load-bearing information in the first case and merely a default in
the second; read it accordingly. Inactive windows are worth recording for historical
completeness, but must not drive routing or alerting decisions.

### Point budget

A ceiling on how many measurement points a single fleet-wide history read may return.

When the budget is reached, whole series are dropped in rank order — never silently
thinned — and the response says what was omitted. A budgeted response must be presented as
a partial view, because rendering it as a complete one would tell an operator the fleet has
no data when in fact the read was truncated.

### List-price era

A span of time, starting at a fixed instant, during which one published list price applies to
a model. The tokens an account used in a closed capacity window (see Canonical usage window) are
valued at the era in effect, so value history follows rate changes without rewriting earlier
spans' rates.

A model can have a long-context tier, which bills a whole request at higher rates once its
prompt passes a threshold. The tier is decided per request, so valuing such a model needs the
window's tokens split by whether their request crossed the threshold. A per-model total
without that split is never priced at the base rate. When the era table is revised, closed
windows are re-priced from the detail they stored when they closed.

### Unpriced tokens

Tokens that a valued window counts but cannot price. This happens when the model has no
list-price era, the time precedes every era, a needed rate is unknown, or a tiered model's
long-context split is missing.

They are kept apart from priced value rather than treated as free, so an incomplete window reads
as incomplete instead of cheap. Re-pricing works only from what a window stored when it closed.
A closed window is rebuilt from individual requests only when its external usage changes (see
External usage), and only while retained request history still reaches back to the window's
start and holds every request it counted. As a result, tokens left unpriced for lack of a rate
or era become priced once one is added, while tokens left unpriced for lack of stored detail
stay unpriced.

### External usage

Subscription usage that a client recorded in its own session logs without going through the
router, counted into the same account's window value alongside the router's own requests.

It must hold only usage the router never saw. A client session whose log names the router as
the service it used is already counted as requests, so its logged usage is left out, and so is
any usage under a route-profile name, which only the router serves. External usage under such a
name therefore means the same usage was counted twice, not that a price is missing (see Unpriced
tokens). A session that reached the router but logged itself as direct use cannot be told apart:
its usage is counted twice under an ordinary model name and prices normally, so only matching it
against the router's requests reveals it. When a closed window's external usage changes, the
window is rebuilt from the router's requests plus its current external usage, but only while
retained request history still reaches back to the window's start and holds every request it
counted; otherwise it keeps what it stored when it closed.

### Public subscription value

An opt-in feed, readable without authentication, that values each published subscription
account's multi-day capacity windows (see Window key) at API list prices and shows each account
under a public label instead of its name.

An account appears only once it is explicitly published with a label, and a label that would
reveal the account's own name or identifier is refused, including after a rename. The open window
is valued live from the usage recorded in it so far; closed windows are valued from what they
stored when they closed (see List-price era). Each window says whether all of its tokens were
priced (see Unpriced tokens) and whether it was first observed partway through. Only windows that
began at or after the account's creation are published, so a replaced account never shows its
predecessor's history. Responses are reused for a short time rather than recomputed for every
reader.

## Local authentication and recovery

### Local-control secret

A persisted secret shared by an installation's command-line clients and proxy for local
control requests, also used to derive the encryption key for OAuth rotation recovery records.

Unlike a disposable process-local credential, it must remain available across restarts while
recovery records depend on it. A newly generated value whose save failed cannot fulfill this
role, even when ordinary settings are allowed to continue in memory.

### Rotation slot

A fixed-size encrypted file per account whose provider rotates its refresh token, made while
there is space and overwritten in place after that, holding a rotation the provider has
committed but the database has not stored yet.

Because a save rewrites blocks the file already owns, it works on a full disk; an account with
no slot and no space has its token refresh refused before the provider is called, so no
rotation can exist that nothing can store. A slot can hold the only copy of the refresh token
the provider still accepts, so deleting one can cost that account its sign-in. Only deleting
the account itself proves no live account can still own a slot's rotation. The slots replaced
an older store that wrote a new file for every save, which a full disk refused; files left by
it are still read at start and removed once a slot holds the account's current rotation. The
slots are encrypted with a key derived from the *Local-control secret*.

## Process supervision

### Memory recycle

A deliberate stop-and-restart of the supervised upstream, triggered because its own memory
footprint stayed above a configured ceiling for a sustained run of consecutive samples —
not because it crashed and not because an operator asked.

A recycle drains before it stops (see *Guard-first drain*) and deliberately does not count
toward the *Restart circuit*, so it never feeds restart backoff: a recycled process
returns immediately, while a crash-looping one is held off. Recycles are bounded per rolling
window. Exhausting that budget is recorded and then leaves the process uncontained rather
than restarting forever, which makes budget exhaustion an incident signal rather than routine
noise. The counter lives in the supervisor process itself, so a supervisor restart resets the
window — a subtlety worth remembering before reading a low recycle count as evidence of a
quiet day.

### Guard-first drain

The shutdown ordering a memory recycle follows: the admission guard sitting in front of the
upstream is stopped first so it admits no new work, and the upstream is stopped only once
in-flight requests have settled.

The reverse order would destroy work the guard could have let finish. A drain that completes
on its own is recorded distinctly from one that hit its deadline and was forced, and the two
are never collapsed into one outcome, because a forced drain means clients saw errors while a
natural one means they did not.

### Quiesced backend

An old upstream that a backend-only deployment has told to stop being the owner while it
finishes work it already accepted. It has released its listening port, stopped its schedulers
and refreshes no tokens. It keeps its database connection and in-flight responses until the
guard retires its generation, and is then stopped.

Quiescing lets the replacement boot on the same port while old streams run, so new requests
wait for one boot instead of for the longest old stream. It is not blue/green. At any moment
exactly one process admits requests, and at most one quiesced process only finishes. A backend
that cannot prove it quiesced, because it lacks the capability or still holds the port, is
drained instead.

### Restart circuit

The supervisor's bound on restarting a stack whose children keep failing: failures are counted
inside a rolling window, and once the count reaches a cap the circuit opens and the supervisor
stops restarting.
*Avoid:* child-failure circuit

An open circuit normally ends the supervisor with an exit status of its own, so the service
manager decides what happens next. Only an explicit hold, outside a service manager, keeps the
supervisor running and paused until an operator restarts it. The count starts over once the
window has passed, or when the stack had stayed up long enough to count as stable before it
failed. Below the cap, each restart waits a backoff that doubles with each failure up to a
ceiling. A *Memory recycle* that completes is not counted, but one that fails counts like any
other failure. An *Out-of-space start* is not counted, within the limits its entry gives.

### Out-of-space start

A start of the upstream, or of anything the supervisor needs before it, that failed only
because the disk has no space left.

The supervisor waits one out and tries again, for as long as the disk stays full, instead of
counting it toward the restart circuit. Exiting would hand the restart to the service manager,
whose start limit leaves the service failed until a person resets it, long after the space has
come back. Only failures that report a full disk qualify. An I/O error does not, because a
failing device raises one on a disk with room, and waiting for space would never end. Nor does
a failure after the stack was ready, or during a deployment or its rollback: those keep the
bounded circuit.

### Start reserve

A small file of written bytes kept beside the database, which the server removes when its
start cannot open the database for lack of space, so that the immediate retry has blocks to use.

One reserve covers one start: it is written back only once space returns, so a second start on
a disk that stayed full has no margin. Only the server's start spends it. Command-line commands
opening the same database never do, so they cannot use up the margin the next start depends on.
Deleting it by hand removes that margin without any other effect.

### Ownership record

The supervisor's durable note of which upstream process owns the database: written before the
upstream is launched, and completed with that process's identity once it is running.

A record left between those two writes names nothing that can be checked, so the next
supervisor start holds rather than risk a second owner, and stays held until a person settles
it. The supervisor closes such a record itself when it knows nothing was launched for it, or
when it knows which process was launched and has stopped it. Between a launch and learning which
process it started, the record is left to hold, because a process it cannot name may be running. A record that cannot be read holds the same way, since only a
missing file proves there is no record. The supervisor's exit path decides all of this from what it has done so
far, never from how it was asked to stop, because a shell can leave through its exit handler
without running the handler for the signal that stopped it.

### Managed pin

The deploy-owned block of service configuration binding a running deployment to one exact
build, guard, runner, and policy set, written and replaced only by the deploy tool.

Operator policy belongs in a separate, later-loading fragment; anything an operator writes
inside the managed block is overwritten by the next deploy without warning. The pin is what
makes a deployment verifiable after the fact — the running service is checked against the
exact artifacts the pin names rather than inferred from a filename. A pin can drift from what
the current source expects, and not every verification path inspects every value it carries,
so confirming a specific policy value means reading the pin rather than trusting a green
pre-flight check.

Merging does not move the pin. Deployment is a separate, deliberate act, so the pinned build
routinely lags the default branch — which makes the pin, not the branch, the correct answer to
"what produced this behavior." Any measurement taken against the running system is scoped to
the pinned build and can already be stale with respect to fixes that have merged but not
shipped.

## Approved lines

### Approved line

An approved line is a named model line and the exact model identities the router supports on it (`SUPPORTED_IDENTITIES` in `packages/providers/src/auto-model-capabilities.ts`). Catalog position never adds a model to a line. A Codex route profile can follow a line (`gpt-astra` or `gpt-sol`): each account serves the newest supported model of that line in its own catalog, wherever the provider ranks it. The Claude lines were read only by the Auto quality lane, removed in #816. The catalogue-gap alert keeps that lane's id, `auto_line`, which stored alerts carry; it fires when a newly released model's name places it in a line a route profile can pin and the line does not support it.

## Ingress policy

### Background merge policy

An opt-in, server-owned policy that rewrites the merge ban in Claude Code's background-session
instructions into an operator merge grant, and refuses the request when those instructions are
not a render it recognizes.

Only the complete host-written section counts, and the job's scratch path is its only variable
part. A recognized render that carries no merge ban is forwarded unchanged and gets no grant.
When the section's heading or its Git paragraph's opening sentence is present but the section is
not a recognized render, including a new Claude Code release's wording, the request is refused
rather than forwarded, so host drift surfaces as an error instead of a silently unedited ban. A
request carrying neither is forwarded unchanged, so a release that renamed both would pass with
no grant and no error. The refusal happens before routing and leaves no request history. The
refusal message calls these instructions the *host template*.

## Stream liveness

### Semantic commit

The moment the router releases a held streaming response to the client. It buffers the first
events of an attempt and commits only when one carries content, ends the message, reports an
error, or is of a type it does not recognize. Before commit the router can still abandon the
attempt and try another route without the client seeing anything; after commit the client has
output on screen and the attempt is final.

### Protocol activity and meaningful progress

Protocol activity is any well-formed stream event, including keepalive pings, lifecycle events
and integrity signatures; meaningful progress is narrower, an event that carries non-empty
text, thinking or tool-call input. Idle deadlines that ask whether the stream is still talking
are refreshed by protocol activity, while the commitment deadline that asks whether the model
has produced anything is met only by meaningful progress, which triggers the *Semantic
commit*. A stream that only pings can therefore pass the first kind and still fail the second.

### Synthesized keepalive

A ping the router emits itself, from a local timer, so the client's and the guard's idle timers
stay satisfied while the upstream is silent, as opposed to a ping the upstream sent. It proves
only that the router's own side of the stream is alive, never that the upstream is. Every ping
on a stream the router translates from another provider's format into Anthropic's is of this
kind, the Codex provider's 25 s heartbeats included. Whether one counts as *Protocol activity*
depends on the clock. The pre-commit protocol-idle deadline ignores the translator's pings since
#639, so for xai, kilo and qwen it judges the upstream; openai-compatible has no such deadline
(#505). Codex is not in that translator set (`TRANSLATED_SSE_PROVIDERS`), and #639 left its
heartbeats out of scope, so they do refresh the deadline. For Codex the deadline therefore checks
only that the provider's own stream transform is still emitting, and the upstream is judged by
the provider's 480 s raw-silence timer (`CODEX_STREAM_RAW_SILENCE_TIMEOUT_MS`), which counts
upstream bytes alone. Post-commit liveness counts every ping by design (#636): the client already
has output, and the aim is not to cut a working stream. The commitment deadline never counts a
ping; only *Meaningful progress* meets it.

## Off-thread database work

### Reader lane

A read-only database connection on its own worker thread that dashboard reads can be sent to,
so a slow read never blocks the thread serving proxy traffic. There are two: the bulk lane
takes every read not marked otherwise, including the heavy analytics and statistics scans, and
the interactive lane takes the small reads a page waits on before it can render.

A lane runs one read at a time while the rest wait their turn, which is why the interactive
lane exists: on a shared lane a page read waits behind whatever scan is running. A read that
waits too long fails as busy instead of falling back to the main thread, because running it
there would block traffic for as long as the lane is behind. When a lane's worker faults, the
reads still waiting go to a fresh worker; only once the lane has given up for good do reads
fall back to the main connection. Without an interactive lane, interactive reads use the bulk
lane.

### Off-thread writer

The single database connection that performs the router's writes, on its own worker thread,
so a slow commit makes the waiting caller slower instead of freezing the thread that serves
traffic. While it runs, the main connection refuses writes, so nothing can race its order.

Writes run one at a time in the order they were posted, so they commit in that order. A write
the worker never received runs on the main connection instead, and the writer is retired for
good. Once the worker has received a write, a fault leaves that write's outcome unknown: the
caller gets the failure and the write is never re-run, because running it again could apply
it twice.

## Flagged ambiguities

- *Idle timeout* names several unrelated clocks: the client's own stream watchdog, the guard's
  response-body idle cut, the router's pre-commit protocol-idle deadline, its post-commit
  liveness check, and the usage recorder's inactivity eviction. They are reset by different
  events (see *Synthesized keepalive*), so name the clock rather than "the idle timeout".
- *Active* on a usage window means "currently binding" only in the shapes that report an
  explicit array of limits; in every other shape it is just the default and carries no
  information. A fixture for the limits-array shape that marks every entry active
  describes a payload that shape does not send — a real trap, because that is precisely
  the shape whose active flag is supposed to mean something.
- *Pinned* describes both a route profile that names one account and an account family whose
  model is fixed by configuration. These are distinct: a pinned profile can route to an
  automatic family.
- *Utilization* is always a 0–100 percentage once past normalization, never a 0–1 fraction,
  even though several providers report it as a fraction natively.
- *Drain* names three unrelated things: *Guard-first drain* lets in-flight requests settle
  before a process stops, *Credit drain* spends an account's purchased credits once its plan
  windows are spent, and *Drain-soonest* orders accounts so the multi-day allowance most at
  risk of expiring unused is spent first.
- *Catalog* names both the bundled model catalog compiled into the proxy and a provider's live
  catalog for an account, which a catalog role reads. These are distinct: a model can appear in
  a live catalog while the bundled one still lacks it.
- *Discovery* names both the model list the router offers Claude Code's model picker, which
  lists route profiles, and the fetch of a provider's live catalog for one account. These are
  distinct: the picker list never fetches a provider catalog, and the client refreshes its copy
  of that list only when its own discovery runs.
- *Lane* names unrelated things in routing and in the database: an *Affinity lane* is the unit
  session affinity pins an owner account to, while a *Reader lane* is a database connection that
  dashboard reads are sent to. The physical-model and web-search lanes are routing
  lanes as well. Say which one is meant.
- *Episode* names both a warm-owner hold episode, capped from its first held turn, and an
  organization refusal episode, which runs from the first refusal to the first accepted request
  or usage check after it. These are distinct.

## Retained ingress and cold backend handoff

**Terminal full-service shutdown** stops admission by closing the public listener, then drains and retires all service children. **Retained-ingress replacement** keeps the public guard/listener alive while fencing physical dispatch, draining old streams and replacing exactly one backend database/routing authority. It has a dispatch pause, bounded unread queues and original accepted deadlines; it is not a zero-pause blue/green deployment. While the old backend drains, dashboard reads (GET or HEAD outside `/v1/`, not event streams) still reach it, so only inference, writes and streams pause for the whole drain. The replacement backend inherits the environment of the runner that stays up, so a change to the service's environment takes effect only after a terminal full-service restart.

A **committed backend generation** has verified executable/source, PID/start, listener, nonce, timing/compatibility identity and a durable exact pin before it receives new work. **Admission continuity** measures listener acceptance separately from dispatch availability, stream completion and forced retirement. Ingress source identity may differ from backend source identity after a compatible handoff.

The **accepted request deadline** is the trusted first-header work limit shared across managed ingress and backend. It differs from response-start, stream-idle and meaningful-progress limits (see *Protocol activity and meaningful progress*). Its **cleanup reserve** bounds settlement after the primary terminal; cleanup failure is secondary evidence and cannot renew work or change the first terminal cause.
