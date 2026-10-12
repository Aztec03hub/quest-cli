---
name: migrate-from-backlog
description: "Move a repository's Backlog.md records into Quest, from inside Claude Code: preview the migration, choose whether to keep Backlog's ids, apply exactly what was previewed, verify it, and roll it back if needed. Use whenever someone asks to migrate from Backlog.md, move a backlog/ directory to Quest, import Backlog tasks into the tracker, or check on or undo a migration already applied."
---

# migrate-from-backlog — Backlog.md to Quest

`quest migration backlog` is a four-step lifecycle: `preview` writes nothing,
`apply` writes exactly what one preview described, `status` reports what landed,
and `rollback` undoes an applied migration. This skill drives that lifecycle and
stops at every step that writes, for the person to approve.

The tracker itself is `quest` — see the `quest` skill and `quest instructions
workspace` for the command set. This skill is a procedure, not a substitute:
read `quest help migration backlog` for flags, and never re-derive a mapping
Quest has already reported.

**Backlog.md and Quest are different trackers with different id shapes.** Backlog
numbers positionally and allows dotted subtask ids (`ODOC-63.2`); Quest's ids are
flat and stable. Deciding what the ids become is a real choice, so step 2 asks
rather than assuming.

## Step 1 — Find both sides, and write nothing

Find the Backlog.md project: a `backlog/` directory in the repository, or a path
the person names. It holds `tasks/`, `completed/`, `drafts/` and possibly
`archive/`. A Backlog project that lives elsewhere is reached with
`--backlog-dir <path>`.

Then check for a Quest workspace — `.quest/workspace.toml`.

**If there is none, say so and stop.** Propose `quest init` and wait for the
person to agree before running it. A repository with no workspace is not an
error; it is a step that has not happened yet.

## Step 2 — Choose what the ids become

Ask with **AskUserQuestion**, because this choice is visible in every later
citation of the migrated records and cannot be undone by re-running:

- **Renumber positionally** (Quest's default) — the records get the workspace's
  own next ids. Choose this when nothing outside the repository cites the old
  ids.
- **Keep Backlog's ids** — `--preserve-source-ids --source-family <PREFIX>`. The
  records keep their own ids. A Backlog project holding more than one id family
  imports one family per run, so the prefix has to be named.

Preview reports the families it found; show them before asking. A dotted subtask
id has no flat equivalent, so it is translated to a fresh id in the family with
its dotted spelling kept as an alias and its parent threaded through — worth
saying out loud, because it is the one mapping that is not identity.

## Step 3 — Preview, and show what it found

```
quest migration backlog preview --source <path> --json
```

with `--backlog-dir` and the step-2 id flags exactly as they will be passed to
`apply`. **Preview writes nothing.** Run it before every apply; a digest is only
good for the source state it was minted from.

Show the person: how many records were found, a sample of the mappings, and the
digest. `renumbered` (in preserve mode) isolates the mappings the translation
actually changed, so nobody has to diff the whole list to see what is about to
move. Report a refusal — an id collision or an unresolvable parent — as the
finding it is, listing every one the run reported, rather than retrying with
different flags to get past it.

## Step 4 — Apply, on approval, and only what was previewed

Ask with **AskUserQuestion**: apply this exact digest, or stop. Say which digest
and what it will write.

On yes:

```
quest migration backlog apply --source <path> --digest <digest> \
  --actor <id> --actor-kind human
```

**The actor is the person who approved, with `--actor-kind human`** — DEC-134's
ruling for writes a person authorised. It is not the agent, and not a
`delegated-agent` declaration: the approving person is the one accountable for
the import. Ask for their actor id if it is not already known in the session.

Re-supply `--backlog-dir`, `--preserve-source-ids` and `--source-family` exactly
as preview was given them. **The digest is the one just previewed — never a
digest from earlier in the conversation, and never one the person pasted in.**
If the source changed since that preview, `apply` refuses with a source
fingerprint conflict; that refusal is the guard working. Re-preview and ask
again rather than working around it.

## Step 5 — Verify and report

```
quest migration backlog status --digest <digest>
quest check
```

Report what landed: the count, the ids, and anything the checks flagged. Read
the mappings from this output rather than restating what the preview predicted —
they should agree, and where they do not, that disagreement is the finding.

## Step 6 — Hand the commit back to the person

The migrated records are files in the working tree. **This skill does not
commit.** Tell the person to land them through the repository's normal branch
and pull-request flow — the `opum-sdlc` skill if it is installed — and say why
it matters beyond tidiness: until the records are committed, other checkouts of
the repository cannot see the ids in them and can mint the same ones.

## Step 7 — Undo, if asked

```
quest migration backlog rollback --digest <digest> --actor <id> --actor-kind human
```

Ask with **AskUserQuestion** before running it, and say what will be undone.
Rollback restores the tree the apply ran against; a rollback runs against the
digest it is undoing, so ask which migration is meant if more than one was
applied.

## What this skill never does

- **Never deletes `backlog/`.** The Backlog source is left exactly as it was
  found, and it is the person's to remove once they have checked the import —
  name the command if they ask, and let them run it. Removing it is the one step
  here that cannot be undone from Quest's side.
- **Never commits.** Step 6 hands that back.
- **Never applies a digest other than the one just previewed**, and never
  re-derives mappings itself instead of reading Quest's output.
