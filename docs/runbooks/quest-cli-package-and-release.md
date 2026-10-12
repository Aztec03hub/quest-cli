---
# yaml-language-server: $schema=../../.lore/schemas/runbook.schema.json
type: Runbook
title: Quest CLI package and release
tags:
  - quest
  - cli
  - packaging
  - release
summary: Immutable package qualification, release, rollback, and publication-truth procedures for Quest.
timestamp: 2026-08-16T18:27:08.312Z
---

# Quest CLI package and release

## Purpose

Qualify immutable Quest package candidates, publish only under explicit owner
authorization, and retain accurate availability and rollback truth when a
release does not complete.

## Prerequisites

- A reviewed source commit and the exact root plus six platform tarballs:
  darwin/linux/win32 on x64 and arm64.
- The exact Bun version this repository pins (`packageManager` in
  `package.json`; the workflows' `bun-version` matches it), for any build
  covering all six platforms **and any `bun install`/lockfile touch before
  it**. Cross-compiling `bun-windows-aarch64` requires a recent Bun: 1.2.x
  refuses it outright with `error: Unsupported compile target`, and
  `build:packages` then stops after four of six, leaving the tree
  half-built. A mismatched Bun is also more dangerous the other way:
  running `bun install` with 1.2.x against a repo pinned to 1.3.14 silently
  dropped `bun.lock`'s `configVersion` field — no error, no warning, just a
  lockfile in a format CI's frozen-lockfile install does not expect. Check
  `bun --version` against `package.json`'s `packageManager` before touching
  `bun.lock` or building, not after. `bun upgrade` does not take a version;
  use `bun update --version <version>`, or
  `curl -fsSL https://bun.sh/install | bash -s "bun-v<version>"` for an
  exact pin.
- Package checks that prove root/platform version and SHA-256 agreement,
  platform constraints, license, repository identity, and published-file
  contents. This is why platform binaries get built **locally, before any
  commit**, not via a CI dispatch on the branch: `check:packages` runs as
  part of `source-gates`, and `immutable-candidates` (the job that actually
  rebuilds the six platforms) `needs: source-gates` — so a commit whose
  platform packages don't yet match the bumped root version fails the very
  gate that would let CI fix it. That is expected, not a runbook gap: build
  locally with the matched Bun version first (previous bullet), commit
  root and platform changes together as one reviewed commit, and only then
  let CI validate it.

  **Qualified by "Why strings first, then bytes" below (QCLI-294).** The
  dependency this bullet describes is real, but "not via a CI dispatch" is
  too strong: a CI dispatch *can* produce the binaries, provided the version
  strings are synced in an earlier commit so `source-gates` stays green. On a
  host that cannot cross-compile all six targets, that is the only available
  route.
- A native-execution receipt emitted by the tagged CI run, binding that exact
  commit and version. A receipt made by hand after the fact is not acceptable
  evidence: the one that existed before QCLI-135 outlived the release it
  described, and downstream qualification then failed closed against it.
- Trusted publishing configured for all seven package names, **created by hand
  for each one**. It does not propagate: `@opum-ai/lore` published 0.1.0 through
  0.3.4 with no trusted publisher and only gained one before 0.3.5, on the same
  npm account, the same organization and the same scope as Quest.

  To check whether a package has ever published through it, without publishing:
  npm attaches a provenance attestation automatically on an OIDC publish, so the
  attestation is a fossil of how each version shipped.

  ```sh
  curl -s https://registry.npmjs.org/@opum-ai%2Fquest \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print({v:('attestations' in d['versions'][v].get('dist',{})) for v in d['versions']})"
  ```

  There is no read path for the configuration itself — no CLI subcommand, and
  the `/access` page is browser-only — so this is the only way to tell from
  outside.
- Trusted publishing configured for all seven package names. npm restricted
  classic tokens for direct publishing, so a stored token cannot publish: both a
  local `npm publish` and the workflow's `NPM_TOKEN` return E404 on PUT, npm's
  response to a token that cannot write to the scope. Granular tokens are capped
  at 90 days and must be created on the website, so a token-based release stops
  working every quarter and surfaces as a stalled release rather than a warning.

  One-time setup per package, at `https://www.npmjs.com/package/<name>/access` —
  not the account settings page — for `@opum-ai/quest` and each of the six
  platform packages:

  | Field | Value |
  | --- | --- |
  | Organization | `opum-ai` |
  | Repository | `quest-cli` |
  | Workflow filename | `release.yml` (filename only, not a path) |
  | Environment | `release` (the job declares one) |

  **npm returns E404 on PUT for at least four different causes** and gives no
  way to tell them apart: a token that cannot write to the scope, a token that
  does not authenticate, an npm below the OIDC floor that silently skipped
  trusted publishing, and no trust relationship at all. Quest's 0.3.0 release
  hit three of the four in sequence. The workflow now eliminates the first
  three before the registry is touched — no token is configured, the npm floor
  is asserted rather than assumed — so an E404 that survives all of that means
  the configuration is missing or mistyped.

  Every field is case-sensitive and **npm does not validate them on save**, so a
  typo appears only as a failed publish. GitHub-hosted runners only.
- Explicit owner authorization immediately before publication. This task does
  not reserve a name, alter registry access, or publish on its own.

## What a version bump touches

Before "a reviewed source commit" above can exist, the version itself has to
move in every place that carries it. Established by a pre-0.7.0 version audit
(OPAG-142) and corrected during the 0.7.0 bump itself (QCLI-294), which found
one site the audit had missed -- verify against source before trusting this
list for a release further out than the one that produced it.

**Sync the version STRINGS first, then replace the BINARY bytes -- in two
commits, not one.** This is the ordering the rest of this section assumes, and
getting it backwards strands the release: see "Why strings first, then bytes"
below, which also reconciles this section with the Prerequisites bullet above.

**Hand-edited, independently -- nothing here derives from anything else:**

- `package.json` (root) `.version` -- the actual source of truth: everything
  generated below reads from this field, not the other way round.
- `src/application/version.ts`'s `QUEST_VERSION` constant. Its own doc
  comment calls it "the single release-version source of truth," but it is
  **not derived from `package.json`** -- a comment claiming an authority the
  file does not have. A bump that only touches `package.json` leaves this
  stale, and `bun run check` will not catch it; only `bun run test:packages`
  does.
- `src/contract/tracker/index.ts`'s `QUEST_ADAPTER_PINNED_VERSION` constant.
  Has its own pinning test, same failure mode as above if skipped.
- `fixtures/tracker/v1/conformance.json`'s `questVersion` golden value.
- `.claude-plugin/plugin.json`'s `.version`. **The audit that produced the
  first version of this list missed this file, and it had already been wrong
  for two releases** -- it read `0.6.0` from the 2026-09-10 repository
  recreation until QCLI-294 moved it, so it was stale through the abortive
  0.6.1 and through the 0.6.2 that actually shipped. QCLI-258 (the 0.6.0
  release) listed it as a hand-edited site, and that knowledge was simply
  lost. Nothing generates it and no test compares it to `package.json`, which
  is exactly why it drifted silently; treat its presence on this list as the
  only thing currently preventing a third occurrence.
- Root `package.json`'s six `optionalDependencies` pins (`@opum-ai/quest-<platform>`),
  which `check:packages` requires to equal the root version exactly.

**The dev-checkout version suffix is build-derived, and adds no hand-edited
site.** A build (`scripts/build-platform-packages.mjs`) runs `git describe
--tags --long` and, when the checkout carries commits beyond the last reachable
tag, rewrites the `<distance>-g<sha>` suffix to `-dev.<distance>.g<sha>` --
`v0.12.0-60-gd49cb95e` becomes `0.12.0-dev.60.gd49cb95e` -- injecting it into
the binary as the `__QUEST_BUILD_VERSION__` define. The base is always root
`package.json`'s version, **never the describe tag's own text**, so a bump
window (`package.json` bumped ahead of the last tag) does not under-report and
an irregular tag such as `v0.13.0-rc.1` is ignored rather than read as a
version. A **RELEASE build** is the candidate build with `QUEST_RELEASE_BUILD=1`
set in its environment -- the candidate step in
`.github/workflows/prepublication-qualification.yml`, the only place the signal
is set -- and it embeds the bare `package.json` version, which is what lets
`prepublish.mjs`'s candidate-version check (bare semver) pass. With no reachable
tag, `git describe` fails and the build falls back to the bare `package.json`
version. That suffix is generated at build time (QCLI-296), so it is not a site
anyone edits at bump time: **this bump-touches list is unchanged, and no new
hand-edited version site is added.**

**Generated, not hand-edited -- `scripts/build-platform-packages.mjs` is the
generator:**

- `npm/quest-<platform>/package.json` for all six platforms (`darwin-arm64`,
  `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`).
- `npm/quest-<platform>/bin/quest`(`.exe`) for all six.
- Root `package.json`'s `questPlatformPackages` checksum map.

The script reads `version` from root `package.json` -- confirming root as the
one real source of truth above -- then, in the *same pass*, both writes each
platform manifest and recompiles that platform's binary
(`bun build --compile`). **There is no manifest-only mode.** That is the
actual mechanism behind "Anchor every artifact claim to stored bytes" below:
this script cannot be safely re-run against an already-published version to
fix a manifest typo alone, because doing so also produces a new, non-byte-
identical binary for a release that already shipped a different one. Before
publish -- preparing a new bump, nothing published yet -- running it via a CI
dispatch against the release branch (see "Exercising a build before it is
published") is the normal, correct procedure, not an exception to this rule.

**Also generated, separately:**

- CLAUDE.md's managed Quest block (the "Quest CLI `<version>`" sentence), via
  `quest agents --update-instructions --target claude`. Run it against the
  **freshly built local binary** for this machine's own architecture (e.g.
  `./npm/quest-darwin-arm64/bin/quest agents --update-instructions --target
  claude`), never the globally installed CLI on `PATH` -- it reads its own
  running version, not `package.json`. Regenerating against a stale global
  install silently reports `state: current` against itself; this exact
  mistake happened at the 0.6.1 bump.

**Regenerated by running `bun install`, in the strings commit, on every bump:**

- `bun.lock`'s six `@opum-ai/quest-<platform>` pins, in the root workspace's
  `optionalDependencies` block (and any resolved `packages` entry bun has
  written for them). Nothing else updates these. Run `bun install` after
  editing `package.json` and commit the lockfile with the strings. It works
  before the new version is published: measured on bun 1.3.14, it rewrites
  exactly those six lines, and a frozen install passes afterwards.

**Why this is gated, not just written down (QCLI-292).** Measured on bun
1.3.14, 2026-09-25: CI's own `bun install --frozen-lockfile` **cannot see a
stale pin at bump time**. When the new version is not on the registry yet, the
optional dependency is skipped rather than compared, and a lockfile still
pinned to the previous version exits 0. It goes red only once the version is
**published** ("lockfile had changes, but lockfile is frozen"), which is after
the release, on whatever unrelated pull request runs next. That is the 0.6.2
breakage, which was patched once as a one-off. This paragraph used to be a
written reminder, and it did not prevent the drift, because the failure shows
up long after the step it depends on.

So `scripts/check-lockfile-pins.mjs` (`bun run check:lockfile`) fails closed
when any of the six pins differs from `package.json`'s version, or when it
reads fewer than six. It runs as the `lockfile_pins` gate in the
prepublication qualification's source gates, which is the required
`source-gates` context, so it runs on the bump pull request itself. Its
message names `bun install` as the fix. Kept as a separate gate rather than
added to `check:packages`, because that script also packs every platform
package and needs the binaries in place, while this one reads two text files.

**Not part of the bump commit:** `CHANGELOG.md`'s `## Unreleased` heading
becomes `## <version>` at tag time (Step 5 below), not when the version
files above are committed -- moving it early makes the changelog claim a
release before qualification has run. It is a RENAME PLUS A NEW HEADING, not
a rename: step 5 leaves a fresh empty `## Unreleased` above the section it
just named. Omitting the successor is what produced QCLI-319 -- four
consumer-observable changes landed on `dev` after the 0.7.1 tag with no
heading to be recorded under, and nobody noticed until a consumer reported it
could not detect one of them by any means. An absent section is invisible in
a way a wrong section is not: nothing reads as missing.

**A breaking section needs at least a minor bump, and the bump PR is gated on
it (QCLI-328).** 0.6.2's entry correctly carried `### Changed (breaking)` and
still shipped as a patch. `scripts/check-breaking-bump.mjs` (`bun run
check:breaking-bump`) runs as the `breaking_bump` source gate. It reads the
notes that belong to `package.json`'s version: `## <version>` once step 5 has
run, otherwise `## Unreleased`, which is the state on the bump PR. If those
notes carry a `### ... (breaking)` heading and the step from the version
heading below is patch-level, it fails. Before choosing the number, run it
with `--next <x.y.z>` to check a proposed version against `## Unreleased`.
Ruled in opum-doc
`docs/adr/gate-release-prep-on-a-breaking-changelog-entry-at-a-patch-bump.md`.

**Because the pair shares one version, a breaking entry on EITHER side forces
the pair to at least minor, including the side that did not change
functionally (QCLI-403).** `bun run check:breaking-bump:pair` runs the same
rule over lore-cli's notes for the same version. It reads lore-cli's
`CHANGELOG.md` through the GitHub API at the commit its `main` resolves to,
and it names that ref, that SHA and how many sections it read. Before you
choose the number, run `node scripts/check-breaking-bump.mjs --pair
--lore-ref dev --next <x.y.z>`, because lore's unreleased notes are on `dev`.
`release.yml` runs the `main` form right after the version-parity gate and
before anything is published. It fails closed: a 404, an auth failure, a
network error, or a CHANGELOG with no version section refuses, and never
passes on nothing read. It stays out of the `breaking_bump` source gate on
purpose, because a network read in the required `source-gates` context would
make that context flaky. lore-cli runs the mirror check against quest-cli.

### Why strings first, then bytes

The Prerequisites bullet above says platform binaries are built "locally,
before any commit, not via a CI dispatch on the branch," and the first
version of this section said a CI dispatch was simply the normal procedure.
**Both were incomplete, and the disagreement was real rather than a wording
difference** -- recorded here rather than silently resolved, because the
mechanism underneath is what a bump actually has to obey.

`check-package-artifacts.mjs` tests two things *independently*: that every
version string agrees (root `.version`, each `optionalDependencies` pin, each
platform manifest's `.version`), and that every checksum agrees with the bytes
it describes (each manifest's `questBinarySha256` and root's
`questPlatformPackages` entry, both against the actual binary on disk). A
commit can therefore satisfy the second while moving only the first.

That is the intermediate state a bump needs, because of a CI dependency that
is otherwise a trap. `check:packages` runs inside `source-gates`;
`immutable-candidates` -- the job that rebuilds the six platforms -- declares
`needs: source-gates`. So a commit that bumps only the root version fails
`check:packages` on a version mismatch, `source-gates` goes red, and the
rebuild job never runs: **the gate that would let CI fix it is the gate the
mismatch breaks.** That is what the Prerequisites bullet is warning about, and
it is correct as far as it goes.

The way through is two commits:

1. **Strings.** Move every hand-edited site above *and* each platform
   manifest's `.version` field. Leave the binaries, the `questBinarySha256`
   fields and the `questPlatformPackages` map untouched -- each still matches
   its own (now-previous-version) bytes, so the checksum half still passes
   while the version half now reads the new number. `check:packages` exits 0
   in this state; verified at the 0.7.0 bump.
2. **Bytes.** With `source-gates` green, dispatch the qualification workflow
   against the branch so `immutable-candidates` builds all six platforms with
   the new version compiled in, then install the result with the repository
   script rather than the hand steps this section used to describe:

   ```sh
   bun run install:platform-candidates -- --run <qualification-run-id>
   ```

   That script (`scripts/install-platform-candidates.mjs`, QCLI-305) downloads
   the six `quest-package-<target>` artifacts from that run, recomputes each
   binary's sha256 and **refuses, writing nothing, unless it matches that
   artifact's own `questBinarySha256`** -- the digest check runs over every
   artifact before anything is copied. It then writes each manifest, LICENSE
   and binary into `npm/quest-<target>/`, chmods the binary, and rewrites root
   `package.json`'s `questPlatformPackages` map to the recomputed digests.
   `npm/quest-darwin-arm64/bin/quest` is the last thing it writes, and it never
   executes a downloaded binary (see "A locally-rebuilt darwin-arm64 binary can
   SIGKILL git on this host"). Add `--dry-run` to download and verify a run id
   and write nothing:

   ```sh
   bun run install:platform-candidates -- --run <qualification-run-id> --dry-run
   ```

   Then commit the real binaries, manifests and checksums.

A local `build:packages` run is a legitimate substitute for step 2 on a host
that can cross-compile all six targets; run it with `QUEST_RELEASE_BUILD=1`, the
same release signal the candidate build sets, so it embeds the bare version
rather than a `-dev.<N>.g<sha>` suffix the candidate-version gate would reject.
It is not available on a host that cannot cross-compile, and on macOS it
additionally risks the code-signing hazard documented below. Neither route
changes step 1, which is required either way.

## Steps

1. Build candidates from the reviewed commit. Record the source SHA, Bun
   version, root checksum, each platform checksum, and every compiler fallback
   used. A local compiler cache is build infrastructure, never a package
   payload. Before committing a rebuilt `npm/quest-darwin-arm64/bin/quest`,
   see "A locally-rebuilt darwin-arm64 binary can SIGKILL git on this host"
   below -- executing it before the final delete-and-recreate, not after,
   avoids a real host-level hazard.

2. Run the artifact and packed-tarball gates:

   ```sh
   bun run check:packages
   bun run test:packages
   ```

   The candidate must contain only the root Node launcher or a single platform
   binary, its manifest, and the license. It must not ship source TypeScript,
   development fixtures, private workspace paths, or a host Bun dependency.

3. Require QCLI-93's qualification evidence to name the exact clean-install
   harness and immutable tarball for every platform target. It must cover
   `quest --version`, `quest manifest --json`, a task operation, projection
   access/rebuild, and migration smoke behavior. Projection and migration
   smoke commands are not public 0.1 executable commands, so do not present
   invented interactive syntax here: a missing harness or unavailable target
   is an explicit publication-blocking gate, not an assumed pass.

4. Run the complete qualification record: type, formatting, layer, unit,
   contract, integration, black-box, fault, clone/worktree, migration, scale,
   package, provenance, dependency-license, checksum, and repository-identity
   checks. Attach each command, result, candidate checksum, and skipped-gate
   reason to the release evidence.

5. Finalize the changelog, then tag. Rename `CHANGELOG.md`'s `## Unreleased`
   heading to `## <version>`, **and add a fresh empty `## Unreleased` heading
   directly above it in the same edit**:

   ```markdown
   ## Unreleased

   ## <version>
   ```

   **The tag has to carry this edit, not a later one.** QCLI-407 reads the
   release notes at the commit `v<version>` peels to, so a section finalized
   after the tag does not reach the release: the cut reads the tagged bytes and
   refuses rather than shipping the older ones. Finalizing and tagging in the
   same step is what makes the notes true, not merely tidy.

   The empty heading is the step, not a courtesy. Every change that lands
   between this tag and the next one needs somewhere to be written down at
   the moment it lands. What was measured after the 0.7.1 tag, which left no
   successor: four consumer-observable changes landed on `dev` and not one
   carries a changelog entry (QCLI-319). Why each author wrote nothing was
   not measured and is not the point -- the heading costs two lines and
   removes the question.

   Then require the native-execution receipt for this exact commit and
   version, create the release tag, and dispatch the qualification workflow
   **against that tag**:

   ```sh
   git tag v<version> && git push origin v<version>
   gh workflow run prepublication-qualification.yml --ref v<version>
   ```

   Dispatch explicitly rather than relying on the tag push to trigger it. The
   workflow's `push` trigger carries a `paths` filter, which is evaluated
   against the tagged commit's own diff, so tagging a commit that did not
   touch those paths starts no run at all. A dispatch against the tag always
   does, and sets `github.ref` to `refs/tags/v<version>`, which is what the
   release-only jobs key off.

   On a tag ref each platform job executes the **committed** artifact rather
   than rebuilding it, having first attested that the binary on disk is
   byte-identical to the blob at that ref. Rebuilding would defeat the receipt:
   Bun's `--compile` output is not byte-reproducible, so a rebuilt binary is a
   different artifact from the one being published. An aggregation job then
   emits the receipt from the run's own metadata and uploads it as the
   `native-execution-receipt` artifact. Download it and run the gate:

   ```sh
   bun run receipt:require -- --receipt native-execution-receipt.json
   ```

   The gate re-derives every digest from the artifacts on disk rather than
   trusting the document, and refuses a receipt bound to any other commit or
   version. A failure here is publication-blocking: without it the run proves
   only that a binary built from this source executes on each target, not that
   the bytes about to be published do.

6. Immediately before a separately authorized publish, recheck the registry
   name and conflicts, the repository identity, current Lore release gate, and
   package metadata. If any fact changed, stop for an owner decision; do not
   substitute a package name or artifact.

7. Publish the exact reviewed immutable artifacts only after the owner grants
   that authorization. Dispatch the release workflow against the tag, dry run
   first:

   ```sh
   gh workflow run release.yml --ref v<version> -f publish=false
   gh workflow run release.yml --ref v<version> -f publish=true
   ```

   The workflow fetches the receipt from the qualification run for that exact
   commit rather than accepting one as input, and refuses to publish without
   it. Both routes STAGE the release under `release-candidate` and leave
   `latest` alone; see "Stage, qualify, promote" below for the step that moves
   it. Platform packages publish before the root, so the root never briefly
   advertises `optionalDependencies` that do not exist. Then clean-install from the registry and repeat the
   public version, manifest, task, projection, and migration smokes. Only this
   successful verification permits availability or install documentation.

   If the CI/OIDC publish path is unavailable (see "Publishing locally when
   CI cannot" below), `scripts/publish-release.mjs` performs a fail-closed,
   receipt-gated publish from an operator's own machine. It does NOT run the
   same gate set as `release.yml`: two of that workflow's gate scripts --
   three invocations -- are CI-only and must be run by hand on the local
   route. The enumeration is in "The gate set each route runs" below.

8. Confirm the receipt describes what the registry actually serves, then hand
   it to downstream qualification:

   ```sh
   bun run receipt:verify-published -- <version> --receipt native-execution-receipt.json
   ```

   This downloads all six platform tarballs and compares each binary's digest
   to the receipt. Publish the receipt to the consuming harness only after it
   passes; a receipt that describes a build nobody published is the exact
   failure this step exists to prevent.

## Promoting dev to main

Not one of the eight numbered steps above, deliberately: the release workflow
dispatches against the TAG (`--ref v<version>`), never against `main`, so
promoting `dev` is orthogonal to qualification and to publish. It can happen
any time after a reviewed commit lands on `dev` -- most naturally right after
step 5's tag-time commit -- and if the publish is later declined, `main`
carrying a prepared-but-unpublished version costs nothing; the tag is what
step 7 actually reads.

This repository gates `main`, not `dev` (see the repository profile in
`CLAUDE.md`): a `dev`-to-`main` PR triggers the same required checks a second
time, on a SHA that already passed them once on its way into `dev`. Learned
at the 0.8.0 promotion (QCLI-332), 2026-09-17, because each of these reads as
a broken promotion to whoever sees it for the first time mid-release:

- **Two full rounds of `source-gates` / `Tracker integrity` / `lore check`
  fire on one SHA.** "Green once" is not "done" -- read the newest run per
  required context (by `started_at`) from `gh api
  repos/opum-ai/quest-cli/commits/<sha>/check-runs`, intersected against the
  context names in `rules/branches/main`, and confirm zero non-`completed`
  runs remain before merging.
- **`promotion-is-manual` failing and `main-is-fast-forward-of-dev` skipping
  are the documented always-fail tripwire from
  `.github/workflows/promotion-guardrails.yml`, not blockers.** Neither is in
  the required-checks list; both exist only to stop the GitHub merge button
  from being used on this PR.
- **`mergeStateStatus` reading `UNSTABLE` is expected on this PR shape**, not
  evidence the promotion is broken.

Land it with `git push origin origin/dev:main` -- the remote-tracking ref,
never bare `dev:main`, which resolves to a local branch that can be stale and
silently no-ops instead of promoting anything -- chained on the check with
`&&`, never `;`. Never the merge button: it staples a merge commit onto
`main` that never reaches `dev`, breaking the fast-forward ancestor invariant
this whole procedure depends on. Assert the result from the API (`gh api
repos/opum-ai/quest-cli/git/ref/heads/main`) rather than trusting the push's
exit code, then fetch and read `origin/main` before reporting it -- local
`main` is stale in any session that has been promoting, because the push
never checks `main` out.

## A locally-rebuilt darwin-arm64 binary can SIGKILL git on this host

Host-specific, not a code defect, confirmed via live kernel log capture
(QCLI-271): once a freshly built `npm/quest-darwin-arm64/bin/quest` has been
**executed** on a machine that code-signs and validates Mach-O binaries at
mmap time, any subsequent git operation that reads that exact file --
`status`, `diff`, `add`, `hash-object`, `commit`, even an unscoped `git
status` that merely refreshes the whole index -- gets killed outright
(`exit 137`). `log stream` at the moment of the kill shows the kernel's own
diagnosis: `CODE SIGNING: cs_invalid_page(...) ... denying page ... sending
SIGKILL`, naming the exact path, with the process marked `tainted:1`. Only
`darwin-arm64` is affected -- it is the only platform binary that is
natively executable (and therefore code-signed and validated) on this class
of host; the `linux-*`/`win32-*` binaries never engage this kernel path.

**A fresh inode (delete-then-recreate the file) is necessary but NOT
sufficient.** Recreating the file clears stale validation state tied to the
old inode, so a git operation on the fresh copy succeeds -- right up until
the fresh copy is itself *executed*. Executing it taints its own vnode for
subsequent git access, even though a git-only read (e.g. `git hash-object`)
on that same inode had already succeeded moments earlier. So the ordering
that actually avoids the kill is:

1. Do every execution you need against the freshly built binary first
   (`--version`, `agents --update-instructions`, whatever the release step
   requires).
2. Delete the file and recreate it fresh from the untouched build artifact,
   as the **literal last step** before any git command touches it.
3. Run git operations against it with **zero execution** in between that
   final recreate and the commit.

If a git operation on this path gets killed anyway, do not try to strip
quarantine attributes, re-sign, or otherwise bypass the platform's
validation -- escalate instead. The escape hatch for finishing an unrelated
commit while this is unresolved is plumbing that never mmaps the working-tree
file: `git show HEAD:<path>` + `cp` to revert a single file's content, and
`git update-index --cacheinfo <mode>,<sha>,<path>` to unstage one, both avoid
the working-tree read that `git checkout --`/`git reset --` perform. A killed
git process can leave a stale `.git/index.lock`; verify with `ps`/`lsof` that
nothing still holds it before removing the lock file by hand.

This is a **general macOS code-signing hazard**, not specific to Quest's own
build step -- see opum-doc's fleet-wide reference,
[`native-macos-binary-git-sigkill-hazard.md`](https://github.com/opum-ai/opum-doc/blob/main/docs/reference/native-macos-binary-git-sigkill-hazard.md)
(ODOC-188), for the mechanism in general terms. QCLI-275 (converging
`npm/*/bin/` packaging on a build-in-CI, never-commit shape) would remove
this repository's exposure to it as a side effect, but is not a substitute
for the execution-ordering discipline above wherever a native binary is
still built and committed locally.

## Publishing locally when CI cannot

`scripts/publish-release.mjs` exists for exactly the case the CI/OIDC path
cannot cover -- trusted publishing not yet configured, or (as observed
2026-09) GitHub's org-wide immutable-subject-claim policy rejecting the
subject shape npm Trusted Publishing expects. It shares CI's fail-closed,
receipt-gated posture, but not CI's full gate set: `release.yml` runs two
gate scripts the local script does not (three invocations), so a reader who
takes this route must run those by hand. "The gate set each route runs"
below enumerates every gate of each route. `--receipt <path>` is required,
and the receipt must bind the exact commit and version being published
(`validateReceipt`, re-deriving every digest from the artifacts on disk
rather than trusting the document).

`--qualification-run <id>` is also required (QCLI-366; opum-doc ADR
`harden-fleet-ci-against-a-single-runner-outage-and-unqualified-publication`,
ruling 3). It names the `prepublication-qualification.yml` run on the release
tag. The script checks that run qualified this exact commit, downloads its
`quest-candidate-bundle`, and refuses -- dry run included, before any
credential is read or any npm call is made -- unless opum-cli-e2e's receipt at
`receipts/quest/<version>.json` on its `main` binds this version, commit, run
id and the sha256 of all seven bundle tarballs, with `verdict: "QUALIFIED"`.
A 403 or 404 reading that private repository counts as no receipt. The only
override is an `override` object that opum-cli-e2e writes into the receipt;
it waives the verdict and nothing else, and is printed verbatim when used.
There is no flag or variable that bypasses the gate.

The seven tarballs that stage are the six platforms at X and the root launcher
at `X-rc.N` (QCLI-399, see "Stage, qualify, promote" below). The bundle also
carries the launcher at X in `final/`, which is never staged. So the receipt
must also name `launcherVersion` (the bundle's `X-rc.N`) and carry
opum-cli-e2e's own `launcherSubstitution` verdict of `MATCH`, naming
`final/`'s file with its sha256 re-derived from the bytes. The publisher
re-runs the substitution check on the downloaded bundle as well. An override
does not waive the substitution.

The seven staged `.tgz` files are what gets published, byte-for-byte
(`npm publish <file>`), not a repack of `npm/*` in the working tree -- so the
bytes on npm are the bytes opum-cli-e2e qualified. `release.yml` applies the
same gate and publishes the same files; it reads the receipt with the
`E2E_RECEIPT_READ_TOKEN` secret, and refuses until one exists, because the
job's own `GITHUB_TOKEN` cannot read a private repository.

After publishing, both paths compare npm's `dist.integrity` for all seven
packages with the bundle files (`scripts/qualification/bundle-integrity.mjs`,
QCLI-368) and fail the release on any difference. `--verify-published`
compares only the executables inside the tarballs, which is why it never saw
0.9.0 and 0.10.0's win32 packages differ in LICENSE and package.json line
endings. The CRLF came from the Windows runners' checkout, and is pinned to LF
by `.gitattributes`.

```sh
node scripts/publish-release.mjs --receipt native-execution-receipt.json --qualification-run <run-id>
node scripts/publish-release.mjs --publish --otp <code> --receipt native-execution-receipt.json --qualification-run <run-id>
```

**Two auth mechanisms**, tried in this order, reported explicitly at the
start of a run so the operator knows which one is active:

1. **A stored npm granular access token** -- macOS Keychain under the service
   name `npm-opum-ai-publish`, or `$NPM_TOKEN`. Store one with (never typed
   where it lands in shell history):

   ```sh
   read -rs T
   security add-generic-password -a "$USER" -s npm-opum-ai-publish -w "$T" -U
   unset T
   ```

   Shape-checked before any publish attempt -- length, prefix, and an
   internal-whitespace flag, the value itself never logged. A granular token
   is `npm_` followed by 36 characters (length 40); anything else refuses to
   publish rather than attempt one. This matters because an npm `PUT` to an
   unauthorised package returns 404, not 403 (so as not to disclose whether
   the package exists) -- "not a token", "wrong token", and "token without
   rights" are otherwise indistinguishable, and a sibling repo's release
   burned two full publish attempts on a permissions theory before finding a
   malformed stored value was the actual cause. A token found this way
   bypasses the interactive OTP requirement entirely and is written to a
   *temporary* npmrc for the run only (`npm_config_userconfig`); `~/.npmrc`
   is never touched, and no `--otp` is required or sent.

   **A Keychain entry that exists can still yield no token, and this is the
   single most likely thing to stall the next release.** Measured during the
   0.9.0 publish, 2026-09-18: the Keychain entry existed and was perfectly
   valid, while reading it from a non-interactive shell (an agent session, a
   CI-less script, anything without a TTY) failed:

   ```sh
   security find-generic-password -s npm-opum-ai-publish -w   # exit 36
   # errSecInteractionNotAllowed -- the per-item ACL wants a prompt that a
   # non-interactive shell cannot answer
   ```

   **Absent and present-but-unreadable have opposite remedies** -- create and
   store a token, versus unlock the keychain. Up to 0.10.0 the script caught
   every `security` failure identically and printed "no stored token found
   (Keychain or NPM_TOKEN)", which names the wrong one. Since QCLI-349 the
   `Auth:` line names the state it measured:

   | `security` result | reported as | remedy |
   |---|---|---|
   | exit 0, non-empty value | token used | none |
   | exit 44 (errSecItemNotFound), or an empty value | no entry exists | create and store a token (above) |
   | exit 36 (errSecInteractionNotAllowed) | entry EXISTS, could not be read | `security unlock-keychain` at a terminal; create nothing |
   | anything else, `security` missing included | could not be checked | neither of the above; read the named failure |

   A real publish with the entry locked and no `--otp` refuses with the
   unlock remedy rather than asking for an OTP. With an older script, or to
   check by hand without reading the value:

   ```sh
   security find-generic-password -s npm-opum-ai-publish >/dev/null; echo $?
   #  0 = the entry exists (44 = it really is missing)
   ```

   If it exists, the clearing action is `security unlock-keychain` **at a
   terminal**, by the owner. Confirmed to work: after the unlock the same
   `-w` read returned exit 0 with a valid granular shape, and the publish ran
   on the token route with no OTP at any point. Do not go looking for a token
   to create, and do not reach for `--otp`.

2. **An interactive `npm login` session**, with `--otp <code>` on the real
   publish. This is the human path and needs 2FA at the point of the write,
   regardless of whether the login session itself succeeded -- a valid
   `npm whoami` does not mean the write will be accepted without an OTP.

Deliberately **not** implemented as a pre-publish readiness gate: `npm
whoami` (401s for a correctly scoped package-only granular token -- too
strict), `npm owner ls` (succeeds with no token at all -- vacuous), `npm
config get //registry.npmjs.org/:_authToken` (npm redacts the value -- a
false negative). Write permission is only observable by writing, which is
exactly why the two properties below matter together with fail-closed
platform-then-root ordering: a refusal costs one package, not the release.

**Resumable.** A target already on the registry at the exact version being
published is skipped, not re-attempted (`isPublished`, wrapping `npm view
<pkg>@<version> version`). A partial failure -- an expired OTP mid-sequence,
a transient network error -- can be cleared by simply re-running the same
command; whatever already landed is skipped rather than rejected as "cannot
publish over an existing version."

**Registry propagation lag is real and can be long.** After every platform
and the root publish successfully, the script waits for the registry's read
API to catch up with npm's own write confirmation before verifying (a single
shared backoff window across all seven packages, not one per package,
default 30 minutes). This is not paranoia: read-after-write lag has been
measured *worsening* release to release elsewhere in this fleet (seconds,
then tens of seconds, then tens of minutes). **A timeout here is reported as
registry lag, not a failed release** -- the write already succeeded, and
running `npm unpublish` in response is destructive, available for 72 hours,
and would remove a release that is not actually broken.

### The gate set each route runs

`release.yml` and `scripts/publish-release.mjs` are **not** the same gate set.
The local script imports and runs neither `scripts/qualification/release-provenance.mjs`
(`--pre` and `--post`) nor `scripts/check-breaking-bump.mjs --pair`, both of
which `release.yml` runs; a reader who took the local route believing the old
"same gates" wording unknowingly dropped two CI gate scripts -- three
invocations in all (`release-provenance --pre`, `check-breaking-bump --pair`
and `release-provenance --post`). The table lists every gate `release.yml`
runs, in workflow order, and where the local route covers it. A reader
taking the local route must run the CI-only rows by hand, or the release
ships having silently skipped them.

| `release.yml` step | Gate | Local route (`publish-release.mjs`) |
|---|---|---|
| Assert the npm OIDC floor | The asserted gate is the npm floor, >= 11.5.1; Node is pinned by `setup-node` (`node-version: 24`) rather than asserted | Not applicable: the local route authenticates with a stored token or an interactive OTP, never OIDC. |
| Fetch the native-execution receipt for this commit | `gh run list`/`gh run download` the successful `prepublication-qualification.yml` run at the released commit, both the `native-execution-receipt` and the `quest-candidate-bundle` | Partly covered: the script downloads the `quest-candidate-bundle` itself and proves its provenance from the run record, given only `--qualification-run <id>`. Only the native-execution receipt is operator-supplied, as `--receipt <path>`. |
| Gate on the receipt | `native-execution-receipt.mjs --require` | Covered: `validateReceipt`, re-deriving every digest from the artifacts on disk. |
| Gate on the opum-cli-e2e qualification receipt | `e2e-receipt.mjs --require` -- binds version, commit, run id, all seven tarball sha256, and the launcher substitution | Covered: `requireQualification`, the same receipt and the same substitution re-run on the downloaded bundle. |
| Gate on release provenance | `release-provenance.mjs --pre` -- tag, commit and `package.json` agree, and the commit is reachable from `main` | **Not run -- run it by hand** (below). |
| Gate on lore/quest version parity | `version-parity.mjs --require` | Covered: `requireVersionParity`. |
| Gate the pair's bump level on both CHANGELOGs | `check-breaking-bump.mjs --pair` | **Not run -- run it by hand** (below). |
| Preflight the publish credential | `npm whoami` (`continue-on-error`) | Replaced: the local script's `Auth:` line and token shape-check report the credential state instead. |
| Publish the platform packages | six `npm publish ... --tag release-candidate` | Covered: same staged tarballs, byte-for-byte. |
| Gate -- all six platform packages must resolve for a consumer | `require-platform-visibility.mjs` | Covered: the script gates the wrapper publish on the same anonymous read. |
| Publish the wrapper | `npm publish ... --tag release-candidate` | Covered: same. |
| Verify the registry serves what was published | npm-read loop, then `native-execution-receipt.mjs --verify-published` | Covered: `waitForPublished`, the same receipt-against-registry comparison. |
| Verify npm serves the qualified bundle, tarball for tarball | `bundle-integrity.mjs` | Covered: `verifyRegistryHoldsBundle`. |
| Verify the registry's provenance matches what was released | `release-provenance.mjs --post` | **Not run -- run it by hand** (below). |

**The CI-only gates, run by hand.** These run only inside `release.yml`, so the
local route must run them itself, from the release commit's checkout:

```sh
# Before publishing: the tag, the commit and package.json must agree, and the
# commit must be reachable from origin/main. --pre reads GITHUB_REF, so it must
# name the tag being released; GITHUB_SHA otherwise defaults to HEAD.
GITHUB_REF=refs/tags/v<version> node scripts/qualification/release-provenance.mjs --pre

# Before publishing: a breaking CHANGELOG heading in EITHER repository forces at
# least a minor bump of the pair. --pair reads lore-cli's CHANGELOG.md at its
# main through `gh api`, so it needs an authenticated `gh`.
node scripts/check-breaking-bump.mjs --pair

# After publishing: the registry's own gitHead for the staged version must be
# the commit it was released from. --version names the launcher's X-rc.N,
# because the platforms stage at X and the wrapper at X-rc.N (QCLI-399).
GITHUB_SHA=<released-commit> node scripts/qualification/release-provenance.mjs --post --version <X-rc.N>
```

Found while running the 0.13.0 publish (main `5996e24a`), where both gate scripts
were run by hand precisely because the local route does not: `release-provenance --pre`
with `GITHUB_REF=refs/tags/v0.13.0`, and `check-breaking-bump --pair`, both
exit 0.

## Anchor every artifact claim to stored bytes

Bun's `--compile` output is **not byte-reproducible**: the same source at the
same Bun version produces a different binary on a different machine. Measured,
not assumed — six platform jobs each reported a mismatch against binaries built
locally minutes earlier.

So *rebuild and compare* is not available as a verification technique anywhere
in this pipeline. Every claim about an artifact must anchor to bytes that are
**stored** — the blob committed at the release ref — never to bytes that can be
regenerated. Two mistakes have already come from ignoring this: a reproduction
gate that could never pass, and a candidate bundle that named a commit whose
bytes it did not carry.

## A 404 on an old gitHead is expected, not tampering

Every version published before v0.6.1 (0.3.0 through 0.6.0, eight versions)
records an npm `gitHead` that returns HTTP 422 from
`gh api repos/opum-ai/quest-cli/commits/<sha>` — "No commit found for SHA".
This is a consequence of the 2026-09-10 repository deletion and recreation
(OPAG-70), not evidence of tampering, a broken reference, or a reason to
retag or republish anything. See QCLI-267 for the fullest measured case
(v0.6.0) and its forward fix.

**Nothing repairs this.** npm forbids republishing an existing version, and
the commits those `gitHead` values name are unrecoverable — the recreation
did not just move history, it replaced it. Re-pointing a tag to a surviving
commit would make the tag agree with the repository again but would still
disagree with the immutable npm `gitHead`, which cannot be changed at all.
The published tarballs, their checksums, and their SLSA provenance
attestations are all intact and correctly signed; only the commit their
provenance names has stopped existing. The cure is worse than the
condition, which is why this is a documentation entry and not a task.

The `release-provenance.mjs --pre`/`--post` gate wired into `release.yml`
(QCLI-267) prevents this class from recurring silently on any release from
v0.6.1 onward. It does not, and cannot, retroactively fix the eight versions
that predate it — a reader hitting a 422 on one of those `gitHead` values is
seeing the expected, permanent state of an already-published artifact, not a
new defect. Cite the immutable npm version, not the git tag or commit, when
that matters.

Check this from the live GitHub API, never from a local clone: the destroyed
commits still resolve inside a local clone's own loose objects (`git cat-file
-t <sha>` happily answers `commit`), because deletion-and-recreation replaced
what the *remote* serves, not what an existing local checkout had already
fetched. Only `gh api repos/opum-ai/quest-cli/commits/<sha>` — or an equally
fresh clone — shows the 422 that proves the commit is actually gone
(lore-cli, hitting the identical shape in its own repository).

## Exercising a build before it is published

To qualify changes that have not been released, dispatch the qualification
workflow against the branch and collect the `quest-candidate-bundle` artifact:

```sh
gh workflow run prepublication-qualification.yml --ref <branch>
gh run download <run-id> --name quest-candidate-bundle --dir candidate
```

The bundle is digest-pinned and reaches no registry. A consumer binds it with
`--quest-candidate` and installs Quest from the exact tarballs inside it,
recomputing every executable digest from those bytes.

State what it does and does not establish, rather than reporting the verdict
alone. Binding a candidate replaces per-platform CI-receipt rows with
candidate-byte rows: it gains live digest re-derivation and binds the binary
that actually runs the behavioural rows, and it loses execution attestation for
the platforms the running host cannot execute. Six targets attested becomes one
target executed plus six artifacts digest-bound. The native-execution receipt
covers the second, so the two are complementary rather than substitutes, and
neither is soak.

The consuming harness may also read the platform and root `package.json` from a
sibling source checkout rather than from the bundle. Tell the consumer which
checkout and which version to expect, and leave it there for the duration of
the run; a working tree that moves mid-run fails those rows on a mismatch that
has nothing to do with the candidate.

## A publish can land STAGED: accepted, reserved, and invisible

Measured during the 0.7.0 release, 2026-09-15 (QCLI-299). npm 12 has a
staged-publish flow: a version can sit in the registry **non-public, awaiting a
maintainer's 2FA approval**, and a staged version **occupies the same semver
unique index as a published one**. So a fourth state exists alongside
published / slow / absent, and nothing in the publish path names it.

What it looked like. `npm publish` returned success for
`@opum-ai/quest-darwin-x64@0.7.0` and the loop published five more packages
after it. The version never appeared: absent from `versions`, absent from
`time`, `dist-tags.latest` still `0.6.2`, and the packument's `time.modified`
still showing the previous day. Meanwhile `@opum-ai/quest@0.7.0` was live
advertising it as an `optionalDependency`, so a macOS x64 install succeeded
and left no binary -- silently, because optional dependencies do not fail an
install.

**The symptom that identifies it is a 409 on a re-publish attempt:**

```
http fetch PUT 409 https://registry.npmjs.org/@opum-ai%2fquest-darwin-x64
error code E409
error 409 Conflict - Cannot publish over previously staged version "0.7.0".
```

Two properties worth knowing before the next release:

- **The release token cannot see it.** `npm stage list` returned `[]` for the
  granular publishing token while the registry was refusing its PUT over a
  staged version that token had itself created. The publisher is blind to the
  thing blocking the publisher.
- **`time.modified` does not distinguish staged from never-written.** A staged
  version does not touch the public packument, so that field -- which looks
  decisive, and was used as decisive here before the 409 arrived -- separates
  "the public packument was not written" from "nothing happened", and those are
  different facts.

**AMENDED 2026-09-18 (QCLI-350): that signature is not decisive for staging,
because a third state produces it identically.** During the 0.9.0 publish
`@opum-ai/quest-linux-arm64` missed the visibility window entirely and
presented every symptom above -- absent from `versions`, absent from `time`,
`time.modified` still showing the previous release -- and `npm stage list`
could not adjudicate either, returning **E401** for the publishing token
rather than the `[]` seen at 0.7.0. It was neither staged nor never-landed:
`--diagnose-staged` reported *"skip (already on the registry at this
version)"*. It had landed and was merely **SLOW**. The wrapper then did the
same thing minutes later, with the targeted version endpoint returning 404
while the publish had in fact succeeded, and two npm cache layers disagreeing
with each other for a further interval.

So the states are **published / slow / absent / staged**, and a single read
separates none of the middle three. Only the 409 is positive evidence of
staging; everything else is compatible with lag. Wait and re-read before
reaching for an operator action, and treat "absent from `time`" as suggestive
rather than decisive.

The publisher now says this itself. An `absent-or-staged` package lists SLOW,
STAGED and NEVER LANDED, and tells you to re-read before `--diagnose-staged`.
The success line names each object with the check that verified it: the
platform packages against the receipt, the seven tarballs by integrity, and
the wrapper by the same anonymous consumer read that gates the platforms. It
does not print until that last read resolves. On 0.9.0 it printed "published
and verified (1 check)" while that read still returned 404.

**Clearing it is an operator action and needs 2FA**, which is the entire point
of staging: `npm stage list` then `npm stage approve <stage-id>` from a
logged-in session, or the package's page on npmjs.com. The owner approved this
one roughly twelve minutes after the publish, and the staged tarball went
public **unmodified** -- shasum, integrity, file count and unpacked size all
identical to what the pre-publication receipt gate had verified, so candidate
digests do not need re-deriving after an approval.

That last sentence is measured, not inferred: the owner confirmed directly
that they approved it. It matters because the alternatives imply different
tooling. Staging that self-resolves would be a transient state worth waiting
out; staging cleared by a human is a procedure with a named actor, and a wait
loop pointed at it burns its entire window on something that was never going
to resolve on its own. The publish script reports it as its own outcome for
exactly that reason.

### Why one package of seven staged: undetermined, and here is what is ruled out

Recorded rather than guessed, and re-measured on 2026-09-15 rather than
carried over:

- **Nothing in this repository ever asks for a stage.** The CI release
  workflow (`.github/workflows/release.yml`, the per-target loop) and
  `scripts/publish-release.mjs` both invoke `npm publish --access public`.
  Neither calls `npm stage publish`. So the stage was created registry-side.
- **npm's own documentation says this should not happen.** `npm help stage`
  and the v12 docs describe staging as an explicit `npm stage publish`
  workflow, and GitHub's changelog dates the removal of direct publishing for
  2FA-bypass granular tokens to *around January 2027*. The observed behaviour
  on 2026-09-15 was neither: an ordinary `npm publish` with a granular token,
  landing in a stage, four months before the documented enforcement.
- **A per-package 2FA requirement is the most plausible remaining mechanism
  and cannot be checked from here.** `npm access set mfa=none|publish|automation`
  is settable per package, but nothing reads it back: `npm access get status`
  returns only `public`/`private`, and it returned `public` for all seven.
  So a per-package setting is neither confirmed nor excluded.
- **If it recurs, the measurement that would settle it** is the package's own
  settings page on npmjs.com, read by the owner -- the 2FA requirement is
  visible there and nowhere the release credential can reach.

Whatever the trigger, the publish path no longer depends on the answer: a
version that is not resolvable for a consumer blocks the wrapper, whether it
is staged, slow, or absent.

## The wrapper publish is gated on a CONSUMER-side read

Added by QCLI-299, after the failure above. Write order does not produce
visibility order, and on 0.7.0 the two disagreed in four of six positions.

`scripts/publish-release.mjs` publishes the six platform packages, then
**blocks until every one of them resolves from a read that is not the
publisher's** -- plain HTTPS to `registry.npmjs.org` with no credential and no
npmrc -- and only then publishes `@opum-ai/quest`. A package that resolves and
then stops resolving drops back to not-visible rather than counting, because an
installer hitting the stale CDN edge is in exactly that state.

**The second sense of publisher blindness, which is the one that survives
fixing the gate's position.** opum-cli-e2e timed 9-20 seconds between a
package's registry `time[0.7.0]` and its first resolution from a non-publishing
npm client, across five packages, bounded above by their 10s poll granularity.
A publisher-side poll therefore reports ready while an installer still resolves
the previous version -- so the gate holds a 30s settle margin after the last
package appears and re-reads before proceeding. Two distinct blindnesses, and
the release needs both handled: the publisher cannot see a stage it created,
and the publisher sees a publish before consumers do.

When the gate does not pass, the wrapper is **not** published -- so the failure
is a release that did not happen rather than one that installs and leaves no
binary -- and the script prints each unresolved package's state read from the
public registry at that moment. `--diagnose-staged` adds the one thing a read
cannot do: it re-attempts the publish, where a 409 "previously staged" means
staged and a success means it never landed. That costs a write, which is why it
is a flag and not part of the poll.

### What "verified" means at the end of a publish

The wrapper gets the same consumer-side read, after its own write (QCLI-304).
The script prints `Published @opum-ai/quest@<v>. Verified:` only after all
three of these pass, in this order:

1. the six platform packages match the qualification receipt
   (`waitForPublished`);
2. all seven tarballs npm serves have the qualified bundle's integrity
   (`verifyRegistryHoldsBundle`, through npm's own client);
3. `@opum-ai/quest@<v>` resolves from the plain anonymous read above and is
   still there after the 30s settle margin (`waitForConsumerVisibility`).

The line names each object next to its check. If the third check does not pass
inside the window, the script exits 1 saying the release is NOT verified yet,
prints the wrapper's state, and warns against `npm unpublish`. The code is
`verifyPublishedRelease`, and
`test/qcli304-wrapper-post-publish-verification.test.ts` makes the lag happen
through the real read.

**Why the third check exists: 0.7.1, 2026-09-15.** The script printed
"@opum-ai/quest 0.7.1 published and verified (1 check)" and exited 0. Seconds
later, at 16:03:02Z, `npm install -g @opum-ai/quest@0.7.1` failed with
`notarget`. A plain read of `registry.npmjs.org/@opum-ai/quest/0.7.1` returned
"version not found", and the packument still showed `latest` at 0.7.0. The
wrapper first resolved from a plain read at 16:04:06Z, about a minute after
"verified" (packument `time.modified` 16:03:39Z). The first two checks read
through paths that see a write before the public read does. So they cannot
be the last word on whether a consumer can install.

## lore and quest publish at one version, or not at all

Constitution Article 3 clause 6, QCLI-386. Before anything else, and in dry
runs too, both publishers compare this checkout's `package.json` version with
`@opum-ai/lore`'s `package.json` on `opum-ai/lore-cli`'s `main`, read through
the GitHub contents API. They refuse on a mismatch, and on any failure to read
the peer: a 404, a network error, something that is not lore's manifest, or a
missing version. The local publisher does this inline. `release.yml` runs
`node scripts/qualification/version-parity.mjs --require` before its first
`npm publish`, and the same command answers the question on its own. lore-cli
runs the mirror check against `quest-cli`.

It reads `main`, not the registry or a tag, on purpose. With the registry,
whichever side stages first would see the other still on the old number, so
neither could ever go first. A tag would force a tag order across the two
repositories. So a paired release promotes both `dev` branches to `main` at
the shared version before either side publishes. There is no override flag.
Changing the rule means amending Article 3.

## Stage, qualify, promote: `latest` moves last

Constitution Article 3 clause 5 (opum-agent `docs/reference/opum-project-constitution.md`,
ratified 2026-09-27) and QCLI-385. lore and quest release as a pair, and a
publish no longer moves `latest`:

**The root launcher is the one exception to "`latest` moves by dist-tag"**
(QCLI-399; Article 3 clause 5 as amended by ODOC-302, read at opum-doc
`f322cff`). npm derives a package page's readme only when a version is
published onto `latest`, never on a dist-tag move, so every launcher before
this change shipped with an empty packument readme. So `@opum-ai/quest` stages
as `X-rc.N` and reaches `latest` by a fresh publish of X. The qualified rc and
the published X may differ only by the version string. That is checked
mechanically: both are unpacked and compared entry by entry, with the same
paths, the same modes, and the same bytes once every `X-rc.N` in the rc
becomes X (`scripts/qualification/launcher-equivalence.mjs`). The check runs
when the bundle is built, when it is staged, and twice more at promotion,
against the rc npm serves. `package.json` on `dev` and `main` stays at X. The
rc is the next unused `X-rc.N` on npm, because a published rc cannot be
reused (`--launcher-rc <n>` on `build-candidate-bundle.mjs` overrides it). The
six platform packages are unchanged. The flow is paired with lore-cli's
LCLI-621, and the receipt fields are opum-cli-e2e's (TASK-126,
`receipts/README.md` "Root launcher rc-staging").

1. **Stage.** Both publishers (`scripts/publish-release.mjs` and
   `release.yml`) run every `npm publish` with `--tag release-candidate`: the
   six platforms at X, then the launcher at the bundle's `X-rc.N`. A
   bare `npm publish` would move `latest` as a side effect, so the local
   publisher builds every argument list through one `publishArgs` helper, the
   `--diagnose-staged` re-attempt included, and
   `test/qcli385-stage-under-release-candidate.test.ts` fails on a tagless
   publish in either file. After staging, `latest` still names the previous
   release, and `npm install @opum-ai/quest@release-candidate` installs the
   new one: the rc launcher, which pins the platforms at exactly X.
2. **Qualify.** opum-cli-e2e qualifies the staged lore/quest pair from clean
   registry installs. That is a second pass, after the bundle receipt the
   publisher already required (see "Publishing locally when CI cannot").
3. **Promote.** Only on the orchestrator's go after that PASS, quest first and
   then lore:

   ```sh
   node scripts/promote-release.mjs --record <path> --qualification-run <run-id>             # dry run
   node scripts/promote-release.mjs --record <path> --qualification-run <run-id> --promote
   ```

   `--qualification-run` is the same run the publisher staged from. The
   script downloads that run's `quest-candidate-bundle` again, because the X
   launcher that publishes is the bundle's `final/` tarball. It gates the
   bundle on the pass-1 receipt against the commit the `v<version>` tag peels
   to, exactly as the publisher did. The bundle artifact is kept for 90 days,
   GitHub's maximum. Promote before it expires: after that, the only way
   forward is a new qualification run, which takes `rc.N+1` and needs both
   receipts again.

   It refuses, dry run included, unless opum-cli-e2e's pair receipt
   `receipts/pair/<version>.json` on its `main` qualifies this pair (QCLI-388,
   opum-agent ruling A on OPAG-465; schema in opum-cli-e2e's
   `receipts/README.md`, "Pair receipts"). The receipt must be `QUALIFIED` or
   carry a four-field override, which is printed verbatim. It must name quest
   and lore at this one version, with `pair.quest.commit` equal to what the
   tag peels to, and installs from the registry. `pair.quest.launcherVersion`
   must be the bundle's `X-rc.N`. The launcher entry is keyed and read at
   that version, the platforms at X. All seven `distIntegrity` values must
   equal what npm serves at that moment. A relayed "it passed" is not a
   substitute. `--rollback` is not gated on the receipt.

   It then reads all seven packages' dist-tags anonymously and refuses unless
   `release-candidate` is X on every platform and `X-rc.N` on the launcher.
   It downloads the rc npm serves, requires it to be the bundle's rc byte for
   byte, and requires `final/`'s X to equal it with only the version
   substituted. It writes each package's prior `latest` to `<path>`, then
   moves `latest` on the six platforms by dist-tag. It runs the download and
   the substitution check again, then runs `npm publish final/<X>.tgz --tag
   latest`. That is the only publish in the pipeline that does not stage, and
   the qcli385 test holds it to one call site. It passes only when an
   anonymous re-read shows `latest` at X on all seven and npm serves X with
   `final/`'s integrity. A rerun after X already landed confirms npm holds
   those exact bytes, then moves the tag instead of republishing. The record
   is written once: a rerun reuses it rather than re-reading priors, because
   after a partial move the registry's `latest` is already the new version.
   Keep the file until lore's promotion has also succeeded. After the first
   release under this flow, `npm view @opum-ai/quest readme` should be
   non-empty. That is QCLI-399's AC3, and it can only be measured then.

   Once `latest` is verified, the same run cuts the GitHub Release
   `v<version>`, titled `Quest CLI <version>`, from this version's
   `CHANGELOG.md` section **at the commit the tag peels to**, and marks it
   latest (QCLI-398; read at the tagged commit since QCLI-407). The section is
   read through the GitHub API at that commit and never from the working tree,
   so an uncommitted edit -- or a line landed on `dev` after the tag -- cannot
   become the body of a release. That is also why step 5 folds the changelog
   into the commit it tags: the tag is what the notes are read from. It
   refuses before any tag moves, dry run included, if that section is missing
   or empty, or if `gh` cannot read the release (not installed, logged out,
   offline). If only the release step fails, `latest` has still moved. Do not
   roll back; repair it with `node scripts/github-release.mjs --version
   <version> --create`. That script never creates a tag and never rewrites an
   existing release's notes. GitHub Releases had stopped at v0.6.0 because no
   step cut them. v0.6.1 to v0.11.0 were backfilled on 2026-09-27, so every
   tag has one.

   **Since QCLI-407, a section that is missing at the tagged commit is not
   repairable by adding one and re-running**: the tag exists and is immutable
   by the time the refusal can fire. The remedies are the hand cut above, or a
   re-tag -- and the hand cut is listed first deliberately, because a re-tag
   moves a tag that published pages read live (see the tag-stability note
   above), while a hand cut touches the release and nothing else. The same
   re-sourcing moved what the existing-release check compares, so a release
   cut or backfilled from a working tree that differed from its tag no longer
   matches its tag's section: four of the 2026-09-27 backfill (0.6.1, 0.6.2,
   0.7.0, 0.8.0) are in that state, and 0.6.0 has always differed -- it
   predates the backfill and the tool, its tag's section still matches the
   file, and its body is an out-of-band provenance record. The decision
   (QCLI-410, 2026-09-29) is that **each of the five keeps its stored body**:
   every difference is text authored after its tag -- 0.6.1's and 0.8.0's
   "tagged, never published" publish histories, 0.6.2's added entries and
   known-limitations section, 0.7.0's post-release observation, and 0.6.0's
   provenance record, which replaces its section entirely (its body says this
   tag does not point at the commit that produced the published artifact, and
   to prefer the npm version over the tag). Reconciling any body to its tag
   would delete that text and state something the tag could not know.

   `node scripts/github-release.mjs --version <version>` therefore **reports**
   each of the five by name and reason (`BY RECORDED EXCEPTION (QCLI-410)`),
   edits nothing, and does not mark them latest; there is nothing to repair.
   The recorded set is a closed table in `scripts/github-release.mjs`, and
   adding a version to it is a deliberate edit there. Any other release whose
   notes differ still refuses and still names the tagged-commit bytes. Nothing
   in the release flow reaches those five versions, so this is the whole
   operator-visible behaviour for them.
4. **Roll back the tags, never the versions.** A failure part way through
   restores the tags that run moved, the launcher's included. A failed or
   refused launcher publish moves its `latest` back to the prior version by
   dist-tag. Once X is published, it stays on npm. If lore's promotion fails
   after quest's succeeded, restore quest too:

   ```sh
   node scripts/promote-release.mjs --rollback <path>
   ```

   The rollback refuses unless every package's current `latest` is the
   release or its recorded prior value, and every recorded prior value must
   be a version other than the release (QCLI-390). So it can only undo that
   record's promotion. A mid-way failure restores the failed package as well,
   because its write may have landed before the error.

   Then retry at the same version. Never unpublish, and never skip the failed
   side to a different number.

   `--rollback` does not touch GitHub Releases, so the promoted run's
   `v<version>` release still says Latest after it. Retrying at the same
   version fixes that, because the rerun marks the existing release latest
   (true for the version being promoted; the recorded legacy releases above
   are never marked latest, and no run reaches them). If the version is
   abandoned, move Latest back yourself:
   `gh release edit v<prior> -R github.com/opum-ai/quest-cli --latest`.

Auth for promotion is the publisher's: the stored token, else `--otp`. Moving
a dist-tag is a registry write and needs the same owner authorization as a
publish.

## Rollback

Before publication, discard only candidate artifacts and keep the evidence
showing that nothing was released. After publication, preserve the immutable
version, integrity values, source commit, and verification record. Do not
claim an unpublished candidate is available, overwrite published history, or
quietly replace an artifact. If withdrawal or deprecation is required, obtain
separate owner authorization and document the registry's actual state.
