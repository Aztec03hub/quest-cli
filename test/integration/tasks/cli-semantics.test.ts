import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runQuest } from "../../../src/cli/main.ts";

const actor = ["--actor", "person-1", "--actor-kind", "human"];

async function withStore(
  body: (
    run: (argv: readonly string[]) => Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>,
  ) => Promise<void>,
): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), "quest-cli-semantics-"));
  const previous = process.env.QUEST_TASK_STORE;
  process.env.QUEST_TASK_STORE = store;
  try {
    await body((argv) => runQuest(argv, false));
  } finally {
    if (previous === undefined) delete process.env.QUEST_TASK_STORE;
    else process.env.QUEST_TASK_STORE = previous;
    await rm(store, { recursive: true, force: true });
  }
}

function json(result: { stdout: string }): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function diagnostic(result: { stderr: string }): Record<string, unknown> {
  return JSON.parse(result.stderr) as Record<string, unknown>;
}

test("status-flow reports the configured policy and list matches statuses case-insensitively", async () => {
  await withStore(async (run) => {
    const flow = await run(["task", "status-flow", "--json"]);
    expect(flow.exitCode).toBe(0);
    expect(json(flow)).toEqual({
      schemaVersion: 1,
      contractVersion: 1,
      kind: "task.status-flow",
      data: {
        statuses: ["To Do", "In Progress", "Done"],
        terminalStatuses: ["Done"],
        pausedStatus: "Paused",
        // QCLI-331: the second terminal status, reported beside the ladder.
        closedStatus: "Closed",
        resolutions: ["duplicate", "superseded", "wont-do"],
      },
      principal: null,
    });

    await run([
      "task",
      "create",
      "Case task",
      ...actor,
      "--label",
      "case",
      "--json",
    ]);
    for (const spelling of ["to do", "TO DO", "To Do"]) {
      const listed = await run([
        "task",
        "list",
        "--status",
        spelling,
        "--json",
      ]);
      expect(listed.exitCode).toBe(0);
      expect(json(listed).data).toEqual([
        expect.objectContaining({ id: "T-1", status: "To Do" }),
      ]);
    }
    // Not "Paused": that was "Blocked" until QCLI-287's rename made it the
    // configured paused status, which a list filter accepts (QCLI-392).
    const unknown = await run(["task", "list", "--status", "Parked", "--json"]);
    expect(unknown.exitCode).toBe(6);
    expect(unknown.stdout).toBe("");
    expect(diagnostic(unknown)).toEqual({
      error_type: "validation",
      message: "Task status is not configured.",
      principal: null,
    });
  });
});

test("edit resolves case-insensitive configured statuses and rejects unknown or illegal transitions loudly", async () => {
  await withStore(async (run) => {
    await run(["task", "create", "Flow task", ...actor, "--json"]);
    const advanced = await run([
      "task",
      "edit",
      "T-1",
      "--status",
      "in progress",
      ...actor,
      "--json",
    ]);
    expect(advanced.exitCode).toBe(0);
    expect(json(advanced).data).toEqual(
      expect.objectContaining({ id: "T-1", status: "In Progress" }),
    );
    // The legal next step from In Progress is Done: case-insensitive spelling accepted.
    const completed = await run([
      "task",
      "edit",
      "T-1",
      "--status",
      "done",
      ...actor,
      "--json",
    ]);
    expect(completed.exitCode).toBe(0);
    expect(json(completed).data).toEqual(
      expect.objectContaining({ id: "T-1", status: "Done" }),
    );
    // A backward transition is illegal and fails loud.
    const demoted = await run([
      "task",
      "create",
      "Backward",
      ...actor,
      "--json",
    ]);
    expect(demoted.exitCode).toBe(0);
    await run([
      "task",
      "edit",
      "T-2",
      "--status",
      "In Progress",
      ...actor,
      "--json",
    ]);
    const skipped = await run([
      "task",
      "edit",
      "T-2",
      "--status",
      "to do",
      ...actor,
      "--json",
    ]);
    expect(skipped.exitCode).toBe(6);
    expect(diagnostic(skipped)).toMatchObject({
      error_type: "validation",
      message: "Illegal task transition: In Progress -> To Do.",
    });
    const unknown = await run([
      "task",
      "edit",
      "T-2",
      "--status",
      "Paused",
      ...actor,
      "--json",
    ]);
    expect(unknown.exitCode).toBe(6);
    expect(diagnostic(unknown)).toEqual({
      error_type: "validation",
      message: "Task status is not configured.",
      principal: null,
    });
  });
});

