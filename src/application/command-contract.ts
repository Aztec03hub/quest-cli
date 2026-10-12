import type { TaskVocabularyContext } from "../domain/tasks/vocabulary.ts";
import { commandHelp } from "./command-help.ts";
import { flagParameter, positionalParameters } from "./command-parameters.ts";
import {
  type DiagnosticEnvelope,
  type ExitCode,
  exitCodes,
  type ResultEnvelope,
} from "../domain/command-contract.ts";

export type OutputMode = "json" | "plain" | "pretty";

export interface OutputFlags {
  readonly json?: boolean;
  readonly plain?: boolean;
  readonly stdoutIsTty: boolean;
}

export function selectOutputMode(flags: OutputFlags): OutputMode {
  if (flags.json) return "json";
  if (flags.plain || !flags.stdoutIsTty) return "plain";
  return "pretty";
}

export function success<TData extends object | readonly unknown[]>(
  kind: `${string}.${string}`,
  data: TData,
): ResultEnvelope<TData> {
  return { schemaVersion: 1, contractVersion: 1, kind, data, principal: null };
}

export function diagnostic(
  errorType: DiagnosticEnvelope["error_type"],
  message: string,
  options: Pick<DiagnosticEnvelope, "hint" | "input"> = {},
): DiagnosticEnvelope {
  return { error_type: errorType, message, ...options, principal: null };
}

export function exitCodeFor(
  errorType: DiagnosticEnvelope["error_type"],
): ExitCode {
  switch (errorType) {
    case "uncaught":
      return exitCodes.uncaught;
    case "usage":
      return exitCodes.usage;
    case "not_found":
      return exitCodes.notFound;
    case "denied":
      return exitCodes.denied;
    case "conflict":
      return exitCodes.conflict;
    case "validation":
    case "drift":
      return exitCodes.validationOrDrift;
  }
}

export interface CommandManifestEntry {
  readonly name:
    | "manifest"
    | "version"
    | "help"
    | "init"
    | "init --reconfigure"
    | "instructions"
    | "instructions --list"
    | "instructions <guide>"
    | "agents"
    | "completion"
    | "migration backlog preview"
    | "migration backlog apply"
    | "migration backlog status"
    | "migration backlog rollback"
    | "task status-flow"
    | "task binding"
    | "task list"
    | "task list --across-refs"
    | "task view"
    | "search"
    | "search --all"
    | "task create"
    | "task edit"
    | "task edit-batch"
    | "task pause"
    | "task start"
    | "task complete"
    | "task archive"
    | "task demote"
    | "task close"
    | "draft create"
    | "draft list"
    | "draft view"
    | "draft promote"
    | "draft archive"
    | "milestone list"
    | "milestone view"
    | "milestone create"
    | "milestone edit"
    | "milestone delete"
    | "milestone archive"
    | "decision list"
    | "decision view"
    | "decision create"
    | "decision edit"
    | "decision delete"
    | "overview"
    | "board"
    | "board export"
    | "doctor"
    | "check"
    | "cleanup"
    | "browser";
  readonly schemaVersion: 1;
  readonly kind: `${string}.${string}` | null;
  readonly mutates: boolean;
  readonly fields?: readonly string[];
  readonly filters?: readonly string[];
}

