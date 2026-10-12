---
# yaml-language-server: $schema=../../.lore/schemas/reference.schema.json
type: Reference
title: Quest board hooks module in the opum-quest plugin
tags:
  - quest-board
  - opum-quest
  - plugin
  - hooks
  - mod
summary: "Design, gates and limits of the Quest board mod shipped in the opum-quest plugin: the execution choices, the alternatives rejected, and which half of its qualification runs only on a machine."
timestamp: 2026-10-02T16:50:38.326Z
---

# Quest board hooks module in the opum-quest plugin

The `opum-quest` plugin ships two things from this repository: the `quest` skill
and a Claude Code **hooks module** — the Quest board, a pane listing the tasks
being worked on in the session's own repository and editable there. This doc
records what the module is, the execution choices behind it, the alternatives
that were rejected, and the one half of its qualification that runs only on a
machine.

Built under [QCLI-431](../../.quest/tasks/QCLI-431.json), from the design brief
at `opum-doc` `docs/reference/quest-board-mod-design-brief.md` and a
session-local prototype. Fleet mode — the pane's read of every Quest workspace
under a discovered root — was **removed** by
[QCLI-490](../../.quest/completed/QCLI-490.json) under DEC-172 (4bg) item 1 (a):
the board, the alerts and the `dashboard` tool read this session's own
repository and nothing else.

## What the module is

| Path | What it holds |
|---|---|
| `hooks/register.tsx` | The pane: list and kanban tabs, search, status picker, detail with acceptance criteria, comments and the latest note, collapse. |
| `hooks/quest.ts` | Argv building, both `task list` parsers, coverage parsing, and the session's own repository name — split out so they are testable without a surface. |
| `types/index.d.ts` | The module's state contract and its drawn shapes. |
| `tests/` | Three engine test files, run by Claude Code's own runner. |
| `.claude-plugin/plugin.json` | The manifest: the types contract and the actor option. |
| `scripts/mod-test.mjs` | Stages what the plugin ships and runs the three tools against the stage. |

## Auto-start, the clocks, and what a refresh does (QCLI-490, DEC-172 (4bg) item 1)

`session.start` opens a pane, registers a clock and runs its initial read-back
**only in a process a person is at the prompt of**. When `!e.isInteractive` (a
headless `-p` run, the SDK, a dynamic-workflow child) or
`$.env.get("CLAUDECODE") === "1"` (a teammate), it registers the `dashboard`
tool and stops: no pane, no clock and no read, so the process spawns no child at
all for a view nobody draws. That is the 2026-10-12 host-load incident's fix —
host load reached ~315 with every Claude process opening the board and re-reading
on its own clock. An explicit open by the person (the tool, or the band's
button) still works in a gated process, and starts the clock from then on.

The clocks are **once per process** and cancelled at `session.end`:

- **The refresh clock** (60 s) is registered behind a module guard, its handle
  kept, and it does its work only while the pane is shown.
- **The alerts clock** (120 s) is once per process too, and cancelled the same
  way.
- **The WHOLE tick callback is guarded in flight.** A tick that finds the
  previous one still running is **skipped**, never stacked — the incident's
  shape was a `void (async …)` callback returning at once while the next tick
  started on top of it.
- **A person's explicit refresh that finds a read in flight is COALESCED, not
  dropped**: one more read runs after the current one, with the view as it
  stands then. Dropping it left the board drawing the view the person had
  already replaced.
- **No tick spawns more than three subprocesses**, and every subprocess carries
  a timeout. The refresh tick runs two — one `task list` and one `git status`.
  The alerts tick runs its two reads plus, still inside the same budget, the one
  `task view` it uses to tell a Done task from a Closed one; a tick with more
  departed tasks than the budget allows classifies what it can and carries the
  rest into the next tick rather than dropping them.

The counts this rests on — real processes spawned and watched, both ways, with
the gate removed as a control and an eight-process soak — are in
[QCLI-490](../../.quest/completed/QCLI-490.json).

## The plugin root stays the repository root

The engine's runner takes every `*.test.ts`/`*.test.tsx` under the directory it
is given, and this repository's own suite lives in `test/`. Moving the plugin
into a subdirectory would give the runner a clean folder — but it restructures a
shipped plugin and changes `opum-marketplace`'s entry shape from a ref pin to a
`git-subdir` source. Rejected for that reason, not because it does not work.

The cost accepted instead: the module is tested against a **stage**, a temp
directory `scripts/mod-test.mjs` builds from the files the plugin ships. That is
also the benefit — the tests exercise exactly what ships, and nothing else.

