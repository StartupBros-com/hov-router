# HoV Router release automation (draft-only)

For the current published release, 6.2.2 (Linux x86_64), follow the technical
reference's [consumer installation and verification instructions](reference.md#install-the-linux-x86_64-release).

This is the operator guide for HoV Router release automation at
`StartupBros-com/hov-router`, repository ID `1278801682` (see
[the repository move](hov-router-migration.md#repository-move)).
The repository moved from the `StartupBros` personal account to the
`StartupBros-com` organization on 2026-11-20
([#911](https://github.com/StartupBros-com/hov-router/issues/911)); the transfer
kept the repository ID. The automation accepts `StartupBros/hov-router` or
`StartupBros-com/hov-router`, each only with that repository ID and with an owner
that matches its name, and derives the current name from validated metadata. The
pre-rename name `StartupBros/wstack-router` is refused. The artifact workflow runs
from the release tag's own copy of the workflow, and every tag before `v6.2.0` was
cut before the two-owner guards landed, so a rerun of an older tag's artifact
workflow skips every job. Historical release evidence below intentionally keeps
the repository and signer identity each release was signed with.
The automation stages a verified **draft** GitHub release. It never publishes a
release, publishes npm packages or images, announces, installs, restarts services,
or deploys. The operator publishes each verified draft as it is cut, after the
[pre-publish checks](#publishing-a-verified-draft), and publishing posts a
[tool-drops announcement](#publishing-announces-the-release); the consumer
instructions above do not use the draft-only automation helpers.

## Optional consumer provenance verification

The technical reference's [binary install](reference.md#install-the-linux-x86_64-release)
checks the download against a SHA-256 pinned in that reference. If you also want
signed evidence of its origin, run the following block **after the checksum check
and before running the binary**. It verifies the binary already downloaded; no
manifest or additional release asset is needed.

Requires `curl`, a current [GitHub CLI](https://cli.github.com/) supporting every
flag below, and network access: the block downloads the signed attestation bundle
from this repository, and GitHub CLI fetches Sigstore's trust root. It needs no
GitHub login (checked with GitHub CLI 2.103.3 signed out). If a tool, flag,
download, or verification step fails, stop and resolve it; do not treat an
incomplete provenance check as successful.

For each release this guide verifies, the bundle exactly as GitHub issued it is
committed in [`docs/provenance/`](provenance/). The block downloads that bundle,
checks it against the SHA-256 pinned here, then verifies the binary against it under
the repository and certificate the release was signed with. Release 6.2.1 is the
first built and signed as `StartupBros-com/hov-router`. Releases signed before the
repository moved on 2026-11-20 keep their attestations under the former owner, and
GitHub's lookup by this repository no longer finds them
([#911](https://github.com/StartupBros-com/hov-router/issues/911)), so their committed
bundles are how they still verify. The blocks for 6.2.1 and later use their bundles
the same way, so they keep working if the repository's name changes again. You need not trust where the
bundle came from: the pinned
checksum and GitHub CLI's signature check decide. GitHub CLI compares the repository
and workflow names with the ones recorded in the signing certificate when the release
was signed, and the pinned checksums tie each block to that one build. Committed
bundles are never deleted or rewritten, so each block's download address keeps working.

<!-- router-release-provenance -->
```bash
(
  set -eu
  binary="$HOME/.local/lib/hov-router/6.2.2/hov-router"
  source_sha=baaa81a4656851f51ed30eaa92433f27c47d459a
  digest=955696abccd1d4b7fe02e298687fc136655797d94aeec856dc785990fc78a4ac
  bundle_sha=d60ef772511873dcb626d856b2921f1447dff9c99b9ad63200e19363dd346f9e
  printf '%s  %s\n' "$digest" "$binary" | sha256sum --check --strict -
  bundle_dir=$(mktemp -d "${TMPDIR:-/tmp}/router-provenance.XXXXXX")
  bundle="$bundle_dir/v6.2.2.jsonl"
  curl -q --fail --location --proto '=https' --proto-redir '=https' \
    --output "$bundle" https://raw.githubusercontent.com/StartupBros-com/hov-router/refs/heads/main/docs/provenance/v6.2.2.jsonl
  printf '%s  %s\n' "$bundle_sha" "$bundle" | sha256sum --check --strict -
  gh attestation verify "$binary" \
    --repo StartupBros-com/hov-router \
    --source-digest "$source_sha" \
    --source-ref refs/tags/v6.2.2 \
    --cert-identity https://github.com/StartupBros-com/hov-router/.github/workflows/router-release-artifacts.yml@refs/tags/v6.2.2 \
    --signer-digest "$source_sha" \
    --deny-self-hosted-runners \
    --bundle "$bundle"
)
```
<!-- /router-release-provenance -->

This independently checks GitHub's signed build provenance against the expected
repository, source commit, tag, workflow identity, signer commit, and hosted-runner
policy. Those expectations are pinned here, not read from a downloaded manifest.
Neither a checksum nor provenance proves the program is free of bugs or malicious
behavior. After verification succeeds, return to the technical reference's separate run step.
This procedure does not execute the binary or change its installed aliases. The
temporary directory holding the bundle is left for inspection.

The release also publishes `SHA256SUMS` and an attested `release-manifest.json` for
release auditing; neither is required by the consumer install above. The operator
pipeline below still verifies the complete inventory and both attestations before
executing release smoke checks. Its strict verification policy is unchanged.

Release ID **453517976** and tag `refs/tags/v6.2.2` identify source commit
`baaa81a4656851f51ed30eaa92433f27c47d459a`. The exact certificate is
`https://github.com/StartupBros-com/hov-router/.github/workflows/router-release-artifacts.yml@refs/tags/v6.2.2`.

| 6.2.2 asset | Asset ID | Size (bytes) | SHA-256 |
| --- | --- | --- | --- |
| `better-ccflare-linux-amd64` | 774797487 | 96044512 | `955696abccd1d4b7fe02e298687fc136655797d94aeec856dc785990fc78a4ac` |
| `release-manifest.json` | 774798053 | 809 | `2d22b979009104db021996ddfe95c9028f3d5160004995efb37a87682b67fdaa` |
| `SHA256SUMS` | 774797148 | 93 | `b5f701ad3f315321c724bad612b63733e63c34894f9e7ed0aea550c3e5de90b0` |

For a manifest audit, download `release-manifest.json` from the v6.2.2 release,
check its digest above, then run the same block with `binary` set to that local
manifest and `digest` set to its SHA-256. The bundle stays the same: one signed
statement names both the binary and the manifest. The signed manifest names repository
`StartupBros-com/hov-router`. Its distribution token is
`v1:startupbros-hov-router-binary`, with `actionable: false` and
`updateChannel: null`. Releases 3.6.2 through 3.7.1 carry
`v1:startupbros-wstack-router-binary` instead, an operational name that predates
HoV Router, with the same fields. Rebuilding one of those releases reproduces its
original token.

### Verify release 6.2.1

Release 6.2.1 is the first release built and signed as `StartupBros-com/hov-router`,
and its own committed bundle verifies it. Release ID **453439321** and tag
`refs/tags/v6.2.1` identify source commit `786722ba026b7095e31aef91ca62f34bda79d490`. The exact
certificate is
`https://github.com/StartupBros-com/hov-router/.github/workflows/router-release-artifacts.yml@refs/tags/v6.2.1`.

| 6.2.1 asset | Asset ID | Size (bytes) | SHA-256 |
| --- | --- | --- | --- |
| `better-ccflare-linux-amd64` | 774423044 | 96044512 | `d6af6b2fa24873b6876ffd86bd41513f97536160bf7cd75670f1393e8edc2011` |
| `release-manifest.json` | 774423382 | 809 | `7f568e6a94d8b6e584a65a1417050d88767c3c1d1d5012a820bd5da749d8ae07` |
| `SHA256SUMS` | 774422735 | 93 | `8b79b1669b6ba39c87467d41098da165cb0386fe6bc09ebe9ac5ae890db2e34e` |

To install it, use the reference's install block the same way: `6.2.1` in place of
`6.2.2` in the version directory and download URL, and the binary's digest above.
Then verify it, before running it, with this block. It expects that install path,
the one this guide used while 6.2.1 was the current release. For a manifest audit, set `binary`
and `digest` as described for the current release; the bundle stays the same.

<!-- router-release-provenance-v6.2.1 -->
```bash
(
  set -eu
  binary="$HOME/.local/lib/hov-router/6.2.1/hov-router"
  source_sha=786722ba026b7095e31aef91ca62f34bda79d490
  digest=d6af6b2fa24873b6876ffd86bd41513f97536160bf7cd75670f1393e8edc2011
  bundle_sha=066a87ca559a3476a5c47317b9bb997073890dfb54bfc6e5c34d70cbf7aeff61
  printf '%s  %s\n' "$digest" "$binary" | sha256sum --check --strict -
  bundle_dir=$(mktemp -d "${TMPDIR:-/tmp}/router-provenance.XXXXXX")
  bundle="$bundle_dir/v6.2.1.jsonl"
  curl -q --fail --location --proto '=https' --proto-redir '=https' \
    --output "$bundle" https://raw.githubusercontent.com/StartupBros-com/hov-router/refs/heads/main/docs/provenance/v6.2.1.jsonl
  printf '%s  %s\n' "$bundle_sha" "$bundle" | sha256sum --check --strict -
  gh attestation verify "$binary" \
    --repo StartupBros-com/hov-router \
    --source-digest "$source_sha" \
    --source-ref refs/tags/v6.2.1 \
    --cert-identity https://github.com/StartupBros-com/hov-router/.github/workflows/router-release-artifacts.yml@refs/tags/v6.2.1 \
    --signer-digest "$source_sha" \
    --deny-self-hosted-runners \
    --bundle "$bundle"
)
```
<!-- /router-release-provenance-v6.2.1 -->

### Verify release 3.7.1

Release 3.7.1 is the last release that supports PostgreSQL (see
[PostgreSQL support removed](hov-router-migration.md#postgresql-support-removed)).
Like every release from 3.7.0 through 6.2.0, it was signed as
`StartupBros/hov-router`, and its own committed bundle
verifies it. Release ID **423574844** and tag `refs/tags/v3.7.1` identify source
commit `6b88f789e30c3a86ee918d35a6673e7be12f9243`. The exact certificate is
`https://github.com/StartupBros/hov-router/.github/workflows/router-release-artifacts.yml@refs/tags/v3.7.1`.

| 3.7.1 asset | Asset ID | Size (bytes) | SHA-256 |
| --- | --- | --- | --- |
| `better-ccflare-linux-amd64` | 675765162 | 97969632 | `f6e6ee137d0766eb6df9d6c76d264603e9696c12797e1570b8ad6b9648d0b12c` |
| `release-manifest.json` | 675765600 | 811 | `5e88ab1d8376fe783da736003c40f34a0207db4c71be5f6a5c328d1c30881d0c` |
| `SHA256SUMS` | 675764852 | 93 | `923d6041201ba6ade61ff3dcd2ec200970475076ae7b9af261058211394545e5` |

To install it, use the reference's install block the same way: `3.7.1` in place of
`6.2.2` in the version directory and download URL, and the binary's digest above.
Then verify it, before running it, with this block. It expects that install path,
the one this guide used while 3.7.1 was the current release. For a manifest audit, set `binary`
and `digest` as described for the current release; the bundle stays the same.

<!-- router-release-provenance-v3.7.1 -->
```bash
(
  set -eu
  binary="$HOME/.local/lib/hov-router/3.7.1/hov-router"
  source_sha=6b88f789e30c3a86ee918d35a6673e7be12f9243
  digest=f6e6ee137d0766eb6df9d6c76d264603e9696c12797e1570b8ad6b9648d0b12c
  bundle_sha=c8476e8ef8dcf4a4b4d8e6ea005daf56598ede319950c6e5c611431b56e4ed9a
  printf '%s  %s\n' "$digest" "$binary" | sha256sum --check --strict -
  bundle_dir=$(mktemp -d "${TMPDIR:-/tmp}/router-provenance.XXXXXX")
  bundle="$bundle_dir/v3.7.1.jsonl"
  curl -q --fail --location --proto '=https' --proto-redir '=https' \
    --output "$bundle" https://raw.githubusercontent.com/StartupBros-com/hov-router/refs/heads/main/docs/provenance/v3.7.1.jsonl
  printf '%s  %s\n' "$bundle_sha" "$bundle" | sha256sum --check --strict -
  gh attestation verify "$binary" \
    --repo StartupBros/hov-router \
    --source-digest "$source_sha" \
    --source-ref refs/tags/v3.7.1 \
    --cert-identity https://github.com/StartupBros/hov-router/.github/workflows/router-release-artifacts.yml@refs/tags/v3.7.1 \
    --signer-digest "$source_sha" \
    --deny-self-hosted-runners \
    --bundle "$bundle"
)
```
<!-- /router-release-provenance-v3.7.1 -->

### Verify the historical 3.6.2 release

The published v3.6.2 evidence remains historical. It was signed as
`StartupBros/wstack-router`, the repository's name before the 2026-10-21 rename, and
this block keeps every historical verification expectation. GitHub CLI 2.97 binds
`--repo` during verification to `SourceRepositoryURI`, so replacing it with the
current repository or an owner-only policy would change the historical trust policy.
Like every block in this guide, it verifies its committed bundle. This block expects the 3.6.2 install
path that earlier versions of this guide used.

<!-- router-release-provenance-v3.6.2 -->
```bash
(
  set -eu
  binary="$HOME/.local/lib/wstack-router/3.6.2/wstack-router"
  source_sha=5d7b2a888a9b61d87916332b414e46606498d896
  digest=b01a4989323ecf4e2d0a68394b45828741430d89eb35288f7318a28c45b4c9d7
  bundle_sha=360daf3dd228a69dcb1444de7ca367b44d392abab54b144392a1a7c270e67b60
  printf '%s  %s\n' "$digest" "$binary" | sha256sum --check --strict -
  bundle_dir=$(mktemp -d "${TMPDIR:-/tmp}/router-provenance.XXXXXX")
  bundle="$bundle_dir/v3.6.2.jsonl"
  curl -q --fail --location --proto '=https' --proto-redir '=https' \
    --output "$bundle" https://raw.githubusercontent.com/StartupBros-com/hov-router/refs/heads/main/docs/provenance/v3.6.2.jsonl
  printf '%s  %s\n' "$bundle_sha" "$bundle" | sha256sum --check --strict -
  gh attestation verify "$binary" \
    --repo StartupBros/wstack-router \
    --source-digest "$source_sha" \
    --source-ref refs/tags/v3.6.2 \
    --cert-identity https://github.com/StartupBros/wstack-router/.github/workflows/router-release-artifacts.yml@refs/tags/v3.6.2 \
    --signer-digest "$source_sha" \
    --deny-self-hosted-runners \
    --bundle "$bundle"
)
```
<!-- /router-release-provenance-v3.6.2 -->

Release ID **418096444** and tag `refs/tags/v3.6.2` identify source
commit `5d7b2a888a9b61d87916332b414e46606498d896`. The exact certificate remains
`https://github.com/StartupBros/wstack-router/.github/workflows/router-release-artifacts.yml@refs/tags/v3.6.2`.

| Historical asset | Asset ID | Size (bytes) | SHA-256 |
| --- | --- | --- | --- |
| `better-ccflare-linux-amd64` | 658578101 | 97965536 | `b01a4989323ecf4e2d0a68394b45828741430d89eb35288f7318a28c45b4c9d7` |
| `release-manifest.json` | 658578455 | — | `a90aa5f71ba5ae9f4b255e487c2afc80f39d44bc70a6193da43d83f4b05dc60b` |
| `SHA256SUMS` | 658577847 | — | `dee851d757ec92a28946c838a11919d34bf2fc4755613e67b34bd1e3cdf70b29` |

For a 3.6.2 manifest audit, download `release-manifest.json` from the current repository's
v3.6.2 release, check the independent digest above, then run the same block with
`binary` set to that local manifest and `digest` set to its pinned SHA-256; the
bundle stays the same. Keep the full old source SHA, tag ref, certificate, signer SHA,
`--repo StartupBros/wstack-router`, `--deny-self-hosted-runners`, and the pinned
bundle; authenticate both assets before any release smoke execution.
The signed manifest's repository remains `StartupBros/wstack-router` and its
distribution token remains `v1:startupbros-wstack-router-binary`, with
`actionable: false` and `updateChannel: null`. Do not rewrite the public bytes,
manifest, tag, or certificate for the new display name. The historical binary
still reports `wstack Router v3.6.2` through `hov-router`; newly built artifacts
report `HoV Router`. Only Linux x86_64 was publicly released for v3.6.2.

### Verify another release from before the move

The bundles of the other releases published before the move are committed in
[`docs/provenance/`](provenance/) as well, so each of them still verifies as
`StartupBros/hov-router`. To check one, run the [3.7.1 block](#verify-release-371),
which verifies under that name, with `binary` set to that release's binary and
`source_sha`, `digest` and `bundle_sha` taken from its row below. Then change every
`v3.7.1` in the block to that release's tag: the bundle's file name and download
address, `--source-ref` and `--cert-identity`. Each release has one bundle, whose
signed statement names both its binary and its `release-manifest.json`.

| Release | Source commit | Binary SHA-256 | Bundle SHA-256 |
| --- | --- | --- | --- |
| [3.7.0](https://github.com/StartupBros-com/hov-router/releases/tag/v3.7.0) | `79a957526bd1994cb3c52b6a110de3c70c1e5c6f` | `49e3ddbc9fc683ffc68dbbacbf4350db582e4cdac417df32a8e6244c90bf2afe` | `4bd800969a4f1fba6147edaae4ba79b798a03471a6b77f2ee49b8b1f1b1c2152` |
| [4.0.0](https://github.com/StartupBros-com/hov-router/releases/tag/v4.0.0) | `8009109dad34843e8b456bfc15dac80aee2ba47c` | `bf9d57f4a2ddd0e8f9b4cf98926f073986a70ed2185f6194315c0ef6c2d1e2ed` | `35280aed2e627c67508f7e26c5f34305335d18af0e8bdcc43ad10a2ed2dd8151` |
| [5.0.0](https://github.com/StartupBros-com/hov-router/releases/tag/v5.0.0) | `3b43b5ba0535c6c6dd5bd245789c5846578dbf46` | `75a0fb0ce5e24547b3abd2275da3baaa1da561815ac5876deca437401a668e23` | `eed4aa7d9e7816c3d73681471e4c1eae61abe39304d5dbad06428f0460085554` |
| [5.0.1](https://github.com/StartupBros-com/hov-router/releases/tag/v5.0.1) | `83886c7b41c38e03de6d876e042819c20d530f53` | `1ac3321405e3afa9332080a31d9c022f880d3bb9bbbe0a4f1ea787f3eb4b2eb5` | `f9ccc13696ccabdfa210311a129fe08aa42e18076dc0714a0c426bf000da64dc` |
| [5.1.0](https://github.com/StartupBros-com/hov-router/releases/tag/v5.1.0) | `218473fd2c122b61d9df9a62823a754c23973124` | `036b0b7b2d867c719a5f2fc4f7d1c1c9e7bc02c641d86397d6dedbfafe445ce8` | `0676f3f905398fa02fcf632ee94f8c8a227bcaeb09e99ff8dc98724d19041bca` |
| [6.0.0](https://github.com/StartupBros-com/hov-router/releases/tag/v6.0.0) | `0db6b0de4e3e1d19719780714f4a67a7f7a3b60e` | `cc9338d70d37430c3b566f7796a84bb04cbf423a14ee133a4c78382d733b239f` | `be74b5bbd703c14c84e12c5fa1998ec31d743058beb674d9dfba6c323f78f2d6` |
| [6.1.0](https://github.com/StartupBros-com/hov-router/releases/tag/v6.1.0) | `157f4bc0e7c3b29dffae48ab777ad05225848069` | `b3109dc051fbd0ba0b0269776ea841c55586289f5047748a6236d450363627e1` | `c8718b828620d1e32e1544707273e909d461138e28d15f7fffd1027fdeb205df` |
| [6.2.0](https://github.com/StartupBros-com/hov-router/releases/tag/v6.2.0) | `f21d5c9ac5ee8a0f9e3fd9a1cdb6346b8c6d4dd8` | `08115d81588c7ae79fd89188396fb091cce36c0c468a3945ce21971658762a55` | `2a3a24c00e1a094e162bc897896ce56d3a03aea381f313a6218fb034ef9fcca4` |

## App authentication and verification boundaries

Release PR reconciliation uses a dedicated GitHub App installation token, not the
built-in Actions token. Keep `default_workflow_permissions: read` and the combined
“Allow GitHub Actions to create and approve pull requests” setting
(`can_approve_pull_request_reviews`) **off**. Neither policy needs relaxing.
The `pull-requests` job's built-in token has only `contents: read`; top-level workflow
permissions remain empty. This change does not grant the App a ruleset bypass or
authorize unattended release-PR merges, and it uses no personal access token.

PR #556 activated the scoped App/token wiring with the required checks preserved.
Its coordinator passed App token minting, release-PR reconciliation and post-job
token revocation. That no-op reconciliation did not create a release PR and is not
proof of the release PR, its checks, or the draft/artifact path. Verify those steps
for each actual release; the release's Actions runs are the evidence, not this
setup guide. Missing configuration fails the mint step; it never silently skips
reconciliation or falls back to the built-in token, even on a chore-only run that
would otherwise need no release PR.

The `drafts` job still runs when `pull-requests` fails, so an already merged release
is not hidden by an App failure. The overall workflow run stays red. Manual draft
retries skip the entire PR job and never mint an App token.

## Dedicated Router App configuration

1. Use a dedicated App installed on the account that owns the repository,
   `StartupBros-com` since the 2026-11-20 move
   ([#911](https://github.com/StartupBros-com/hov-router/issues/911)).
   Retain the existing scoped installation and verify its access.
   An App installation does not move with a repository transfer: the move
   transferred the App itself to the organization, keeping its Client ID and key,
   and installed it there. Any later move needs the same, with the variable and
   secret below pointing at that App, before the next release run.
   A private App can be installed only on the account that owns it; do not
   broaden an App's visibility to reuse it.
   Grant repository permissions **Contents: read/write**, **Pull requests: read/write**,
   **Issues: read/write** (release labels), and **Actions: read-only** (source CI).
   GitHub's implicit **Metadata: read-only** permission remains. No administration,
   workflow-write, organization permissions, or ruleset bypass is needed.
2. Scope the installation to **only this Router repository**, `hov-router`.
   Preserve all other repository protection and
   Actions policies. The token request restricts `owner` and `repositories` to the
   current owner and name from validated repository metadata, with the
   four explicit permissions above; neither installation nor request should include
   other repos.
3. Set repository Actions variable `ROUTER_RELEASE_APP_CLIENT_ID` to the App's
   **Client ID**, not its numeric App ID. Generate its private key and set repository
   Actions secret `ROUTER_RELEASE_APP_PRIVATE_KEY` through the approved secure
   provisioning path. Never paste the PEM into chat, command arguments, source, or
   logs; never echo it or invent another credential store. App registration,
   installation and key handling require the operator's provisioning decision.
4. Verify the real coordinator can mint the token, create or update a genuinely
   needed release PR, and trigger its required checks. Do not fake a version bump
   to exercise this. Local tests cannot verify installation access or live CI events.

The pinned `actions/create-github-app-token` v3.3.0 action
(`64ab729a6294000f5aa4a4bc0b73d1f32bc45510`, Node 24) mints after dependency installation,
only immediately before reconciliation. Only that step receives the output through
the existing `GITHUB_TOKEN` interface. Checkout does not persist credentials. The
App token is not passed to dependency installation, build, smoke, draft or artifact
jobs, and the action's default post-job revocation remains enabled. Draft and
artifact jobs retain their separate built-in tokens and existing permissions.

## Version policy

- One product version for the whole repository, calculated by the pinned
  `release-please` 17.11.2 engine. The initial cutoff is bootstrap commit
  `d981843f014e76d8d1743410010d3628bbdc3962`; subsequent releases use the engine's
  matching version tags as their cutoff.
- The lineage continues from 3.5.78 (seeded in `.release-please-manifest.json`);
  no manual version bump is needed or allowed.
- Root `package.json`, `apps/cli/package.json`, the release manifest and the Bun
  `apps/cli` workspace entry in `bun.lock` always advance together.
- Prefixes: `fix`/`bug`/`resolve` produce a patch; `feat`/`feature`/`add`/`new` a minor;
  a breaking change (`!` or `BREAKING CHANGE`) a major. `security`, `improve`,
  `enhance` and `update` keep their existing changelog intent. `docs`, `chore`, `test`
  and `style` alone produce no release pull request.
- Tags are `vX.Y.Z` with no component. The change that merges this automation uses
  `chore` commits and creates no tag or release.

## Squash commits release-please can parse

release-please builds the release PR from the commit messages on `main`. When its
parser rejects part of a commit, it logs that at debug level, leaves that part out and
still finishes green. That is how the #795 fix went missing from release PR #793:
GitHub's 72-column rewrap of the description put a line the parser rejects at the
start of a line.

So the required `prepare` check (`scripts/check-squash-commit-parse.ts`) rebuilds the
squash commit GitHub writes by default (the PR title, ` (#N)`, then the description
rewrapped at 72 columns) and parses it with the pinned release-please parser. On
failure it prints one annotation naming the line and column, followed by the parsed
text with line numbers. It re-runs when the title or description is edited.

To fix a failure, do one of these:

- Reword the line it names.
- Put an override block in the description: a line `BEGIN_COMMIT_OVERRIDE`, the
  commit message you want, and a line `END_COMMIT_OVERRIDE`. release-please then reads
  only that text. A mention of the start marker anywhere in the description, even in a
  sentence, makes release-please read everything after it as the commit message, and
  the check fails that too.
- If it fails on line 1, the title has no conventional prefix: retitle the PR.

Limits:

- It checks GitHub's default squash message. A merge that sets its own message, in
  the merge dialog or with `gh pr merge --subject --body-file` as in the `Release-As`
  procedure below, is not checked; read back the merged commit as that procedure says.
- PRs from other repositories merge with `--no-ff` (see `AGENTS.md`) and are skipped.
- A manual re-run of the workflow replays the title and description the run started
  with. Edit the description to check new text.
- A pass means release-please can read the commit, not that it cuts a release:
  `docs`, `chore`, `test` and `style` alone still produce none.

Remove the step, the script and its test once the pinned release-please parser accepts
`scripts/__tests__/fixtures/squash-parse/pr795-body.txt` (#797).

## Intentional first release or explicit version request

An intentional release request can use the engine's `Release-As` commit-body
trailer without inventing a feature or editing version files. The first release,
3.6.0, was requested this way. Replace `<subject>` with an honest description and
`<version>` with the approved version, and preserve this complete request PR squash
message:

```text
chore: <subject>

Release-As:<version>
```

1. Open a normal request PR and let its required checks pass. Ordinary unmarked
   `docs`, `chore`, `test` and `style` commits remain no-ops; the trailer is a
   deliberate release request, not a new rule that releases every chore.
2. When merging the request PR, put `Release-As:<version>` in a local body file and use
   `gh pr merge <request-pr> --squash --subject "chore: <subject>" --body-file <body-file>`.
   Do not rely on the PR description or GitHub's default squash body to retain it.
   Use the normal checked merge path, never a direct-main push, force push or bypass.
3. Read back the **actual main commit message** using the merged PR's
   `mergeCommit.oid` and `gh api repos/StartupBros-com/hov-router/commits/<sha> --jq .commit.message`.
   Confirm the honest subject, blank line and exact `Release-As:<version>` trailer before
   treating the request as delivered. A local message or PR description is not proof.
4. After that commit's foundation gate passes, observe the coordinator's generated
   release PR. The pinned engine selects `<version>` and synchronizes root/CLI packages,
   release manifest and Bun workspace version without changing dependency resolution.
   The request subject appears in generated PR notes and `CHANGELOG.md`; arbitrary
   body prose is not a supported way to enrich those notes. Leave version-file edits
   to the engine and verify the actual App-authored PR's required checks.
5. Merge that genuine engine release PR only through the normal required-check path.
   The request commit alone cannot authorize a draft. Its release PR's exact merged
   commit needs its own successful foundation gate before the coordinator can create
   the draft/tag and stage verified artifacts. After observing draft creation, richer
   release notes can be supplied through supported release-note editing; do not
   publish the draft as part of this procedure.

This procedure does not enable auto-merge or change the publication boundary.
Local characterization verifies engine behavior, not completion of these live steps.

## What authorizes a draft

Only a merged release PR whose exact merge commit has a successful
`Managed Routing Foundation Gate` push run on `main`. A newer commit on `main` never
vouches for an older release commit: that commit needs its own green run and must be
an ancestor of `main`. Release PR reconciliation requires the source to be the
current `main` head.

## Flow

1. `router-release.yml` (the coordinator) runs after a successful foundation gate
   push on `main`. It validates the exact repository, event, workflow path, branch
   and SHA, reconciles release PRs, then creates or reuses the draft and tag.
2. It explicitly dispatches `router-release-artifacts.yml` **at the tag**
   (`--ref vX.Y.Z`), not at `main`. A checkout alone does not change GitHub's OIDC
   claims; dispatching at the tag makes the attestation certificate carry the
   release commit and tag ref. The workflow file must exist on `main` and in the tag.
3. The tag run requires `github.sha` and `github.ref` to equal the release identity,
   then revalidates eligibility, source CI, merged PR, tag and draft read-only.
   The `validate` job needs `contents: write` because GitHub's
   [release listing](https://docs.github.com/en/rest/releases/releases#list-releases)
   only exposes drafts to callers with push access; validation does not mutate them.
4. A credential-free `build` job runs `apps/cli/prepare-router-release.ts prepare`.
   A separate `attest` job (`id-token: write`, `attestations: write`) attests the
   binary and manifest. A separate `stage` job holds its own write token for uploads.
5. `stage` uploads only missing assets, re-reads the inventory, downloads fresh bytes,
   authenticates attestations and then runs smoke checks. It revalidates release
   eligibility, source CI, merged PR, tag and draft again after those checks, before
   printing the verified draft URL and source identity. This is a final recheck,
   not an atomic guarantee against subsequent GitHub changes.

The coordinator processes every validated pending candidate. Its concurrency group
is separate from the artifact workflow's per-tag groups. All use
`cancel-in-progress: false`: staging for the same tag is serialized, while distinct
release tags do not replace each other's pending runs.

## Publishing a verified draft

The automation stops at a verified draft. The operator publishes each one as it
is cut (a standing decision since 2026-11-10), after these checks:

1. The coordinator run and the tag's artifact run both succeeded.
2. The draft's tag is `vX.Y.Z` at the release PR's merge commit, and the tag ref
   points at that commit.
3. The draft holds exactly the three assets listed under
   [Fixed inventory and provenance](#fixed-inventory-and-provenance), and the
   binary's SHA-256 matches both `SHA256SUMS` and `release-manifest.json`.
4. The body opens with a short summary and a `## Highlights` list (see the next
   section), and tells upgraders what to do about any breaking change.
5. The new release's attestation bundle is on `main` as
   `docs/provenance/vX.Y.Z.jsonl`. The body's verify block (in every release
   since 6.2.0) downloads it from there, so merge it in a pull request of its own
   before publishing, or the published notes point at a missing file. Download
   the draft's three assets with `gh release download vX.Y.Z --repo
   StartupBros-com/hov-router`, then the bundle with `gh attestation download
   better-ccflare-linux-amd64 --repo StartupBros-com/hov-router`, and confirm the
   file holds one bundle. Once it is on `main`, run the body's verify block as
   written in the folder holding the three assets; the block needs no login.
   `binary-install.test.ts` accepts this one undocumented bundle while it is
   newer than the current block's release.

When editing a draft's body through the API, send `tag_name` and
`target_commitish` with the new body: a body-only update resets a draft's tag to
`untagged-…`. After publishing, check that `releases/latest` names the new
release, that the tag ref is unchanged, and that the
[announce run](#publishing-announces-the-release) succeeded. Then repoint the
current-release pins in the [install reference](reference.md#install-the-linux-x86_64-release),
this guide, the migration guide and the README, together with
`apps/cli/__tests__/binary-install.test.ts`, and pin the SHA-256 of the bundle
merged before publishing as `bundle_sha`. The committed bundle lets the consumer
block run with no login, and keeps it working if the repository moves again.

The release that leaves the current block keeps a place in this guide.
Releases signed as `StartupBros/hov-router` went to the
[table of releases from before the move](#verify-another-release-from-before-the-move),
whose rows verify under that name. 6.2.0 was the last of them. 6.2.1 was the first
signed as `StartupBros-com/hov-router`, so it cannot join that table; its block is
kept under [its own heading](#verify-release-621), as the 3.7.1 block is kept.
Later releases signed in the organization get rows, as each leaves the current
block, in a table of their own that points at the 6.2.1 block, the way the
pre-move table points at the 3.7.1 block. 6.2.2 is the first of them, when 6.2.3
replaces it.

Never delete or rewrite a committed bundle: copies of this guide in older checkouts
download them from `main`.

## Publishing announces the release

The automation never announces, but publishing does. Publishing a release posts a
card for it in the House of Vibe #tool-drops Discord channel. Two lanes post it,
and both write the same record, so the card posts once:

- [`tool-drop-announce.yml`](../.github/workflows/tool-drop-announce.yml) runs when
  a release is published or edited, and posts within about a minute. It calls
  hov-stack's reusable announce workflow, pinned to a full commit SHA. A release
  event runs this file from the released tag's tree, so this lane covers only
  releases whose tag already contains it.
- The members site's hourly tool-drops sweep posts the card if the workflow run
  failed or never fired.

This applies from 3.7.1 on; earlier versions are never posted. A card posts only
for a full, non-draft release on a `v<major>.<minor>.<patch>` tag whose commit is
on `main` in this repository, once it is the repository's **Latest** release.
Editing the body of the Latest release re-runs the workflow, which updates the
posted card in place instead of posting a new one.

The card's "What's new" section is the first three bullets under a `## Highlights`
heading in the release body. A body without that heading gets a card with no
"What's new" section. Before publishing, edit the draft so its body has a
`## Highlights` list of short, user-facing changes, as
[3.7.0](https://github.com/StartupBros-com/hov-router/releases/tag/v3.7.0) does. The
card's other text lives in pushbot's product registry, not in this repository.

Keep each of those three bullets to 180 characters, counted with its markdown,
and the three together to 600: a longer bullet is cut off mid-word on the card.
The card also drops backticks, asterisks, underscores, brackets and parentheses,
so a bullet should read correctly without them. `claude-bccf-quality-*` posted
as "claude-bccf-quality-" on the 6.0.0 card until the body was edited.

## Fixed inventory and provenance

The draft holds exactly `better-ccflare-linux-amd64`, `SHA256SUMS` and
`release-manifest.json`. The manifest records repository, version, ref, SHA, Bun pin,
target and binary size/digest, plus the compiled provenance claim. It is a claim,
not its own trust anchor. GitHub build attestation covers the binary and manifest;
attestation bundles are not extra release assets. The consumer blocks above use the
copies committed in `docs/provenance/`, never a release asset.

Verification binds repository, source digest, source ref `refs/tags/vX.Y.Z`, the
signer workflow identity
`.../router-release-artifacts.yml@refs/tags/vX.Y.Z`, the signer commit, and denies
self-hosted runners. The binary is executed only after that passes. The compiled
fixture check covers the full provenance tuple; the shipped binary itself is checked
through `--version` and `--git-sha`.

## Reruns and failures

- Rerun the failed `stage` job: it reuses the same-run build artifact (retained 7 days).
  Existing identical assets are reused; missing assets are uploaded.
- A fresh rebuild that produces different bytes, a differing remote asset, an
  unexpected asset, a moved tag, a published release or mismatched metadata stops with
  the offending identity. Nothing is deleted, clobbered, replaced or published, and
  a human must resolve it.
- A coordinator run that fails with `Stale or non-ancestor source SHA` before any
  write was started by the foundation gate of an earlier commit that finished
  after the release commit reached `main`. It is not a release failure: the
  release commit's own gate run starts the coordinator again. Wait for that run
  (6.2.2 took one).
- A failed draft/coordinator step: run the coordinator by `workflow_dispatch` with
  `source_sha` (the release PR merge commit) and `version`. It re-validates and
  re-dispatches the artifact run; each write is preceded by re-validation.
- The release listing can lag a draft the coordinator has just created. The
  coordinator re-reads it for about a minute before failing with `release missing`;
  any other readback mismatch fails at once ([#784](https://github.com/StartupBros-com/hov-router/issues/784)).
- The auto-rerun workflow excludes both new workflows.

GitHub immutable releases are currently disabled on the platform. The no-clobber
behavior is enforced by this pipeline only; do not describe it as platform immutability.

## Pull request CI approval

PRs created or updated with the built-in `GITHUB_TOKEN` produce approval-required
`pull_request` runs for `opened`, `synchronize`, and `reopened` events. App-authored
PRs avoid that token-specific manual approval gate. This wiring does not prove
that the live installation will trigger CI: verify the actual release PR and its checks.

The required checks have been verified live as `managed-routing-foundation` and
`prepare`, both bound to the GitHub Actions integration **15368**. Since 2026-11-19
([#909](https://github.com/StartupBros-com/hov-router/pull/909)), `main` no longer
requires a pull request to be up to date with it before it merges: both checks also
run on every push to `main`, so the merged result is tested right after the merge.
Preserve that binding and all other policies. The App receives no bypass; required
PR CI is neither waived nor automatically dispatched by this change. If checks are
held for approval, suppressed or unavailable, the PR remains blocked until normal
approval and CI requirements are satisfied. Unattended release-PR merging is outside
this increment.

## Containment

The inherited npm release, multi-architecture release and both SignPath workflows,
with `.signpath/` and the npm publish hooks, were deleted on 2026-11-03 when
wholesale upstream merges ended ([UPSTREAM.md](../UPSTREAM.md)).
`scripts/__tests__/router-release-workflow.test.ts` fails if one reappears.
Upstream's Docker publishing workflow was removed earlier: this fork publishes no
container image, and the [Docker guide](docker.md) builds one from source.
`prepare-router-artifacts.yml` stays a local, non-publishing preparation check; it
also runs the [squash-commit check](#squash-commits-release-please-can-parse).

## Evidence required for each release

Verify the actual App-authored release PR and its CI events, draft, tag,
attestation, upload and dispatch at the release's immutable source SHA. PR #556's
successful token mint, no-op reconciliation and revocation prove the App wiring,
not that later releases completed those steps.

The App action's pinned `action.yml` and `main.js` confirm the inputs, Node 24
runtime and failure on missing Client ID or private key. Static YAML assertions
alone prove wiring, not live credential availability, revocation or GitHub event
behavior. The other action pins (`actions/checkout` 7.0.1, `setup-bun` 2.2.0,
`upload-artifact` 6.0.0, `download-artifact` 7.0.0, `actions/attest` 4.2.1) and the
`gh attestation verify` flags have source and local-test coverage. The `stage` job
checks the runner's `gh` supports every verifier flag used by the helper before
using it. Local executable fixtures exercise CLI output and the coordinator's shell
with synthetic API responses and command stand-ins; they do not prove live GitHub
attestation or dispatch behavior.
