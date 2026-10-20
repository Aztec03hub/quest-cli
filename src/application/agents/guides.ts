/**
 * The workflow guides `quest instructions <guide>` serves.
 *
 * These are the single home for Quest's agent-facing workflow guidance. The
 * bundled skill (`questSkillContent`) deliberately points here instead of
 * restating any of it: two copies of the same guidance drift, and the drift is
 * invisible because both look authoritative. A test asserts the two share no
 * substantive sentence.
 *
 * Loading is just-in-time by design, which is why there is no `all` guide:
 * bundling them defeats the point of splitting them, and `--list` already
 * covers discovery.
 */
export interface QuestGuide {
  readonly name: string;
  /** One line, shown by `--list`. */
  readonly summary: string;
  readonly content: string;
}

const overview = `# Quest overview

Quest is a deterministic, envelope-based tracker CLI: task, draft, milestone and
decision records, an explicit actor on every write, and machine-stable exit
codes. Reach for it rather than a raw editor on \`.quest/\` whenever you create,
read, edit or complete tracker state, so writes stay attributed and consistent.

## Before you act

1. Confirm the workspace is initialized: look for \`.quest/workspace.toml\`. If it
   is missing, see \`quest instructions workspace\`.
2. Search before you create, and read before you change. \`quest search "<query>"\`
   and \`quest task view <id> --json\` cost far less than a duplicate record.
3. Every write needs \`--actor <actor> --actor-kind human\`, or \`delegated-agent\` with
   \`--accountable-human <id>\`.
4. Run \`quest doctor\` when the workspace looks inconsistent, rather than working
   around it by hand.

## Commands

- \`init\`                       Initialize a Quest workspace in the current Git worktree
- \`instructions\`                Print the managed agent-instructions block, a workflow guide, or \`--list\`
- \`agents\`                      Check or update the managed agent-instructions block
- \`help\` / \`manifest\`           Human-readable help, or the machine command registry
- \`task list\` / \`task view\`     List or view tasks
- \`task list --across-refs\`     List tasks across origin/dev AND every open PR head into dev, with per-state provenance and coverage (QCLI-417); \`--allow-partial\` accepts incomplete coverage
- \`task create\` / \`task edit\`   Create or edit a task
- \`task edit-batch\`             Apply a batch of task edits from a JSONL operations file
- \`task pause\` / \`start\`        Park an In Progress task, or bring it back
- \`task complete\` / \`archive\` / \`demote\`   Move a task through its terminal or prior status
- \`task close\`                  Retire a never-worked task as a duplicate, superseded, or won't-do
- \`task status-flow\`            Print the configured task status set and terminal statuses
- \`task binding\`                Bind an agent to a task under the Opum workflow contract
- \`draft create/list/view/promote/archive\`   Draft lifecycle (an idea not yet promoted to a task)
- \`milestone list/view/create/edit/archive/delete\`   Milestone lifecycle
- \`decision list/view/create/edit/delete\`    Decision-record lifecycle
- \`question ask/answer/withdraw/list/view\`   Operator-question lifecycle; asked by a session and answered by the operator in the Quest pane (opum-doc seq 179(a), DEC-190)
- \`search [--all]\`              Search tasks, or tasks + milestones + decisions together
- \`overview\` / \`board\` / \`doctor\`   Project overview, kanban-style board, or consistency check
- \`check\`                      Run a named check; \`--continuity --base <ref>\` fails when a task record id or alias present at the merge base resolves nowhere now
- \`cleanup\`                     Remove closed, unreferenced milestones and superseded decisions
- \`migration backlog preview/apply/status/rollback\`   Backlog.md-to-Quest migration lifecycle
- \`browser\`                     Start a local read-only web server showing the overview and board
- \`completion bash\`             Print a shell completion script

Exact flags for any of them: \`quest help <command>\`, or \`quest manifest --json\`
for the same registry without the prose.

## Machine contract

Every command supports \`--json\` and \`--plain\` (human-readable, auto-selected
off a TTY). Branch on the semantic exit code, never on prose: \`0\` ok, \`2\`
usage, \`3\` not_found, \`4\` denied, \`5\` conflict, \`6\` validation or drift.

\`--json\` emits one of TWO envelope shapes, and they share no payload key:

- success: \`{schemaVersion, contractVersion, kind, data, principal}\`
- error:   \`{error_type, message, principal}\`

**The record you asked for is under \`data\`, never at the top level.** Reach for
it as \`.data\`, and read the exit code to know which shape you have. A path
naming a top-level \`id\` or \`title\` matches nothing and prints \`null\` for every
field, which looks like a record that came back empty rather than a path
pointing one level too high. If a projection comes back all-null, print the key
set (\`jq 'keys'\`) before concluding anything about the record.

Some commands add a key of their own between \`data\` and \`principal\` -- \`task
list\` carries \`scope\`, for instance. **\`principal\` is always the last key**, and
a caller must tolerate a top-level key it does not recognize rather than
treating the envelope as malformed.

**Narrow a read with \`--fields\`.** \`task list\` and \`task view\` both accept
\`--fields <a,b,...>\`, which projects \`data\` to exactly the top-level keys named,
in the order given. Under \`--json\` each item carries exactly those keys -- a
named field absent from a record is \`null\`, never a dropped key -- and the human
form is one TAB-separated line in that order. The accepted names are exactly the
fields \`quest manifest --json\` advertises for the command, and an unknown name
exits \`2\` naming the valid ones. When a bound was supplied and its bounded field
is among the named fields, the projection also carries that bound's omission
marker beside the named keys, under its own key name -- so \`task view --max-notes
N --fields implementationNotes\` carries \`notesOmitted\`. The marker is JSON-only:
the human form is still just the named columns. A projection never emits a
\`fieldsOmitted\` key of its own.

Quest never retries a write conflict for you. On exit \`5\`, re-read the latest
record and perform your own bounded retry rather than resubmitting a stale write.

## Other guides

\`quest instructions --list\` enumerates them. Read the one that matches what you
are about to do, not all of them.
`;