test("task pause/start reach and leave the paused status, and task demote requires an explicit --to that never falls back to a hardcoded status (QCLI-229)", async () => {
  await withStore(async (run) => {
    await run(["task", "create", "Pausable", ...actor, "--json"]);
    await run([
      "task",
      "edit",
      "T-1",
      "--status",
      "In Progress",
      ...actor,
      "--json",
    ]);

    const paused = await run(["task", "pause", "T-1", ...actor, "--json"]);
    expect(paused.exitCode).toBe(0);
    expect(json(paused)).toMatchObject({
      kind: "task.paused",
      data: expect.objectContaining({ status: "Paused" }),
    });

    // `--status` can neither reach nor leave the paused status.
    const viaEdit = await run([
      "task",
      "edit",
      "T-1",
      "--status",
      "In Progress",
      ...actor,
      "--json",
    ]);
    expect(viaEdit.exitCode).toBe(6);

    const started = await run(["task", "start", "T-1", ...actor, "--json"]);
    expect(started.exitCode).toBe(0);
    expect(json(started)).toMatchObject({
      kind: "task.started",
      data: expect.objectContaining({ status: "In Progress" }),
    });

    // demote requires --to; omitting it is a usage error and nothing mutates.
    const missingTo = await run(["task", "demote", "T-1", ...actor, "--json"]);
    expect(missingTo.exitCode).toBe(2);
    expect(diagnostic(missingTo)).toMatchObject({ error_type: "usage" });
    const stillInProgress = await run(["task", "view", "T-1", "--json"]);
    expect(stillInProgress.exitCode).toBe(0);
    expect((json(stillInProgress).data as { status: string }).status).toBe(
      "In Progress",
    );

    // An illegal --to target names the current status and the legal targets,
    // never the opaque "already at destination" message.
    const illegalTo = await run([
      "task",
      "demote",
      "T-1",
      "--to",
      "Done",
      ...actor,
      "--json",
    ]);
    expect(illegalTo.exitCode).toBe(6);
    expect(diagnostic(illegalTo)).toEqual({
      error_type: "validation",
      message:
        "Illegal task demotion: In Progress -> Done. Legal targets from In Progress: To Do.",
      principal: null,
    });

    // demote never reaches the paused status either; only `start` may.
    const toPaused = await run([
      "task",
      "demote",
      "T-1",
      "--to",
      "Paused",
      ...actor,
      "--json",
    ]);
    expect(toPaused.exitCode).toBe(6);

    const demoted = await run([
      "task",
      "demote",
      "T-1",
      "--to",
      "To Do",
      ...actor,
      "--json",
    ]);
    expect(demoted.exitCode).toBe(0);
    expect(json(demoted)).toMatchObject({
      kind: "task.demoted",
      data: expect.objectContaining({ status: "To Do" }),
    });

    // Already at the earliest status: no legal target remains.
    const exhausted = await run([
      "task",
      "demote",
      "T-1",
      "--to",
      "To Do",
      ...actor,
      "--json",
    ]);
    expect(exhausted.exitCode).toBe(6);
    expect(diagnostic(exhausted)).toEqual({
      error_type: "validation",
      message:
        "Illegal task demotion: To Do has no earlier status to demote to.",
      principal: null,
    });
  });
});

test("create accepts the full advertised field set and stores it losslessly", async () => {
  await withStore(async (run) => {
    // A dangling milestone reference must be rejected before any mutation.
    const withoutMilestone = await run([
      "task",
      "create",
      "Full create",
      "--id",
      "T-9",
      "--milestone",
      "M-1",
      ...actor,
      "--json",
    ]);
    expect(withoutMilestone.exitCode).toBe(6);
    const milestoneCreate = await run([
      "milestone",
      "create",
      "Sprint One",
      "--id",
      "M-1",
      ...actor,
      "--json",
    ]);
    if (milestoneCreate.exitCode !== 0) console.error(milestoneCreate.stderr);
    const created = await run([
      "task",
      "create",
      "Full create",
      "--id",
      "T-9",
      "--priority",
      "high",
      "--type",
      "feature",
      "--ordinal",
      "7",
      "--alias",
      "FULL",
      "--acceptance-criteria",
      '["works"]',
      "--definition-of-done",
      '[{"index":0,"text":"shipped","checked":false}]',
      "--plan",
      '["step one"]',
      "--implementation-notes",
      '["note one"]',
      "--assignee",
      "person-2",
      "--reference",
      "docs/story.md",
      "--modified-file",
      "src/app.ts",
      "--dependency",
      "T-1",
      "--parent",
      "T-1",
      "--milestone",
      "M-1",
      "--final-summary",
      "wrapped",
      ...actor,
      "--json",
    ]);
    // T-1 does not exist yet, so the dependency is rejected before any mutation.
    expect(created.exitCode).toBe(6);
    expect(created.stdout).toBe("");
    expect(diagnostic(created)).toMatchObject({
      error_type: "validation",
      message: "dependency_target_not_found",
      // QCLI-163: a forward reference gets a next step, not just a stop.
      hint: expect.stringContaining("--add-dependency"),
    });

    await run(["task", "create", "Base", ...actor, "--json"]);
    const full = await run([
      "task",
      "create",
      "Full create",
      "--id",
      "T-9",
      "--priority",
      "high",
      "--type",
      "feature",
      "--ordinal",
      "7",
      "--alias",
      "FULL",
      "--acceptance-criteria",
      '["works"]',
      "--definition-of-done",
      '[{"index":0,"text":"shipped","checked":false}]',
      "--plan",
      '["step one"]',
      "--implementation-notes",
      '["note one"]',
      "--assignee",
      "person-2",
      "--reference",
      "docs/story.md",
      "--modified-file",
      "src/app.ts",
      "--dependency",
      "T-1",
      "--parent",
      "T-1",
      "--milestone",
      "M-1",
      "--final-summary",
      "wrapped",
      ...actor,
      "--json",
    ]);
    expect(full.exitCode).toBe(0);
    expect(json(full).data).toEqual({
      // QCLI-137 stamps every write; the values are clock-dependent.
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      acceptanceCriteria: [
        { index: 0, position: 1, text: "works", checked: false },
      ],
      aliases: ["FULL"],
      assignees: ["person-2"],
      blockers: [],
      comments: [],
      definitionOfDone: [
        { index: 0, position: 1, text: "shipped", checked: false },
      ],
      dependencies: ["T-1"],
      documentation: [],
      finalSummary: "wrapped",
      gates: [],
      gateEvents: [],
      id: "T-9",
      implementationNotes: ["note one"],
      labels: [],
      milestoneId: "M-1",
      modifiedFiles: ["src/app.ts"],
      ordinal: 7,
      parentId: "T-1",
      plan: ["step one"],
      priority: "high",
      references: ["docs/story.md"],
      status: "To Do",
      title: "Full create",
      type: "feature",
    } as Record<string, unknown>);

    const badJson = await run([
      "task",
      "create",
      "Broken",
      "--plan",
      "{not json",
      ...actor,
      "--json",
    ]);
    expect(badJson.exitCode).toBe(2);
    expect(diagnostic(badJson)).toMatchObject({
      error_type: "usage",
      message: "--plan must be a JSON array of strings.",
    });
    const badOrdinal = await run([
      "task",
      "create",
      "Broken ordinal",
      "--ordinal",
      "high",
      ...actor,
      "--json",
    ]);
    expect(badOrdinal.exitCode).toBe(2);
    expect(diagnostic(badOrdinal)).toMatchObject({
      error_type: "usage",
      message: "--ordinal must be an integer.",
    });
  });
});

