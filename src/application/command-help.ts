import type { CommandManifestEntry } from "./command-contract.ts";

/** Human-facing help content for one manifest command, kept separate from
 * commandManifest so `quest manifest` stays byte-identical. */
export interface CommandHelpEntry {
  readonly summary: string;
  readonly usage: string;
  readonly flags: readonly string[];
}

const ACTOR_FLAGS = ["--actor", "--actor-kind", "--accountable-human"] as const;

export const commandHelp: Record<
  CommandManifestEntry["name"],
  CommandHelpEntry
> = {
  manifest: {
    summary:
      "Print the versioned public command registry. A command's `fields` array advertises that command's key vocabulary, and its MEANING is NOT uniform across commands -- a consumer must not assume one reading for all of them. (1) For the read commands brought to completeness -- `task list`, `task view`, `search`, `question list` and `question view` -- it is the COMPLETE top-level key set of `data` (a key is present only on a record that actually carries it), not a curated subset. `--fields` PROJECTION is a separate surface, offered only on `task list` and `task view` and exactly this set there: `search`, `question list` and `question view` declare the same complete set but do NOT accept `--fields`. (2) Other read commands (for example `milestone view`, `decision view`, the `draft` reads) may still advertise a CURATED SUBSET of the keys their `data` carries -- so a command not on the completed list in (1) must be treated as a subset unless verified otherwise. (3) For `task create`, `task edit` and `task edit-batch`, `fields` is the settable-INPUT vocabulary, which lists the keys a caller may SET, not the keys a payload carries.",
    usage: "quest manifest",
    flags: [],
  },
  version: {
    summary: "Print the installed Quest version.",
    usage: "quest --version",
    flags: [],
  },
  help: {
    summary: "Print this command reference, optionally scoped to one topic.",
    usage: "quest help [topic]",
    flags: [],
  },
  init: {
    summary:
      'Initialize a Quest workspace in the current Git worktree. On a real terminal with no flags, prompts for project name, task ID prefix, then a multi-select listing supported instruction files (CLAUDE.md for Claude Code, AGENTS.md for Codex/OpenCode/pi/etc., GEMINI.md for Google Antigravity/Gemini CLI) -- tick zero, one, or more; nothing is pre-checked. --target claude/codex/antigravity writes exactly one non-interactively (requires --agent-instructions; the default target for a scripted --agent-instructions with no --target remains AGENTS.md, unchanged, so existing callers are unaffected -- only the interactive prompt changed). --skill-source takes "repo" (the default, unset: generate .claude/skills/quest/SKILL.md into this repository), "plugin" (the skill ships from the opum-quest Claude Code plugin instead), or "none" (this workspace generates no quest skill file and none ships from anywhere -- the value for a workspace that does not use Claude Code at all, so a Codex-only or Antigravity-only consumer need not declare "plugin", which would assert a plugin they do not have). "plugin" and "none" behave identically on every file operation and differ only in what they assert; given on the SAME call as --agent-instructions, either also skips writing the skill file this time ("explicit beats config" holds only against a persisted skillSource from an earlier call, not against an explicit --skill-source given in the same breath). With --agent-instructions and a claude or codex target (scripted or ticked), data.plugins.<runtime> reports whether that runtime has the opum-quest marketplace plugin (installed, disabled, not-installed, not-detectable) and what to run next; init never installs, enables or updates it (QCLI-371). Refuses if already initialized -- use `quest init --reconfigure` on an existing workspace instead of deleting .quest/ and starting over. --reconfigure accepts --name, --task-id-prefix and --skill-source, in any combination or none; it persists --skill-source exactly as a first init does, which is how an already-initialized workspace opts out of the skill file after the fact. A first init also writes the canonical [tasks] vocabulary (types feature, bug, chore, docs, enhancement, spike; priorities low, medium, high, critical) into .quest/workspace.toml, and task create/edit/edit-batch then accept only those values, storing a case-only difference in the configured spelling (QCLI-330). --reconfigure, bare or with fields, adds that default only to a workspace that configures neither field and never changes a configured set; a workspace with no [tasks] table stays open, validating nothing.',
    usage:
      'quest init [--name "My Project"] [--task-id-prefix ABC] [--agent-instructions [--target claude|codex|antigravity]] [--skill-source repo|plugin|none] | quest init --reconfigure [--name ...] [--task-id-prefix ...] [--skill-source repo|plugin|none]',
    flags: [
      "--name",
      "--task-id-prefix",
      "--agent-instructions",
      "--target",
      "--skill-source",
    ],
  },
  "init --reconfigure": {
    summary:
      'Change the declared name, task ID prefix, and/or skill source on an existing workspace without deleting .quest/. The supported alternative to `rm -rf .quest && quest init`, which discards every task record --.quest/ is not always tracked in git. Fields not given keep their current value. Bare, with no field flag, it adds the canonical [tasks] vocabulary when the workspace configures neither types nor priorities, and otherwise writes nothing at all: a configured set, even one field of it, is never changed, and a run that changes nothing rewrites nothing, so comments and unrecognized tables in workspace.toml survive it (QCLI-330). --skill-source takes the same repo|plugin|none values a first init does and persists them the same way, so this is how an existing workspace opts out of .claude/skills/quest/SKILL.md after the fact ("none" for a workspace with no Claude Code at all; "plugin" only when the opum-quest Claude Code plugin really does ship the skill).',
    usage:
      'quest init --reconfigure [--name "My Project"] [--task-id-prefix ABC] [--skill-source repo|plugin|none]',
    flags: ["--name", "--task-id-prefix", "--skill-source", "--reconfigure"],
  },
  // The human-facing entry stays whole: `--list` is a flag of `quest
  // instructions`, and splitting it out would make `quest help instructions`
  // stop mentioning it. The two entries below exist so a MACHINE reading the
  // registry can find the envelope kind for each form (QCLI-151); they are not
  // separate commands.
  instructions: {
    summary:
      "Print the managed agent-instructions block (written to AGENTS.md by default, or CLAUDE.md/GEMINI.md via `quest agents --update-instructions --target claude|antigravity`), one workflow guide, or the guide index.",
    usage: "quest instructions [<guide>] [--list]",
    flags: ["--list"],
  },
  "instructions --list": {
    summary: "List the workflow guides with a one-line purpose each.",
    usage: "quest instructions --list",
    flags: ["--list"],
  },
  "instructions <guide>": {
    summary: "Print one workflow guide.",
    usage: "quest instructions <guide>",
    flags: [],
  },
  agents: {
    summary:
      'Check or update the managed agent-instructions block and the quest Claude Code skill. --target selects which file the instructions block targets: codex (AGENTS.md, the default when --target is omitted), claude (CLAUDE.md), or antigravity (GEMINI.md). A --check call must pass the same --target the block was written with -- it checks exactly one file per invocation, never more than one; a --check with no --target checks AGENTS.md, and exits 6 naming the --target to use when AGENTS.md has no Quest block but CLAUDE.md or GEMINI.md carries one. The skill file (.claude/skills/quest/SKILL.md) is separate: when this workspace\'s agents.skill_source is "plugin" or "none" (set via `quest init --skill-source ...`, on a first init or a --reconfigure), it is neither written nor proposed -- a leftover reports as drift, and --force removes it only when its bytes exactly match what Quest would generate; a hand-edited file is never removed. "none" is the value for a workspace with no Claude Code at all: it behaves exactly as "plugin" does here, and says only that no skill file is generated, never that a plugin provides one. A block that differs from the installed CLI only in its one embedded version number reports "version-only" and does not fail --check (a routine patch/minor bump alone is not drift); any other difference, including a version bump paired with real content change, still reports drift and fails. --update-instructions always refreshes to the exact current bytes regardless, so the file never falls permanently behind. With the claude or codex target, data.plugin reports the opum-quest marketplace plugin as installed, disabled, not-installed or not-detectable, read through the `plugin list --json` of that runtime CLI; --check only reports it and prints what to run, and --update-instructions with an explicit --target runs the plugin update for an installed plugin (with no --target it only reports) but never installs or enables one (QCLI-371; neither changes the exit code; QUEST_AGENT_PLUGINS=off skips it). A leftover Backlog.md installer block (its own BACKLOG.MD GUIDELINES START/END markers) is a real contradiction, not silently ignored: --check reports drift even when the Quest block is otherwise exact, and --update-instructions removes it -- bounded to exactly that delimited block, touching nothing else.',
    usage:
      "quest agents --check [--require-installed] [--target claude|codex|antigravity] | --update-instructions [--target claude|codex|antigravity] [--force]",
    flags: [
      "--check",
      "--require-installed",
      "--update-instructions",
      "--target",
      "--force",
    ],
  },
  completion: {
    summary: "Print a shell completion script.",
    usage: "quest completion bash",
    flags: [],
  },
  "migration backlog preview": {
    summary:
      "Preview a Backlog.md-to-Quest migration without writing anything. " +
      "--preserve-source-ids keeps each record's own Backlog id instead of " +
      "renumbering positionally: it requires --source-family to select one " +
      "id family from the source (a backlog holding more than one, e.g. " +
      "LCLI and LORE, imports one family per run). A dotted subtask id " +
      "(ODOC-63.2) has no equivalent in Quest's flat canonical id, so it is " +
      "translated -- a fresh flat id in the family, its dotted spelling kept " +
      "as an alias, its parent threaded through -- rather than preserved " +
      "verbatim; the run refuses on an id collision or an unresolvable " +
      "parent, reporting every one in a single report. The output's " +
      "`renumbered` field (preservation mode only) isolates exactly the " +
      "mappings a translation actually changed, so a caller does not have " +
      "to diff the full `mappings` list by hand to find what is about to " +
      "change; `mappings` itself is unchanged, additive only.",
    usage:
      "quest migration backlog preview --source <path> [--backlog-dir <path>] [--preserve-source-ids --source-family <PREFIX>]",
    flags: [
      "--source",
      "--backlog-dir",
      "--preserve-source-ids",
      "--source-family",
    ],
  },
  "migration backlog apply": {
    summary:
      "Apply a previously previewed Backlog.md migration. Re-supply " +
      "--preserve-source-ids/--source-family exactly as given to preview.",
    usage:
      "quest migration backlog apply --source <path> --digest <digest> --actor <name> --actor-kind human [--backlog-dir <path>] [--preserve-source-ids --source-family <PREFIX>]",
    flags: [
      "--source",
      "--digest",
      "--backlog-dir",
      "--preserve-source-ids",
      "--source-family",
      ...ACTOR_FLAGS,
    ],
  },
  "migration backlog status": {
    summary: "Report the status of a Backlog.md migration by digest.",
    usage: "quest migration backlog status --digest <digest>",
    flags: ["--digest"],
  },
  "migration backlog rollback": {
    summary: "Roll back a previously applied Backlog.md migration.",
    usage:
      "quest migration backlog rollback --digest <digest> --actor <name> --actor-kind human",
    flags: ["--digest", ...ACTOR_FLAGS],
  },
  "task status-flow": {
    summary:
      'Print the configured task status set, terminal statuses, the paused status -- a BUILT-IN literal ("Paused"), NOT workspace-configurable, carried with `pausedStatusConfigurable: false` beside it so a reader can tell from this output alone (QCLI-325) -- reached only via `task pause`/`task start`, and the closed status with its resolutions (QCLI-331). `terminalStatuses` lists the ladder\'s terminal statuses and is always a subset of `statuses`: "Done" asserts the outcome happened. `closedStatus` ("Closed" by default) is a second terminal status, reached only by `task close`, saying the task was retired without its outcome (duplicate, superseded, or wont-do); it is NOT in `terminalStatuses` yet and joins it in a later release. Decide whether a task is finished by membership in `terminalStatuses` or equality with `closedStatus`, never by comparing to "Done".',
    usage: "quest task status-flow",
    flags: [],
  },
  "task binding": {
    summary:
      "Bind an agent to a task under the Opum workflow contract (flags, or a piped stdin request envelope).",
    usage:
      "quest task binding --contract <name> --task <id> --claim-or-correlation <id> --holder <id> --repository <id> --base <ref> --settlement <ref>",
    flags: [
      "--contract",
      "--task",
      "--claim-or-correlation",
      "--holder",
      "--repository",
      "--base",
      "--settlement",
    ],
  },
  "task list": {
    summary:
      "List tasks, optionally filtered by status, label, readiness, assignee, milestone, parent, priority, type, unresolved-at-completion, or a search term. Completed tasks are included by default like any other status (QCLI-165); archived tasks need --include-archived. --unresolved-at-completion (QCLI-336) selects only tasks that completed with acceptance criteria or definition-of-done items still unchecked -- the persisted counterpart of the `unresolvedAtCompletion` field `task complete` adds to its own response (QCLI-252) -- so a sweep for 'what did we knowingly ship with open items' does not require reading every completed record by hand. SCOPE (QCLI-316): this reads the CHECKED-OUT ref's .quest/ and nothing else, so a result -- and an EMPTY result especially -- is a claim about that branch, not about the repository. A task filed on an unmerged branch is invisible here, which is exactly the task most likely to be forgotten. Every listing carries a `scope` field naming the branch it answered about; when the result is empty, scope also reports `unseenTaskIds`, the ids that exist on some other ref and not on this one (filenames only, one tree listing per ref, no record is read and no status is merged across refs). An empty list with an empty `unseenTaskIds` is load-bearing; an empty list naming ids is the check not having run on them. Before reporting that nothing is open, read `scope`, and cross-check an independent source such as `gh pr list`. `quest task list --across-refs` (QCLI-417) is the complete form of that answer: one read-only view over origin/dev plus every open PR head into dev, with per-state provenance and a coverage report, so a nothing-open answer holds for the repository only when every planned ref was read. See `quest help 'task list --across-refs'` -- that invocation, not this one, is where the flags it takes are documented. --fields <a,b,...> (QCLI-312 / DEC-161) narrows each record to EXACTLY the named fields: under --json every item carries exactly those keys (a named field absent from a record is null, never a dropped key), and the human form (both --plain and the default human mode) renders one TAB-separated line per task in the order named. The accepted names are exactly the fields `quest manifest --json` advertises for this command -- QCLI-461 makes that the COMPLETE top-level key set a record can carry, not a curated subset, so every key a record emits is acceptable and a declared key appears only on a record that actually carries it; an unknown name is a usage error (exit 2) whose message lists the valid names. (QCLI-462 / DEC-161 (k)) The projection is the named keys PLUS, when a bound was supplied and its bounded field is among the named fields, that bound's omission marker beside them under its own key name; `task list` has no field-level bound (its --limit bounds the array of records, not a field), so its projection is never anything but the named keys. A projection itself reports no `fieldsOmitted` key.",
    usage:
      'quest task list [--status "To Do"] [--exclude-status "Done"] [--label backend] [--ready] [--assignee person-1 | --unassigned] [--milestone M-1] [--parent T-1] [--priority high] [--type feature] [--unresolved-at-completion] [--search text] [--sort id[:asc|desc]] [--limit 20] [--include-archived] [--fields id,status,title]',
    flags: [
      "--status",
      "--exclude-status",
      "--label",
      "--ready",
      "--assignee",
      "--unassigned",
      "--milestone",
      "--parent",
      "--priority",
      "--type",
      "--unresolved-at-completion",
      "--search",
      "--sort",
      "--limit",
      "--include-archived",
      "--fields",
    ],
  },
  "task list --across-refs": {
    summary:
      "The repository-true listing (QCLI-417): one read-only view over origin/dev PLUS the head of every open pull request into dev, so an empty or filtered answer is a claim about the repository rather than about this checkout. Every entry is one task id with a `states` array, and every state carries `refProvenance` {ref, pullRequest, sha} naming the ref it was read from, `owner/repo#N` for a PR head (null for origin/dev and for a ref you named yourself), and the full 40-hex commit actually read. A record that exists only on a PR head is reported as `proposedBy` that PR; an id whose states disagree lists EVERY state with its own refProvenance and sets `conflict: true`, and no winner is picked -- resolving it is a judgement call this view does not make. `identity` says whether the states are one task AT ALL, and takes exactly three values: `task`, `collision`, `unresolved`. It is `task` when every state carries the same `createdAt` (one record read from several refs), `collision` when every state carries one and there are two or more distinct `createdAt` values -- different records that happen to share an id, the window the refs-aware allocator leaves open when two checkouts create before either commits -- and `unresolved` when ANY state in a group of two or more carries no `createdAt`, so the states cannot be compared. An unresolved pair is reported as `unresolved`, never assumed to be one task. A LONE state -- a group of fewer than two states -- is always `task`, whatever its record carries: there is nothing to compare it against, so a one-state group with no `createdAt` is `task`, not `unresolved`. `identity` is not `conflict`: `conflict` reports status divergence WITHIN one task, `identity` reports whether the states are one task at all. A consumer that must detect two different records sharing an id MUST read `identity`; `conflict` alone cannot tell a collision from one task whose states disagree. Filters (--status, --label, --limit, ...) compose as they do on `task list`: an entry matches when ANY of its states matches, and a matched entry still shows all of its states. --ready is the one filter not accepted here: readiness is evaluated over one coherent dependency graph, and a PR head can legitimately carry a task whose dependency is not on that branch at all. COVERAGE, a top-level key after `data`: {complete, population, discoveredAt, refsRead, refsUnreadable}. `complete` is true only when every planned ref was read without error, so 'nothing is open' holds for the repository only then. Incomplete coverage exits 6 with the unreadable refs named in the message and the whole coverage object in the error's `input`; --allow-partial downgrades that to exit 0 with complete false and the same refs still named. A read of ZERO refs is the one exception -- that is no coverage rather than partial coverage, so it still exits 6 even with --allow-partial. --ref <ref> and --pr <N> (both repeatable) replace discovery with an explicit population and need no forge: --pr resolves refs/pull/<N>/head through Git alone. OFFLINE: discovery is `gh pr list --repo <slug> --state open --base dev`; with no gh on PATH, or an origin remote that is not GitHub, the run reports incomplete coverage -- exit 6, or 0 under --allow-partial with population dev-only and complete false -- and never fails as an uncaught error. A listing that was truncated at gh's limit, or that carried rows this view cannot use, counts as incomplete for the same reason: a narrowed population must not report complete. Exit 3 when origin or origin/dev is absent. Exit 5 is never used: two refs disagreeing about a task's status is data, not a command conflict. THIS READS REFS, NEVER THE WORKING TREE: uncommitted records are not in the view, and nothing here writes a record, a ref or a branch -- a fetch, when one is needed, writes objects and FETCH_HEAD only (it passes an empty --refmap, so no remote-tracking ref moves either).",
    usage:
      'quest task list --across-refs [--allow-partial] [--ref <ref>] [--pr <N>] [--status "In Progress"] [--exclude-status Done] [--label backend] [--assignee person-1 | --unassigned] [--milestone M-1] [--parent T-1] [--priority high] [--type feature] [--unresolved-at-completion] [--search text] [--sort id|title[:asc|desc]] [--limit 20] [--include-archived]',
    flags: [
      "--across-refs",
      "--allow-partial",
      "--ref",
      "--pr",
      "--status",
      "--exclude-status",
      "--label",
      "--assignee",
      "--unassigned",
      "--milestone",
      "--parent",
      "--priority",
      "--type",
      "--unresolved-at-completion",
      "--search",
      "--sort",
      "--limit",
      "--include-archived",
    ],
  },
  "task view": {
    summary:
      "View one task by id or alias. The result carries a `revision` field " +
      "(QCLI-277) a caller can capture and later supply back as `task edit " +
      "--if-revision <revision>`'s precondition. --max-notes N caps " +
      "implementationNotes to the most recent N entries and adds a " +
      "notesOmitted count; N may be 0 (an empty notes array with notesOmitted " +
      "equal to the whole count). Omitted, the read is the full unbounded " +
      "record, unchanged. A task completed with acceptance criteria or " +
      "definition-of-done items still unchecked carries an " +
      "`unresolvedAtCompletion` field (QCLI-336) naming them. A COMPLETION " +
      "refreshes it (QCLI-479 / opum-doc DEC-172 (4ae)): a task demoted " +
      "back to an active status, amended and completed again carries the " +
      "unresolved set of THAT completion, and the field is cleared when " +
      "nothing is unresolved then, so the earlier snapshot does not survive " +
      "that re-completion. The field is written ONLY by a completion, so an " +
      "amendment with no demote and no re-completion -- editing a completed " +
      "task's checklist, or `task edit --status <terminal>`, which reaches the " +
      "terminal status without a completion -- leaves the snapshot as the " +
      "completion before it wrote it. It is " +
      "absent on any task not completed that way. --fields <a,b,...> (QCLI-291 / DEC-161) is the " +
      "same projection `task list` takes: it narrows the record to EXACTLY the " +
      "named fields, so under --json `data` carries exactly those keys (a " +
      "named field absent from the record is null, never a dropped key) and " +
      "the human form renders one TAB-separated line in the order named. The " +
      "accepted names are exactly the fields `quest manifest --json` " +
      "advertises for this command -- the COMPLETE top-level key set the " +
      "record can carry (QCLI-461), not a curated subset; an unknown name is " +
      "a usage error (exit 2) whose message lists the valid names. It composes " +
      "with --max-notes: the " +
      "note cap is applied first, then the projection. (QCLI-462 / DEC-161 " +
      "(k)) When `implementationNotes` is among the named fields AND the bound " +
      "was supplied, `data` also carries `notesOmitted` beside the named keys " +
      "(its value copied from the record); when the bounded field is not named, " +
      "no marker is emitted. A projection itself reports no `fieldsOmitted` key.",
    usage: "quest task view <id> [--max-notes N] [--fields id,status,title]",
    flags: ["--max-notes", "--fields"],
  },
  search: {
    summary: "Search tasks by title and description.",
    usage: 'quest search "query"',
    flags: [],
  },
  "search --all": {
    summary: "Search tasks, milestones, and decisions together.",
    usage: 'quest search "query" --all',
    flags: ["--all"],
  },
  "task create": {
    summary:
      "Create a task. --type and --priority accept only the workspace's configured vocabulary when .quest/workspace.toml has a [tasks] table (quest init writes the canonical default); a case-only difference is stored in the configured spelling, anything else exits 6. `quest manifest --json` reports the set as data.taskVocabulary, null for an open field (QCLI-330).",
    usage:
      'quest task create "<title>" --actor <name> --actor-kind human [--priority high] [--type bug]',
    flags: [
      "--id",
      "--summary",
      "--description",
      "--label",
      "--doc",
      "--priority",
      "--type",
      "--ordinal",
      "--alias",
      "--acceptance-criteria",
      "--definition-of-done",
      "--plan",
      "--implementation-notes",
      "--comments",
      "--assignee",
      "--reference",
      "--modified-file",
      "--dependency",
      "--parent",
      "--milestone",
      "--final-summary",
      ...ACTOR_FLAGS,
    ],
  },
  "task edit": {
    summary:
      "Edit an existing task's fields, or append/remove list items. " +
      "CREATE/EDIT NAMING SPLIT (QCLI-283, QCLI-484): `task create` and `task edit` spell several " +
      "list fields differently, and this help describes the EDIT side. Create sets a list " +
      "wholesale with --label, --reference, --assignee, --dependency and --modified-file; edit " +
      "MUTATES it with --labels (replace the whole list, one JSON array), " +
      "--add-label/--remove-label, --add-reference/--remove-reference, " +
      "--add-assignee/--remove-assignee, --add-dependency/--remove-dependency, and " +
      "--add-modified-file/--remove-modified-file. Running `task edit` with ANY of those five " +
      "create-only spellings -- --label, --reference, --assignee, --dependency, --modified-file " +
      "-- is a usage error (exit 2) that names the edit-side flag(s) to use instead; these are " +
      "deliberately NOT accepted as aliases here, so the split is taught rather than papered over. " +
      "Checklist positions are 1-based and reader-facing: --check-ac/--uncheck-ac/--remove-ac " +
      "and the --*-dod equivalents address an item by the `position` field `quest task view` " +
      "(and every other checklist-bearing command) prints on each acceptanceCriteria/" +
      "definitionOfDone entry -- pass that number back verbatim, no arithmetic required. Each " +
      "entry also keeps its 0-based `index` for programmatic addressing (position is always " +
      "index + 1); `index` is not what these flags take. Removing an item renumbers everything " +
      "after it, in both forms: re-read the task before addressing what you think is 'the next' " +
      "item rather than trusting a position computed before the removal. " +
      "--acceptance-criteria/--definition-of-done REPLACE the whole list, and take a JSON array " +
      "whose entries may be bare strings or " +
      '{"index":<0-based>,"text":"<string>","checked":<boolean>} objects (QCLI-313). Only the ' +
      "object form carries checked state, so it is the one to use when amending an entry on a " +
      "list that has anything ticked -- a bare string says nothing about the box and the edit " +
      "is refused with an exit-6 validation error naming this shape, rather than clearing it " +
      'silently as it did before. Pass the object form with "checked": false to reset a box ' +
      "deliberately. For a one-entry change prefer --check-ac/--uncheck-ac/--remove-ac, which " +
      "need no restatement of the list at all. " +
      "--comments/--add-comment take a JSON array of structured objects, not free text: each " +
      'entry needs {"id":"<string>","authorId":"<string>","body":"<string>","createdAt":"<ISO-8601 string>"}. ' +
      "--if-revision <revision> (QCLI-277) is an optional precondition: capture `revision` from an " +
      "earlier `task view --json`, and an edit whose value does not match the record's current " +
      "revision is refused with an exit-5 conflict instead of silently applying over a change " +
      "the caller never saw. The refusal names the mismatch and carries both values -- " +
      "input.sentRevision (what was sent) and input.actualRevision (the record's current " +
      "revision) -- so the comparison needs no reconstruction of argv. The precondition is scoped to THAT RECORD " +
      "(QCLI-310): writing any other task leaves it valid. Omitted, behavior is unchanged. " +
      "REMOVAL IS ONE VOCABULARY ADDRESSED TWO WAYS, and every removal fails loud on a miss " +
      "(QCLI-297). BY POSITION: --remove-ac/--check-ac/--uncheck-ac and the --*-dod equivalents " +
      "take a 1-based position; a position outside the list is an exit-6 validation error. " +
      "BY VALUE: --remove-label, --remove-plan, --remove-note, --remove-reference, " +
      "--remove-modified-file, --remove-assignee and --remove-dependency match the stored " +
      "entry's text EXACTLY -- including leading and trailing whitespace, and with no case " +
      "folding or trimming -- while --remove-comment matches a comment's `id`. A value matching " +
      "nothing is an exit-6 validation error naming the task id and echoing the value " +
      "JSON-delimited (so a miss caused by a trailing space or a tab is visible), and NOTHING is " +
      "removed -- not even the values in the same flag that did match. Every unmatched value in " +
      "one flag is reported together rather than one per round trip. This is deliberately not a " +
      "remove-if-present: a caller who wants that should read the record first and skip the " +
      "edit, which is also the only way to be sure the value it read is the one it removed.",
    usage:
      'quest task edit <id> --status "In Progress" --actor <name> --actor-kind human',
    flags: [
      "--status",
      "--title",
      "--priority",
      "--type",
      "--ordinal",
      "--summary",
      "--description",
      "--final-summary",
      "--clear-final-summary",
      "--append-final-summary",
      "--labels",
      "--add-label",
      "--remove-label",
      "--doc",
      "--plan",
      "--add-plan",
      "--remove-plan",
      "--notes",
      "--implementation-notes",
      "--add-note",
      "--remove-note",
      "--comments",
      "--add-comment",
      "--remove-comment",
      "--acceptance-criteria",
      "--definition-of-done",
      "--check-ac",
      "--uncheck-ac",
      "--remove-ac",
      "--clear-ac",
      "--check-dod",
      "--uncheck-dod",
      "--remove-dod",
      "--clear-dod",
      "--add-dependency",
      "--remove-dependency",
      "--parent",
      "--clear-parent",
      "--milestone",
      "--clear-milestone",
      "--add-assignee",
      "--remove-assignee",
      "--add-reference",
      "--remove-reference",
      "--add-modified-file",
      "--remove-modified-file",
      "--if-revision",
      ...ACTOR_FLAGS,
    ],
  },
  "task edit-batch": {
    summary:
      "Apply a batch of task edits from a JSONL operations file: one JSON object per line, " +
      'each {"reference":"<id-or-alias>","operationId":"<caller-chosen label>","patch":{...}} -- ' +
      "`patch` takes the same field vocabulary as `quest task edit`'s flags (e.g. " +
      '{"status":"In Progress"} or {"addLabels":["urgent"]}), by field name rather than flag ' +
      "spelling. `operationId` is optional (defaults to a positional label) but must be unique " +
      "within the file; each line's result reports success or a per-item error against it, so one " +
      "bad line never blocks the rest of the batch. Each item also takes an optional top-level " +
      '"ifRevision":"<revision>" (QCLI-277), the per-item counterpart of `task edit --if-revision`: ' +
      "a mismatch fails only that item (a per-item error, same as an unresolvable reference), " +
      "checked against THAT RECORD's own revision as the batch opened on it -- the same value " +
      "`task view --json` emits, so a captured revision is usable here too (QCLI-310).",
    usage:
      "quest task edit-batch --file operations.jsonl --actor <name> --actor-kind human",
    flags: ["--file", ...ACTOR_FLAGS],
  },
  "task complete": {
    summary:
      "Move a task to its terminal complete status. Unchecked acceptance criteria and definition-of-done items do NOT block completion -- an honestly-unchecked item is advisory, not an error (QCLI-252) -- but completing with any left unchecked prints a stderr warning naming them and adds an `unresolvedAtCompletion` field to the JSON result, so the gap is reported rather than silent. That field is also PERSISTED on the record itself (QCLI-336), not just this one response -- `quest task view`/`task list --json` surface it afterward, and `task list --unresolved-at-completion` finds every completed task still carrying one, so the gap survives past this command's own output. A COMPLETION REFRESHES that field (QCLI-479 / opum-doc DEC-172 (4ae)): a task demoted back to an active status, amended and completed again carries the unresolved set of THAT completion, and the field is CLEARED when nothing is unresolved then, so the earlier snapshot does not survive that re-completion. The field is written ONLY by this command, so an amendment with no demote and no re-completion -- editing a completed task's checklist, or `task edit --status <terminal>`, which reaches the terminal status without a completion -- leaves the snapshot as the completion before it wrote it. Nothing else on the record carries an earlier one; each completion replaces it. --final-summary is optional and applies a plain replacement to the record as part of the same write (QCLI-270), so a final summary can be recorded and the task completed in one command instead of `task edit --final-summary` followed by `task complete`; `--clear-final-summary`/`--append-final-summary` stay edit-only. A record ALREADY at the terminal status -- reached by `task edit --status <terminal>`, which per QCLI-221 deliberately does not relocate -- is RELOCATED to .quest/completed/ rather than refused with `Illegal task transition` (QCLI-338); the completion still runs, so `--final-summary` and `unresolvedAtCompletion` are computed on that path too (opum-doc DEC-172 (4ai)). A record ALREADY IN .quest/completed/ or .quest/archive/ is a different case and is NOT relocated: only tasks/ -> completed/ is the relocation this command finishes, so those shapes still refuse exactly as before.",
    usage:
      'quest task complete <id> [--final-summary "text"] --actor <name> --actor-kind human',
    flags: ["--final-summary", ...ACTOR_FLAGS],
  },
  "task archive": {
    summary:
      "Retire a task, preserving its record. This is the only way to remove a task from active listings: there is deliberately no `task delete`, unlike milestone and decision which carry both (DEC-8, QCLI-164). A task record is audit-significant in a way those two are not -- every write demands an explicit actor, and the record carries history, gateEvents and comments -- so it is retired rather than destroyed. A throwaway probe task is archived like any other; that cost is accepted rather than solved with a destructive verb. Deleting would not deliver clean removal in any case, since .quest/ is committed to Git and the record stays recoverable from history. `--if-revision <revision>` is an optional precondition (QCLI-423): capture `revision` from `task view --json`, and a value that does not match the record's current revision refuses with an exit-5 conflict -- carrying input.sentRevision beside input.actualRevision -- and moves nothing, so a guarded edit followed by an archive has no unguarded window.",
    usage:
      "quest task archive <id> [--if-revision <revision>] --actor <name> --actor-kind human",
    flags: ["--if-revision", ...ACTOR_FLAGS],
  },
  "task pause": {
    summary:
      'Pause an In Progress task to the paused status -- a BUILT-IN literal ("Paused"), NOT workspace-configurable for now (QCLI-325; opum-doc relay 570, DEC-172 (4af)) -- recording that work was started rather than resetting it. The only way in; `task edit --status` cannot reach the paused status. There is no user-reachable knob that sets it, and being built in it is never absent.',
    usage: "quest task pause <id> --actor <name> --actor-kind human",
    flags: [...ACTOR_FLAGS],
  },
  "task start": {
    summary:
      'Move a task to In Progress from either To Do or the paused status. The only way out of the paused status -- including the retired pre-0.7.0 default "Blocked" on a record parked before the rename (the paused literal is BUILT IN and the workspace cannot configure it; QCLI-302, QCLI-325); nothing is migrated silently, and `quest doctor` names such records.',
    usage: "quest task start <id> --actor <name> --actor-kind human",
    flags: [...ACTOR_FLAGS],
  },
  "task demote": {
    summary:
      "Demote a task to an explicit earlier status (--to is required; omitting it is a usage error and nothing mutates). Also reaches back from Done/archived into an active status, and reopens a Closed task to any non-terminal status, withdrawing its resolution (QCLI-331). Never reaches the paused status -- use `task start` to leave it.",
    usage:
      'quest task demote <id> --to "<status>" --actor <name> --actor-kind human',
    flags: ["--to", ...ACTOR_FLAGS],
  },
  "task close": {
    summary:
      'Retire a task that was never worked, or whose outcome did not happen, at the closed status ("Closed" by default) with a REQUIRED --resolution: duplicate, superseded, or wont-do (QCLI-331). duplicate and superseded also require --survivor <id>, the task that carries the work forward; it must already exist in some location and must not be the task itself; wont-do takes no survivor. Legal straight from To Do, In Progress, or the paused status -- there is no In Progress step to fake -- and refused from Done or Closed. Use this instead of stepping a task through In Progress to Done: Done asserts the outcome happened, Closed says it was retired without it. The record moves to completed/ like `task complete`, blocking gates do not hold it (it claims no completion), and a dependency on a Closed task counts as satisfied. --final-summary is an optional plain replace, as on `task complete`. `task demote` reopens a Closed task and withdraws its resolution; `task edit --status Closed` is refused.',
    usage:
      'quest task close <id> --resolution <duplicate|superseded|wont-do> [--survivor <id>] [--final-summary "text"] --actor <name> --actor-kind human',
    flags: ["--resolution", "--survivor", "--final-summary", ...ACTOR_FLAGS],
  },
  "draft create": {
    summary: "Create a draft (a task idea not yet promoted into the tracker).",
    usage: 'quest draft create "<title>" --actor <name> --actor-kind human',
    flags: ["--id", "--description", "--label", "--doc", ...ACTOR_FLAGS],
  },
  "draft list": {
    summary: "List drafts.",
    usage: "quest draft list [--include-archived]",
    flags: ["--include-archived"],
  },
  "draft view": {
    summary: "View one draft by id.",
    usage: "quest draft view <id>",
    flags: [],
  },
  "draft promote": {
    summary: "Promote a draft into a task.",
    usage: "quest draft promote <id> --actor <name> --actor-kind human",
    flags: ["--task-id", ...ACTOR_FLAGS],
  },
  "draft archive": {
    summary: "Archive a draft.",
    usage: "quest draft archive <id> --actor <name> --actor-kind human",
    flags: [...ACTOR_FLAGS],
  },
  "milestone list": {
    summary: "List milestones, excluding archived ones by default.",
    usage: "quest milestone list [--include-archived]",
    flags: ["--include-archived"],
  },
  "milestone view": {
    summary: "View one milestone by id.",
    usage: "quest milestone view <id>",
    flags: [],
  },
  "milestone create": {
    summary: "Create a milestone.",
    usage:
      'quest milestone create "<title>" --actor <name> --actor-kind human [--task <id>]',
    flags: ["--id", "--status", "--description", "--task", ...ACTOR_FLAGS],
  },
  "milestone edit": {
    summary:
      "Edit a milestone's fields or its linked tasks. " +
      "--add-task/--remove-task adjust the current membership; --replace-task states it " +
      "outright and cannot be combined with either. --remove-task matches a linked task id " +
      "EXACTLY, the same rule `task edit`'s by-value removals follow: an id matching nothing " +
      "is an exit-6 validation error naming the milestone id and echoing the value " +
      "JSON-delimited, and nothing is removed (QCLI-297). It is not a remove-if-present.",
    usage:
      'quest milestone edit <id> --title "<title>" --actor <name> --actor-kind human',
    flags: [
      "--title",
      "--status",
      "--description",
      "--add-task",
      "--remove-task",
      "--replace-task",
      ...ACTOR_FLAGS,
    ],
  },
  "milestone delete": {
    summary: "Delete a milestone, destroying its record.",
    usage: "quest milestone delete <id> --actor <name> --actor-kind human",
    flags: [...ACTOR_FLAGS],
  },
  "milestone archive": {
    summary:
      "Retire a milestone, preserving its record and its task references.",
    usage: "quest milestone archive <id> --actor <name> --actor-kind human",
    flags: [...ACTOR_FLAGS],
  },
  "decision list": {
    summary: "List decisions.",
    usage: "quest decision list",
    flags: [],
  },
  "decision view": {
    summary: "View one decision by id.",
    usage: "quest decision view <id>",
    flags: [],
  },
  "decision create": {
    summary: "Create a decision record.",
    usage:
      'quest decision create "<title>" --actor <name> --actor-kind human [--outcome "..."]',
    flags: [
      "--id",
      "--status",
      "--description",
      "--context",
      "--outcome",
      ...ACTOR_FLAGS,
    ],
  },
  "decision edit": {
    summary: "Edit a decision's fields.",
    usage:
      'quest decision edit <id> --outcome "..." --actor <name> --actor-kind human',
    flags: ["--title", "--status", "--context", "--outcome", ...ACTOR_FLAGS],
  },
  "decision delete": {
    summary: "Delete a decision.",
    usage: "quest decision delete <id> --actor <name> --actor-kind human",
    flags: [...ACTOR_FLAGS],
  },
  "question ask": {
    summary:
      "File an operator question (opum-doc seq 179(a), DEC-190): a record that blocks the tasks that need the answer without blocking the asking session, until the operator answers it in the Quest pane. --title is required. Supply 2 to 4 --option <key>=<label>:<description> values, and --recommend <key>, which is REQUIRED and must name one of them; a text-only answer through the pane's Other row stays allowed. The id allocates as Q-N unless --id is given. Status starts `open`.",
    usage:
      'quest question ask --title "<title>" --option A=<label>:<description> --option B=<label>:<description> [--option C=<label>:<description>] [--option D=<label>:<description>] --recommend A [--context "<context>"] --actor <name> --actor-kind human',
    flags: [
      "--id",
      "--title",
      "--context",
      "--option",
      "--recommend",
      ...ACTOR_FLAGS,
    ],
  },
  "question answer": {
    summary:
      "Record the operator's answer to an open question: either --choice <option key> or --text \"<their own words, verbatim>\". The actor MUST be the operator -- --actor-kind human is required, and a delegated agent is refused (the CLI half of the design's forgery guard). --via names how the answer arrived; the Quest board pane passes quest-board-pane, and any other value is not an operator answer. Sets status `answered`.",
    usage:
      'quest question answer <id> --choice <key> | --text "<words>" [--via "<source>"] --actor <name> --actor-kind human',
    flags: ["--choice", "--text", "--via", ...ACTOR_FLAGS],
  },
  "question withdraw": {
    summary:
      "Withdraw an open question that no longer needs asking, recording --reason. Sets status `withdrawn`. Only an `open` question can be answered or withdrawn.",
    usage:
      'quest question withdraw <id> --reason "<text>" --actor <name> --actor-kind human',
    flags: ["--reason", ...ACTOR_FLAGS],
  },
  "question list": {
    summary: "List question records, optionally filtered by --status.",
    usage: "quest question list [--status open|answered|withdrawn]",
    flags: ["--status"],
  },
  "question view": {
    summary: "View one question record by id.",
    usage: "quest question view <id>",
    flags: [],
  },
  overview: {
    summary:
      "Print a project-wide task overview. Task counts span every retention location -- .quest/tasks/, completed/ and archive/tasks/ -- so completing a task moves a count rather than removing the record from it; byLocation names how the total divides. Milestone counts report archived alongside open and closed: a retired milestone is neither open nor closed work, and is counted separately rather than silently dropped.",
    usage: "quest overview",
    flags: [],
  },
  board: {
    summary: "Print tasks grouped by status, like a kanban board.",
    usage: "quest board",
    flags: [],
  },
  "board export": {
    summary:
      "Write the board to a Markdown file, for pasting into a pull request or doc.",
    usage: "quest board export <file> [--force]",
    flags: ["--force"],
  },
  doctor: {
    summary:
      'Check the workspace for consistency problems: milestone references to unknown tasks, and active tasks parked at a status on neither the configured ladder nor the paused slot (for example the retired pre-0.7.0 paused literal "Blocked"), each with the command that repairs it.',
    usage: "quest doctor",
    flags: [],
  },
  check: {
    summary:
      "Run a named check. --continuity fails when a task record id or alias present at the merge base of --base and HEAD resolves to no record in the current store (DEC-18/QCLI-415): a record may live in .quest/tasks, .quest/completed or .quest/archive/tasks, so it is a dropped record rather than a moved one that this catches. A broken continuity is a `drift` diagnostic on exit 6 naming every missing reference; an empty read at the base is itself a failure, so a misdirected --base cannot pass as clean. This is the check a Tracker integrity job runs.",
    usage: "quest check --continuity --base <ref>",
    flags: ["--continuity", "--base"],
  },
  cleanup: {
    summary: "Remove closed, unreferenced milestones and superseded decisions.",
    usage: "quest cleanup --confirm --actor <name> --actor-kind human",
    flags: ["--dry-run", "--confirm", ...ACTOR_FLAGS],
  },
  browser: {
    summary:
      "Start a local read-only web server showing the overview and board. It runs until it is stopped, or until the workspace root it was started against no longer exists, which it checks every 2 seconds (QCLI-348). It does not stop when its parent process exits.",
    usage: "quest browser [--port 4173]",
    flags: ["--port"],
  },
};