const taskCreation = `# Creating tasks

Create a task when the work needs planning, a decision, or a handoff note. If
you would not have to think about how to do it, just do it.

## Search first

\`quest search "<query>" --json\` covers task ids, titles, summaries, descriptions,
aliases and labels; add \`--all\` to include milestones and decisions. Reading one
likely match with \`quest task view <id> --json\` is cheaper than discovering the
duplicate later.

## Then scope it

Ask whether the work lands in one reviewable change. If it does not, create the
parent first and hang subtasks off it with \`--parent <id>\`; if the pieces belong
to different components, prefer separate tasks joined by \`--dependency <id>\`.
Dependencies are what \`quest task list --ready\` reads, so an honest edge here is
what lets the next agent pick work safely.

A parent organizes scope; it implies no ordering and is not a substitute for a
dependency. Reserve \`--dependency\` for a prerequisite the target actually needs
before it can start -- not every alternative approach you considered and set
aside, which only makes \`--ready\` wait on work nobody is actually blocked on.

## Create it

\`\`\`
quest task create "<title>" --actor <actor> --actor-kind human --json \\
  --description "<why this exists>" \\
  --acceptance-criteria '["<observable outcome>"]' \\
  --label <label> --dependency <id>
\`\`\`

Write acceptance criteria as outcomes someone else could verify without asking
you what you meant. An id is allocated for you; pass \`--id\` only to reserve a
specific one.

A criterion also has to stay true until someone checks it. Do not put a count
of anything the task does not control into a criterion: live processes, open
pull requests, records in a directory, rows in a report. The world keeps moving
while the task is open. "The three leaked daemons are reaped" goes false as
soon as a fourth one starts. It is still clear and still checkable, but it is no
longer true, so whoever checks it either ticks it against a stale number or
cannot tick it at all. Write that kind of criterion to enumerate when it is
checked, for example "every leaked daemon alive at fix time is reaped". A count
of what the task itself produces is safe, such as the files it changes or the
flags it adds. A count of live or external state is not safe. The problem is a
number that goes stale, not numbers in general.

## Auto-allocated ids are refs-aware

Omitting \`--id\` checks every local branch and remote-tracking ref for the same
prefix, not just the current working tree. A sibling branch carrying an
unmerged record, or a detached checkout sitting behind a branch that has since
moved, no longer produces a silent duplicate id -- allocation takes the highest
sequence number visible across every local ref, not only the one checked out.
This only consults refs that already exist locally; it never fetches. A
\`.quest\` directory with no Git repository behind it keeps allocating from the
working tree alone, exactly as before.

**This covers all four id families**: tasks (QCLI-279), and drafts, milestones
and decisions (QCLI-290). Between those two releases the guarantee held for
tasks only, and this section said so in a way that read as covering the rest --
which is how two sessions independently minted \`DEC-3\` on 2026-09-14. A
draft, milestone or decision id allocated before QCLI-290 shipped was minted
under the narrower rule, so an existing collision is not repaired by upgrading.

The mechanism differs beneath the two, and the difference is deliberately
invisible here: tasks and drafts are stored one record per file, so their ids
are read from file names, while milestones and decisions share a single
\`.quest/planning.json\` and are read out of its content. Both degrade the same
way -- an unreadable or unparseable document on some unrelated branch is
skipped, and the remaining refs are still consulted.

**A duplicate id is still possible, and \`--across-refs\` reports it.** The
allocator consults \`refs\`, never another checkout's uncommitted working tree, so
two uncommitted \`create\` calls in two checkouts of one repository can both mint
the same id; committing one closes the window (this is the QCLI-431 shape).
\`task list --across-refs\` distinguishes that genuine collision from one
task whose states disagree across refs. An entry's \`identity\` takes exactly
three values: \`task\`, \`collision\`, \`unresolved\`. It is \`task\` when every
state carries the same \`createdAt\` (one record, read from several refs),
\`collision\` when every state carries one and there are two or more distinct
\`createdAt\` values (different records that happen to share an id), and
\`unresolved\` when ANY state in a group of two or more carries no \`createdAt\`,
so the states cannot be compared. An unresolved pair is reported as
\`unresolved\`, never assumed to be one task. A LONE state -- a group of fewer
than two states -- is always \`task\`, whatever its record carries: there is
nothing to compare it against, so a one-state group with no \`createdAt\` is
\`task\`, not \`unresolved\`. Resolve a collision by landing one record and
deleting the other.

## Type and priority come from the workspace's vocabulary

A workspace can declare the values \`--type\` and \`--priority\` accept, in the
\`[tasks]\` table of \`.quest/workspace.toml\`. \`quest init\` writes the canonical
default: types \`feature\`, \`bug\`, \`chore\`, \`docs\`, \`enhancement\`, \`spike\`, and
priorities \`low\`, \`medium\`, \`high\`, \`critical\`. \`task create\`, \`task edit\` and
\`task edit-batch\` refuse any other value with exit 6. A value that differs only
in case is accepted and stored in the configured spelling. Read the set
before you write: \`quest manifest --json\` reports it as \`data.taskVocabulary\`,
where \`null\` means the field is open and accepts anything. A workspace
without a \`[tasks]\` table is open on both fields. \`quest doctor\` reports an
existing record whose value falls outside the set, and nothing rewrites it.

## Dependencies must already exist

\`--dependency\`/\`--parent\` validate against real records at creation time, so a
forward reference -- naming a task you have not created yet -- fails with
\`dependency_target_not_found\` instead of being deferred. That is deliberate,
fail-closed validation, not a bug to route around. For a forward reference,
either create the target first, or create this task without \`--dependency\`/
\`--parent\` and add the edge afterward:

\`\`\`
quest task create "<title>" --actor <actor> --actor-kind human --json
quest task edit <id> --add-dependency <target-id> --actor <actor> --actor-kind human --json
\`\`\`

Use \`--parent <target-id>\` on that same \`task edit\` instead when the edge is a
parent, not a dependency.

## Checklist positions renumber after a removal

\`--check-ac\`/\`--uncheck-ac\`/\`--remove-ac\` (and the \`--*-dod\` equivalents)
address an acceptance-criteria/definition-of-done item by its 1-based
\`position\` field (QCLI-269) -- every acceptanceCriteria/definitionOfDone entry
\`quest task view\` (and every other checklist-bearing command) prints carries
one; read it and pass it straight back. Each entry also keeps a 0-based
\`index\` for programmatic addressing (position is always index + 1); \`index\`
is not what these flags take. Removing an item shifts every later item's
position and index down by one, so a position computed before a removal is
stale after it. Re-read the task rather than assume:

\`\`\`
quest task create "<title>" --acceptance-criteria '["<observable outcome>","<observable outcome>"]' --actor <actor> --actor-kind human --json
quest task edit <checklist-id> --check-ac 1 --actor <actor> --actor-kind human --json
quest task edit <checklist-id> --remove-ac 1 --actor <actor> --actor-kind human --json
quest task view <checklist-id> --json
quest task edit <checklist-id> --check-ac 1 --actor <actor> --actor-kind human --json
\`\`\`

The second item was position 2 when created; once position 1 is removed it
becomes position 1, which is what the final \`--check-ac 1\` above actually
addresses -- rereading first is what makes that safe rather than a guess.

Use \`quest draft create\` instead when the idea is not yet committed work;
\`quest draft promote\` turns it into a task when it is.
`;