export const commandManifest = {
  commands: [
    {
      name: "manifest",
      schemaVersion: 1,
      kind: "manifest.registry",
      mutates: false,
    },
    {
      name: "version",
      schemaVersion: 1,
      kind: null,
      mutates: false,
    },
    { name: "help", schemaVersion: 1, kind: "help.commands", mutates: false },
    {
      name: "init",
      schemaVersion: 1,
      kind: "workspace.initialized",
      mutates: true,
    },
    // A separate entry rather than reusing "init": --reconfigure emits a
    // different envelope kind because it is a different event -- updating
    // declared config on an existing workspace, never creating one -- not a
    // second spelling of initialization (QCLI-161).
    {
      name: "init --reconfigure",
      schemaVersion: 1,
      kind: "workspace.reconfigured",
      mutates: true,
    },
    // Three entries rather than one, following `search` / `search --all`: the
    // three forms emit three different envelope kinds, and a consumer reading
    // the registry to learn which envelope to expect must be able to find the
    // one that matches the invocation it is about to make. Declaring only the
    // bare form's kind made the other two undiscoverable (QCLI-151).
    {
      name: "instructions",
      schemaVersion: 1,
      kind: "agent.instructions",
      mutates: false,
      // Bare: the managed block. With a guide name: that guide. With --list:
      // the guide index. There is deliberately no "all" (QCLI-141).
      filters: ["guide", "list"],
      fields: ["content", "version"],
    },
    {
      name: "instructions --list",
      schemaVersion: 1,
      kind: "agent.guides",
      mutates: false,
      fields: ["guides", "version"],
    },
    {
      name: "instructions <guide>",
      schemaVersion: 1,
      kind: "agent.guide",
      mutates: false,
      fields: ["content", "name", "summary", "version"],
    },
    {
      name: "agents",
      schemaVersion: 1,
      kind: "agent.instructions-status",
      mutates: true,
    },
    {
      name: "completion",
      schemaVersion: 1,
      kind: "completion.script",
      mutates: false,
    },
    {
      name: "migration backlog preview",
      schemaVersion: 1,
      kind: "migration.backlog-preview",
      mutates: false,
      fields: ["digest", "mappings", "requiresApproval", "sourceFingerprint"],
    },
    {
      name: "migration backlog apply",
      schemaVersion: 1,
      kind: "migration.backlog-applied",
      mutates: true,
      fields: ["digest"],
    },
    {
      name: "migration backlog status",
      schemaVersion: 1,
      kind: "migration.backlog-status",
      mutates: false,
      fields: ["digest"],
    },
    {
      name: "migration backlog rollback",
      schemaVersion: 1,
      kind: "migration.backlog-rolled-back",
      mutates: true,
      fields: ["digest"],
    },
    {
      name: "task status-flow",
      schemaVersion: 1,
      kind: "task.status-flow",
      mutates: false,
      // QCLI-325: `pausedStatusConfigurable` is emitted beside `pausedStatus`
      // (always false for now -- opum-doc relay 570, DEC-172 (4af)).
      // QCLI-482: the COMPLETE emitted key set. `closedStatus` and
      // `resolutions` are emitted too whenever a closed status is configured
      // (src/cli/commands/task/index.ts), so a curated subset here was the
      // same under-declaration QCLI-461 closed for task list/view/search.
      fields: [
        "statuses",
        "terminalStatuses",
        "pausedStatus",
        "pausedStatusConfigurable",
        "closedStatus",
        "resolutions",
      ],
    },
    {
      name: "task binding",
      schemaVersion: 1,
      kind: "task.binding",
      mutates: false,
      fields: [
        "baseRef",
        "contract",
        "expiresAt",
        "holder",
        "issuedAt",
        "relationshipId",
        "relationshipKind",
        "relationshipState",
        "repositoryId",
        "requestId",
        "selectedVersion",
        "settlementRef",
        "taskId",
        "taskState",
      ],
    },
    {
      name: "task list",
      schemaVersion: 1,
      kind: "task.list",
      mutates: false,
      filters: [
        "assignee",
        "exclude-status",
        "fields",
        "include-archived",
        "label",
        "limit",
        "milestone",
        "parent",
        "priority",
        "ready",
        "search",
        "sort",
        "status",
        "type",
        "unassigned",
        "unresolved-at-completion",
      ],
      // QCLI-461: the COMPLETE top-level key set a `task list` item can carry
      // -- the task record's keys plus `path` -- not a curated subset. A key
      // is present in an item only when the record carries it (many are
      // conditional); the declared set is the union over records.
      fields: [
        "acceptanceCriteria",
        "aliases",
        "assignees",
        "blockers",
        "claim",
        "comments",
        "createdAt",
        "definitionOfDone",
        "dependencies",
        "description",
        "documentation",
        "finalSummary",
        "gateEvents",
        "gates",
        "id",
        "implementationNotes",
        "labels",
        "milestoneId",
        "modifiedFiles",
        "ordinal",
        "parentId",
        "path",
        "plan",
        "priority",
        "references",
        "resolution",
        "source",
        "status",
        "summary",
        "title",
        "type",
        "unresolvedAtCompletion",
        "updatedAt",
      ],
    },
    {
      // QCLI-417 / DEC-40. Its own entry rather than more filters on
      // `task list`: the KIND differs (`task.list-across-refs`), the payload
      // shape differs (one entry per task id with a states array), and a
      // consumer switching on kind has to be able to find it. The coverage
      // key is a top-level envelope key, so it is not listed in `fields` --
      // those describe `data`.
      name: "task list --across-refs",
      schemaVersion: 1,
      kind: "task.list-across-refs",
      mutates: false,
      filters: [
        "across-refs",
        "allow-partial",
        "assignee",
        "exclude-status",
        "include-archived",
        "label",
        "limit",
        "milestone",
        "parent",
        "pr",
        "priority",
        "ref",
        "search",
        "sort",
        "status",
        "type",
        "unassigned",
        "unresolved-at-completion",
      ],
      fields: ["conflict", "id", "identity", "proposedBy", "states", "title"],
    },
    {
      name: "task view",
      schemaVersion: 1,
      kind: "task.view",
      mutates: false,
      // QCLI-276 / DEC-3: `--max-notes N` caps `implementationNotes` to the
      // most recent N entries; absent, the read is the full unbounded
      // record, unchanged.
      // QCLI-291 / DEC-161: `--fields` is the same projection `task list`
      // takes, against `task view`'s own `fields` below.
      filters: ["fields", "max-notes"],
      // QCLI-461: the COMPLETE top-level key set a `task view` record can
      // carry -- the task record's keys plus `path`, `revision` and the
      // conditional `notesOmitted` -- not a curated subset.
      fields: [
        "acceptanceCriteria",
        "aliases",
        "assignees",
        "blockers",
        "claim",
        "comments",
        "createdAt",
        "definitionOfDone",
        "dependencies",
        "description",
        "documentation",
        "finalSummary",
        "gateEvents",
        "gates",
        "id",
        "implementationNotes",
        "labels",
        "milestoneId",
        "modifiedFiles",
        "notesOmitted",
        "ordinal",
        "parentId",
        "path",
        "plan",
        "priority",
        "references",
        "resolution",
        "revision",
        "source",
        "status",
        "summary",
        "title",
        "type",
        "unresolvedAtCompletion",
        "updatedAt",
      ],
    },
    {
      name: "search",
      schemaVersion: 1,
      kind: "task.search",
      mutates: false,
      filters: ["query"],
      // QCLI-461: the COMPLETE top-level key set a `search` item can carry
      // (the task record's keys -- search adds no `path`), not a curated
      // subset. The same defect as `task list`/`task view`; corrected here
      // because the payload-subset-of-declared test covers this surface too.
      fields: [
        "acceptanceCriteria",
        "aliases",
        "assignees",
        "blockers",
        "claim",
        "comments",
        "createdAt",
        "definitionOfDone",
        "dependencies",
        "description",
        "documentation",
        "finalSummary",
        "gateEvents",
        "gates",
        "id",
        "implementationNotes",
        "labels",
        "milestoneId",
        "modifiedFiles",
        "ordinal",
        "parentId",
        "plan",
        "priority",
        "references",
        "resolution",
        "source",
        "status",
        "summary",
        "title",
        "type",
        "unresolvedAtCompletion",
        "updatedAt",
      ],
    },
    {
      name: "search --all",
      schemaVersion: 1,
      kind: "search.results",
      mutates: false,
      filters: ["query"],
    },
    {
      name: "task create",
      schemaVersion: 1,
      kind: "task.created",
      mutates: true,
      fields: [
        "acceptanceCriteria",
        "aliases",
        "assignees",
        "comments",
        "definitionOfDone",
        "description",
        "documentation",
        "finalSummary",
        "implementationNotes",
        "labels",
        "milestoneId",
        "modifiedFiles",
        "ordinal",
        "parentId",
        "plan",
        "priority",
        "references",
        "summary",
        "title",
        "type",
      ],
    },
    {
      name: "task edit",
      schemaVersion: 1,
      kind: "task.updated",
      mutates: true,
      fields: [
        "acceptanceCriteria",
        "addAssignees",
        "addComments",
        "addDependencies",
        "addLabels",
        "addModifiedFiles",
        "addNotes",
        "addPlan",
        "addReferences",
        "appendFinalSummary",
        "checkAcceptanceCriteria",
        "checkDefinitionOfDone",
        "clearAcceptanceCriteria",
        "clearDefinitionOfDone",
        "clearFinalSummary",
        "clearMilestone",
        "clearParent",
        "comments",
        "definitionOfDone",
        "description",
        "documentation",
        "finalSummary",
        "implementationNotes",
        "labels",
        "milestoneId",
        "ordinal",
        "parentId",
        "plan",
        "priority",
        "removeAcceptanceCriteria",
        "removeAssignees",
        "removeComments",
        "removeDefinitionOfDone",
        "removeDependencies",
        "removeLabels",
        "removeModifiedFiles",
        "removeNotes",
        "removePlan",
        "removeReferences",
        "status",
        "summary",
        "title",
        "type",
        "uncheckAcceptanceCriteria",
        "uncheckDefinitionOfDone",
      ],
    },
    {
      name: "task edit-batch",
      schemaVersion: 1,
      kind: "task.batch-updated",
      mutates: true,
      fields: [
        "acceptanceCriteria",
        "addAssignees",
        "addComments",
        "addDependencies",
        "addLabels",
        "addModifiedFiles",
        "addNotes",
        "addPlan",
        "addReferences",
        "appendFinalSummary",
        "checkAcceptanceCriteria",
        "checkDefinitionOfDone",
        "clearAcceptanceCriteria",
        "clearDefinitionOfDone",
        "clearFinalSummary",
        "clearMilestone",
        "clearParent",
        "comments",
        "definitionOfDone",
        "description",
        "documentation",
        "finalSummary",
        "implementationNotes",
        "labels",
        "milestoneId",
        "ordinal",
        "parentId",
        "plan",
        "priority",
        "removeAcceptanceCriteria",
        "removeAssignees",
        "removeComments",
        "removeDefinitionOfDone",
        "removeDependencies",
        "removeLabels",
        "removeModifiedFiles",
        "removeNotes",
        "removePlan",
        "removeReferences",
        "status",
        "summary",
        "title",
        "type",
        "uncheckAcceptanceCriteria",
        "uncheckDefinitionOfDone",
      ],
    },
    {
      name: "task pause",
      schemaVersion: 1,
      kind: "task.paused",
      mutates: true,
    },
    {
      name: "task start",
      schemaVersion: 1,
      kind: "task.started",
      mutates: true,
    },
    {
      name: "task complete",
      schemaVersion: 1,
      kind: "task.completed",
      mutates: true,
      fields: ["finalSummary"],
    },
    {
      name: "task archive",
      schemaVersion: 1,
      kind: "task.archived",
      mutates: true,
    },
    {
      name: "task demote",
      schemaVersion: 1,
      kind: "task.demoted",
      mutates: true,
      filters: ["to"],
    },
    {
      // QCLI-331: the second terminal status, with a required resolution.
      name: "task close",
      schemaVersion: 1,
      kind: "task.closed",
      mutates: true,
      fields: ["finalSummary", "resolution"],
    },
    {
      name: "draft create",
      schemaVersion: 1,
      kind: "draft.created",
      mutates: true,
      fields: ["description", "documentation", "labels", "title"],
    },
    {
      name: "draft list",
      schemaVersion: 1,
      kind: "draft.list",
      mutates: false,
      filters: ["include-archived"],
    },
    {
      name: "draft view",
      schemaVersion: 1,
      kind: "draft.view",
      mutates: false,
      fields: ["description", "documentation", "labels", "title"],
    },
    {
      name: "draft promote",
      schemaVersion: 1,
      kind: "draft.promoted",
      mutates: true,
    },
    {
      name: "draft archive",
      schemaVersion: 1,
      kind: "draft.archived",
      mutates: true,
    },
    {
      name: "milestone list",
      schemaVersion: 1,
      kind: "milestone.list",
      mutates: false,
      filters: ["include-archived"],
      fields: ["archived", "description", "status", "taskIds", "title"],
    },
    {
      name: "milestone view",
      schemaVersion: 1,
      kind: "milestone.view",
      mutates: false,
      fields: ["archived", "description", "status", "taskIds", "title"],
    },
    {
      name: "milestone create",
      schemaVersion: 1,
      kind: "milestone.created",
      mutates: true,
      fields: ["archived", "description", "status", "taskIds", "title"],
    },
    {
      name: "milestone edit",
      schemaVersion: 1,
      kind: "milestone.updated",
      mutates: true,
      fields: ["archived", "description", "status", "taskIds", "title"],
    },
    {
      name: "milestone delete",
      schemaVersion: 1,
      kind: "milestone.deleted",
      mutates: true,
    },
    {
      name: "milestone archive",
      schemaVersion: 1,
      kind: "milestone.archived",
      mutates: true,
      fields: ["archived", "description", "status", "taskIds", "title"],
    },
    {
      name: "decision list",
      schemaVersion: 1,
      kind: "decision.list",
      mutates: false,
      fields: ["context", "outcome", "status", "title"],
    },
    {
      name: "decision view",
      schemaVersion: 1,
      kind: "decision.view",
      mutates: false,
      fields: ["context", "outcome", "status", "title"],
    },
    {
      name: "decision create",
      schemaVersion: 1,
      kind: "decision.created",
      mutates: true,
      fields: ["context", "outcome", "status", "title"],
    },
    {
      name: "decision edit",
      schemaVersion: 1,
      kind: "decision.updated",
      mutates: true,
      fields: ["context", "outcome", "status", "title"],
    },
    {
      name: "decision delete",
      schemaVersion: 1,
      kind: "decision.deleted",
      mutates: true,
    },
    {
      name: "overview",
      schemaVersion: 1,
      kind: "project.overview",
      mutates: false,
    },
    { name: "board", schemaVersion: 1, kind: "project.board", mutates: false },
    {
      name: "board export",
      schemaVersion: 1,
      kind: "project.board-export",
      // Writes a file outside the task store; no tracker record changes, so
      // no actor is required, matching every other read command.
      mutates: false,
      filters: ["force"],
      fields: ["bytes", "path"],
    },
    {
      name: "doctor",
      schemaVersion: 1,
      kind: "project.doctor",
      mutates: false,
    },
    {
      // DEC-18/QCLI-415. `data` is a ContinuityReport; a broken continuity is
      // reported as a `drift` diagnostic (exit 6) rather than a result, so a
      // Tracker integrity job turns red on it.
      name: "check",
      schemaVersion: 1,
      kind: "check.continuity",
      mutates: false,
    },
    {
      name: "cleanup",
      schemaVersion: 1,
      kind: "project.cleanup",
      mutates: true,
    },
    {
      name: "browser",
      schemaVersion: 1,
      kind: "browser.started",
      mutates: false,
    },
  ] satisfies readonly CommandManifestEntry[],
  exitCodes,
} as const;