test("edit replace add remove clear operations keep deterministic ordering", async () => {
  await withStore(async (run) => {
    await run(["task", "create", "Base", ...actor, "--json"]);
    const seeded = await run([
      "task",
      "create",
      "Merge task",
      "--id",
      "T-2",
      "--label",
      "keep",
      "--label",
      "drop",
      "--plan",
      '["keep","drop"]',
      "--implementation-notes",
      '["keep-note","drop-note"]',
      "--assignee",
      "person-2",
      "--assignee",
      "person-3",
      "--reference",
      "ref-a",
      "--modified-file",
      "a.ts",
      ...actor,
      "--json",
    ]);
    expect(seeded.exitCode).toBe(0);

    const updated = await run([
      "task",
      "edit",
      "T-2",
      "--add-label",
      "new",
      "--remove-label",
      "drop",
      "--plan",
      '["replaced"]',
      "--notes",
      '["replaced-note"]',
      "--acceptance-criteria",
      '[{"index":0,"text":"ac","checked":true}]',
      "--definition-of-done",
      '["done-check"]',
      "--add-dependency",
      "T-99",
      "--clear-milestone",
      "--add-assignee",
      "person-4",
      "--remove-assignee",
      "person-3",
      "--add-reference",
      "ref-b",
      "--remove-reference",
      "ref-a",
      "--add-modified-file",
      "b.ts",
      "--remove-modified-file",
      "a.ts",
      ...actor,
      "--json",
    ]);
    // --add-dependency T-99 names a missing task: fail loud, no mutation.
    expect(updated.exitCode).toBe(6);
    expect(diagnostic(updated)).toMatchObject({
      error_type: "validation",
      message: "dependency_target_not_found",
      // QCLI-163: a forward reference gets a next step, not just a stop.
      hint: expect.stringContaining("quest task create"),
    });

    const applied = await run([
      "task",
      "edit",
      "T-2",
      "--add-label",
      "new",
      "--remove-label",
      "drop",
      "--plan",
      '["replaced"]',
      "--notes",
      '["replaced-note"]',
      "--acceptance-criteria",
      '[{"index":0,"text":"ac","checked":true}]',
      "--definition-of-done",
      '["done-check"]',
      "--clear-milestone",
      "--add-assignee",
      "person-4",
      "--remove-assignee",
      "person-3",
      "--add-reference",
      "ref-b",
      "--remove-reference",
      "ref-a",
      "--add-modified-file",
      "b.ts",
      "--remove-modified-file",
      "a.ts",
      ...actor,
      "--json",
    ]);
    expect(applied.exitCode).toBe(0);
    expect(json(applied).data).toEqual({
      // QCLI-137 stamps every write; the values are clock-dependent.
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      acceptanceCriteria: [
        { index: 0, position: 1, text: "ac", checked: true },
      ],
      aliases: [],
      assignees: ["person-2", "person-4"],
      blockers: [],
      comments: [],
      definitionOfDone: [
        { index: 0, position: 1, text: "done-check", checked: false },
      ],
      dependencies: [],
      documentation: [],
      gates: [],
      gateEvents: [],
      id: "T-2",
      implementationNotes: ["replaced-note"],
      labels: ["keep", "new"],
      modifiedFiles: ["b.ts"],
      plan: ["replaced"],
      references: ["ref-b"],
      status: "To Do",
      title: "Merge task",
    } as Record<string, unknown>);
    // JSON.stringify omits undefined keys: cleared fields are absent, not null.
    const appliedData = json(applied).data as object;
    expect("milestoneId" in appliedData).toBe(false);
  });
});

