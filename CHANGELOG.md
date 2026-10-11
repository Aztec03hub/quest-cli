# Changelog

Records start here, at 0.5.0. Earlier releases are documented in
`docs/reference/quest-cli-release-truth.md` and in each release's own PR
history; this file is the forward-looking record.

Each version heading is dated with the UTC day `@opum-ai/quest` reached npm, read
from the registry's `time` field. 0.6.1 and 0.8.0 never reached npm, so each is
dated by its own tag. No date here is inferred (QCLI-398).

## Unreleased

### Added

- **`task list --across-refs` reports a genuine id collision distinctly from a
  status conflict, as a per-entry `identity` field** (QCLI-432; the shape is
  final, opum-doc 565 / DEC-172 (4u)). The field is `task` when every state of
  an id carries the same `createdAt` (one record read from several refs),
  `collision` when the states carry two or more distinct `createdAt` values
  (different records that happen to share an id -- the window the refs-aware
  allocator leaves open when two checkouts each create before either commits),
  and `unresolved` when a state carries no `createdAt`, so the two cannot be
  compared. **A consumer that must detect two different records sharing an id
  MUST read `identity`**: `conflict` reports only status divergence WITHIN one
  task and cannot tell a collision from one task whose states disagree.

- **`task status-flow`'s `data` gains `pausedStatusConfigurable`** (QCLI-325;
  opum-doc relay 570, DEC-172 (4af)): emitted beside `pausedStatus` as `false`
  while the paused status is a built-in literal that no user-reachable knob
  sets, so a consumer can read the situation from the output alone. A docs and
  wire-field change only -- `pausedStatus` itself is unchanged, and the three
  prose sites that read as a promise of a workspace knob now state the real
  behaviour.

## 0.13.0

### Added

- **The opum-quest plugin ships the Quest board: a pane listing the tasks in
  flight across your Quest workspaces, editable in the session's own
  repository** (QCLI-431, from the operator's instruction of 2026-10-02 tracked
  in opum-agent as OPAG-1074). The plugin is cut from this repository at the
  CLI's own tag, so the board arrives with this version rather than separately.
  The pane discovers its repository set from the plugin's `userConfig` instead
  of a hardcoded roster, always including the session's own repository, and
  offers the repository-true read (`quest task list --across-refs`) as a toggle
  that draws cross-ref disagreements and incomplete coverage as such rather
  than as an empty result. A write happens only in the session's own
  repository, through Quest lifecycle commands, with an explicit actor on every
  write -- the person, `--actor <configured id> --actor-kind human`, from the
  plugin's `actor` option, per DEC-134 (A) -- and `--if-revision` on field
  edits. The repository's own check suite runs the module's tests, so a failing
  mod test fails the gate rather than passing unrun. Design record:
  `docs/reference/quest-board-hooks-module-in-the-opum-quest-plugin.md`.
- **The Quest board takes the full screen, on `z` or the dashboard tool's
  `full`** (QCLI-435, from an operator instruction relayed by opum-doc as seq
  164).
  Full mode reopens the pane at the largest size the surface allows: docked it
  asks for the viewport's width less a transcript margin, so the conversation
  stays visible beside it, and inline it asks for the height less the prompt
  area. Both are asked for in one call, because the dock ignores `rows` and the
  inline block ignores `columns`, so neither has to guess which shape it will
  be given. The choice is stored with the pane's other settings and restored at
  the next session. From 120 body columns the board draws the list and the
  detail side by side rather than the detail below the list. `c` still
  collapses to the rail, which stays a third state beside normal and full. When
  the surface keeps a size the person dragged instead of granting the one
  asked for, the pane says so on one line rather than claiming a size it did
  not get.

- **The Quest board opens through a tool Claude calls,
  `mcp__opum-quest__dashboard`** (QCLI-441, from opum-doc's pane dashboard tool
  design, seq 174). The mod registers it at `session.start` and serves it from a
  `tool.call` hook, and every input is optional: `scope` (`fleet` or `local`),
  `full`, and `task`, a task id to open in the detail view. It opens the pane
  WITHOUT focus, because Claude may call it unasked while the person is typing —
  the same rule a full mode restored at `session.start` follows. It reports bad
  input rather than guessing: an unknown task id comes back as an error result
  naming it, with nothing opened in its place, and a task id is resolved against
  every Quest workspace on the board rather than assumed from the current view,
  so a Done task or one outside the current scope is still found.

- **The `opum-quest` plugin ships a `migrate-from-backlog` skill**, so a
  Backlog.md project can be moved into Quest from inside Claude Code instead of
  by hand (QCLI-436, from the same operator instruction). It drives
  `quest migration backlog` through preview, apply, status and rollback, and
  stops at each write for the person to approve with `AskUserQuestion`: once to
  choose whether the records keep Backlog's own ids or take Quest's, and once to
  approve the exact digest that was just previewed. The apply is recorded as the
  approving person (`--actor-kind human`), not the agent. The skill never
  deletes `backlog/`, never commits — it hands the records to the repository's
  own branch-and-PR flow — and never applies a digest other than the one just
  previewed. The `quest` skill carries a one-line pointer to it.

