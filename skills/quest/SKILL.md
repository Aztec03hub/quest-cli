---
name: quest
description: "Drive this repo's task tracker with the quest CLI instead of editing backlog/tracker state directly. Use whenever creating, listing, viewing, editing, completing, or archiving tasks, drafts, milestones, or decisions in a Quest-initialized workspace. Run `quest instructions --list` for the workflow guides and `quest help [command]` for full usage."
---

# quest — tracker CLI

This skill is a pointer, not a manual, installed from the `opum-quest` Claude Code
plugin rather than generated into this repository. The guidance ships inside the CLI,
so it cannot drift from the release you have installed:

- `quest instructions --list` — the workflow guides, one line each.
- `quest instructions overview` — start here.
- `quest instructions` — the versioned protocol block Quest manages in your instructions file (AGENTS.md, CLAUDE.md, or GEMINI.md).
- `quest help [command]` — exact flags; `quest manifest --json` for the machine registry.

`quest dashboard` — then `full` or a task id, in any combination — opens the board in ONE
call to `mcp__opum-quest__dashboard` (`full`, `task`), so "quest dashboard full" asks for
both. Every argument that does not start at `dashboard` goes to the `quest` CLI as before
— "quest board" included, which the CLI already serves. Where the tool is unavailable
(Claude Code older than 2.1.287, a `claude -p` run, or mods off), say the pane is
unavailable here and answer from the CLI instead.

Drive tracker state through `quest`, never by editing `.quest/` by hand.

Coming from Backlog.md? The `migrate-from-backlog` skill drives
`quest migration backlog` preview, apply, status and rollback.