test("edit composes a wholesale list replacement with an add in the same command instead of discarding the add (QCLI-150)", async () => {
  await withStore(async (run) => {
    const seeded = await run([
      "task",
      "create",
      "Compose task",
      "--label",
      "stale",
      "--plan",
      '["stale-step"]',
      "--implementation-notes",
      '["stale-note"]',
      "--comments",
      '[{"id":"c-1","authorId":"person-1","body":"stale comment","createdAt":"2026-01-01T00:00:00.000Z"}]',
      ...actor,
      "--json",
    ]);
    expect(seeded.exitCode).toBe(0);
    const id = (json(seeded).data as { id: string }).id;

    const updated = await run([
      "task",
      "edit",
      id,
      "--labels",
      '["fresh"]',
      "--add-label",
      "extra",
      "--plan",
      '["fresh-step"]',
      "--add-plan",
      "extra-step",
      "--notes",
      '["fresh-note"]',
      "--add-note",
      "extra-note",
      "--comments",
      '[{"id":"c-2","authorId":"person-1","body":"fresh comment","createdAt":"2026-01-02T00:00:00.000Z"}]',
      "--add-comment",
      '[{"id":"c-3","authorId":"person-1","body":"extra comment","createdAt":"2026-01-03T00:00:00.000Z"}]',
      ...actor,
      "--json",
    ]);
    expect(updated.exitCode).toBe(0);
    const data = json(updated).data as Record<string, unknown>;
    // Each family composes: the replacement supplies the base, and the add
    // in the same command still lands on top of it rather than being
    // silently discarded.
    expect(data.labels).toEqual(["fresh", "extra"]);
    expect(data.plan).toEqual(["fresh-step", "extra-step"]);
    expect(data.implementationNotes).toEqual(["fresh-note", "extra-note"]);
    expect(
      (data.comments as { id: string }[]).map((comment) => comment.id),
    ).toEqual(["c-2", "c-3"]);
  });
});

test("list sees completed tasks by default and archived tasks behind --include-archived (QCLI-165)", async () => {
  await withStore(async (run) => {
    const active = await run(["task", "create", "Active", ...actor, "--json"]);
    const activeId = (json(active).data as { id: string }).id;

    const completed = await run([
      "task",
      "create",
      "Completed",
      ...actor,
      "--json",
    ]);
    const completedId = (json(completed).data as { id: string }).id;
    await run([
      "task",
      "edit",
      completedId,
      "--status",
      "In Progress",
      ...actor,
      "--json",
    ]);
    const completeResult = await run([
      "task",
      "complete",
      completedId,
      ...actor,
      "--json",
    ]);
    expect(completeResult.exitCode).toBe(0);

    const archived = await run([
      "task",
      "create",
      "Archived",
      ...actor,
      "--json",
    ]);
    const archivedId = (json(archived).data as { id: string }).id;
    const archiveResult = await run([
      "task",
      "archive",
      archivedId,
      ...actor,
      "--json",
    ]);
    expect(archiveResult.exitCode).toBe(0);

    // view already resolves any location; confirms the fixtures landed where expected.
    expect(
      (
        json(await run(["task", "view", completedId, "--json"])).data as {
          status: string;
        }
      ).status,
    ).toBe("Done");
    expect(
      (
        json(await run(["task", "view", archivedId, "--json"])).data as {
          status: string;
        }
      ).status,
    ).toBe("To Do");

    // path (QCLI-220) reflects the record's current lifecycle location and
    // moves with it -- this is what lets lore's adapter link a task's file.
    const pathOf = async (id: string): Promise<string> =>
      (
        json(await run(["task", "view", id, "--json"])).data as {
          path: string;
        }
      ).path;
    expect(await pathOf(activeId)).toBe(`.quest/tasks/${activeId}.json`);
    expect(await pathOf(completedId)).toBe(
      `.quest/completed/${completedId}.json`,
    );
    expect(await pathOf(archivedId)).toBe(
      `.quest/archive/tasks/${archivedId}.json`,
    );

    const ids = (result: { stdout: string }): string[] =>
      (json(result).data as { id: string }[]).map((task) => task.id).sort();

    // Default: active + completed, never archived.
    expect(ids(await run(["task", "list", "--json"]))).toEqual(
      [activeId, completedId].sort(),
    );
    // Explicit terminal-status filter reaches the completed task.
    expect(
      ids(await run(["task", "list", "--status", "Done", "--json"])),
    ).toEqual([completedId]);
    // Excluding Done leaves only the still-active task.
    expect(
      ids(await run(["task", "list", "--exclude-status", "Done", "--json"])),
    ).toEqual([activeId]);
    // --include-archived adds the archived task on top of the default set.
    const allListed = await run([
      "task",
      "list",
      "--include-archived",
      "--json",
    ]);
    expect(ids(allListed)).toEqual([activeId, archivedId, completedId].sort());
    const pathsById = new Map(
      (json(allListed).data as { id: string; path: string }[]).map((task) => [
        task.id,
        task.path,
      ]),
    );
    expect(pathsById.get(activeId)).toBe(`.quest/tasks/${activeId}.json`);
    expect(pathsById.get(completedId)).toBe(
      `.quest/completed/${completedId}.json`,
    );
    expect(pathsById.get(archivedId)).toBe(
      `.quest/archive/tasks/${archivedId}.json`,
    );
  });
});

test("completing a task another active task depends on does not block later creates or edits (QCLI-223)", async () => {
  await withStore(async (run) => {
    const dependency = await run([
      "task",
      "create",
      "Dependency",
      ...actor,
      "--json",
    ]);
    const dependencyId = (json(dependency).data as { id: string }).id;

    const dependent = await run([
      "task",
      "create",
      "Dependent",
      ...actor,
      "--json",
      "--dependency",
      dependencyId,
    ]);
    const dependentId = (json(dependent).data as { id: string }).id;

    await run([
      "task",
      "edit",
      dependencyId,
      "--status",
      "In Progress",
      ...actor,
      "--json",
    ]);
    const completeResult = await run([
      "task",
      "complete",
      dependencyId,
      ...actor,
      "--json",
    ]);
    expect(completeResult.exitCode).toBe(0);

    // Before the fix, every operation below failed with
    // dependency_target_not_found: canonicalizeTaskLinks/createTaskLinkSession
    // were only ever shown snapshot.tasks (active records), so `dependent`'s
    // now-completed dependency became an unresolvable edge and broke every
    // subsequent create and edit in the whole workspace, not just this task.
    const unrelated = await run([
      "task",
      "create",
      "Unrelated",
      ...actor,
      "--json",
    ]);
    expect(unrelated.exitCode).toBe(0);

    const labelEdit = await run([
      "task",
      "edit",
      dependentId,
      "--add-label",
      "probe",
      ...actor,
      "--json",
    ]);
    expect(labelEdit.exitCode).toBe(0);

    const unrelatedId = (json(unrelated).data as { id: string }).id;
    const graphEdit = await run([
      "task",
      "edit",
      dependentId,
      "--add-dependency",
      unrelatedId,
      ...actor,
      "--json",
    ]);
    expect(graphEdit.exitCode).toBe(0);
  });
});