/**
 * QCLI-266: the registry plus each command's argument SHAPE. `fields` lists
 * domain field names and cannot tell a caller that `title` is positional or
 * that `--acceptance-criteria` takes one JSON array, so a caller generating a
 * command line from it wrote `--title` and failed. `parameters` is additive --
 * every existing key, `fields` included, is untouched -- and is derived from
 * the same `usage` string and flag sets the CLI itself parses with, so it
 * cannot drift from what the command accepts.
 */
function withParameters(entries: typeof commandManifest.commands) {
  return entries.map((entry) => {
    const help = commandHelp[entry.name];
    if (!help) return entry;
    const flags = Object.fromEntries(
      help.flags.map((flag) => [flag, flagParameter(flag, entry.name)]),
    );
    return {
      ...entry,
      parameters: {
        positional: positionalParameters(help.usage),
        flags,
      },
    };
  });
}

/**
 * QCLI-330: `data.taskVocabulary` carries the workspace's configured sets, so
 * a consumer can validate a value before writing it. A field that is OPEN is
 * `null`, never `[]`: open and configured are different facts, and an empty
 * list would read as "nothing is allowed" (opum-agent OPAG-177 depends on
 * telling them apart). Outside a workspace -- or when a declared `[tasks]`
 * table cannot be read -- both are null, so the manifest itself never fails
 * on configuration. The key sits inside `data`, never at the top level, so
 * the envelope's key order is untouched.
 */
