import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  readQuestConfiguration,
  validateQuestConfiguration,
} from "../../src/adapters/toml-configuration.ts";
import { questSkillContent } from "../../src/application/agents/agent-instructions.ts";
import {
  findQuestGuide,
  questGuides,
} from "../../src/application/agents/guides.ts";
import {
  commandManifest,
  diagnostic,
  exitCodeFor,
  manifestResult,
  selectOutputMode,
  success,
  validateCommandManifest,
} from "../../src/application/command-contract.ts";
import { commandHelp } from "../../src/application/command-help.ts";

test("success envelopes have the frozen Opum wire shape", () => {
  const envelope = success("query.results", { tasks: [] });
  expect(envelope).toEqual({
    schemaVersion: 1,
    contractVersion: 1,
    kind: "query.results",
    data: { tasks: [] },
    principal: null,
  });
  expect(Object.keys(envelope).at(-1)).toBe("principal");
});

test("diagnostics classify every non-success exit and retain principal", () => {
  const expectedExits = {
    uncaught: 1,
    usage: 2,
    not_found: 3,
    denied: 4,
    conflict: 5,
    validation: 6,
    drift: 6,
  } as const;
  for (const [errorType, exitCode] of Object.entries(expectedExits)) {
    const typedError = errorType as keyof typeof expectedExits;
    const envelope = diagnostic(typedError, "Failure.");
    expect(envelope).toEqual({
      error_type: typedError,
      message: "Failure.",
      principal: null,
    });
    expect(Object.keys(envelope).at(-1), typedError).toBe("principal");
    expect(exitCodeFor(typedError)).toBe(exitCode);
  }
});

test("JSON wins over plain, and non-TTY output is plain", () => {
  expect(selectOutputMode({ json: true, plain: true, stdoutIsTty: true })).toBe(
    "json",
  );
  expect(selectOutputMode({ plain: true, stdoutIsTty: true })).toBe("plain");
  expect(selectOutputMode({ stdoutIsTty: false })).toBe("plain");
  expect(selectOutputMode({ stdoutIsTty: true })).toBe("pretty");
});

test("configuration is additive and rejects unsupported schemas without mutation", () => {
  expect(
    validateQuestConfiguration('schemaVersion = 1\nextra = "allowed"'),
  ).toMatchObject({
    ok: true,
    configuration: { extra: "allowed" },
  });
  expect(validateQuestConfiguration("schemaVersion = 2")).toEqual({
    ok: false,
    errorType: "drift",
    message: "Unsupported Quest configuration schema 2; expected 1.",
  });
  expect(validateQuestConfiguration('schemaVersion = "one"')).toMatchObject({
    ok: false,
    errorType: "validation",
  });
  expect(validateQuestConfiguration("not valid TOML =")).toMatchObject({
    ok: false,
    errorType: "validation",
  });
});

test("configuration reads through its read-only port without normalizing input", async () => {
  const original = 'schemaVersion = 1\nextra = "allowed"';
  let reads = 0;
  const result = await readQuestConfiguration({
    async read() {
      reads += 1;
      return original;
    },
  });
  expect(reads).toBe(1);
  expect(result).toMatchObject({
    ok: true,
    configuration: { extra: "allowed" },
  });
  expect(original).toBe('schemaVersion = 1\nextra = "allowed"');
  expect(
    await readQuestConfiguration({
      async read() {
        return undefined;
      },
    }),
  ).toBe(undefined);
});

