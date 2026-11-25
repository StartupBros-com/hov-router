# Repository Agent Instructions

Instructions for any agent working on **HoV Router** (`hov-router`): a load balancer and gateway that routes Claude Code and other clients across multiple provider accounts, with a dashboard for usage, cost and errors. It is a House of Vibe project at [StartupBros-com/hov-router](https://github.com/StartupBros-com/hov-router), a product fork of [tombii/better-ccflare](https://github.com/tombii/better-ccflare) (MIT). `CLAUDE.md` only imports this file, so edit this one.

## ⚠️ CRITICAL: Anthropic accounts take Claude Code traffic only

Anthropic-backed accounts, including the `claude` account, are Claude subscription logins. Traffic from the unmodified Claude Code binary is normal use: interactive sessions, headless `claude -p`, and programs or containers that run the binary through Router. Anthropic documents `claude -p` for scripts and CI ([headless](https://code.claude.com/docs/en/headless)) and documents gateways that pass subscription traffic through ([LLM gateway](https://code.claude.com/docs/en/llm-gateway)).

**Never send an Anthropic-backed account a request that does not come from Claude Code**, directly or through Router: no curl, test harness, SDK script, diagnostic probe or third-party agent harness, whether or not you would call it "testing". Anthropic limits subscription logins to "ordinary use of Claude Code and other native Anthropic applications" and can enforce that without notice ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)), so such a request puts the account at risk. For scripted API requests, use a non-Anthropic account (ollama, litellm, omniroute, etc.) and force-route with `x-better-ccflare-account-id`.

Nothing here authorizes paid overage.

## ⚠️ CRITICAL: Names that must NOT be renamed

The product is HoV Router, but these operational names predate it and existing installs depend on them. A "consistency" rename breaks configuration, credentials, clients or deployments. Change them only in a separately approved migration.

- **Commands:** `hov-router` is preferred; `better-ccflare` must keep working (`COMMAND_NAMES` in `packages/core/src/product-identity.ts`). New installs no longer create `wstack-router`, but existing `wstack-router` links run the same binary and the upgrade block in `docs/reference.md` keeps them current.
- **Storage:** config directory `~/.config/better-ccflare` (or `$XDG_CONFIG_HOME/better-ccflare`; Windows `better-ccflare` under `LOCALAPPDATA`/`APPDATA`), `better-ccflare.json`, `better-ccflare.db`.
- **Environment variables:** `BETTER_CCFLARE_*`, `CCFLARE_*`, and the legacy `ccflare_*` fallbacks. **Headers:** `x-better-ccflare-*`.
- **Packages and artifacts:** npm package name `better-ccflare`, internal `@better-ccflare/*` workspaces, `apps/cli/dist/better-ccflare`, release asset `better-ccflare-linux-amd64`.
- **Ports and services:** default `8080`; production guard `:8788` → binary `:8789`; `ccflare-stack.service`.
- **Release identity:** the `v1:startupbros-wstack-router-*` provenance tokens embedded in published v3.6.2 through v3.7.1 (later builds embed `v1:startupbros-hov-router-*`; the verifier and runtime catalogue recognize both), and published v3.6.2 bytes and signer identity (historical; never rewrite).
- **Upstream recognition and credit:** `tombii` distribution contexts in build provenance and the version checker exist to classify upstream builds; LICENSE, `docs/acknowledgements.md`, `UPSTREAM.md` and historical citations stay.

Display text uses the constants instead of hard-coded names: `PRODUCT_NAME` / `COMMAND_NAME` from `@better-ccflare/core/product-identity`. Import that subpath directly, not the core barrel, which the dashboard cannot load. Reference: [docs/hov-router-migration.md](docs/hov-router-migration.md#what-stays-the-same).

## ⚠️ CRITICAL: Generated files

**Never edit, stage or commit these auto-generated files.** Leave them out of searches too, since they are bundled build output and a match inside one is not a call site:
- `packages/database/src/inline-vacuum-worker.ts`
- `packages/database/src/inline-integrity-check-worker.ts`
- `packages/database/src/inline-incremental-vacuum-worker.ts`
- `packages/database/src/inline-reader-worker.ts`
- `packages/proxy/src/inline-worker.ts` (retired — see below)

All four `packages/database` files are gitignored build output of `bun run build:cli`.
If one is accidentally modified, do not stage or commit it; re-run that build to
restore it. A fresh worktree will not have them at all, and `bun test` crashes on
import until you build once.

`packages/proxy/src/inline-worker.ts` is no longer generated or tracked: its source worker
was retired. Its `.gitignore` entry stays as a guard; if an old checkout still holds a copy,
never stage it.

**`apps/cli/README.md`** is a short pointer to the root README. This fork publishes no npm package, and the upstream publish hooks that overwrote it with the root README are deleted. Keep product documentation in `./README.md` and `docs/`.

## Git

This repo has both a `main` branch and a `main` tag:
- **Push/fetch:** use `refs/heads/main` (`git push origin refs/heads/main:refs/heads/main`, `git fetch origin refs/heads/main`).
- **Checkout:** use `git switch main`. `git checkout refs/heads/main` detaches HEAD.
- **Comparisons:** use `origin/main` (`git merge-base`, `git log X..origin/main`) to avoid the ambiguous-refspec warning.

Branch from a freshly fetched `origin/main`; never change `main` directly. Before changing anything, run `git status` and note pre-existing changes so you can tell them apart from yours. Stage files by name (`git add <files>`), never `git add .`, which picks up generated workers.

## Deployment source (production)
Production is a root systemd service, `ccflare-stack.service` (guard on `:8788` in front of the binary on `:8789`). Deploys ship only the freshly fetched `origin/main` tip, via `scripts/deploy-ccflare.sh`. Run it from any checkout: it snapshots that tip and runs the snapshot's own copy of the script, so the invoking branch, HEAD and uncommitted files never ship. `scripts/deploy-ccflare.sh --check` prints the target and live SHAs and whether a deploy would be backend-only or a full restart (naming the first field that forces one), without a build, sudo or systemd. The binary embeds its git SHA at build time, verifiable at runtime via the health endpoint's `git_sha` field (no need to trust the binary filename). The systemd pin lives at `/etc/systemd/system/ccflare-stack.service.d/50-pinned-build.conf`. Never let a long-lived feature branch become the de-facto trunk again — merge to `main` and deploy from there. Merging never deploys; the script is the only deploy path.

**Who may deploy.** The operator's standing decision (2026-10-15) lets a session deploy merged `main` through the script without a fresh ask when the deploy is a backend-only handoff: the running guard and runner stay up and in-flight streams finish within the guard's shutdown grace. A full restart restarts the whole unit and interrupts clients, so it needs the operator's go for that deploy; when unsure which one a deploy is, ask. Run `--check` first. Its verdict compares only the schema digest, the five ingress scripts (runner, guard, guard policy, timing, transaction) and the systemd pin, never other drop-ins or environment files, so a deploy that goes with a changed drop-in or environment file needs a full restart even when `--check` says backend-only ([why](docs/solutions/workflow-issues/backend-only-deploy-keeps-the-runners-environment.md)).

## Releases and versions

**NEVER bump the version by hand, and never publish to npm.** Router releases are GitHub releases drafted by release-please (`.github/workflows/router-release.yml`, `scripts/router-release.ts`), and the automation never publishes one. The operator's standing decision (2026-11-10) is to publish each verified draft as it is cut, after the pre-publish checks in [docs/hov-router-releases.md](docs/hov-router-releases.md#publishing-a-verified-draft). Upstream's npm, multi-architecture and signing publishers (`release.yml`, `release-dispatch.yml`, `signpath-*.yml`, `.signpath/`) and the npm publish hooks were deleted on 2026-11-03 and must not come back; `scripts/__tests__/router-release-workflow.test.ts` fails if a publisher workflow reappears. No container image is published; Docker builds from source ([docs/docker.md](docs/docker.md)). Full policy: [docs/hov-router-releases.md](docs/hov-router-releases.md).

Commit prefixes drive the version and changelog (`release-please-config.json`, plus the alias map in `scripts/router-release.ts`):
- `feat:` → minor, under Features (`feature:`/`add:`/`new:` are accepted aliases)
- `fix:` → patch, under Bug Fixes (`bug:`/`resolve:` aliases)
- `security:` → Security; `refactor:` → Improvements (`improve:`/`enhance:`/`update:` aliases); `perf:` → Performance Improvements
- `docs:`, `chore:`, `test:`, `style:` alone produce no release
- `!` or `BREAKING CHANGE` → major

A squash commit is the PR title plus the description, and release-please silently drops any part it cannot parse. The required `prepare` check fails such a PR; the fix is in [docs/hov-router-releases.md](docs/hov-router-releases.md#squash-commits-release-please-can-parse).

`CLAUDE_CLI_VERSION` in `packages/core/src/version.ts` tracks the Claude Code CLI version used in user-agent headers. It is not the product version.

## PR Review Against Current Main (MANDATORY)

Before reviewing or merging a PR you did not write, and after resolving conflicts while bringing `main` into your own PR, find the merge base and identify what main has added since the PR branched. The required checks run on the PR's head, which can be behind `main`: since 2026-11-19 ([#909](https://github.com/StartupBros-com/hov-router/pull/909)) `main` does not require an up-to-date branch, and both checks run again on `main` after the merge. Neither run shows whether a conflict resolution undid something `main` changed. A clean update keeps both sides' changes, so your own PR needs this only after a conflicted one:

```bash
git fetch origin pull/<PR_NUMBER>/head:<branch-name>
git fetch origin refs/heads/main
MERGE_BASE=$(git merge-base <branch-name> origin/main)
git log $MERGE_BASE..origin/main --oneline          # commits on main the PR doesn't have
git diff $MERGE_BASE..origin/main --name-only        # files main changed since PR branched
```

Cross-check the PR's changed files against main's post-branch files. If they overlap, inspect those specific hunks to confirm the PR doesn't regress recent fixes. A PR based on an old main can silently overwrite hotfixes, security patches, or behaviour changes that landed after it branched.

## Merging PRs from External Contributors
When merging a PR from an external contributor (someone other than the repository owner), **create a merge commit** (a no-fast-forward merge) instead of squashing or rebasing, so the contributor's commits and authorship stay in history. `main` accepts changes only through a pull request, so merge it on GitHub, giving the merge commit the PR's conventional title as its subject:

```bash
gh pr merge <PR_NUMBER> --merge --subject "<type>(<scope>): <PR title> (#<PR_NUMBER>)"
```

Without `--subject`, GitHub's merge commit subject is `Merge pull request #N from user/branch`. Tooling that scans merge commits for contributor credit must handle both shapes.

Then, in PRs of your own (each squash-merged as usual):
1. Fix any still-unresolved review findings, with their own prefix.
2. Thank the contributor for their specific contribution in [docs/acknowledgements.md](docs/acknowledgements.md), titled `chore: acknowledge <name> for PR #<N>` (excluded from release notes).

The owner's own PRs merge normally (squash).

## Upstream syncs

This is a product fork with intentional hard divergence, not a mirror. Take upstream fixes by cherry-pick only: wholesale release merges ended on 2026-11-03. Port a fix only after the four checks in [UPSTREAM.md](UPSTREAM.md), protecting the fork contracts listed there, and never port anything to the upstream surfaces it lists as removed. Never merge or cherry-pick upstream on ahead/behind counts alone. Upstream-only issue reports belong at tombii/better-ccflare.

## Issue Management
- Close an issue when its fix is live and its acceptance is met: the fix's merge commit is an ancestor of production's `git_sha` (`/health`), or, for a change that never deploys (docs, CI, release tooling), it is on `main`, and every acceptance item is delivered. Say what you checked in the closing comment.
- An issue whose acceptance names a live observation stays open until that observation is seen.
- Use `Refs #N`, not closing keywords, in commits and PR bodies: merging never deploys here, so `Closes` would close the issue before the fix is live (with the hov-stack harness, pass `wt-new.sh --refs-only`).
- An issue reported by someone outside the project waits for that reporter to confirm.
- This repository is public. In new issues, PRs, commit messages and docs, name an account without its owner suffix (`max-primary`, not `max-primary-<owner>`), and write `00000000-0000-4000-8000-000000000001` where an account ID is needed. Leave older text that already names one as it is.

## Issue Staleness Check (MANDATORY before implementing)
Before implementing any GitHub issue, always run:
```bash
git log origin/main --since='<issue-open-date>' --oneline --no-merges -- <relevant-paths>
gh pr list --search "#<N>" --state all
```
Decide from the result whether the issue still applies, and state that conclusion with its evidence before proceeding. If it no longer applies, say so on the issue instead of implementing it. Rate limiting, health, and proxy code change frequently. Especially check: has the reported symptom been fixed? Does the proposal conflict with new architecture?

## Database
- Default: `~/.config/better-ccflare/better-ccflare.db`
- Custom: Set `BETTER_CCFLARE_DB_PATH=/path/to/dev.db` in env or .env
- Query: `sqlite3 -readonly ~/.config/better-ccflare/better-ccflare.db "SELECT name, provider, custom_endpoint FROM accounts;"`
- **The CLI opens `BETTER_CCFLARE_DB_PATH`, else the default path.** On a host where production runs as the same user, the default is the production database, and these commands change it with no prompt: `--remove` deletes the account, `--reset-stats` zeroes every account's request and session counters, and `--clear-history` deletes requests, payloads and routing attempts older than the configured retention, plus orphaned payloads. Point `BETTER_CCFLARE_DB_PATH` at a scratch copy before trying them.

## Database migrations

SQLite is the only backend. When adding a column or table in `packages/database/src/migrations.ts`:
1. Add it to `ensureSchema()` (CREATE TABLE for new installs).
2. Add it to `runMigrations()` (ALTER TABLE for existing DBs).
3. Put any backfill/data migration in `runMigrations()` as well.

## Test-Driven Development
When creating new functionality: write tests first, then implement, then run tests. This ensures the implementation matches the specs/request before and after coding.

## After Code Changes
Always run: `bun run lint && bun run typecheck && bun run format`

**`typecheck` does not cover test files.** The root `tsconfig.json` excludes
`**/__tests__` and `**/*.test.ts`, so stale call sites in tests compile green and fail
only when that suite actually runs. After changing a shared repository/facade signature,
grep its call sites yourself (`grep -a`, not plain `grep` — see the doc) and run the
affected suites. Details:
[docs/solutions/workflow-issues/typecheck-does-not-cover-test-call-sites.md](docs/solutions/workflow-issues/typecheck-does-not-cover-test-call-sites.md)

Run affected suites one file at a time (`bun test <file>`). A full `bun test` batch shows cross-file mock-isolation failures that do not occur in isolation.

`docs/solutions/` is the searchable store for documented bugs, practices, and workflow patterns, organized by category and YAML frontmatter (`module`, `tags`, `problem_type`); `CONCEPTS.md` defines shared domain vocabulary. Both are relevant when implementing or debugging in documented areas.

## Commands

### Server
- First run: `bun install --frozen-lockfile && bun run build` (builds dashboard/CLI)
- Start: `bun start` (port 8080) or `bun start --serve --port 8081` (testing)
- Startup: Takes ~15 seconds, wait before testing with curl
- Production: guard on `:8788` forwards to the binary on `:8789`. Test local changes on port 8081.

### Account Management
- Add: `bun run cli --add-account <name> --mode <mode> --priority <number>`
- Accepted modes: `ACCOUNT_MODES` in `apps/cli/src/main.ts` is authoritative, and `--help` prints the same list. Read it rather than trusting a list in docs. `vertex-ai`, `openrouter`, `ollama-cloud` and `qwen` accounts are not in it; add those from the dashboard, or through the HTTP API (`POST /api/accounts/<type>`; for `qwen`, the device flow at `POST /api/oauth/qwen/init`).
- List: `bun run cli --list`
- Remove: `bun run cli --remove <name>` (deletes at once; see [Database](#database))
- Reauth: `bun run cli --reauthenticate <name>` (preserves metadata, auto-notifies servers)
- Priority: `bun run cli --set-priority <name> <priority>` (lower = higher priority, 0 = first)
- Provider behavior: OAuth (5hr windows, session-based), API keys (pay-as-you-go, no sessions)

### Maintenance
- `bun run cli --reset-stats|--clear-history|--stats|--analyze` (`--reset-stats` and `--clear-history` write with no prompt; see [Database](#database))

### API Endpoints
- `POST /api/accounts/:id/reload|pause|resume`

### Testing OpenRouter
Use a **currently free** model, and look one up rather than trusting a slug written
here — OpenRouter rotates which models carry the `:free` tier, so any pinned slug
rots. (`z-ai/glm-4.5-air:free` was named here until 2026-08-16, when it started
returning HTTP 404 `This model is unavailable for free. The paid version is
available now`. A pinned paid slug silently spends real money instead.)

Pick one:
```bash
curl -s https://openrouter.ai/api/v1/models | \
  python3 -c "import json,sys; print('\n'.join(m['id'] for m in json.load(sys.stdin)['data'] if m['id'].endswith(':free')))"
```

Then send it, force-routing to the openrouter account so the request cannot land
on an Anthropic-backed one (see the Anthropic-accounts rule at the top of this file):
```bash
curl -X POST http://localhost:8081/v1/messages \
  -H "Content-Type: application/json" -H "Authorization: Bearer test" \
  -H "x-better-ccflare-account-id: $(sqlite3 ~/.config/better-ccflare/better-ccflare.db "SELECT id FROM accounts WHERE provider='openrouter' LIMIT 1;")" \
  -d '{"model":"<free-slug>","messages":[{"role":"user","content":"test"}],"max_tokens":10}'
```

Add `"stream":true` to exercise the SSE translation path; a healthy stream ends
with a `message_stop` event.

## Qwen Provider
- When working on the Qwen provider or streaming transform, **always mirror the qwen-code implementation**: compare against `QwenLM/qwen-code`, either a local checkout or the upstream source at a named commit or tag. In the final response, state the checkout path or source URL and the commit or tag compared; if the comparison was not performed, explicitly say so and explain why.
- Qwen/DashScope sends incremental tool call argument chunks (not cumulative like standard OpenAI). The streaming transform buffers all chunks and emits complete JSON at stream end, matching `StreamingToolCallParser` in qwen-code.

## Honest Work and Anti-Ceremony (binding for agents and humans alike)

The purpose of agent work here is working, deployable capability. Process
serves that outcome and never becomes the product.

- A process artifact (certificate, ledger, dashboard, matrix, meta-report,
  speculative check) may be created only if it names a concrete consumer,
  the named feature it gates, the observed defect class justifying it, and
  its deletion condition. Otherwise it does not get created. Boundary test:
  if running code branches on it, it is product; if only humans and status
  reports read it, it is process and the creation-gate rule above applies;
  code written just to flip this answer counts as the pathology, not as a
  consumer. Sole exception: a minimal
  integrity/recovery control (crash-recovery state, provenance snapshot) is
  legitimate when it prevents a named evidence-loss or corruption mode and
  is necessary and minimal.
- Real code + real tests in the same unit of work. Forbidden: faked tests,
  fixtures/mocks presented as live proof, weakened assertions, golden
  regeneration to force green, hard-coded success paths, placeholder macros
  in commits, editing the spec instead of implementing it, narrowing scope
  while claiming full success.
- No self-certification: work is closed by an independent verifier citing
  evidence at an exact revision. Solo sessions re-verify by re-execution and
  state what was not independently verified.
- A typed refusal beats a fabricated result and is less valuable than the
  real capability; refusal-only work stays open and says so.
- Truthful null results ("checked X, found no material increment") are
  successful outcomes. Unsupported claims are worse than silence.
- Metrics predeclare denominator and countermetric; agreement between
  agents may raise confidence but is never independent evidence; never
  silence stderr in evidence-bearing commands.
- Name these pathologies when they occur (gate self-weakening, proof-class
  inflation, golden regeneration, tolerance widening, suppression-pragma
  laundering, refusal farming, follow-up laundering); the names are the
  deterrent. The full catalog with countermeasures lives in the
  just-say-no-to-process-porn-and-ceremony skill; ask the operator for it
  if you cannot resolve that reference.