const taskExecution = `# Working a task

## Before you touch code

Read the task: \`quest task view <id> --json\`. Confirm it is eligible, its
dependencies are satisfied, and its scope still matches what was asked. Do not
trust an approach proposed when the task was filed; the code has moved since.

\`--ready\` is only an execution filter: it says a prerequisite finished, not
that it established what you need from it. A completed dependency answers "may
this start", never "did that prove what this task now assumes" -- read what a
prerequisite actually concluded before depending on it for anything more
specific than "it is no longer blocking."

Claim it, then record the plan you actually intend to follow:

\`\`\`
quest task edit <id> --status "In Progress" --actor <actor> --actor-kind human --json
quest task edit <id> --plan '["1. ...", "2. ..."]' --actor <actor> --actor-kind human --json
\`\`\`

## While you work

Work in short loops: one focused slice, then the checks that prove it. Record
what a later reader would need and could not reconstruct from the diff — a
decision and its reason, a blocker, a validation result:

\`\`\`
quest task edit <id> --add-note "<what changed and why>" --actor <actor> --actor-kind human --json
\`\`\`

Checkbox edits are addressed by the 1-based \`position\` that \`task view\` prints,
so two editors do not overwrite each other: \`--check-ac 2\`, \`--uncheck-dod 1\`,
\`--remove-ac 3\`. Pass that number back verbatim. Each entry also carries a
0-based \`index\`; it is NOT what these flags take. Prefer them over replacing a
whole list.

## If the scope moves

Work you discover outside the acceptance criteria is a new task, not a silent
addition to this one. File it and say so.
`;