test("the live manifest is non-empty and matches its result golden", () => {
  expect(commandManifest.commands).toEqual([
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
    {
      name: "init --reconfigure",
      schemaVersion: 1,
      kind: "workspace.reconfigured",
      mutates: true,
    },
    {
      name: "instructions",
      schemaVersion: 1,
      kind: "agent.instructions",
      mutates: false,
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
      fields: ["statuses", "terminalStatuses", "pausedStatus"],
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
      filters: ["fields", "max-notes"],
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
      // QCLI-415/DEC-18: `check --continuity` reports a ContinuityReport, or
      // a `drift` diagnostic (exit 6) when continuity is broken.
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
  ]);
  expect(manifestResult()).toMatchObject({
    schemaVersion: 1,
    kind: "manifest.registry",
    principal: null,
  });
  expect(validateCommandManifest(commandManifest)).toBe(true);
  expect(validateCommandManifest({ ...commandManifest, commands: [] })).toBe(
    false,
  );
  expect(
    validateCommandManifest({
      ...commandManifest,
      commands: [commandManifest.commands[0], commandManifest.commands[0]],
    }),
  ).toBe(false);
  expect(
    validateCommandManifest({
      ...commandManifest,
      exitCodes: { ...commandManifest.exitCodes, conflict: 99 },
    }),
  ).toBe(false);
  expect(
    validateCommandManifest({
      ...commandManifest,
      commands: [{ ...commandManifest.commands[0], kind: "out-of-band" }],
    }),
  ).toBe(false);
  expect(
    validateCommandManifest({
      ...commandManifest,
      commands: [{ ...commandManifest.commands[0], mutates: undefined }],
    }),
  ).toBe(false);
});

test("manifest conformance rejects unknown, missing, and drifted command entries", () => {
  const withUnknown = {
    ...commandManifest,
    commands: [
      ...commandManifest.commands,
      {
        name: "task export",
        schemaVersion: 1,
        kind: "task.exported",
        mutates: false,
      },
    ],
  };
  expect(validateCommandManifest(withUnknown)).toBe(false);
  const withoutBrowser = {
    ...commandManifest,
    commands: commandManifest.commands.filter(
      (entry) => entry.name !== "browser",
    ),
  };
  expect(validateCommandManifest(withoutBrowser)).toBe(false);
  const flippedMutates = {
    ...commandManifest,
    commands: commandManifest.commands.map((entry) =>
      entry.name === "task create" ? { ...entry, mutates: false } : entry,
    ),
  };
  expect(validateCommandManifest(flippedMutates)).toBe(false);
  const driftedKind = {
    ...commandManifest,
    commands: commandManifest.commands.map((entry) =>
      entry.name === "task edit"
        ? { ...entry, kind: "task.edited" as `${string}.${string}` }
        : entry,
    ),
  };
  expect(validateCommandManifest(driftedKind)).toBe(false);
  const badFields = {
    ...commandManifest,
    commands: commandManifest.commands.map((entry) =>
      entry.name === "task view" ? { ...entry, fields: "nope" } : entry,
    ),
  };
  expect(validateCommandManifest(badFields)).toBe(false);
  const duplicateFields = {
    ...commandManifest,
    commands: commandManifest.commands.map((entry) =>
      entry.name === "task view"
        ? { ...entry, fields: ["id", "id"] as readonly string[] }
        : entry,
    ),
  };
  expect(validateCommandManifest(duplicateFields)).toBe(false);
  const omittedFields = {
    ...commandManifest,
    commands: commandManifest.commands.map((entry) =>
      entry.name === "task view"
        ? {
            name: entry.name,
            schemaVersion: 1,
            kind: entry.kind,
            mutates: entry.mutates,
          }
        : entry,
    ),
  };
  expect(validateCommandManifest(omittedFields)).toBe(false);
});

test("migration capabilities advertise exact kinds and mutability", () => {
  const byName = new Map(commandManifest.commands.map((e) => [e.name, e]));
  expect(byName.get("migration backlog preview")).toMatchObject({
    kind: "migration.backlog-preview",
    mutates: false,
  });
  expect(byName.get("migration backlog apply")).toMatchObject({
    kind: "migration.backlog-applied",
    mutates: true,
  });
  expect(byName.get("migration backlog status")).toMatchObject({
    kind: "migration.backlog-status",
    mutates: false,
  });
  expect(byName.get("migration backlog rollback")).toMatchObject({
    kind: "migration.backlog-rolled-back",
    mutates: true,
  });
  const kinds = commandManifest.commands.flatMap((entry) =>
    entry.kind === null ? [] : [entry.kind],
  );
  for (const kind of kinds)
    expect(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(kind)).toBe(true);
  expect(new Set(kinds).size).toBe(kinds.length);
  expect(validateCommandManifest(commandManifest)).toBe(true);
});

test("the overview guide lists every lifecycle verb the manifest declares", () => {
  // The overview guide holds the agent-facing command list (QCLI-141 moved it
  // out of the skill so the two cannot drift), so a verb added to a lifecycle
  // group without touching it ships a list that is quietly wrong. Prose
  // spellings vary ("create/list/view", or the group named once and the verbs
  // after it), so this reads every backticked span on a line that mentions the
  // group rather than matching one shape.
  const commandList = questGuides.find(
    (guide) => guide.name === "overview",
  )?.content;
  expect(commandList).toBeDefined();
  for (const group of ["task", "draft", "milestone", "decision"]) {
    const mentioned = new Set<string>();
    for (const line of (commandList ?? "").split("\n")) {
      const spans = [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
      if (
        !spans.some((span) => span === group || span?.startsWith(`${group} `))
      )
        continue;
      for (const span of spans) {
        const bare = (span ?? "").replace(new RegExp(`^${group}\\s+`), "");
        // A manifest name inside a lifecycle group may itself carry a flag
        // (`task list --across-refs`, QCLI-417), so the whole remainder counts
        // as a mention too -- tokenizing alone can never produce it, and
        // without this the guide could omit the invocation and still pass.
        if (span !== undefined && span !== bare && bare.length > 0)
          mentioned.add(bare);
        for (const token of bare.split(/[/\s]+/))
          if (token) mentioned.add(token);
      }
    }
    const declared = commandManifest.commands
      .map((entry: { name: string }) => entry.name)
      .filter((name: string) => name.startsWith(`${group} `))
      .map((name: string) => name.slice(group.length + 1));
    expect(declared.length).toBeGreaterThan(0);
    expect({
      group,
      missing: declared.filter((verb: string) => !mentioned.has(verb)),
    }).toEqual({ group, missing: [] });
  }
});

test("the skill and the guides never restate the same guidance (QCLI-141)", () => {
  // AC4/AC5: guidance lives in the guides, and the skill points at them. Two
  // copies drift, and the drift is invisible because both surfaces look
  // authoritative. Overlap is measured in eight-word shingles rather than
  // whole sentences, so a reworded copy, a bullet list with no terminal
  // punctuation, or a block lifted into a code fence all still trip it.
  const shingles = (text: string) => {
    const words = text
      .replace(/[`*#>|-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
      .split(" ")
      .filter(Boolean);
    const result = new Map<string, string>();
    for (let index = 0; index + 8 <= words.length; index += 1) {
      const window = words.slice(index, index + 8);
      result.set(window.join(" "), window.join(" "));
    }
    return result;
  };

  const skill = shingles(questSkillContent);
  for (const guide of questGuides) {
    const shared = [...shingles(guide.content).keys()].filter((phrase) =>
      skill.has(phrase),
    );
    expect({ guide: guide.name, shared }).toEqual({
      guide: guide.name,
      shared: [],
    });
  }

  // The skill must stay a pointer: it names the CLI entry points and little
  // else. A skill that grows past this has started restating a guide.
  expect(questSkillContent.split("\n").length).toBeLessThan(30);
  expect(questSkillContent).toContain("quest instructions --list");
});

test("every guide is discoverable and none of them is an aggregate (QCLI-141)", () => {
  expect(questGuides.map((guide) => guide.name)).toEqual([
    "overview",
    "task-creation",
    "task-execution",
    "task-finalization",
    "workspace",
  ]);
  // The recorded decision: no "all" guide. Guides exist to be loaded one at a
  // time, and bundling them defeats that.
  expect(questGuides.some((guide) => guide.name === "all")).toBe(false);
  for (const guide of questGuides) {
    expect(guide.summary.length).toBeGreaterThan(0);
    expect(guide.summary).not.toContain("\n");
    expect(guide.content).toContain("# ");
    expect(findQuestGuide(guide.name)).toBe(guide);
  }
  expect(findQuestGuide("all")).toBeUndefined();
});

test("the CLI and application sort vocabularies stay in sync (QCLI-137)", async () => {
  // The list is written twice — the CLI parses and error-messages from its
  // copy, the application layer sorts from its own. Nothing but this keeps
  // them equal, and a field in one but not the other is either an accepted
  // flag that cannot sort or a sort that cannot be asked for.
  const cli = await Bun.file(
    new URL("../../src/cli/main.ts", import.meta.url),
  ).text();
  const application = await Bun.file(
    new URL("../../src/application/tasks/tasks.ts", import.meta.url),
  ).text();
  const fields = (source: string) => {
    const block = source.slice(source.indexOf("TASK_LIST_SORT_FIELDS"));
    return [...block.slice(0, block.indexOf("]")).matchAll(/"([a-zA-Z]+)"/g)]
      .map((match) => match[1])
      .sort();
  };
  const cliFields = fields(cli);
  expect(cliFields.length).toBeGreaterThan(0);
  expect(cliFields).toEqual(fields(application));
});

test("`task edit` documents every flag it accepts (QCLI-147)", () => {
  // test/contract/cli-process.test.ts already runs documented => accepted.
  // This is the other direction, which nothing covered: a flag the parser
  // takes but the help omits is invisible to anyone reading `quest help`.
  // Both halves are needed — each catches a different way the two drift.
  const source = readFileSync(
    new URL("../../src/cli/main.ts", import.meta.url),
    "utf8",
  );
  const branch = source.slice(
    source.indexOf('if (command === "edit" && rest[0])'),
  );
  // QCLI-270 pulled the allowlist out of the `only()` call and into a named
  // `editFlags` array (so the shared usage-failure helper can report it),
  // so anchor on that declaration instead of the call site.
  const start = branch.indexOf("const editFlags = [");
  const allowlist = branch.slice(start, branch.indexOf("];", start));
  const accepted = [...allowlist.matchAll(/"(--[a-z-]+)"/g)]
    .map((match) => match[1])
    .sort();
  expect(accepted.length).toBeGreaterThan(20);
  const documented = new Set(commandHelp["task edit"]?.flags ?? []);
  expect({
    undocumented: accepted.filter((flag) => !documented.has(flag as string)),
  }).toEqual({ undocumented: [] });
});