test("--ready resolves a parent or dependency that has been archived, instead of throwing for the whole workspace (QCLI-249)", async () => {
  await withStore(async (run) => {
    // Reproduces the production shape found in quest-cli's own repo: a
    // feature parent archived independently of its children (still status
    // "To Do", not Done -- archiving does not itself close a task) while
    // several children remain active with --parent pointing at it.
    const parent = await run(["task", "create", "Parent", ...actor, "--json"]);
    const parentId = (json(parent).data as { id: string }).id;
    const child = await run([
      "task",
      "create",
      "Child",
      ...actor,
      "--json",
      "--parent",
      parentId,
    ]);
    const childId = (json(child).data as { id: string }).id;
    const archiveResult = await run([
      "task",
      "archive",
      parentId,
      ...actor,
      "--json",
    ]);
    expect(archiveResult.exitCode).toBe(0);

    // Before the fix: listFilteredLocated fed evaluateReadySet only the
    // archive-excluded `listed` array, so validateTaskGraph could not
    // resolve `child`'s parentId and every --ready call threw
    // dependency_target_not_found -- not just for this pair, but for the
    // whole workspace, since graph validation is all-or-nothing.
    const ready = await run(["task", "list", "--ready", "--json"]);
    expect(ready.exitCode).toBe(0);
    const readyIds = (json(ready).data as { id: string }[]).map(
      (task) => task.id,
    );
    expect(readyIds).toContain(childId);
    // The archived parent itself never leaks into --ready output, matching
    // plain `task list`'s existing default exclusion of archive/tasks.
    expect(readyIds).not.toContain(parentId);

    // Same shape again, but with a dependency edge instead of a parent edge,
    // since validateTaskGraph resolves both against the same array.
    const dependency = await run([
      "task",
      "create",
      "Dependency",
      ...actor,
      "--json",
    ]);
    const dependencyId = (json(dependency).data as { id: string }).id;
    const dependent = await run([
      "task",
      "create",
      "Dependent",
      ...actor,
      "--json",
      "--dependency",
      dependencyId,
    ]);
    const dependentId = (json(dependent).data as { id: string }).id;
    expect(
      (await run(["task", "archive", dependencyId, ...actor, "--json"]))
        .exitCode,
    ).toBe(0);

    const readyAfterDependencyArchive = await run([
      "task",
      "list",
      "--ready",
      "--json",
    ]);
    expect(readyAfterDependencyArchive.exitCode).toBe(0);
    // The archived dependency is still status "To Do", not terminal, so the
    // dependent correctly stays excluded -- the fix must not throw, but it
    // must not silently treat an unresolved-then-fixed edge as satisfied
    // either.
    const readyAfterDependencyIds = (
      json(readyAfterDependencyArchive).data as { id: string }[]
    ).map((task) => task.id);
    // QCLI-298: pair the absence assertion with a presence one over the SAME
    // list and the SAME source, so an empty --ready list fails this row
    // instead of satisfying it vacuously -- exactly the shape the
    // parent-archive row above already uses. childId is known ready (asserted
    // there), and archiving the dependency does not touch it.
    expect(readyAfterDependencyIds).toContain(childId);
    expect(readyAfterDependencyIds).not.toContain(dependentId);
  });
});

test("writes without an actor are denied and unknown flags fail loud as usage", async () => {
  await withStore(async (run) => {
    const noActor = await run(["task", "create", "No actor", "--json"]);
    expect(noActor.exitCode).toBe(4);
    expect(noActor.stdout).toBe("");
    expect(diagnostic(noActor)).toEqual({
      error_type: "denied",
      message: "Tracker writes require an explicit actor declaration.",
      principal: null,
    });
    const delegated = await run([
      "task",
      "create",
      "No human",
      "--actor",
      "bot-1",
      "--actor-kind",
      "delegated-agent",
      "--json",
    ]);
    expect(delegated.exitCode).toBe(4);
    expect(diagnostic(delegated)).toEqual({
      error_type: "denied",
      message: "Tracker writes require an explicit actor declaration.",
      principal: null,
    });
    // QCLI-270: the flag is named, not folded into a generic "invalid
    // arguments" sentence that could equally mean a missing reference or
    // actor -- both were supplied correctly here.
    const unknownFlag = await run([
      "task",
      "create",
      "Unknown flag",
      "--bogus",
      "value",
      ...actor,
      "--json",
    ]);
    expect(unknownFlag.exitCode).toBe(2);
    expect(diagnostic(unknownFlag)).toMatchObject({
      error_type: "usage",
      message:
        "Unrecognized flag --bogus. Nothing was written: the rest of this" +
        " command was not applied either. Accepted flags: --id, --summary," +
        " --description, --label, --doc, --priority, --type, --ordinal," +
        " --alias, --acceptance-criteria, --definition-of-done, --plan," +
        " --implementation-notes, --comments, --assignee, --reference," +
        " --modified-file, --dependency, --parent, --milestone," +
        " --final-summary, --actor, --actor-kind, --accountable-human.",
    });
    const empty = await run(["task", "list", "--json"]);
    expect(empty.exitCode).toBe(0);
    expect(json(empty).data).toEqual([]);
  });
});