const taskFinalization = `# Finishing a task

## Verify before you check anything

Status is not a verdict. Closing a task, even correctly, does not retroactively
satisfy a criterion nobody proved -- a task whose criterion is to establish some
outcome does not meet it just because the work session on it ended. Check an
acceptance criterion only when you have evidence that proves it: a test that
fails without the change, command output, an observed result. Code being
present is not evidence, and neither is intent.

\`\`\`
quest task edit <id> --check-ac 1 --check-ac 2 --actor <actor> --actor-kind human --json
\`\`\`

An acceptance criterion you cannot prove stays unchecked, and the reason belongs
in the notes. A criterion checked on faith is worse than one left open, because
it stops anyone else from looking.

\`quest task complete\` does not refuse or require checking every item first
(QCLI-252) -- but completing with any acceptance criterion or definition-of-done
item still unchecked is not silent either: it prints a stderr warning naming
the unresolved items and adds an \`unresolvedAtCompletion\` field to the JSON
result. A completion carrying that field is a signal to read the notes for why,
not evidence that something went wrong.

## Then summarize and close

The final summary is for someone deciding whether to trust this work: what
changed, why, and how it was verified.

\`\`\`
quest task edit <id> --final-summary "<what changed, why, how it was verified>" \\
  --actor <actor> --actor-kind human --json
\`\`\`

If review then changes the picture, extend the summary rather than retyping it,
and close only once it is right:

\`\`\`
quest task edit <id> --append-final-summary "<what review changed>" \\
  --actor <actor> --actor-kind human --json
quest task complete <id> --actor <actor> --actor-kind human --json
\`\`\`

\`quest task complete\` moves the record to its terminal status; \`quest task
archive\` retires it afterwards, and \`quest task demote <id> --to "<status>"\`
walks it back to an explicit earlier status if closing turns out to be wrong.
None of the three destroys a task: an archived task stays readable, and there
is no \`task delete\` at all — not an omission but a decision (DEC-8,
QCLI-164). Milestone and decision each carry delete alongside archive; task
deliberately does not, because a task record is audit-significant in a way
those two are not. A throwaway probe task is archived like any other. (\`quest
cleanup\` is unrelated to tasks — it removes closed, unreferenced milestones
and superseded decisions.)

## The commit that carries a completion

\`quest task complete\` relocates the record -- \`.quest/tasks/\` to
\`.quest/completed/\` -- and nothing stages that rename, so a commit delivering
a completion must carry both the removal of the old path and the addition of
the new one. Stage it with a scoped add -- \`git add -A .quest/\` -- or with
the record's own two paths,
\`git add .quest/tasks/<id>.json .quest/completed/<id>.json\` -- and never a
repo-wide \`git add -A\`: that also stages any unrelated tracked file merely
missing from the working tree, so an accidental deletion rides your commit and
the tree reads clean afterwards (\`git status\` and \`git diff HEAD\` both
empty). Read \`git diff --cached --name-status\` before committing; a
completion commit should name exactly those two paths. Staging one side alone
is not enough either: \`git add -u .quest/\` stages the removal but leaves the
new record untracked. \`task close\`, \`task archive\` and \`task demote\`
relocate records too and stage by the same recipe -- but not always to
\`.quest/completed/\`, so a commit carrying one of those names different paths:
close joins complete in \`.quest/completed/\`, archive moves the record to
\`.quest/archive/tasks/\`, and demote returns it to \`.quest/tasks/\` (QCLI-412).
A demotion of a record already stored at \`tasks\` is a status write with no
rename behind it, so there is nothing to stage and no hint is printed. Each of
the four commands prints the path it actually used. This is not hypothetical
(QCLI-311): a tracker-only commit once also deleted npm/quest-darwin-arm64
this way, and the package-artifact gate caught it, not anything in the
session.

## When the outcome did not happen: close, do not complete

\`quest task complete\` asserts the outcome happened. When it did not -- the
task duplicates another, a later task superseded it, or it will not be done --
retire it with \`quest task close\` instead:

\`\`\`
quest task close <duplicate-id> --resolution duplicate --survivor <survivor-id> \\
  --actor <actor> --actor-kind human --json
quest task close <abandoned-id> --resolution wont-do --final-summary "<why it will not be done>" \\
  --actor <actor> --actor-kind human --json
\`\`\`

\`--resolution\` is required: \`duplicate\` and \`superseded\` also take
\`--survivor <id>\`, the task that carries the work forward, and \`wont-do\`
takes none. Close works straight from To Do, In Progress, or the paused status,
so do not step a never-worked task through In Progress to reach Done: that
records a start that never happened and a completion that never happened, and
the status field cannot say otherwise. The record reaches "Closed", a second
terminal status beside Done, and moves to completed/. \`quest task demote\`
reopens it and withdraws the resolution.

Records already retired by the old In-Progress-then-Done workaround stay as they
are: nothing requires rewriting them. When you need to know whether a task is
finished, never compare against "Done". Read \`quest task status-flow\` and
treat a task as finished when its status is in \`terminalStatuses\` OR equals
\`closedStatus\`. \`terminalStatuses\` does not list Closed yet; it will in a
later release.

An In Progress task that is paused rather than closed does not go through
demote: \`quest task pause <id>\` parks it at the paused status, a BUILT-IN
literal ("Paused") that is NOT workspace-configurable -- no knob sets it, and
\`task status-flow\` reports \`pausedStatusConfigurable: false\` beside it
(QCLI-325) -- without erasing that work was started, and \`quest task
start <id>\` brings it back to In Progress. A record parked before 0.7.0 sits
at the retired literal "Blocked" instead; \`quest task start <id>\` is its one
sanctioned exit too, \`quest doctor\` names any such record, and nothing
migrates it silently (QCLI-302).

Status and on-disk location are deliberately independent (QCLI-221): only
\`task complete\`/\`close\`/\`archive\`/\`demote\` relocate a record. \`task edit --status
<terminal>\` sets the status field in place and does not move it -- it stays
wherever it already was. Two tasks sharing the same terminal status can
legitimately live in different storage locations depending on which command
reached it; every command that reads a task (\`view\`, \`list\`, \`edit\`, ...)
resolves it by id across every location regardless.
`;