export function manifestResult(
  context: TaskVocabularyContext = { vocabulary: {} },
) {
  return success("manifest.registry", {
    ...commandManifest,
    commands: withParameters(commandManifest.commands),
    // A broken [tasks] table reads as OPEN here rather than failing the
    // manifest: lore-cli's adapter probes with manifest --json, and doctor
    // is the command that names the problem.
    taskVocabulary:
      context.problem !== undefined
        ? { types: null, priorities: null }
        : {
            types: context.vocabulary.types ?? null,
            priorities: context.vocabulary.priorities ?? null,
          },
  });
}

export function validateCommandManifest(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== "object") return false;
  const candidate = manifest as {
    commands?: unknown;
    exitCodes?: unknown;
  };
  if (!Array.isArray(candidate.commands) || candidate.commands.length === 0)
    return false;
  if (JSON.stringify(candidate.exitCodes) !== JSON.stringify(exitCodes)) {
    return false;
  }
  const canonical = new Map<string, CommandManifestEntry>();
  for (const entry of commandManifest.commands)
    canonical.set(entry.name, entry);
  const names = new Set<string>();
  const kinds = new Set<string>();
  // Non-empty unique string lists; the live manifest never advertises an
  // empty list, and order is part of the closed-set contract (exact
  // JSON.stringify equality below is deliberately order-sensitive).
  const isStringList = (value: unknown): boolean =>
    value === undefined ||
    (Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => typeof item === "string") &&
      new Set(value).size === value.length);
  for (const command of candidate.commands) {
    if (!command || typeof command !== "object") return false;
    const entry = command as Record<string, unknown>;
    if (
      typeof entry.name !== "string" ||
      entry.schemaVersion !== 1 ||
      typeof entry.mutates !== "boolean" ||
      names.has(entry.name)
    ) {
      return false;
    }
    if (!canonical.has(entry.name)) return false;
    if (!isStringList(entry.fields) || !isStringList(entry.filters))
      return false;
    const expected = canonical.get(entry.name);
    if (
      !expected ||
      entry.kind !== expected.kind ||
      entry.mutates !== expected.mutates ||
      JSON.stringify(entry.fields ?? []) !==
        JSON.stringify(expected.fields ?? []) ||
      JSON.stringify(entry.filters ?? []) !==
        JSON.stringify(expected.filters ?? [])
    ) {
      return false;
    }
    names.add(entry.name);
    if (entry.kind !== null) {
      if (
        typeof entry.kind !== "string" ||
        !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(entry.kind) ||
        kinds.has(entry.kind)
      ) {
        return false;
      }
      kinds.add(entry.kind);
    }
  }
  for (const entry of commandManifest.commands)
    if (!names.has(entry.name)) return false;
  return true;
}