test("`task complete --final-summary` writes the summary and closes in one command (QCLI-270)", async () => {
  await withStore(async (run) => {
    const created = await run([
      "task",
      "create",
      "Ship it",
      ...actor,
      "--json",
    ]);
    expect(created.exitCode).toBe(0);
    const id = (json(created).data as { id: string }).id;
    expect(
      (await run(["task", "start", id, ...actor, "--json"])).exitCode,
    ).toBe(0);

    const completed = await run([
      "task",
      "complete",
      id,
      "--final-summary",
      "Shipped in one write.",
      ...actor,
      "--json",
    ]);
    expect(completed.exitCode).toBe(0);
    // QCLI-264: the written record sits directly in `data`, not nested under
    // `data.task`.
    expect(json(completed).data).toMatchObject({
      status: "Done",
      finalSummary: "Shipped in one write.",
    });

    const viewed = await run(["task", "view", id, "--json"]);
    expect(json(viewed).data).toMatchObject({
      status: "Done",
      finalSummary: "Shipped in one write.",
    });
  });
});

test("`task complete` with a real reference and actor still names an unrecognized flag rather than blaming either (QCLI-270)", async () => {
  await withStore(async (run) => {
    const created = await run([
      "task",
      "create",
      "Ship it",
      ...actor,
      "--json",
    ]);
    expect(created.exitCode).toBe(0);
    const id = (json(created).data as { id: string }).id;
    expect(
      (await run(["task", "start", id, ...actor, "--json"])).exitCode,
    ).toBe(0);

    const result = await run([
      "task",
      "complete",
      id,
      "--final-summary",
      "x",
      ...actor,
      "--bogus-flag",
      "1",
      "--json",
    ]);
    expect(result.exitCode).toBe(2);
    const problem = diagnostic(result);
    expect(problem).toMatchObject({ error_type: "usage" });
    const message = problem.message as string;
    expect(message).toContain("--bogus-flag");
    expect(message).not.toContain("requires a reference and an explicit actor");
  });
});

test("concurrent edits serialize into a structured conflict without silent loss", async () => {
  await withStore(async (run) => {
    await run([
      "task",
      "create",
      "Contention",
      "--label",
      "base",
      ...actor,
      "--json",
    ]);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, writer) =>
        run([
          "task",
          "edit",
          "T-1",
          "--add-label",
          `writer-${writer}`,
          ...actor,
          "--json",
        ]),
      ),
    );
    const failures = results.filter((result) => result.exitCode !== 0);
    expect(failures.length).toBeGreaterThan(0);
    for (const result of failures) {
      expect(result).toMatchObject({ exitCode: 5, stdout: "" });
      expect(diagnostic(result)).toMatchObject({
        error_type: "conflict",
        message:
          "Task state changed concurrently; the operation was not applied.",
      });
    }
    const listed = await run(["task", "list", "--json"]);
    const rows = json(listed).data as readonly {
      labels: readonly string[];
    }[];
    // Surviving writers are unique and ordered; no duplicate merge, no silent loss.
    expect(rows).toHaveLength(1);
    const labels = rows[0]?.labels ?? [];
    expect(labels[0]).toBe("base");
    const writers = labels.filter((label) => label.startsWith("writer-"));
    expect(writers).toEqual([...writers].sort());
    expect(new Set(writers).size).toBe(writers.length);
  });
});

test("task edit --milestone closes forward and back references atomically", async () => {
  await withStore(async (run) => {
    await run([
      "milestone",
      "create",
      "Sprint One",
      "--id",
      "M-1",
      ...actor,
      "--json",
    ]);
    await run([
      "milestone",
      "create",
      "Sprint Two",
      "--id",
      "M-2",
      ...actor,
      "--json",
    ]);
    await run(["task", "create", "Linked", "--id", "T-1", ...actor, "--json"]);

    const link = await run([
      "task",
      "edit",
      "T-1",
      "--milestone",
      "M-1",
      ...actor,
      "--json",
    ]);
    expect(link.exitCode).toBe(0);
    expect(JSON.parse(link.stdout).data.milestoneId).toBe("M-1");
    expect(
      JSON.parse((await run(["milestone", "view", "M-1", "--json"])).stdout)
        .data.taskIds,
    ).toEqual(["T-1"]);

    const move = await run([
      "task",
      "edit",
      "T-1",
      "--milestone",
      "M-2",
      ...actor,
      "--json",
    ]);
    expect(move.exitCode).toBe(0);
    expect(
      JSON.parse((await run(["milestone", "view", "M-1", "--json"])).stdout)
        .data.taskIds,
    ).toEqual([]);
    expect(
      JSON.parse((await run(["milestone", "view", "M-2", "--json"])).stdout)
        .data.taskIds,
    ).toEqual(["T-1"]);

    const clear = await run([
      "task",
      "edit",
      "T-1",
      "--clear-milestone",
      ...actor,
      "--json",
    ]);
    expect(clear.exitCode).toBe(0);
    expect(JSON.parse(clear.stdout).data.milestoneId).toBeUndefined();
    expect(
      JSON.parse((await run(["milestone", "view", "M-2", "--json"])).stdout)
        .data.taskIds,
    ).toEqual([]);

    const dangling = await run([
      "task",
      "edit",
      "T-1",
      "--milestone",
      "M-99",
      ...actor,
      "--json",
    ]);
    expect(dangling.exitCode).toBe(6);
    expect(diagnostic(dangling).message).toBe("milestone_reference_dangling");
  });
});