- **The Quest board toasts the changes worth interrupting for** (QCLI-442, from
  the operator's instruction relayed by opum-doc as seq 175). A decision
  becoming `proposed` and its resolution, a task moving to Paused or Closed, and
  a high-priority task reaching Done each raise a toast; everything else waits
  in the pane rather than interrupting. More than three changes in one check
  collapse into a single batched toast, and decisions are never folded into it.
  While any decision is proposed a status-line entry — `Quest: N decisions
  waiting` — stays up, because a toast can be missed and the status line cannot.
  The check runs every two minutes whether or not the pane is open, looks a task
  that left the open set up once with `quest task view` to tell Done from
  Closed, and keeps the last state in the plugin's store so nothing replays: the
  first check after install records a baseline and shows nothing, and changes
  that happened while no session was running arrive as one "while you were away"
  summary. A repository that cannot be read is skipped quietly rather than
  toasted about. A new `alerts` setting takes `all` (the default), `decisions`
  or `off`.

### Changed

- **The Quest board is named "Quest", says what a kept width is doing on the
  draw that asks, and its toggle shows the current size** (QCLI-459, from the
  operator's re-test of 2026-10-03 relayed by opum-doc as seq 243). The pane
  title, the tool's lines and the band read "Quest" rather than "Quest board".
  The held-width line ("Width kept at N (you set it): drag the pane edge to
  change") no longer waits for a draw after the full ask: a surface that keeps
  the width a person set has no reason to repaint the pane, and on that draw
  the line went missing; it now renders on the ask's own draw, and a surface
  that grants the ask still clears it on the answering draw. The full toggle
  reads the current mode as state with the key as its hint -- "Normal · z for
  full" / "Full · z for normal" -- because the old "Normal size" named the
  action and read as the current size.

### Removed

- **The Quest board has no slash command any more** (QCLI-441, from opum-doc's
  rulings relayed by opum-agent as seq 176 and seq 180). A command named `quest`
  was tried first and the engine refused it — `/quest` is the plugin's own
  `/opum-quest:quest` — and a refused registration threw the whole
  `session.start` hook, so the mod never initialised; the board ends with no
  slash command at all, `quest-board` included. The board's words are the
  skill's job instead, and the routing is one prefix test rather than a verb
  table: the generated `quest` skill opens the pane for `quest dashboard`,
  reading whatever follows it (`full`, `fleet`, `local`, a task id, or several
  of those) into ONE `mcp__opum-quest__dashboard` call, and sends every argument
  that does not start at `dashboard` — `quest board` included, which the CLI
  already serves as its own board — to the `quest` CLI as before. Where the tool
  is unavailable — Claude Code older than 2.1.287, a `claude -p` run, or mods
  off — the skill says the pane is unavailable there and answers from the CLI.

### Post-release correction (added 2026-10-07)

- **A workspace that installs quest 0.13.0 sees `quest agents --check` report
  DRIFT until it runs `quest agents --update-instructions`** (QCLI-436's
  `migrate-from-backlog` pointer in the generated `quest` skill; recorded as a
  required release note on QCLI-433 under opum-doc ruling seq 167). This is a
  generated-content change, not a version-only one, so `--check` exits 6 rather
  than taking the version-only path that exits 0 — a step not yet taken, not a
  fault. Remedy, for the workspace's own target: `quest agents
  --update-instructions --target <claude|codex|antigravity>`. Added here after
  the v0.13.0 release, having been missed in the release notes at ship time
  (QCLI-467).

## 0.12.0

### Changed

- **The pinned bun moves to 1.4.2, and a check holds the pin to the behaviour
  that motivated it** (QCLI-411, from opum-agent OPAG-734). Bun 1.3.14
  silently STRIPS a top-level binding named `declare` in a TypeScript file —
  `function declare(v) {...}; declare('x')` prints nothing and exits 0 — so a
  test helper of that name would never run while the assertions around it
  passed vacuously. The upstream fix landed in 1.4.0. `package.json`'s
  `packageManager`, `@types/bun`, and every `oven-sh/setup-bun` step across
  the workflows now pin 1.4.2, and `bun.lock` was regenerated with 1.4.2
  itself, so CI's frozen install compares against a lockfile written by the
  runtime the pin names. `test/qcli411-bun-declare-binding.test.ts` asserts
  every pin is >= 1.4.0 — discovering workflows rather than listing them, so a
  new one with a stale pin fails — and runs the repro through
  `process.execPath`, the runtime actually running the suite. The committed
  `npm/*` platform binaries were still 1.3.14-built when this landed; the
  0.12.0 bump is the release step that carries the pin into the shipped bytes.

- **The staging hint now names the right destination for all four relocating
  commands** (QCLI-412, completing QCLI-311). `task complete` was the only one
  carrying it, but `close` and `archive` also move a record out of
  `.quest/tasks/` and `demote` moves one back, and each carries the same
  hazard: an unstaged rename, where a repo-wide `git add -A` also stages
  unrelated deletions. The destination is read from the mutation's own
  `relocatedTo` rather than from a command-to-directory table, because three
  destinations are involved — `.quest/completed/`, `.quest/archive/tasks/` and
  back — and a table would name the wrong one for `archive` and `demote` while
  looking correct for the two that share the first. A `demote` that stays put
  prints nothing, because no rename happened to stage.

- **The `source-gates` push paths include `README.md` and `LICENSE`**
  (QCLI-377). `source-gates` runs `scripts/check-package-artifacts.mjs`, which
  reads both — the README as the packed page's version-claim content gate, the
  LICENSE as a presence gate on the root pack's exact file list — so a push
  touching only one of them fired no push-triggered run and left no row on
  that `dev` SHA for a fast-forward promotion to consume before a PR exists.
  No gate changed; `pull_request` stays unfiltered, so a PR still gets its row.

- **A scheduled detector reports a lore pin that has fallen behind npm**
  (QCLI-358, ruled in opum-doc's ADR "Detect a stale lore pin without touching
  a required CI context"). The `lore check` gate runs AT the pinned version and
  compares the committed schemas against what that version generates, so it is
  self-consistent by construction and stays green as the pin falls behind —
  nothing inside the run can know a newer lore exists. The pin sat at lore
  0.7.0, which had no schema-drift detection at all, while a required context
  reported success on a class it could not represent.
  `scripts/lore-pin-staleness.mjs` exports the schemas under both versions, so
  it can tell behind from behind-and-schema-changing, and keeps one
  `lore-pin-stale` issue in step with that answer. It runs from its own weekly,
  non-required workflow and opens one issue rather than failing anything: a
  network read inside a required context would make that context flaky, and a
  flaky required check teaches people to re-run until green.

- **The task-creation guide warns against a count that goes stale inside an
  acceptance criterion** (QCLI-351). A criterion like "the three leaked
  daemons are reaped" stays clear and stops being true once a fourth starts.
  `quest instructions task-creation` now says to write such a criterion so it
  enumerates when it is checked, and says why. A count of what the task itself
  produces is still fine. This is guide prose only: nothing validates or
  rejects digits in a criterion.

- **The root launcher reaches `latest` by a fresh publish, so npm shows its
  readme** (QCLI-399; constitution Article 3 clause 5 as amended by ODOC-302,
  opum-agent OPAG-474). A dist-tag move never makes npm derive a packument
  readme, so every `@opum-ai/quest` release so far has shown an empty package
  page. The launcher now stages as `X-rc.N` under `release-candidate`, and
  opum-cli-e2e qualifies it there. `scripts/promote-release.mjs` then
  publishes the X launcher straight onto `latest`, from the same qualified
  bundle. The six platform packages still stage at X and move `latest` by
  dist-tag. The rc and X launchers may differ only by the version string.
  `scripts/qualification/launcher-equivalence.mjs` checks that by unpacking
  both and comparing every entry's path, mode, and bytes after substitution.
  The check runs when the bundle is built, when it is staged, and twice at
  promotion against the rc npm serves: before any tag moves, and just before
  the publish. Both receipt readers take opum-cli-e2e's TASK-126 fields:
  `launcherVersion`, and pass 1's `launcherSubstitution` (`MATCH`, and the X
  launcher's sha256). An override does not waive the substitution.
  `promote-release.mjs` now requires `--qualification-run <id>`. A failure
  restores every `latest` this run moved by dist-tag, the launcher's
  included. Paired with lore-cli LCLI-621. Release tooling only.

- **`task edit --if-revision` is scoped to the record it guards, not to the
  whole workspace** (QCLI-310; reported by the mbpm2 project via opum-agent,
  and reproduced here first-hand on 0.11.0). `task view --json`'s `revision`
  was a sha256 of the ENTIRE store -- every task record and every draft -- and
  `--if-revision` compared against that same value. So writing any task
  invalidated the captured revision of every other one, and a guarded edit of
  a record that had never moved was refused with exit 5. In a workspace with
  two unrelated tasks: capture T-1's revision, edit T-2, then edit T-1 with
  the captured revision -- refused. That is the exact concurrent-session case
  the flag was built for. `task view` now emits a per-record revision and
  both guards compare against it, so the pair round-trips; a `task edit-batch`
  item's `ifRevision` is scoped the same way, and its help sentence -- which
  described the whole-batch comparison -- now describes the record's own
  revision.

  **This restores the documented scope rather than changing it**, which is why
  it is a fix and not a redesign. QCLI-277's own acceptance criteria ("apply
  this edit only if THE RECORD is still at the revision I read"), the
  `task edit` help text ("if the record has moved since"), the tracker
  contract's docblock, and the release note that introduced the flag all say
  per-record. The implementation never did, and no test pinned the
  workspace-wide reading as intended -- it was a mechanism a source comment
  described, and the two-task reproduction above is what it produced.

  Two values are deliberately NOT narrowed, because they are the write path's
  own coordination machinery rather than a caller-capturable precondition: the
  repository's internal `expectedRevision` CAS (still the workspace revision,
  still under the write lock), and `task edit-batch`'s reported
  `data.revision` (the workspace revision the batch committed at, pinned since
  QCLI-122 and read by opum-cli-e2e's scale progress line). A relocation
  between `tasks/`, `completed/` and `archive/tasks/` does move a record's
  revision, since `task view` reports the derived `path` beside it.

  **A consumer that read `revision` as a workspace-change detector loses
  that**, and it is worth naming even though no contract promised it. lore-cli
  states the old scope in a comment (`src/commands/link.ts`, "WORKSPACE-WIDE
  (measured on 0.10.0 and 0.11.0)") and asserts it as a positive control in
  `test/link-quest-race.test.ts` -- both describe the previous implementation
  and need updating before lore-cli picks this up. Its decision logic does not
  depend on it: lore-cli already declines to decide on revision movement
  alone, and a narrower hash strengthens rather than weakens that choice.

- **A completion now names the scoped `git add` its commit needs, and the
  guide says why a repo-wide `git add -A` is the wrong flag for it** (QCLI-311,
  ruled 2026-09-29, option 2; requested by lore-cli after the 2026-09-15
  incident here). `task complete` relocates the record from `tasks/` to
  `completed/` and nothing stages that rename, so reaching for a repo-wide
  `git add -A` also stages any unrelated tracked file merely missing from the
  working tree -- which is how a "tracker-only" commit once also deleted
  `npm/quest-darwin-arm64`, caught only by the package-artifact gate. The
  human-readable output of `task complete` now closes with the record's new
  path and the scoped form, `git add -A .quest/`, and
  `quest instructions task-finalization` gains a section naming both record
  paths, the `git diff --cached --name-status` check before committing, and
  the half-staged result of `-u` or a lone path. The JSON envelope is
  unchanged: a machine-readable field for this is a contract change and was
  ruled out of this slice.

### Added

- **`quest task list --across-refs` gives one read-only view over `origin/dev`
  and the head of every open PR into it** (QCLI-417; DEC-40 accepted shape,
  opum-doc ODOC-330). It answers the question QCLI-316's `scope` field could
  only point at: an empty or filtered answer becomes a claim about the
  repository rather than about this checkout, whose `.quest/` is whatever the
  checked-out branch holds. One entry per task id —
  `{id, title, proposedBy, conflict, states}` — with each state carrying
  `refProvenance {ref, pullRequest, sha}`, `pullRequest` as `owner/repo#N` for
  a PR head and `null` for `dev` or an explicitly named ref, and the full
  40-hex commit actually read. An id whose states disagree lists every state
  and sets `conflict` true; no winner is picked.
  `coverage {complete, population, discoveredAt, refsRead, refsUnreadable}` is
  a top-level key after `data` and before `principal`, superseding `scope`
  here, and `complete` is true only when every planned ref was read without
  error — a read of ZERO refs is never complete. Exits: 0 complete, 6
  (`drift`) on incomplete coverage with the unreadable refs named in the
  message and stdout empty, 3 when `origin` or `origin/dev` is absent, 2
  usage, and never 5 — a status conflict is data, not a command conflict.
  `--allow-partial` downgrades the 6 to 0 with `complete` false and the same
  refs named; it does not downgrade a zero-ref read. Discovery is
  `gh pr list --state open --base dev` behind an injectable seam; `dev` is
  read at the SHA `git ls-remote` reports, never the possibly stale local ref,
  objects are fetched with a bare refspec only when absent, and `--ref`/`--pr`
  replace discovery with an explicit population.

- **A new `check` command fails when a change drops a task record other work
  still references** (QCLI-415, DEC-18). `quest check --continuity --base
  <ref>` resolves every record id and alias present at the merge base of
  `<ref>` and HEAD against the current store, reading `.quest/tasks`,
  `.quest/completed` and `.quest/archive/tasks` at the base through a new
  `GitPort.mergeBase`, so a relocation between them is not a loss. It reports
  its counts — records, references, resolved, missing — and a base read of
  ZERO records is exit 6 rather than a pass, which is the positive control. A
  vanished id is named in the message and not only in the structured field.
  `--continuity` is required rather than implied, because the CI consumer
  copies one line into each job. Drafts are out of scope in both directions:
  `draft promote` removes the draft record by design while minting a new id,
  so including them would make every promotion a false positive. Measured on
  this repository from its initial commit, 521 of 521 references resolve, 259
  of them migration aliases.

- **Workspace-configured `type` and `priority` vocabulary** (QCLI-330; opum-doc
  ADR "Make quest's type and priority vocabulary workspace-configured, with a
  canonical default" at `main` 34b4b2d, amended by ODOC-318 with the
  unconfigured-workspace ruling). Both fields were free strings with no
  control at all. A workspace can now declare `types` and `priorities` in a
  `[tasks]` table in `.quest/workspace.toml`. `quest init` writes the
  canonical default: types `feature`, `bug`, `chore`, `docs`, `enhancement`,
  `spike`, and priorities `low`, `medium`, `high`, `critical`.
  - `task create`, `task edit` and `task edit-batch` check only a value the
    write actually carries. A case-only difference is stored in the
    configured spelling. Any other value exits 6, nothing is written, and
    `input.allowed` lists the set. In a batch, only the offending item fails.
  - `quest manifest --json` reports the set as `data.taskVocabulary`, with
    `null` for an open field and never an empty list.
  - `quest doctor` reports each stored value outside the set as
    `task_vocabulary_off_set` (id, field, value, and `normalizesTo` when only
    case differs), in every location, and rewrites nothing.
  - **A broken `[tasks]` table fails closed on writes and never breaks a
    read.** It is read from the parsed TOML, so `[ tasks ]`, `["tasks"]`, an
    inline `tasks = {...}` and dotted `tasks.priorities = [...]` all count as
    configured. A table that cannot be read -- bad TOML, a non-table, an
    empty list, or a table declaring neither `types` nor `priorities` --
    makes `task create`, `task edit` and `task edit-batch` exit 6 with the
    problem. The other writes (`task complete`, `close`, `start`, draft
    create/promote) carry no type or priority value of their own and
    deliberately carry on; `task list`/`view`, `manifest` (which lore-cli
    probes with) and `doctor` also carry on, with doctor reporting the table
    as `task_vocabulary_invalid`. Unrelated configuration errors, like a bad
    `agents.skill_source`, never leak into the vocabulary, and a bad
    skill_source cannot mask a broken table into reading as open.
  - **An existing workspace is unchanged until it opts in.** With no `[tasks]`
    table, both fields stay open: no write is refused and doctor reports
    nothing. Backlog migration is never validated, so imported values are
    preserved verbatim. `quest init --reconfigure`, now accepted bare, adds
    the default to a workspace that configures neither field, never changes
    a configured set, and writes nothing at all when nothing would change --
    comments and unrecognized tables survive a no-op run.
  - Status is still not read from `workspace.toml`. This is the first
    vocabulary a workspace configures, not a second use of an existing
    mechanism.
  - quest-cli's own workspace adopts the default. Its doctor now reports its
    11 historical `type = "task"` records and 4 case-only priorities, as
    written. The 11 are left as history rather than folded: `task` names no
    work-kind distinction (every record is already a task), so the value was
    a free-string artifact of this repo's old workflow, and rewriting Done
    records to remove it would falsify them -- the fleet's own
    retirement-scope convention. Doctor reports them; nothing corrects them.

- **A second terminal status, "Closed", for work whose outcome did not
  happen** (QCLI-331; opum-doc ADR
  `add-a-second-terminal-task-status-for-duplicate-superseded-and-wont-do-outcomes`).
  Retiring a never-worked duplicate used to mean stepping it through
  In Progress to Done, recording a start and a completion that never
  happened. `quest task close <id> --resolution <duplicate|superseded|wont-do>
  [--survivor <id>] [--final-summary "text"]` now retires it directly from
  To Do, In Progress, or the paused status. It refuses from Done or Closed.
  The resolution is required and is stored on the record as
  `resolution: {kind, survivor?}`. `duplicate` and `superseded` require
  `--survivor`. It must name an existing task other than this one, and it is
  stored by canonical id. A survivor that names no task exits 3, and one that
  names the task itself exits 6. `wont-do` takes no survivor. The record moves
  to completed/, with envelope kind `task.closed`. Blocking gates do not hold
  it, because it claims no completion. `quest task demote` reopens a Closed
  task to any non-terminal status and withdraws its resolution.
  `task edit --status Closed` and a `resolution` edit patch are refused. The
  To Do -> Done refusal now names `quest task close`.
  `task status-flow`'s `data` gains `closedStatus` and `resolutions`.
  `terminalStatuses` is unchanged: it still lists only the ladder's terminal
  statuses and stays a subset of `statuses`, because every published lore-cli
  refuses the tracker as drift otherwise. **A consumer must read `closedStatus`
  alongside `terminalStatuses` to know every terminal status**, and must not
  compare a status to `"Done"`. `terminalStatuses` will gain `"Closed"` in a
  later release, once a lore that tolerates it is the floor. The manifest
  advertises `task close`. The advertised field lists of `task status-flow`
  and `task view` are unchanged, because the tracker adapter's probe matches
  them exactly. Inside quest, Closed counts as terminal: `task list --ready`
  treats a Closed dependency as satisfied, and `task list --status Closed`
  finds closed tasks. `quest doctor` reports three inconsistent shapes, and
  never rewrites them, under two new issue codes. `task_resolution_invalid`
  covers a Closed record whose resolution is missing or malformed, and a
  resolution on a record that is not Closed. `task_resolution_survivor_not_found`
  covers a survivor that names no task. The task-finalization and overview
  guides say when to close rather than complete. The change is prospective:
  records retired by the old workaround are not rewritten or migrated, and a
  record without `resolution` reads and round-trips unchanged. The heading
  is non-breaking: no existing command, field, or exit code changes. Only two
  refusal messages change wording, to name `quest task close`.

- **A breaking CHANGELOG section can no longer ship under a patch bump**
  (QCLI-328; opum-doc ADR
  `gate-release-prep-on-a-breaking-changelog-entry-at-a-patch-bump`). The
  motivating case is 0.6.2. Its entry correctly called its envelope change
  breaking, and it shipped as a patch, so the version number gave consumers
  no signal. `bun run check:breaking-bump` now runs as a source gate. It reads
  the notes for `package.json`'s version: `## <version>`, or `## Unreleased`
  on the bump PR before the changelog is finalized. It fails when those notes
  carry a `### ... (breaking)` heading and the bump from the previous version
  heading is patch-level. `--next <x.y.z>` checks a proposed number during
  release prep. lore-cli mirrors the check. Release tooling only.

- **The breaking-bump check reads lore-cli's CHANGELOG too, because the pair
  shares one bump** (QCLI-403, same ADR). A breaking heading in lore's notes
  for the paired version now refuses a patch-level bump of the pair, even
  when quest's own notes carry none. `bun run check:breaking-bump:pair`
  resolves lore-cli's `main` (or `--lore-ref <ref>`) to a commit and reads
  `CHANGELOG.md` at that commit through the GitHub API. It accepts lore's
  bracketed `## [x.y.z]` and `## [Unreleased]` headings, and it prints the
  ref, the SHA and the section count it read. It fails closed: an unreadable
  file, or one with no version section, refuses. `release.yml` runs it after
  the version-parity gate and before the publish. The quest-only source gate
  is unchanged and stays offline. Release tooling only.

- **Promoting `latest` now cuts the GitHub Release too** (QCLI-398, opum-agent
  OPAG-646). GitHub Releases had stopped at v0.6.0 because no release step
  created one, so `releases/latest` still read v0.6.0 after 0.11.0 shipped.
  `scripts/promote-release.mjs --promote` now creates the `v<version>` release
  from this file's section once `latest` is verified moved, and marks it
  latest. It refuses before any tag moves, dry runs included, if the section
  is missing or empty, or if `gh` cannot read the release (missing, logged
  out or offline). A failure found only after `latest` has moved could not be
  undone. `--rollback` does not touch releases.
  `scripts/github-release.mjs --version <v> --create` is the same step on its
  own, for backfill or repair. It never creates a tag and never rewrites an
  existing release's notes. Version headings here now carry dates. Release
  tooling only.

### Fixed

- **The candidate bundle refuses an all-committed artifact set off a release
  ref** (QCLI-419, reported by opum-cli-e2e via opum-agent). `build:candidate`
  run outside CI packed the committed platform packages — the previous
  release's bytes — and stamped them with the current `sourceCommit` and
  `artifactProvenance: "committed"`, whose own comment promises "the bytes
  that publish". A laptop run on `dev` therefore produced a bundle that
  described itself as the committed bytes of a commit whose source it did not
  contain: the packed darwin-arm64 binary rejected `--across-refs`, while the
  source at that commit serves it. The script header said in prose that it
  must run in CI after the platform matrix; nothing enforced it. It now
  refuses, before packing anything, when no platform was rebuilt off a
  release ref: a candidate's platform packages come from the matrix (labeled
  `"rebuilt"`), and the bytes that publish are bundled on the release tag.
  The rebuild check also runs before the root `package.json` rewrite, so a
  refusal can no longer leave that rewrite behind.

- **GitHub Release notes are read at the commit the tag peels to, not from the
  checkout** (QCLI-407, twin of lore-cli LCLI-639). `releaseNotesFor()` read
  `CHANGELOG.md` from the working tree the promotion ran in, so an uncommitted
  edit — or an edit landed after the tag — became the body of a NEW release,
  and nothing compared the notes against the tagged commit. Every path now
  reads the file's bytes at the peeled SHA through the GitHub API: the promote
  pre-flight refusal, the cut, and the standalone repair tool, with no
  working-tree read left on the promote path. The section parser is fence-aware
  under the predicate agreed with lore-cli, and the missing-section refusal now
  names remedies that work.

- **Five legacy release bodies are reported as recorded exceptions rather than
  prescribed for repair** (QCLI-410). QCLI-407 re-sourced the notes from the
  tagged commit, which moved what the existing-release comparison compares:
  0.6.0, 0.6.1, 0.6.2, 0.7.0 and 0.8.0 each differ from their tag's section,
  because a record was written after the tag — publish histories, a
  post-release correction, known limitations, a provenance warning. Rewriting
  a body to match an earlier section would falsify it, so
  `scripts/github-release.mjs` reports each by name and reason, edits nothing,
  and never marks it latest; moving the Latest badge onto a version from
  another era is not a repair. Every other release keeps the notes-differ
  refusal.

- **A resumed promotion refuses when a package's live `latest` is already
  newer** (QCLI-405, mirrored from lore-cli LCLI-638). Before any dist-tag
  moves, `promote-release.mjs --resume` compares the release each package's
  current npm `latest` LEADS WITH under semver precedence and refuses, naming
  the package and both versions: `5.7.0-rc.1` over `5.6.7` is refused, while
  `5.6.7-rc.1` and `5.6.7+build.7` over `5.6.7` are not, and a value leading
  with no release is unorderable and stays accepted. Equal and older still
  resume, which is the case resume exists for. The fresh-run side also gained
  the registry-terms headline for a non-plain current `latest`, with no change
  of verdict.

- **`task list --status Paused` lists the paused tasks** (QCLI-392). The
  status filter checked only the ladder statuses, so the paused status that
  `task pause` assigns was refused as "Task status is not configured."
  `--status` and `--exclude-status` now also accept the configured paused
  status, in any case. Any other unknown status is still refused with exit 6.
  `task edit --status Paused` is still refused, because `task pause` remains
  the only way in.

- **A flag where a title or id belongs is named, not swallowed** (QCLI-353,
  reported by opum-agent). `quest task create --title "x"` used to fail with
  only "task create received invalid arguments." The title is positional, so
  `--title` became the title and the rest of the arguments could not be
  parsed. Each command that takes a positional title or id now refuses a
  first argument starting with `--` with exit 2, before anything runs. That
  covers task create/view/edit/complete/archive/pause/start/demote, draft
  create/view/promote/archive, and milestone and decision
  create/view/edit/delete, plus milestone archive. The message names the
  token and the usage, for example `quest task create <title> [flags]`.
  A title can no longer begin with `--`.

- **`quest browser` exits when its workspace is deleted** (QCLI-348,
  reported by opum-cli-e2e). A browser started as a daemon ran with no upper
  bound, even after its workspace was deleted. The server now checks
  every 2 seconds that the workspace root it was started against still
  exists. When it is definitely gone, the server closes its connections and
  the process exits. Any other read failure keeps it running. By ruling
  there is no parent-death watch, because a person may detach the server on
  purpose. `quest help browser` states both conditions. At fix time, 16
  leaked harness daemons, up to 11 days old, still had their workspaces on
  disk. The "deleted working directory" in the original report was measured
  false. They predate opum-cli-e2e's harness fix and were reaped.

- **The GitHub Release step refuses an existing release it cannot vouch
  for** (QCLI-401, paired with lore-cli LCLI-622). QCLI-398's cut treated any
  existing `vX` as done and marked it latest. It never read the release's
  notes or state. It now reads `body`, `isDraft` and `isPrerelease` in the
  same `gh release view` call. It refuses a draft, a prerelease, or notes
  that differ from the CHANGELOG section after CRLF normalisation and
  trimming. `promote-release.mjs` runs this check before any tag moves, on
  the dry run and on `--promote`, so it refuses there. None of the three
  cases is ever edited, so a person has to repair it. An existing published
  release with matching notes is still marked latest. Release tooling only.

- **A repeated unknown flag is reported as unrecognized, not as an arity
  error** (QCLI-355, reported by opum-cli-e2e). `task edit T-1 --add-ac a
  --add-ac b` answered "--add-ac may only be provided once.", which implies
  the flag exists, so the caller retried it one occurrence per call. The
  parser now defers the repeat check until the command's accepted flags are
  known. An unknown flag gets the same "Unrecognized flag ... Nothing was
  written ... Accepted flags: ..." message however often it is passed. A
  repeated flag the command does accept still reports "may only be provided
  once." This applies to every command.

- **The `latest`-move gate reads a tarball-published release correctly**
  (QCLI-393). A tarball publish records no `gitHead`, and npm 12 then
  answers a two-field `npm view` with a bare value. The reader parsed that as
  "npm serves nothing" for all seven packages and refused 0.11.0's
  promotion. It now reads each version's whole metadata, as lore-cli's reader
  does. It takes the release commit from the `v<version>` tag, dereferenced
  through the annotated tag object, and refuses if the tag cannot be read. A
  `gitHead`, when npm records one, must agree as well. Release tooling only.

- **`scripts/promote-release.mjs --rollback` can only undo its own
  promotion** (QCLI-390, from lore-cli's review of its mirror). A record's
  prior `latest` values must be versions, not tag names, and must differ from
  the release. The rollback refuses unless every package's current `latest`
  is the release or its recorded prior value, so an old record cannot
  silently downgrade `latest` after it has moved on. A tag move that fails
  part way through now restores the failed package too, because the write
  may have landed before the error. Release tooling only.

- **`scripts/promote-release.mjs` refuses to move `latest` backwards, or onto
  a prerelease** (QCLI-402, twin of lore-cli LCLI-631; opum-doc ADR
  `refuse-a-lore-quest-promotion-that-would-move-npm-latest-backwards` and
  its Amendment 1). The dry run and `--promote` both check this before any
  tag moves. A fresh plan now validates the record it would write with the
  release version. It refuses when any package's current `latest` is newer
  than the release, or when the version is not plain X.Y.Z. Either record
  could otherwise be written and then be neither resumable nor rollbackable.
  The refusal names both versions. It says that a backport or a prerelease
  belongs on a non-`latest` dist-tag through a separate path that is not
  built. An equal version keeps its existing behaviour. Release tooling only.

- **Completing a paused task names the way back** (QCLI-397). `task complete`
  on a Paused task refused with "Task transition uses an unconfigured status."
  Paused is configured; it is just off the status ladder. The refusal now
  reads `Task <id> is "Paused", the paused status, which is off the status
  ladder. Bring it back with quest task start <id>, then retry.` The same
  message applies to `task edit --status` and to a retired paused literal
  such as "Blocked". The exit code (6) and the refusal itself are unchanged.

## 0.11.0 - 2026-09-27

The first release under constitution Article 3 (opum-ai/opum-agent
`docs/reference/opum-project-constitution.md`, ratified 2026-09-27): quest and
lore ship as a pair at one version number. lore 0.11.0 skips 0.10.0 to meet
it. Both are staged under the `release-candidate` dist-tag and qualified
together by opum-cli-e2e from registry installs. Only then does `latest`
move, quest first. It is minor rather than patch for two reasons. `quest init`
and `quest agents` gain opum-quest plugin detection and update. And a bare
`quest agents --check` in a Claude-only or Gemini-only project now exits 6
where it used to exit 0 (QCLI-373, below). Nothing else changed in any
command, flag or envelope.

### Added

- **`quest init` and `quest agents` detect the opum-quest marketplace plugin**
  (QCLI-371, with QCLI-378 to QCLI-384 closing parity with lore-cli). When the
  Claude or Codex target is selected, they read `claude plugin list --json` or
  `codex plugin list --json` and report the plugin as installed, disabled, not
  installed or not detectable, with a remedy. Neither ever installs or enables
  it. `quest agents --update-instructions` with an explicit `--target` updates
  an installed plugin and converges on the marketplace, and the skill is drawn
  from the marketplace source so the two copies cannot drift apart. The rules
  match lore-cli's:
  - Claude scopes rank managed > local > project > user > synced. Between two
    rows of one scope, the deeper `projectPath` decides (QCLI-379). A managed
    row decides and is never updated (QCLI-381).
  - A scope that cannot be named as a plain token gets no command at all:
    the update is reported not run, and the remedy is prose (QCLI-383). A
    token must start with a letter or digit (QCLI-382).
  - Every not-run report carries an `updateDetail`, and the Codex wording
    follows how far the update got (QCLI-384).
  - Runtime text is stripped of ANSI, control and bidi/invisible format
    characters before any output mode. `--scope` reaches a remedy or an
    argv only as a plain token. Plugin output is read up to 1 MiB (QCLI-380,
    QCLI-382).
  - The list deadline (15s) ends the runtime's whole process group, so a
    grandchild holding the pipes cannot keep `quest` alive (QCLI-378).
    `QUEST_AGENT_PLUGINS_TIMEOUT_MS` and `QUEST_AGENT_PLUGINS_UPDATE_TIMEOUT_MS`
    override the list and per-step update deadlines.

### Changed

- **A bare `quest agents --check` no longer reports on the wrong file**
  (QCLI-373). With no `--target` it still checks the Codex block, because the
  Codex managed block tells CI to run it that way. But in a project whose
  Quest block lives only in `CLAUDE.md` or `GEMINI.md`, it now exits 6 and
  names the `--target` to use, instead of exiting 0 about an `AGENTS.md` that
  was never the point.
- **Publishing refuses without an opum-cli-e2e qualification receipt, and
  publishes the qualified bytes** (QCLI-366, QCLI-368). The publisher reads
  `receipts/quest/<version>.json` from opum-cli-e2e's `main` and refuses,
  dry run included, unless it binds this version, commit, qualification run
  and all seven candidate-bundle tarballs. The seven bundle tarballs are then
  published byte for byte instead of a repack of the working tree. After
  publishing, npm's `dist.integrity` must match every bundle file.
  `.gitattributes` pins the platform packages' LICENSE and package.json to LF,
  which the Windows runners' checkout had turned into CRLF. Release tooling
  only.

- **Publishing refuses unless lore is at the same version** (QCLI-386,
  constitution Article 3 clause 6). Both publishers read `@opum-ai/lore`'s
  `package.json` on `opum-ai/lore-cli`'s `main`, dry run included, and refuse
  on a mismatch or on any failure to read it.
  `scripts/qualification/version-parity.mjs --require` runs the same check on
  its own. Release tooling only.
- **A release is staged under the `release-candidate` dist-tag, and `latest`
  moves in a separate step** (QCLI-385, constitution Article 3 clause 5). Both
  publishers now pass `--tag release-candidate` on every `npm publish`, so
  publishing leaves `latest` where it was. `scripts/promote-release.mjs` moves
  `latest` after opum-cli-e2e has qualified the staged lore/quest pair from
  registry installs. It refuses unless all seven packages are staged at the
  version, and it records every prior `latest` before moving any tag. It moves
  the platform packages first and the wrapper last. A failure part way through
  restores the tags that run moved, and `--rollback <record>` restores all of
  them. Release tooling only; no command, flag, envelope or exit code of
  `quest` changed.
- **Moving `latest` requires opum-cli-e2e's verdict on the staged pair**
  (QCLI-388). `scripts/promote-release.mjs` reads
  `receipts/pair/<version>.json` from opum-cli-e2e's `main` and refuses unless
  it is `QUALIFIED`, names quest and lore at the same version, and was taken
  from registry installs. Every recorded `distIntegrity` must also match what
  npm serves when the promotion runs. A missing or unreadable receipt refuses.
  Rolling back is never gated. Release tooling only.

### Fixed

- **`task edit --if-revision` reports a stale edit as a conflict** (QCLI-374).
  A stale revision is now refused with exit 5 before the patch is folded. A
  concurrent removal of the same value used to surface as an exit-6
  validation miss rather than the conflict it is. Callers that retry on exit
  5 now retry.
- **`scripts/publish-release.mjs` no longer reports a locked Keychain entry as
  a missing token** (QCLI-349). It used to treat every `security` failure the
  same way and print "no stored token found", which points at the wrong fix. A
  non-interactive read that fails with exit 36 (`errSecInteractionNotAllowed`)
  now says the entry exists and names `security unlock-keychain`. Exit 44 still
  says to create and store a token. Any other failure is reported as "could not
  be checked". A real publish with the entry locked and no `--otp` refuses with
  the unlock remedy. This is release tooling only; no command, flag, envelope
  or exit code of `quest` changed.
- **The publisher's success line names what it actually verified** (QCLI-350).
  "@opum-ai/quest <version> published and verified (N checks)" described
  checks of the six platform packages against the receipt, not of the
  wrapper. On 0.9.0 it printed while an anonymous read of the wrapper still
  returned 404. The script now checks that the wrapper resolves for a consumer,
  using the same read that gates the platform packages, before it prints
  anything. The line then lists each object with the check that verified it.
  A package the registry does not show yet is described as one of three
  states (slow, staged, never landed) instead of two. The wrapper is still
  withheld whenever any platform package does not resolve. Release tooling
  only.
- **The post-publish verification is now testable end to end** (QCLI-304). It
  moved out of `main()` into `verifyPublishedRelease`, with every read
  injectable except the wrapper's anonymous consumer read. A test now makes the
  0.7.1 failure happen through that real read: the wrapper's write succeeded
  but the public packument does not list the version yet. It shows that no
  success line prints until a plain read lists the version. The runbook
  publish section now says what "verified" means. Release tooling only.
- **A version bump now fails fast if `bun.lock` still pins the old platform
  versions** (QCLI-292). CI's `bun install --frozen-lockfile` does not notice
  at bump time, because the new version isn't on the registry yet. It failed
  only after publish, on an unrelated pull request (the 0.6.2 breakage). The
  new `lockfile_pins` source gate (`bun run check:lockfile`) compares the six
  pins to `package.json` and names `bun install` as the fix. Release tooling
  only.

## 0.10.0 - 2026-09-24

This release is minor rather than patch for one reason: the managed-block
change below makes `quest agents --check` report `drift` (exit 6) against every
existing block until `quest agents --update-instructions` rewrites it. No command,
flag, envelope or exit code changed. Apart from the two version constants, the
only source file changed since 0.9.0 is `src/application/agents/agent-instructions.ts`
(QCLI-365).

### Changed

- **The managed agent-instructions block now routes a reader to the guides
  instead of back to itself** (QCLI-362, from opum-agent's OPAG-378 audit).
  It used to call `quest instructions --json` "the current versioned
  protocol", but that command returns this same block. The block now names
  `quest instructions --list` and when to read each guide (`overview`,
  `task-creation`, `task-execution`, `task-finalization`, `workspace`), along
  with `quest search` and `quest help <command>`. It spells out the actor
  flags for a person and for a delegated agent (`--actor`, `--actor-kind`,
  `--accountable-human`), where it used to say only that a declaration is
  required. The Backlog.md cutover recipe is gone from the block; the
  `workspace` guide still carries it. `quest agents --check` reports every
  existing block as `drift` (exit 6) until it is regenerated with
  `quest agents --update-instructions`. That is a real content change, not a
  version-only difference, so it is not exempt.

## 0.9.0 - 2026-09-19

Ships the 0.8.0 section below along with everything here: 0.8.0 was frozen and
tagged but never published, so its content reaches consumers for the first
time under this number.

**Why the published number skips 0.8.0.** 0.8.0 was frozen, tagged at
`9d91fc35` and never published; 15 further commits then landed on `dev`,
including the `Added` entry below and four fixes. Re-pointing the tag was
refused rather than weighed: `quest-web` runs a live link gate against this
repository's tags, and `opum-marketplace` re-resolves tag to commit to tree
against a recorded baseline, so a moved tag falsifies every record citing it.
The precedent for a tagged-but-unpublished version is 0.6.1 to 0.6.2 -- ship
the content under the next unclaimed number. This is breaking-plus-feature
relative to **published** 0.7.1, so the next unclaimed number is a minor one.

**This section exists because QCLI-286 came true.** That task -- open, and
filed as a warning -- predicted that a rolled-forward version section can
silently swallow later fixes. It did: five consumer-observable changes sat on
`dev` with an empty `Unreleased` heading above a frozen `## 0.8.0`, and
nothing caught it. It was found by walking `git log v0.8.0..dev` during
release preparation, which is exactly the manual step QCLI-286 asks to be
replaced by a check.

### Added

- **`unresolvedAtCompletion` is persisted on the task record and queryable
  across completed tasks** (QCLI-336). QCLI-252 made it a response-only
  signal, so the fact that a task closed with unchecked acceptance criteria
  survived only in the output of the command that closed it. `task complete`
  now computes it in the domain and writes it into the record, the zod schema
  validates it, and `task view`/`task list --json` surface it. `TaskInput`
  excludes it from creation: it is a fact a completion establishes, never one
  a caller asserts.

### Fixed

- **`overview` counted only `.quest/tasks/`, so completing a task removed it
  from the totals instead of moving it** (QCLI-339). It now counts every
  retention location, and carries an additive `byLocation` naming how the
  total divides, so a total that looks wrong can be read rather than guessed
  at.
- **`overview` milestone counts silently excluded archived milestones**
  (QCLI-340), the same unlisted-population shape as the entry above. Archived
  is now reported alongside open and closed. QCLI-140 is preserved rather than
  reopened: a retired milestone still counts as neither open nor closed work,
  but the population it belongs to is now visible in the output instead of
  only in a code comment.
- **The `overview` guide documented an envelope the CLI does not emit**
  (QCLI-342). It described `{schemaVersion, kind, data, principal}`, omitting
  `contractVersion` -- the key at index 1 -- and did not say that the record
  lives under `data`. An agent following it and projecting top-level fields
  got all-null with exit 0 and empty stderr. The guide now names the envelope
  exactly as emitted, separates success from error, states the additive-key
  rule, and is pinned by a test that compares it against real CLI output
  rather than against a copy of the prose.
- **`task create --id <taken>` reported a write conflict and told the caller
  to retry, against a condition no retry can resolve** (QCLI-346). The id was
  held by an existing record -- in the reported case an ARCHIVED one, which
  `task list` does not show and which left `doctor` reporting healthy, so
  every signal a caller could reach said the workspace was fine. It is now
  `validation` on exit 6, names the id, and names the path holding it.

  `task_already_exists` covers two cases with opposite remedies and both were
  mapped to the retryable one. An **auto-allocated** id losing a race to a
  concurrent writer is a genuine conflict and retrying recomputes a fresh id;
  an id supplied with `--id` is fixed, so the same retry loops forever. Only
  the explicit case changed -- the auto-allocated path keeps `conflict` and
  its retry hint. Reported by opum-cli-e2e, who followed the old hint three
  times before finding the cause by listing `.quest/archive/` on a hunch.

- **`task edit` rejected `--implementation-notes`, the name `task create`
  uses for the same field** (QCLI-344). It is now accepted as an alias of
  `--notes`. Passing both is a usage error rather than a silent preference for
  one, and a rejected flag now states that the rest of the command was not
  applied -- previously a caller could not tell from the message whether a
  multi-flag edit had partially landed.

## 0.8.0 - 2026-09-17 (tagged, never published)

Version frozen 2026-09-17, **tagged and never published**. Its content ships
under 0.9.0 instead, together with the work that landed after the freeze; see
that entry for why the number moved. The `v0.8.0` tag is left pointing at
`9d91fc35` and is not re-pointed.

Breaks lockstep with `@opum-ai/lore`, forced by QCLI-328's rule that a
breaking `Changed` entry needs at least a minor bump, and the entry directly
below is exactly that.

**Corrected 2026-09-18 (QCLI-345).** This paragraph originally read
"lore-cli's `dev` remains at 0.7.0 and nothing in lore changes". That was
false when it was written, and it is corrected here rather than quietly
dropped because it was the stated justification for shipping quest-only.
Asked to measure their own range, lore-cli reported `dev` at 64 commits past
tag `v0.7.0`, carrying a new `lore types` command, a new `profile.strict_types`
config key, and committed-schema drift detection inside `lore check`.

How it got in is worth more than the correction: the claim came from reading
lore's `dev` package.json (0.7.0) as though it were a running version. It is
not, and the conventions are opposite in the two repositories -- **lore bumps
at release time, so that field names the LAST shipped version; quest bumps at
freeze time, so ours names the NEXT, unpublished one.** Reading a sibling's
field with this repository's convention in mind produces a confident wrong
answer. A version field's meaning is a per-repo convention; the commit range
is the only probe that means the same thing in both.

**The date above is when this version was frozen and the bump landed, not
when it reached npm**; publication is a separate, manually authorized step,
and nothing in this file should be read as evidence that it happened.

### Changed (breaking)

- **A removal that matches nothing now fails loud (exit 6) instead of
  returning `task.updated`/`milestone.updated` with an unchanged list.** Nine
  flags across two commands: `task edit`'s `--remove-label`, `--remove-plan`,
  `--remove-note`, `--remove-comment`, `--remove-assignee`,
  `--remove-reference`, `--remove-modified-file` and `--remove-dependency`,
  plus `milestone edit --remove-task`. The error names the record id and
  echoes every unmatched value JSON-delimited, and NOTHING is removed -- not
  even the values in the same flag that did match.

  Quest shipped two removal vocabularies with opposite miss behaviour in the
  same command. `--remove-ac 9` on a two-item list exits 6; `--remove-note 1`
  exited 0 and removed nothing, because removal matches on exact TEXT. An
  agent that had learned the loud one reasonably tried the same shape on the
  quiet one and was told its edit succeeded. Reported by opum-cli-e2e via
  opum-agent as one flag; reproducing it found eight, then nine across two
  commands, because `milestone edit --remove-task` has its own merge and never
  touches the shared helper.

  **The payload could not have carried this instead, and that is the argument
  that decided the shape.** The natural defensive check on the returned record
  -- "is the value I asked to remove absent from it?" -- returns TRUE on the
  whitespace case, because a value differing by a trailing space was never in
  the list under any outcome. It confirms the failure AS a success. A defect
  that defeats the diligent caller and the careless one identically is worse
  than one that only catches the careless, so an additive `unmatched` count
  would have left the hard case exactly as silent for everyone not reading a
  field they have no reason to expect. Hence the JSON delimiters: a trailing
  space sits inside the quotes and a tab renders as `\t`.

  Both downstream consumers chose loud independently, and lore-cli did so
  against its own convenience: a silent no-op on the only path they reach (a
  read-then-remove race) is worse for them, because lore would then report
  "removed" for an edit that removed nothing, propagating the defect into
  their report rather than stopping at Quest's boundary. They asked for the
  record id in the message for the same reason -- their per-task error field
  carries one line into a multi-task report.

  The ordinal-addressed family (`--remove-ac`/`--check-ac`/`--uncheck-ac` and
  the `--*-dod` equivalents) is unchanged and keeps its own message. Accepting
  an ordinal on the by-value flags was considered and DROPPED, not deferred: a
  value that is both a valid ordinal and valid item text would have two
  meanings, so a note whose text is literally `"1"` would get a removal that
  silently addressed a different item -- a wrong object returning success,
  strictly worse than the no-op it replaced.

  **Who this can break, stated with its bound rather than as a clean bill of
  health.** A caller that passes removal values speculatively -- a
  remove-if-present idiom, or an idempotent retry that re-sends an edit whose
  removal already applied -- now gets exit 6 where it got exit 0. A consumer
  sweep across the fleet checkouts on this machine found exactly one
  cross-repo caller, lore-cli's `src/adapters/quest.ts` emitting
  `--remove-label`, and both of its call sites compute the removal from a
  fresh read and short-circuit when the label is already absent, so neither is
  speculative; lore-cli confirmed from their own side that no third producer
  and no retry path exists. **That finding is bounded to the fleet checkouts
  on this machine and is NOT a claim about consumers generally.** It cannot
  see removals assembled into a `task edit-batch` ops file outside those
  repositories, and it cannot see any consumer outside them -- the mbpm2
  project included, who are a real integration consumer of the published CLIs
  and have not been asked (QCLI-297).

  **What the short-circuit does NOT cover, volunteered by lore-cli against
  their own interest.** Both of those guarded call sites are a
  read-modify-write with no `--if-revision`, which is their open LCLI-522. If
  the label disappears between lore's read and lore's write, quest previously
  returned `task.updated` with an unchanged list and the race stayed silent;
  under this release it becomes exit 6. **So this change converts a silent
  lore race into a loud failure** -- an improvement, and neither side asked to
  hold the release for it, but it means lore 0.7.0 paired with this version
  has a failure mode that neither lore 0.7.0 + quest 0.7.1 nor a matched newer
  pair will necessarily show, because **it needs concurrency to surface**. A
  serial qualification run cannot see it; opum-cli-e2e has been asked to
  exercise that path concurrently. The pair being qualified matters here, not
  just the two version numbers.

### Added

- Every `task.list` envelope carries an additive top-level `scope`
  (`{branch, otherRefsRead, unseenTaskIds?}`), so a listing names the object
  it answered about instead of leaving the reader to assume it covered the
  repository. `quest task list` reads the checked-out ref's `.quest/` and
  nothing else, while the rule that sends a session to it -- confirm nothing
  is still open before reporting clear -- asks about the repository. The two
  diverge for exactly the tasks most likely to be forgotten, the ones still on
  an unmerged branch, and the failure direction is the bad one: an empty list
  reads as the check PASSING rather than as the check NOT RUNNING. Reported by
  opum-doc after an empty In Progress listing on `dev` missed a task that was
  In Progress with an open pull request; they caught it only because an
  independent source disagreed with the empty list, and neither the exit code
  nor the output would ever have shown it.

  `branch` is named on every listing. The cross-ref set difference that fills
  `unseenTaskIds` runs only when the listing came back empty -- the only case
  where naming what was not read changes the reader's conclusion -- and
  `otherRefsRead` says whether it ran. Three limits, all deliberate: it
  reports EXISTENCE only and never status, so a named id may already be Done
  on the ref that carries it (DEC-6); it reads `refs/heads` and
  `refs/remotes` and never fetches, so run `git fetch --prune` first if local
  refs may be stale; and it is a local-git detector, which means it shares a
  blind spot with any other local-ref sweep and does not replace asking
  GitHub (QCLI-316).

  **Detect it by key presence, not by version, and keep doing so after the
  next release.** The success envelope is an open key set, so `scope` is
  exactly the additive change a consumer is required to tolerate, and
  `"scope" in envelope` is the semantically correct probe rather than a
  fallback. A version gate cannot work here in any case: `dev` declares 0.7.1
  and so does the published build that lacks the key (QCLI-296).

- `agents.skill_source` accepts a third value, `"none"`, meaning this
  workspace generates no quest skill file and none ships from anywhere else.
  Set it with `quest init --skill-source none`, or on an existing workspace
  with `quest init --reconfigure --skill-source none`. It behaves identically
  to `"plugin"` on every file operation -- absence is the healthy state, a
  leftover `.claude/skills/quest/SKILL.md` reports as drift, and `--force`
  removes it only when byte-exact -- and differs only in what it asserts.

  That difference is the entire point. Reported by the mbpm2 project, a
  Codex-only consumer, as an integration blocker: `quest agents
  --update-instructions --target codex` writes AGENTS.md **and** the
  Claude-provider skill file, because the skill file is target-independent by
  design and governed by `agents.skill_source`. The only way to stop it was
  `--skill-source plugin`, which asserts the opum-quest **Claude Code** plugin
  ships the skill -- a plugin they do not have and are not using. The opt-out
  required declaring something false. `"none"` says only that no skill file is
  generated, and its drift message names no plugin.

  The `--target codex` path is unchanged and is not deprecated: Codex is
  retired as a runtime this fleet builds on, not as product surface, and this
  is an external user invoking a published flag.

  Two things a reader should not over-read here. First, the file-writing
  behaviour under `"repo"` -- the default, and what every existing workspace
  has -- is byte-identical to before; nothing changes for a consumer who does
  not set the new value. Second, a workspace that had already worked around
  this with `"plugin"` is still correct and needs no migration; `"none"` is a
  more accurate declaration of the same intent, not a replacement for a broken
  one (QCLI-309).

- `quest help init` now states that `--reconfigure` accepts `--skill-source`,
  and both `init` usage lines name all three values. The omission was the
  cheaper half of the report above: `--reconfigure` has accepted and persisted
  `--skill-source` since QCLI-236, but the `init` summary described it as
  being for "name/task-id-prefix on an existing workspace", so a documentation
  gap turned a one-command fix into a blocker. The reporter could not
  reasonably have derived it (QCLI-309).

### Fixed

- **Draft, milestone and decision ids are now allocated refs-aware, like task
  ids have been since QCLI-279.** `quest draft create`, `quest milestone
  create` and `quest decision create` used to compute "next available" from
  the checked-out tree's `.quest/` alone, so an unmerged sibling branch or a
  detached checkout behind a moved branch could mint an id that already
  existed elsewhere. QCLI-279 fixed exactly one of the three allocators and
  deliberately left these two pending a real reproduction; that reproduction
  arrived on 2026-09-14, when two sessions independently minted `DEC-3` from
  branches neither of which carried the other's record. Recovered by hand, no
  data lost, and it would not have been caught by a less careful actor.

  **The obvious fix -- point QCLI-279's existing helper at the other
  subdirectories -- is right for drafts and silently wrong for milestones and
  decisions**, which is the only interesting thing about this change. That
  helper finds ids by reading FILE NAMES, which works because tasks and drafts
  are stored one record per file. Milestones and decisions share a single
  `.quest/planning.json`; a filename scan over that path matches one file
  called `planning.json`, matches no id marker, and returns 0 -- and 0 is
  indistinguishable from "no other ref carries a higher id". So the planning
  half reads blob CONTENT per ref instead, via the revision-pinned read the
  Git port already exposed.

  That is measured, not argued: a mutant implementing the obvious fix produces
  a verdict set byte-identical to a mutant with no fix at all -- five of nine
  tests red, the same five. The wrong mechanism and the absent one are the
  same observation.

  Unchanged in every other respect. Allocation still consults only refs that
  already exist locally and never fetches; only a prefix's own family can
  advance its counter, so a decision cannot advance the milestone counter
  though both live in one document; and a `.quest` directory with no Git
  repository behind it still allocates from the working tree alone. An
  unreadable or unparseable planning document on some unrelated branch is
  skipped while the remaining refs are still consulted -- a coarser guard
  would fall back to the local-only view, which is the un-fixed behaviour
  wearing a passing test. Ids minted before this change are not repaired by
  upgrading.

- `quest task edit --acceptance-criteria` (and `--definition-of-done`) given a
  JSON array of bare strings silently unticked every checked box: exit 0,
  empty stderr, `kind=task.updated`. The lossless `{index, text, checked}`
  element form already existed, but appeared nowhere in the CLI's output
  except the usage error for an object array missing `index`, and
  `quest manifest --json` advertised only `json-array` -- so the discoverable
  path was the destructive one. Three independent agent callers reached for
  the string form within hours on 2026-09-15, none knowing the object form
  existed, all three having read the manifest; one caller reaching for the
  destructive path is a caller mistake, three is the shape of the surface.

  The replacement is now refused with exit 6 (validation, not usage: the two
  neighbouring conflicts are decided by the flag combination alone, this one
  by the record's state) if and only if a currently-checked position is
  replaced by a BARE STRING. The test is on what the replacement carries, not
  on the outcome -- an entry saying `checked: false` has stated its intent and
  is honoured, a bare string has said nothing -- so a deliberate reset is
  still expressible and this needed no `--force` flag. The refusal names that
  spelling at the one moment the caller is certainly reading. `manifest` now
  advertises the element shapes (`string | {index,text,checked}`) additively,
  with `value` still `json-array` so a consumer switching on it is unaffected
  (QCLI-313).

- `quest instructions task-execution` said checkbox edits are
  "index-addressed". The flags take the 1-based `position`, and
  `quest help task edit` already said so at length, including "`index` is not
  what these flags take" -- so two documentation surfaces of the same CLI
  contradicted each other, and the wrong one is the surface the agent protocol
  sends a caller to first. Reported by opum-doc, who hit it as four silent
  successes: a loop over `0..4` gets one error on `i=0` and checks positions
  1-4, leaving the LAST criterion unchecked under a final summary claiming all
  of them met. They caught it by counting `checked: true` against the criterion
  count, not from any exit code (QCLI-315).

- `README.md` no longer states a version of its own, and a pack-time gate
  keeps it that way. It ships inside the tarball, and this repository's
  release path never read it -- `git log -- README.md` returned one commit,
  ever -- so `@opum-ai/quest@0.7.0` and `@0.7.1` both advertise 0.6.0 on their
  npm pages, permanently, because version pages are immutable. The gate reads
  `README.md` back out of a real `npm pack` tarball rather than the
  working-tree copy: a check on the repo file passes while the packed one is
  stale, and the packed one is what the registry serves. Implements the
  shipped-README contract accepted into opum-doc as
  `docs/reference/shipped-readme-version-assertions.md` (ODOC-201), taking its
  "absent" arm, and in a stronger form than the shared clause -- no
  version-shaped token anywhere in the packed README, because the worst site
  here (`**Status: 0.6.0 released.**`) carries no package name on its line and
  the shared clause would have missed the defect it exists for (QCLI-307).

## 0.7.1 - 2026-09-15

Version frozen 2026-09-15. **Breaks lockstep with `@opum-ai/lore`, once and
deliberately, as 0.6.2 did:** lore stays at 0.7.0 and nothing in lore
changes. This is a hotfix for a defect every fleet workspace that paused a
task before 0.7.0 is exposed to, ruled ahead of everything else the same day
it was reported, and holding it for the next paired release would have left
those records unreachable for no reason a consumer benefits from. The one
entry below is additive on the read side (`doctor` gains an issue code) and
restores a transition on the write side (`task start` from the retired
literal); nothing else moves. **The date above is when this version was
frozen and the bump landed, not when it reached npm**; publication is a
separate, manually authorized step, and nothing in this file should be read
as evidence that it happened.

### Fixed

- A record parked at the pre-0.7.0 default paused status `"Blocked"` could
  not leave it by any command after upgrading: `task start` and `task pause`
  refused the transition, `task edit --status` and `task complete` reported
  an unconfigured status, `task demote` had nowhere to go, and `quest doctor`
  reported the workspace healthy. QCLI-287 renamed the default to `"Paused"`
  and every lifecycle check compares the record's status to the configured
  value by exact string, so an already-parked record became an off-flow
  status on upgrade; 0.7.0's changelog warned about the literal and the
  best-placed consumer still missed it, so a warning was not the fix.

  `quest task start <id>` is now the sanctioned exit from the retired
  literal, exactly as it was in 0.6.x, when and only when the workspace does
  not configure `"Blocked"` itself (on its ladder or as its paused status);
  `task pause` then parks the record at `"Paused"`. Nothing is migrated
  silently. `quest doctor` gains a `task_status_off_flow` issue naming every
  active task whose status is on neither the ladder nor the paused slot, with
  the repair command in its `hint`, so a stranded record is a red doctor
  rather than a healthy one. Reported by lore-web (LWEB-80), also hit by
  lore-cli (LCLI-333) (QCLI-302).

  For a stranded workspace, the repair is:

  ```sh
  quest doctor --json                      # names the task id and status
  quest task start <id> --actor <name> --actor-kind human --json
  ```

- The release publish no longer puts `@opum-ai/quest` on the registry until a
  read confirms all six platform packages actually **resolve for a consumer**.
  It previously ordered its writes and treated that as the guarantee; write
  order does not produce visibility order, and during the 0.7.0 publish the
  two disagreed in four of six positions while one package sat non-public for
  twelve minutes past the wrapper. Because platform packages are
  `optionalDependencies`, an install inside that window SUCCEEDS and leaves no
  binary -- so the failure was silent from the consumer's side and reported as
  success from the publisher's (QCLI-299).

  Nothing about an installed release changes; this is release tooling. The
  gate reads over plain HTTPS with no credential, which is a different client
  from the publishing one, and holds a 30s settle margin over the 9-20s
  publisher-early lag measured by opum-cli-e2e.

- A timed-out publish verification no longer asserts "this is registry
  read-after-write lag, not a failed release". That sentence was true of six
  packages and wrong about the one that decided whether 0.7.0 shipped, and it
  told the operator to stop investigating at the moment investigating was the
  whole job. It now reports each package's state read from the registry --
  public, staged, or undetermined -- and names the operator action for a
  staged one, including that the release token cannot clear it. The
  `npm unpublish` warning stays: that half was protecting against a genuinely
  destructive action (QCLI-299).

### Added

- `.github/workflows/lore-check.yml`: CI now runs `lore check` on every pull
  request into `dev` (and on push to `dev` and `main`, so the context can later
  become a required check without deadlocking the fast-forward promotion). The
  operating block has made a green `lore check` the definition of done for a
  docs change all along; nothing here enforced it. Unlike the fleet reference
  job, this one installs no published `@opum-ai/quest`: lore's quest adapter
  shells out to whatever `quest` is on PATH, and this repository authors quest,
  so the job runs lore against a shim over `bun run src/cli/main.ts` from the
  same checkout and asserts that is what PATH resolved to (QCLI-301).

## 0.7.0 - 2026-09-15

Version frozen 2026-09-15, in lockstep with `@opum-ai/lore` 0.7.0 -- the
pairing convention every release has held since 0.5.0, resumed after 0.6.2
broke it once deliberately. **The date above is when this version was frozen
and the bump landed, not when it reached npm**; publication is a separate,
manually authorized step, and nothing in this file should be read as evidence
that it happened.

Minor, not patch, and one entry below deserves reading before you upgrade
rather than after. `quest task pause` now parks a task at `"Paused"` instead
of `"Blocked"`, so **anything matching on the literal string `"Blocked"` to
find paused work will stop matching.** No transition, flag or envelope shape
changed to make that true -- the configured value did. Everything else here
is additive: a new envelope field and two new optional flags, each inert when
not asked for.

*Observed after release, 2026-09-15, reported by opum-cli-e2e from their
0.7.0 qualification matrix (their PR #154):* that warning was published and
the best-placed consumer still missed it. Their `60-project-lifecycle` suite
pinned the literal `"Blocked"` and six rows failed against a conformant quest,
while their `40-cross-product` suite read the value live and absorbed the
same release without moving a row. Their fix binds the suite to what
`task status-flow` declares. A changelog warning is not a gate; a consumer
that binds to the CLI's own declaration does not need one.

### Added

- Every success envelope now carries `contractVersion: 1`, a new field
  distinct from `schemaVersion` (which stays the outer envelope-wrapper
  version). `contractVersion` is a single global counter, not a per-command
  one: it moves whenever any command's `data` payload shape changes in a way
  an existing decoder would misread, so a consumer has one field to check
  rather than needing to track ~30 commands independently (QCLI-289).

  This exists because 0.6.2's `QCLI-264`/`QCLI-265` envelope-shape unification
  (`data.task` becoming bare `data`, among others) shipped with `schemaVersion`
  unchanged at `1` on both sides of the break -- reported downstream by host
  mbpm2, whose own integration suite passed 0.6.2 validation and then broke
  anyway, because nothing distinguished the old shape from the new one.
  **That break predates this field and stays undetectable by it**:
  `contractVersion` starts at `1` in the release that introduces it rather
  than being backdated to claim a transition that had no signal at the time.
  Anything relying on the pre-`contractVersion` shape needs to keep doing
  what it already does today (a defensive read of either shape); this field
  only protects against the *next* shape change, not the last one.

  **What `contractVersion` does NOT cover.** Stated here because a field that
  says what it covers and not what it omits has the same defect it was added
  to fix -- and because 0.7.0 itself contains two changes it does not signal.
  Verified by probing every envelope family the 0.7.0 binary emits, not read
  off the source:

  - **Error envelopes carry no `contractVersion`, by design.** An error
    envelope is `{error_type, message, hint?, input?, principal}` and carries
    no envelope metadata at all -- no `schemaVersion` and no `kind` either --
    so its absence here is the existing design, not an oversight. Do **not**
    infer "`contractVersion` absent ⇒ pre-0.7.0 shape" from an error envelope;
    that rule holds only for success envelopes. Errors are discriminated by
    the frozen exit-code taxonomy (§3) instead, which is stable and needs no
    version field. This is deliberate and will not be revisited quietly: the
    error envelope is specified as a closed key set, so adding a key to it is
    a breaking change for any consumer validating it strictly -- and at least
    one does, which is precisely why the field was added to success envelopes
    only.
  - **Configured-value changes are not payload-shape changes.** The counter
    moves when a `data` payload's *shape* changes in a way an existing decoder
    would misread. It does not move when a value inside an unchanged shape
    changes. **0.7.0 contains exactly such a change**: `quest task pause` now
    parks a task at `"Paused"` instead of `"Blocked"`, so a consumer matching
    the literal string `"Blocked"` stops matching while `contractVersion`
    correctly stays `1`. Read `contractVersion` as "can my decoder still parse
    this?", never as "did anything I depend on change?" -- the second question
    is what a changelog is for, and this entry is the answer for this release.

- `quest task view <id> --max-notes N` caps `implementationNotes` to the most
  recent `N` entries, adding a `notesOmitted` count (present whenever
  `--max-notes` is supplied, including `0`, never otherwise). Additive and
  opt-in -- omitted, `task view` is byte-for-byte unchanged (QCLI-276, one
  piece of DEC-3, a shape agreed jointly with `@opum-ai/lore`'s own
  `lore context` budget work). The rest of DEC-3's originally-scoped surface
  (a general `--fields` selector, `--since`/cursor note selection, retrieving
  one note by a stable id, field-level omission metadata) is deliberately
  deferred, not dropped -- tracked as QCLI-291.

- `quest task edit <id> --if-revision <rev>` (and a per-item `ifRevision` on
  `task edit-batch`) lets a caller supply the revision it read earlier and
  have the edit refused, before any state change, if the record has since
  moved -- the same exit-5 conflict a concurrent write race already produces.
  `quest task view <id> --json` now returns that revision (additive field) so
  a caller has something to capture. Omitted, `task edit` is unaffected
  (QCLI-277).

### Fixed

- A write conflict's `actualRevision` -- the one piece of data a caller needs
  to retry without a second read -- was silently discarded for *every* task
  write conflict, not only the new `--if-revision` case above: the internal
  helper that unwraps a mutation result threw a bare error with no payload.
  The documented retry protocol ("re-read the latest state and perform your
  own bounded retry") was correct advice that the CLI's own diagnostic didn't
  carry the means to follow. Now named in the diagnostic's `input` on every
  conflict, same exit code and message (QCLI-277).

- `quest agents --check --require-installed` exited `0` for a managed
  instruction block whose *content* is current but whose embedded Quest CLI
  version string is stale (`state: version-only`) -- correct, deliberate
  behavior since QCLI-228, and already documented that way in this CLI's own
  guide and help text. The one place that still lied about it: the
  block's own embedded CI-hint sentence, written into every consumer's
  CLAUDE.md/AGENTS.md, which said only "current instructions exit 0, ...
  missing, drifted, or malformed managed instructions exit 6" with no mention
  of the version-only case -- so a reader (lore-cli, concretely, whose
  CLAUDE.md said Quest CLI 0.4.0 against an installed 0.6.0 for two minor
  versions) reasonably concluded CI caught version drift when it deliberately
  does not. The sentence now names the exemption explicitly; the exit code
  itself was never the defect (QCLI-284, DEC-4).

- `quest task pause <id>` parked a task at status `"Blocked"` by default --
  a false signal read fleet-wide as "needs intervention," even when nothing
  was blocking the task. The default paused status is now `"Paused"`,
  structurally unchanged (still separate from the `To Do`/`In Progress`/`Done`
  ladder, still reachable only via `pause`/`start`) -- a naming fix, not a
  new transition (QCLI-287).

## 0.6.2 - 2026-09-14

Breaks lockstep with `@opum-ai/lore`, once, deliberately -- the pairing
convention every release has held since 0.5.0 otherwise. `v0.6.1` was
tagged but never published: every publish attempt failed a registry E404
before writing anything (`actions/setup-node` exporting a placeholder
`NODE_AUTH_TOKEN` that defeated OIDC trusted publishing), a CI-only defect
with no content change of its own. Rather than move an already-pushed tag
(a cross-repo tag-stability concern for `quest-web`'s own CI), this release
carries the same content 0.6.1 would have under the next unclaimed version
number. Unlike 0.6.0's "minor, not patch" note, this is **not** a claim
that the release is safe to take without reading further: the
`### Changed (breaking)` entries below are real envelope-shape breaks
(QCLI-264, QCLI-265). Lore's own 0.6.1 is an uncomplicated patch; quest's
content is not, and normally would have shared the number anyway so the
pair stays coordinated -- this release is the one exception. Read the
breaking section before upgrading.

### Changed

- The root `@opum-ai/quest` package's published tarball now includes
  `README.md` alongside `bin/quest.cjs` and `LICENSE`, so the npm registry
  page renders it. It entered `package.json`'s `files` list as part of the
  2026-09-10 repository recreation (OPAG-70) without a specific review of
  its own; ratified here as a deliberate, ordinary choice for a published
  CLI package rather than reverted to match the pre-recreation three-file
  shape. Confirmed by opum-cli-e2e's pair-qualification suite against both
  a local pack and the live registry tarball; its expected-file-list
  baseline (`baselines/v0.6.2-pair`) now reflects this shape as current,
  not as a regression.

### Changed (breaking)

- Every **single-record** mutating command now carries the written record
  directly in the envelope's `data`, the shape `task create` and `task edit`
  already used. `task complete`, `task archive`, `task pause`, `task start`,
  `task demote`, `draft create`, `draft promote` and `draft archive`
  previously nested it under `data.task`/`data.draft`, alongside the
  repository `revision` hash and a second `kind: "success"` that shadowed the
  envelope's own semantic kind. A caller reading one group could not read the
  other: a `^status:` match over `--plain` matched an edit and silently missed
  a complete. Read the record at `data` on those commands; drop any
  `.data.task`/`.data.draft` hop (QCLI-264).

  "Single-record" is the whole claim, and the qualifier is load-bearing rather
  than pedantic: `task edit-batch` is a batch **report**, not a record, and is
  unchanged. Its records stay at `data.items[].task` and it keeps its declared
  `data.revision`: it is the workspace revision the batch committed at, which
  is what a caller needs to do its own bounded retry after a conflict, and
  `test/qcli122-third-pass.test.ts` has pinned it since QCLI-122. It is kept
  on that reasoning alone -- no external consumer reads it for control flow.
  It is the one payload in the CLI that is not a record, and it is meant to
  stay that way.

- Planning mutations and draft reads now carry the record in `data` too, so
  "where is the record" has one answer across the whole CLI.
  `milestone create|edit|archive|delete` and `decision create|edit|delete`
  returned `{record, result}`, where `result` was the same write receipt
  QCLI-264 unwrapped elsewhere; they now return the record. `draft view` and
  `draft list` returned the repository's `{draft, location}` pair -- the only
  reads in the CLI where the record was not the payload -- and now carry the
  draft's own fields with `location` inline, exactly as `task view` and
  `task list` already carried `path`. Read `data.id`, not `data.record.id` or
  `data.draft.id`; `location` keeps its name and its values (`drafts`,
  `archive/drafts`), so `--include-archived` callers filter on it as before
  (QCLI-265).

- `quest help <command>` prints `summary` and `usage` above the fields and
  flags lists instead of below them, and each flag now carries its value
  shape: `--label <string, repeatable>`, `--acceptance-criteria <json-array>`,
  `--comments <json-objects>`, and a boolean flag claims no value at all.
  Repeatability is per command, so `--type` reads as one scalar on
  `task create` and as a repeatable filter on `task list`.

  `usage` already documented the positional form before this change -- on line
  54 of 56, under ~50 lines of alphabetized names, so a pager, a `head`, or a
  context-budgeted agent never reached it. The fix is placement (QCLI-266).

- `quest manifest --json` gains `parameters` per command: `positional`
  (name, required, value) and `flags` (value kind, and whether the flag is
  repeated per item). `fields` lists domain field names and cannot say that
  `title` is positional rather than `--title`, so a caller generating a
  command line from the manifest -- which is what a manifest is for -- wrote
  `--title` and got a usage error. Additive: every existing key, `fields`
  included, is unchanged (QCLI-266).

  Both surfaces and the argv parser now read one table, so what help reports,
  what the manifest declares, and what the CLI accepts cannot drift apart.

### Fixed

- A write conflict on `task complete`/`archive`/`pause`/`start`/`demote` and
  the `draft` mutations is now the documented `conflict` failure (exit 5)
  rather than a success envelope, exit 0, carrying `kind: "conflict"` inside
  `data`. Only the unwrapped commands ever had this; `task create`/`edit`
  already classified it (QCLI-264).
- `quest init --plain` no longer prints the literal word `undefined` for a
  field it never selected (`agentSkillSource`, `instructionsByTarget`).
  Display-only: the identical `--json` invocation always omitted both keys
  correctly, and the underlying writes were correct. `src/cli/render.ts`'s
  object renderer kept a key whose value is JS `undefined` -- unlike
  `JSON.stringify`, which drops it -- and rendered it as the literal string.
  Fixed at the shared renderer, which protects every command that assigns an
  optional field straight into a data object, not just `quest init` (QCLI-272).
- `--check-ac`/`--uncheck-ac`/`--remove-ac` (and the `--*-dod` equivalents)
  addressed the wrong checklist item: every display surface numbers
  acceptance criteria and definition-of-done items starting at 1, but these
  flags read that same number as the 0-based `index` -- `--check-ac 3` on an
  item printed as position 3 silently checked the fourth item instead. Every
  envelope now carries an additive, presentation-matching 1-based `position`
  alongside the unchanged 0-based `index`; the flags take the printed
  `position` verbatim, and help/agent-guide text no longer describes a
  numbered list that did not exist (QCLI-269).
- The shared usage-error path (`only()` in `src/cli/main.ts`, 37 call sites)
  discarded which flag was rejected, so a caller who supplied every required
  flag correctly plus one unrecognized one was still told a reference or
  actor was missing -- `task complete --final-summary ...` was the reported
  case, since `--final-summary` was not yet an accepted flag on `task
  complete` at all. Both are fixed: `task complete` now accepts
  `--final-summary`, applied in the same write as the terminal transition,
  and 21 of the 37 call sites now name the actual unrecognized flag instead
  of a generic reference/actor sentence. The remaining 15 (the `migration
  backlog`, `milestone`/`decision`, and `draft` action dispatchers) use a
  positive-gate-per-action shape that cannot take this fix without a larger
  restructure and still report the old generic message -- tracked separately
  rather than left silently inconsistent (QCLI-270; the remaining 15 sites
  are QCLI-282).
- A task or draft record present under more than one `.quest/` storage
  location -- the shape a partial `git add` produces -- took down every
  `quest task` command with a bare, unactionable error. The error now names
  every colliding id and its exact file paths, plus sanctioned `rm`/`git rm`
  recovery guidance, instead of a message with nothing to act on (QCLI-261).
- `migration backlog status`/`rollback` reported a not-yet-previewed digest
  as `error_type: "validation"` (exit 6), not `"not_found"` (exit 3),
  contrary to the Opum result contract's not-found convention -- a caller
  branching on `error_type` to distinguish "malformed input" from "no such
  record" could not do so reliably. Reclassified to `not_found`; a
  differently-shaped digest-mismatch case on `apply()` stays `validation`
  deliberately, recorded as DEC-2 (QCLI-257).
- `release.yml`'s post-publish registry-verification step hard-failed the
  whole release if any of the seven npm packages was not yet visible within
  a flat 5-minute window -- and had already false-failed a successful
  publish twice (0.4.0, 0.5.0), both times on `quest-win32-arm64` alone
  propagating slower than the other six platforms. Widened to 12 attempts
  with exponential backoff (15s/30s/60s, capped), about 2.75-3x the old
  window, while the common fast case is unchanged; the step's output now
  also names which of two failure classes occurred (QCLI-247).

### Known limitations

- **0.6.2 ships without a provenance attestation, because provenance
  requires the CI OIDC path, which is currently dead.** GitHub's org-wide
  immutable-subject-claim policy rejects the subject-claim shape npm Trusted
  Publishing expects (unrelated to the 2026-09-10 repository recreation
  below), so 0.6.2 was published manually instead; a manual publish cannot
  produce an attestation. Expected, not evidence of tampering.
- **Versions published before 2026-09-10 carry permanently dangling
  provenance links** (the repository recreation destroyed the commits/build
  runs they point to) **and cannot be repaired -- npm forbids republishing a
  version.** Affects 0.3.0 through 0.6.0 and the never-published `v0.6.1`
  tag. See `docs/runbooks/quest-cli-package-and-release.md`.

## 0.6.1 - 2026-09-13 (tagged, never published)

Tagged at `1fa0fef` and **never published**. Every publish attempt failed a
registry E404 before writing anything: `actions/setup-node` exported a
placeholder `NODE_AUTH_TOKEN` that defeated OIDC trusted publishing. That was
a CI-only defect with no content change of its own. No package reached npm
under this number. The content it would have carried shipped as 0.6.2 (see
that entry). The `v0.6.1` tag stays where it is and is not re-pointed,
because `quest-web`'s CI cites this repository's tags.

## 0.6.0 - 2026-09-09

Lockstep with `@opum-ai/lore` 0.6.0, same pairing convention as every release
since 0.5.0. Minor, not patch: new instruction-file targets and a changed
interactive default are user-visible capability, not a breaking change to any
existing flag, envelope shape, or manifest entry -- every scripted
`--target`/`--agent-instructions` path stays byte-identical to 0.5.0,
verified by the existing test suite needing zero edits across all of it.

### Fixed

- `task list --ready` no longer throws `dependency_target_not_found` for the
  whole workspace when a task's `parentId` or dependency points at an
  archived task. `TasksService.listFilteredLocated`'s readiness computation,
  and the standalone `TasksService.ready()`, now resolve the dependency
  graph across every task location (including `archive/tasks`) while still
  respecting the existing archive exclusion for what `--ready` actually
  returns (QCLI-249).
- `task create`'s `--label`/`--doc`/`--alias`/`--assignee`/`--reference`/
  `--modified-file`/`--dependency`, and their `--add-*`/`--remove-*`
  counterparts on `task edit` (plus `--remove-comment`), now reject a
  JSON-array-shaped value as a usage error instead of silently storing the
  whole array string as one malformed entry (QCLI-250).
- `quest init`'s interactive path now presents a multi-select listing every
  supported instruction file -- CLAUDE.md for Claude Code, AGENTS.md for
  Codex/OpenCode/pi/etc., GEMINI.md for Google Antigravity/Gemini CLI --
  instead of hardcoding AGENTS.md with no way to discover `--target claude`.
  A caller can tick zero, one, or more, with nothing pre-checked -- a bare
  Enter writes nothing (QCLI-254 added the initial claude/codex prompt;
  QCLI-255 replaced it with a multi-select per direct user request and
  reversed the initial pre-check-claude default to nothing pre-checked once
  the multi-select removed the forcing function that default was reasoned
  from; QCLI-159 widened the target set to three, confirming against each
  tool's own docs that pi and OpenCode need no dedicated file while
  Antigravity's GEMINI.md genuinely does). `--skill-source plugin` given on
  the same command line as `--agent-instructions` now skips the skill-file
  write, rather than being silently overridden by it; `--target`'s own
  unset default for scripted callers stays `codex`, unchanged, and the
  non-interactive `--target claude|codex|antigravity` flag path is
  untouched by any of this (QCLI-254, QCLI-255, QCLI-159).
- `quest instructions` and `quest agents --update-instructions` deliberately
  stay single-target, recorded rather than left as an unstated gap: `init`
  is the interactive onboarding path; these are maintenance commands driven
  by scripts and CI that already know their target via `--target` (QCLI-159).
- `migration backlog preview`/`apply`'s id-collision error now names both
  causes it can mean -- a positional-renumbering shift (a dotted subtask's
  flattening landing a fresh id on an unrelated sibling's), where
  `--preserve-source-ids --source-family <PREFIX>` genuinely resolves it,
  and a genuine dual claim (the destination workspace already holds the
  exact id an incoming record also claims), where that flag cannot help --
  and says so directly instead of repeating advice that already failed
  (QCLI-256).

## 0.5.0 - 2026-09-08

**The jump from 0.4.x to 0.5.0 is a lockstep version sync with `@opum-ai/lore`
0.5.0, not a breaking change.** From this release on, Quest and Lore move
together at every stacked release: one version number naming the pair. Nothing
in Quest's public contract (envelope shape, manifest, command surface) changed
in a way that would otherwise call for a minor bump on its own.

### Fixed

- `task edit-batch` now reaches completed and archived records instead of
  reporting the misleading `task_not_found` (QCLI-243), closing the same gap
  QCLI-219 fixed for the single-item `task edit` path.
- `task edit` reaches completed and archived records instead of
  `task_not_found` (QCLI-219).
- `quest agents --check` no longer fails CI on a version skew alone: a block
  that differs from the installed CLI only in its embedded version number now
  reports `"version-only"` and exits 0 rather than failing closed on a routine
  patch/minor bump (QCLI-228).
- `quest agents --update-instructions` now removes a leftover Backlog.md
  guidelines block instead of leaving it alongside the current Quest block
  (QCLI-215).

### Added

- Isolated `renumbered` field on `migration backlog preview`'s output
  (`--preserve-source-ids` mode): exactly the mappings a dotted-subtask
  translation actually changed, so a caller no longer has to diff the full
  `mappings` list by hand to see what a migration is about to do (QCLI-168).
- `.github/workflows/promotion-guardrails.yml`: `promotion-is-manual` and
  `main-is-fast-forward-of-dev` back this repository's fast-forward-only
  `dev` → `main` promotion procedure with active CI detection (QCLI-244).

### Documented

- Status and on-disk location are independent by design: `task edit --status
  <terminal>` does not relocate a record, only `task complete`/`task
  archive`/`task demote` do (QCLI-221).
- `task create`'s forward-dependency validation (`dependency_target_not_found`)
  is documented as deliberate, fail-closed behavior (QCLI-62), with a
  two-pass create-then-`--add-dependency` workaround now shown in the
  task-creation guide and hinted at from the CLI error itself (QCLI-163).
- `quest help task edit` now explains 1-based CLI checklist positions versus
  the JSON envelope's 0-based `index`, that removal renumbers everything
  after it, and the exact JSON shapes `--comments`/`--add-comment` and `task
  edit-batch` expect (QCLI-226).
- Closed out the Backlog.md tracker-surface parity triage register: all
  decided gaps re-verified against current source with no drift, and the
  `doc`/`config`/`mcp` exclusion policy now has a citable source (QCLI-134).