This is recorded as an execution choice, not an ADR. Under the operating
model's design authority every ADR is the operator's, including one about a
single component.

## What runs where

`scripts/mod-test.mjs` has three steps, and it names the state each reached.

- **`claude plugin validate --strict`** — real everywhere, including CI.
  `--strict` is the validator's CI arm: it fails on unrecognized fields and
  missing metadata that the runtime merely tolerates.
- **`claude plugin test`** — real everywhere, including CI. Measured on a clean
  `HOME` with no credentials: both this and `validate` run and need neither, so
  the CI job installs only the CLI.
- **`tsc` against the engine's TypeScript declaration** — **machine-local**.

Validated at the repository root as well as against the stage, and the two
differ in one respect worth recording: the root passes with a warning that
`CLAUDE.md` at the plugin root is not loaded as project context, so the root
would **fail** under `--strict` while the stage passes it. That is not a defect
to fix here — the warning is about a file the plugin does not ship, and shipping
context is a skill's job — but it is why the gate runs `--strict` against the
stage rather than against the checkout.

The typecheck is machine-local by construction, not by preference. The engine
writes its declaration beside a module only when a **session** loads that module
from a folder the person owns; `claude plugin test` does not write one. Measured
directly: after `claude plugin test` ran against a stage, the stage's
`.claude-plugin/` held `plugin.json` and nothing else. The runner therefore uses
the copy the `plugin-authoring` skill leaves in the machine's temp directory,
preferring one whose own first line names the running Claude Code version, and
when neither exists it prints `NOT TYPECHECKED` and **says so in its closing
line** rather than printing the same sentence it prints on success — the
difference between the two is invisible in an exit code, and an exit code is
what CI reads.

**What would change this: the engine writing its declaration under
`claude plugin test`.** Then the typecheck becomes gateable in CI with no
change here.

**The alternative rejected** is vendoring the declaration into the repository: a
746 KB, 20,112-line file whose own header says *"EARLY ACCESS: this surface may
change between releases without notice"*. Its lifecycle would move with every
CLI version, against a fleet that is deliberately frozen on one — a maintenance
cost larger than the coverage it buys. So the typecheck's guarantee in CI is
`validate`'s reading of the module's source, which is real but narrower.

## The id-collision window, and what the pane owes

`quest task create` takes the next id from the working tree plus every **local**
ref. A record that is written but not committed is therefore invisible to this
repository's *other* checkouts, and a create in one of those mints the same id.

Reproduced while building this: two worktrees of one repository, a create on
`main` left uncommitted, then a create on a branch — **both minted `T-1`**.
Committing the first closed the window and the next create minted `T-2`.

The pane cannot close that window. Only landing the record does, and a pane that
commits to Git on the person's behalf would be writing outside the Quest
lifecycle commands its write boundary is defined by. What it owes the person is
the window being **legible at the moment it opens**: the unlanded banner names
what an uncommitted record costs, and that read is lazy — from the session start
*or* the first read — because it previously ran only from `session.start`, which
`claude plugin test` never fires, so a kit-mounted pane drew no window at all.
No window looks exactly like nothing worth warning about.

The detection half is a CLI change and is filed separately: `quest task list
--across-refs` treats the same id on two refs as two *states* of one task and
picks no winner, which is right for one task whose status differs across refs
and silently wrong for a genuine collision. See
[QCLI-432](../../.quest/tasks/QCLI-432.json).

## Scope deliberately not taken

- **Keyboard card movement on the kanban** (brief recommendation 5) is deferred.
  The list tab carries every edit; card movement is new behaviour and new test
  surface that was not asked for.
- **Editing from a view of other repositories** is not reached, and can no
  longer arise: fleet mode went with QCLI-490, so the board only ever draws the
  one repository the pane may write in.
- **The actor identity for pane edits** is the operator's, and is the one thing
  in the build that is not this repository's to settle.

## Where the module meets the repository's own gates

The module is invisible to both gates that already existed: `bun run typecheck`'s
tsconfig covers `src` and `test`, and `bun test` cannot run the module at all —
measured, a bare `bun test` collects all three module test files and fails each
on `Cannot find module 'claude-code/testing'`, the engine's kit, which exists
only under the engine's runner.

So the repository's gates name it explicitly: `bun run check` ends with
`test:mod`, `scripts/qualification/prepublish.mjs` carries a `mod` gate (which
is what makes it a CI result rather than a local habit), and the
prepublication-qualification workflow installs the pinned Claude Code CLI and
watches `hooks/**`, `types/**`, `tests/**`, `.claude-plugin/**` and
`scripts/mod-test.mjs`.