test("task edit reaches a completed or archived record instead of reporting the misleading task_not_found, and leaves it in its own location (QCLI-219)", async () => {
  await withStore(async (run) => {
    await run(["task", "create", "Completed target", ...actor, "--json"]);
    await run([
      "task",
      "edit",
      "T-1",
      "--status",
      "In Progress",
      ...actor,
      "--json",
    ]);
    await run(["task", "complete", "T-1", ...actor, "--json"]);

    await run(["task", "create", "Archived target", ...actor, "--json"]);
    await run(["task", "archive", "T-2", ...actor, "--json"]);

    for (const id of ["T-1", "T-2"]) {
      const edited = await run([
        "task",
        "edit",
        id,
        "--add-note",
        `note on completed/archived ${id}`,
        ...actor,
        "--json",
      ]);
      expect(edited.exitCode).toBe(0);
      expect(JSON.parse(edited.stdout).data).toMatchObject({
        id,
        implementationNotes: [`note on completed/archived ${id}`],
      });
    }

    // Still resolvable and correctly located afterward -- no stray duplicate
    // was written into the active tasks/ directory.
    const completedView = await run(["task", "view", "T-1", "--json"]);
    expect(completedView.exitCode).toBe(0);
    expect(json(completedView).data).toMatchObject({ status: "Done" });

    const archivedView = await run(["task", "view", "T-2", "--json"]);
    expect(archivedView.exitCode).toBe(0);

    const list = await run(["task", "list", "--json"]);
    expect(
      JSON.parse(list.stdout).data.filter(
        (t: { id: string }) => t.id === "T-1",
      ),
    ).toHaveLength(1);

    // A real status *transition* on a terminal record is still rejected
    // through the normal lifecycle ladder -- this fix only reaches the
    // record for metadata edits, it does not relax status semantics.
    const illegalStatus = await run([
      "task",
      "edit",
      "T-1",
      "--status",
      "In Progress",
      ...actor,
      "--json",
    ]);
    expect(illegalStatus.exitCode).toBe(6);
    expect(diagnostic(illegalStatus).message).toBe(
      "Illegal task transition: Done -> In Progress.",
    );
  });
});

test("status and on-disk location are independent: task edit --status <terminal> does not relocate, task complete does (QCLI-221, pinning the decided behavior)", async () => {
  await withStore(async (run) => {
    const store = process.env.QUEST_TASK_STORE;
    if (!store) throw new Error("QUEST_TASK_STORE was not set by withStore");

    await run(["task", "create", "Edited to Done", ...actor, "--json"]);
    await run([
      "task",
      "edit",
      "T-1",
      "--status",
      "In Progress",
      ...actor,
      "--json",
    ]);
    const edited = await run([
      "task",
      "edit",
      "T-1",
      "--status",
      "Done",
      ...actor,
      "--json",
    ]);
    expect(edited.exitCode).toBe(0);
    // Reached Done through edit: stays in tasks/, not relocated to completed/.
    expect(existsSync(join(store, ".quest", "tasks", "T-1.json"))).toBe(true);
    expect(existsSync(join(store, ".quest", "completed", "T-1.json"))).toBe(
      false,
    );

    await run(["task", "create", "Completed via complete", ...actor, "--json"]);
    await run([
      "task",
      "edit",
      "T-2",
      "--status",
      "In Progress",
      ...actor,
      "--json",
    ]);
    const completed = await run([
      "task",
      "complete",
      "T-2",
      ...actor,
      "--json",
    ]);
    expect(completed.exitCode).toBe(0);
    // Reached Done through complete: relocated to completed/.
    expect(existsSync(join(store, ".quest", "completed", "T-2.json"))).toBe(
      true,
    );
    expect(existsSync(join(store, ".quest", "tasks", "T-2.json"))).toBe(false);

    // Both are still Done, both still resolve identically to any caller,
    // regardless of which physical location holds their record.
    const t1 = await run(["task", "view", "T-1", "--json"]);
    const t2 = await run(["task", "view", "T-2", "--json"]);
    expect(json(t1).data).toMatchObject({ status: "Done" });
    expect(json(t2).data).toMatchObject({ status: "Done" });
  });
});

