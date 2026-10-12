---
# yaml-language-server: $schema=../../.lore/schemas/arc.schema.json
type: Story
title: Ship the Quest board mod in the opum-quest plugin
tags:
  - quest
  - plugin
  - board
  - release
summary: Build the Quest board hooks module into the opum-quest plugin and release it, so an operator reads and edits the tasks in flight across their Quest workspaces from a pane.
timestamp: 2026-10-02T21:47:47.952Z
status: done
tasks:
  - qcli-431
  - qcli-433
---

# Ship the Quest board mod in the opum-quest plugin

## Goal

Give the operator a pane over work in flight: the tasks being worked on across
their Quest workspaces, read through the Quest CLI and editable in the session's
own repository. The mod is a hooks module shipped inside the opum-quest plugin,
which is cut from this repository at the CLI's own tag, so the board reaches a
plugin user only once a release carries it and the marketplace pin moves to that
release.

The instruction of 2026-10-02 (relayed by opum-doc as ODOC-OP-2026-10-02-10,
tracked in opum-agent as OPAG-1074) names the design brief. The module's own
execution choices, the alternatives rejected, and the scope deliberately not
taken are recorded in the
[Reference](../reference/quest-board-hooks-module-in-the-opum-quest-plugin.md)
rather than repeated here.

## Acceptance criteria

- The plugin ships the board: `hooks/hooks.json` names one module, the module
  typechecks against the engine declaration, and `claude plugin validate` and
  `claude plugin test` pass on the pinned Claude Code version.
- The fleet view reads a discovered repository set that the plugin's
  `userConfig` configures, always including the session's own repository, and
  the repository-true read (`quest task list --across-refs`) is offered as a
  toggle that draws cross-ref disagreements and incomplete coverage as such.
- A pane write happens only in the session's own repository, through Quest
  lifecycle commands, with an explicit actor on every write and `--if-revision`
  on field edits.
- The repository's own checks run the mod suite, so a failing mod test fails the
  gate rather than passing unrun.
- A release carrying the mod is published under the operator's authorization,
  and the marketplace pin moves to it, so a plugin user gets the board by
  updating rather than by building.

**Note, 2026-10-12 — the fleet-view criterion is kept as written, and is no
longer a live requirement.** QCLI-490 retired fleet view under DEC-172 (4bg)
item 1 (a): the board, the alerts and the `dashboard` tool now read the
session's own repository and nothing else, and the `root`/`repos` options, the
scope toggle and the repo picker are gone. The criterion above is not edited —
a met criterion is not rewritten, which would falsify history — so it stands
with this note, and (4bk) disposition A is the ruling behind that. What the
requirement becomes is tracked as QCLI-494's third criterion.

## Tasks

<!-- lore:tasks:begin -->
| Task | Title | Status |
|---|---|---|
| [QCLI-431](../../.quest/completed/QCLI-431.json) | Ship the quest-board mod in the opum-quest plugin (OPAG-1074) | Done |
| [QCLI-433](../../.quest/completed/QCLI-433.json) | Release quest-cli 0.13.0, paired with lore 0.13.0, so the opum-quest plugin ships the Quest board mod | Done |
<!-- lore:tasks:end -->

## Notes

One design question stays with the operator and is not decided by this Story:
edits made from a fleet view. The actor identity for pane edits was decided as
DEC-134 A — a pane edit is recorded as the person, `--actor <configured id>
--actor-kind human` — which is what the manifest already shipped.