const workspace = `# Workspace setup

## Initializing

\`quest init\` requires an existing Git worktree; it does not create one. On a
real terminal with no flags it prompts for a project name, a task-id prefix, and
whether to write the managed instructions block. Pass \`--json\` or any flag to
skip the prompts and take scriptable defaults.

The result is \`.quest/workspace.toml\` plus the record directories. If a command
reports that the workspace is missing, run \`quest init\` rather than creating the
files by hand.

## Managed agent instructions

\`quest agents --update-instructions\` writes a small versioned block into
AGENTS.md and installs the Quest skill at \`.claude/skills/quest/SKILL.md\`. The
block is delimited and merged into surrounding content; the skill file is
Quest-owned in full, so any edit to it reads as drift.

\`--target\` picks the file: codex (AGENTS.md, the default), claude (CLAUDE.md) or
antigravity (GEMINI.md), exactly one per call. Pass the same \`--target\` to
\`--check\` that the block was written with. A \`--check\` with no \`--target\`
reads AGENTS.md only, and exits 6 naming the \`--target\` to use when AGENTS.md
has no Quest block but CLAUDE.md or GEMINI.md carries one.

\`quest agents --check\` exits 0 when the block is current and 6 when it is
drifted or malformed; a missing block exits 0 unless \`--require-installed\` is
given, which makes it exit 6. Run it with \`--require-installed\` in CI to catch
a Quest upgrade that moved the contract out from under a consumer. A
block that differs from the installed CLI only in its one embedded version
number reports \`"version-only"\` and exits 0 -- a routine patch/minor bump
alone is not drift; any other difference still exits 6.
\`quest agents --update-instructions\` always refreshes to the exact current
bytes regardless, so the file never falls permanently behind.

## The opum-quest marketplace plugin

With the claude or codex target, \`quest init\` and \`quest agents\` also report
whether that agent runtime has the \`opum-quest\` plugin, read through the
runtime's own \`claude plugin list --json\` or \`codex plugin list --json\`:
\`installed\`, \`disabled\` (installed but switched off, so its skill does not
reach the agent), \`not-installed\`, or \`not-detectable\` (the runtime CLI is
missing or its answer unreadable). \`init\` and \`--check\` only report, with the
command to run next. \`--update-instructions --target <claude|codex>\` runs the plugin update when
the plugin is installed, and never installs or enables it; with no \`--target\`
it names no runtime, so it only reports. For Codex the update refreshes the
whole opum marketplace, every opum plugin included, and says so in its output. None of this changes an
exit code. Set \`QUEST_AGENT_PLUGINS=off\` to skip it, for example in a test
suite that must not touch the machine's real agent install.

## Coming from Backlog.md

\`quest migration backlog preview --source <path> --json\` reports a digest and
the record mappings without writing. Review both, then pass the digest back to
\`quest migration backlog apply\`. \`status\` and \`rollback\` cover the rest of the
lifecycle.
`;

/** Ordered: `--list` prints them in this sequence. */
export const questGuides: readonly QuestGuide[] = [
  {
    name: "overview",
    summary: "What Quest is, the command set, and the machine contract",
    content: overview,
  },
  {
    name: "task-creation",
    summary: "How to search, scope, and create tasks",
    content: taskCreation,
  },
  {
    name: "task-execution",
    summary: "How to plan, record, and work through a task",
    content: taskExecution,
  },
  {
    name: "task-finalization",
    summary: "How to verify, summarize, and finish a task",
    content: taskFinalization,
  },
  {
    name: "workspace",
    summary: "Initializing a workspace, managed instructions, and migration",
    content: workspace,
  },
];

export function findQuestGuide(name: string): QuestGuide | undefined {
  return questGuides.find((guide) => guide.name === name);
}