test("repeatable list flags reject a JSON-array value as usage instead of silently storing it as one malformed entry (QCLI-250)", async () => {
  await withStore(async (run) => {
    // Before the fix: every one of these silently stored the whole JSON
    // string as a single array entry and exited 0, because --label/--doc/
    // --alias/--assignee/--reference/--modified-file/--dependency take one
    // raw value per occurrence -- unlike --acceptance-criteria, which takes
    // exactly one JSON-array occurrence on the same command. A caller who
    // learned that convention from --acceptance-criteria and applied it
    // here by analogy got corruption with no diagnostic.
    for (const flag of [
      "--label",
      "--doc",
      "--alias",
      "--assignee",
      "--reference",
      "--modified-file",
      "--dependency",
    ]) {
      const rejected = await run([
        "task",
        "create",
        "Probe",
        ...actor,
        "--json",
        flag,
        '["a","b"]',
      ]);
      expect(rejected.exitCode).toBe(2);
      expect(rejected.stdout).toBe("");
      expect(diagnostic(rejected)).toMatchObject({
        error_type: "usage",
        message: `${flag} takes one value per occurrence, not a JSON array -- repeat the flag instead (e.g. ${flag} a ${flag} b).`,
      });
    }

    // A legitimate single value is untouched, including one that merely
    // starts with `[` without being valid JSON array syntax.
    const legitimate = await run([
      "task",
      "create",
      "Legit",
      ...actor,
      "--json",
      "--label",
      "[urgent]",
      "--reference",
      "https://example.com/doc",
    ]);
    expect(legitimate.exitCode).toBe(0);
    expect(json(legitimate).data).toMatchObject({
      labels: ["[urgent]"],
      references: ["https://example.com/doc"],
    });
    const legitimateId = (json(legitimate).data as { id: string }).id;

    // The correct form -- repeating the flag -- still works exactly as
    // before, on both create and edit's --add-* counterparts.
    const repeated = await run([
      "task",
      "create",
      "Repeated",
      ...actor,
      "--json",
      "--reference",
      "a",
      "--reference",
      "b",
    ]);
    expect(repeated.exitCode).toBe(0);
    expect(json(repeated).data).toMatchObject({ references: ["a", "b"] });

    for (const flag of [
      "--add-label",
      "--remove-label",
      "--doc",
      "--add-dependency",
      "--remove-dependency",
      "--add-assignee",
      "--remove-assignee",
      "--add-reference",
      "--remove-reference",
      "--add-modified-file",
      "--remove-modified-file",
      "--remove-comment",
    ]) {
      const rejected = await run([
        "task",
        "edit",
        legitimateId,
        ...actor,
        "--json",
        flag,
        '["a","b"]',
      ]);
      expect(rejected.exitCode).toBe(2);
      expect(diagnostic(rejected)).toMatchObject({
        error_type: "usage",
        message: `${flag} takes one value per occurrence, not a JSON array -- repeat the flag instead (e.g. ${flag} a ${flag} b).`,
      });
    }

    const addWorks = await run([
      "task",
      "edit",
      legitimateId,
      ...actor,
      "--json",
      "--add-reference",
      "c",
    ]);
    expect(addWorks.exitCode).toBe(0);
    expect(json(addWorks).data).toMatchObject({
      references: ["https://example.com/doc", "c"],
    });

    // Deliberately unguarded: free-text fields where genuine content that
    // happens to parse as a JSON array is plausible (a plan step literally
    // describing example payload syntax), and --add-comment already
    // requires and validates a JSON payload of its own.
    const planLooksLikeJson = await run([
      "task",
      "edit",
      legitimateId,
      ...actor,
      "--json",
      "--add-plan",
      '["a","b"]',
    ]);
    expect(planLooksLikeJson.exitCode).toBe(0);
    expect(json(planLooksLikeJson).data).toMatchObject({
      plan: ['["a","b"]'],
    });
  });
});

test("a record parked at the retired paused literal is named by doctor and leaves only through task start (QCLI-302)", async () => {
  await withStore(async (run) => {
    await run(["task", "create", "Stranded", ...actor, "--json"]);
    await run([
      "task",
      "edit",
      "T-1",
      "--status",
      "In Progress",
      ...actor,
      "--json",
    ]);
    // Strand it the way an upgrade did: the record bytes a 0.6.x
    // `task pause` wrote, read back by a CLI whose default is "Paused".
    const path = join(
      process.env.QUEST_TASK_STORE as string,
      ".quest",
      "tasks",
      "T-1.json",
    );
    const record = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(path, JSON.stringify({ ...record, status: "Blocked" }));
    const stuck = await run(["task", "view", "T-1", "--json"]);
    expect(stuck.exitCode).toBe(0);
    expect((json(stuck).data as { status: string }).status).toBe("Blocked");

    // doctor is red and names the record, the status, and the repair.
    const sick = await run(["doctor", "--json"]);
    expect(sick.exitCode).toBe(0);
    expect(json(sick)).toMatchObject({
      kind: "project.doctor",
      data: {
        healthy: false,
        issues: [
          {
            code: "task_status_off_flow",
            taskId: "T-1",
            status: "Blocked",
            hint: expect.stringContaining("quest task start T-1"),
          },
        ],
      },
    });

    // Every other transition still refuses it -- nothing migrates silently.
    for (const argv of [
      ["task", "pause", "T-1"],
      ["task", "edit", "T-1", "--status", "In Progress"],
      ["task", "complete", "T-1"],
      ["task", "demote", "T-1", "--to", "To Do"],
    ]) {
      const refused = await run([...argv, ...actor, "--json"]);
      expect(refused.exitCode).toBe(6);
      expect(diagnostic(refused)).toMatchObject({ error_type: "validation" });
    }

    // start is the sanctioned exit, exactly as it was before the rename.
    const started = await run(["task", "start", "T-1", ...actor, "--json"]);
    expect(started.exitCode).toBe(0);
    expect(json(started)).toMatchObject({
      kind: "task.started",
      data: expect.objectContaining({ status: "In Progress" }),
    });
    const well = await run(["doctor", "--json"]);
    expect(json(well).data).toEqual({ healthy: true, issues: [] });

    // ...after which pause parks it at the configured literal.
    const paused = await run(["task", "pause", "T-1", ...actor, "--json"]);
    expect(paused.exitCode).toBe(0);
    expect(json(paused)).toMatchObject({
      kind: "task.paused",
      data: expect.objectContaining({ status: "Paused" }),
    });
  });
});
