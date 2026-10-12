import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executable = join(import.meta.dir, "../../../src/cli/main.ts");

async function quest(store: string, argv: readonly string[]) {
  const child = Bun.spawn([process.execPath, executable, ...argv], {
    cwd: store,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, QUEST_TASK_STORE: store },
  });
  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

// QUEST_TASK_STORE short-circuits configuredTaskIdPrefix() to "T" (see
// runQuest), so exercising a real configured taskIdPrefix needs a genuine
// discovered workspace instead: a real `git init` + `quest init`, no env
// override.
async function questNative(cwd: string, argv: readonly string[]) {
  const env = { ...Bun.env };
  delete env.QUEST_TASK_STORE;
  const child = Bun.spawn([process.execPath, executable, ...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

async function sourceFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quest-lore-backlog-source-"));
  const tasks = join(root, "backlog", "tasks");
  await mkdir(tasks, { recursive: true });
  for (const [id, title] of [
    ["TASK-1", "Legacy task"],
    ["LCLI-315.4", "Lore dotted subtask"],
    ["TASK-2.1", "Backlog dotted subtask"],
  ]) {
    await writeFile(
      join(tasks, `${id}.md`),
      `---\nid: ${id}\ntitle: ${title}\nstatus: To Do\nlabels: [lore-cutover]\n---\n\nSource-only fixture.\n`,
    );
  }
  return root;
}

test("the public Backlog migration contract preserves Lore-facing aliases and durable receipts", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-backlog-public-"));
  const source = await sourceFixture();
  try {
    const preview = await quest(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--json",
    ]);
    expect(preview.exitCode).toBe(0);
    const previewEnvelope = JSON.parse(preview.stdout);
    expect(previewEnvelope).toMatchObject({
      schemaVersion: 1,
      kind: "migration.backlog-preview",
      data: {
        requiresApproval: true,
        mappings: [
          { sourceIdentifier: "LCLI-315.4", targetIdentifier: "T-1" },
          { sourceIdentifier: "TASK-1", targetIdentifier: "T-2" },
          { sourceIdentifier: "TASK-2.1", targetIdentifier: "T-3" },
        ],
      },
    });
    const apply = await quest(store, [
      "migration",
      "backlog",
      "apply",
      "--source",
      source,
      "--digest",
      previewEnvelope.data.digest,
      "--actor",
      "migration-owner",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(apply.exitCode).toBe(0);
    expect(JSON.parse(apply.stdout)).toMatchObject({
      kind: "migration.backlog-applied",
      data: { state: "applied", survivors: ["T-1", "T-2", "T-3"] },
    });
    for (const [reference, id] of [
      ["TASK-1", "T-2"],
      ["LCLI-315.4", "T-1"],
      ["TASK-2.1", "T-3"],
    ]) {
      const viewed = await quest(store, ["task", "view", reference, "--json"]);
      expect(JSON.parse(viewed.stdout)).toMatchObject({
        kind: "task.view",
        data: { id, source: { system: "backlog", reference } },
      });
    }
    const repeated = await quest(store, [
      "migration",
      "backlog",
      "apply",
      "--source",
      source,
      "--digest",
      previewEnvelope.data.digest,
      "--actor",
      "migration-owner",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(JSON.parse(repeated.stdout).data).toEqual(
      JSON.parse(apply.stdout).data,
    );
    const rollback = await quest(store, [
      "migration",
      "backlog",
      "rollback",
      "--digest",
      previewEnvelope.data.digest,
      "--actor",
      "migration-owner",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(JSON.parse(rollback.stdout)).toMatchObject({
      kind: "migration.backlog-rolled-back",
      data: { state: "rolled-back", survivors: [] },
    });
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("migration closes milestone references transactionally and rollback keeps closure", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-backlog-milestone-"));
  const source = await mkdtemp(join(tmpdir(), "quest-backlog-milestone-src-"));
  try {
    const tasks = join(source, "backlog", "tasks");
    await mkdir(tasks, { recursive: true });
    await writeFile(
      join(tasks, "TASK-M1.md"),
      `---\nid: TASK-M1\ntitle: Milestoned task\nstatus: To Do\nmilestone: Sprint One\n---\n\nBody.\n`,
    );
    const preview = await quest(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--json",
    ]);
    expect(preview.exitCode).toBe(0);
    const digest = JSON.parse(preview.stdout).data.digest;
    const apply = await quest(store, [
      "migration",
      "backlog",
      "apply",
      "--source",
      source,
      "--digest",
      digest,
      "--actor",
      "migration-owner",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(apply.exitCode).toBe(0);
    expect(JSON.parse(apply.stdout).data.state).toBe("applied");

    const viewed = await quest(store, ["task", "view", "TASK-M1", "--json"]);
    expect(JSON.parse(viewed.stdout).data.milestoneId).toBe("M-1");
    const milestone = await quest(store, [
      "milestone",
      "view",
      "M-1",
      "--json",
    ]);
    expect(milestone.exitCode).toBe(0);
    expect(JSON.parse(milestone.stdout).data).toMatchObject({
      id: "M-1",
      title: "Sprint One",
      taskIds: ["T-1"],
    });

    const rollback = await quest(store, [
      "migration",
      "backlog",
      "rollback",
      "--digest",
      digest,
      "--actor",
      "migration-owner",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(rollback.exitCode).toBe(0);
    expect(JSON.parse(rollback.stdout).data.state).toBe("rolled-back");
    const milestoneAfter = await quest(store, [
      "milestone",
      "view",
      "M-1",
      "--json",
    ]);
    expect(JSON.parse(milestoneAfter.stdout).data.taskIds).toEqual([]);
    const viewedAfter = await quest(store, [
      "task",
      "view",
      "TASK-M1",
      "--json",
    ]);
    expect(viewedAfter.exitCode).not.toBe(0);
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("imported Backlog timestamps are normalised to ISO-8601 UTC (QCLI-152)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-backlog-timestamps-"));
  const source = await mkdtemp(join(tmpdir(), "quest-backlog-ts-source-"));
  try {
    const tasks = join(source, "backlog", "tasks");
    await mkdir(tasks, { recursive: true });
    // Backlog's three real shapes, plus one that is not a date at all.
    const fixtures: readonly (readonly [string, string, string])[] = [
      ["TASK-1", "2024-03-04 05:06", "2024-05-06 07:08"],
      ["TASK-2", "2024-03-05", "2024-03-05"],
      ["TASK-3", "2024-03-06T07:08:09.123Z", "2024-03-06T07:08:09.123Z"],
      ["TASK-4", "not a date", "also not a date"],
    ];
    for (const [id, created, updated] of fixtures)
      await writeFile(
        join(tasks, `${id}.md`),
        `---\nid: ${id}\ntitle: Dated ${id}\nstatus: To Do\ncreated_date: '${created}'\nupdated_date: '${updated}'\n---\n\nDated fixture.\n`,
      );

    const preview = await quest(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--json",
    ]);
    expect(preview.exitCode).toBe(0);
    const digest = JSON.parse(preview.stdout).data.digest;
    const applied = await quest(store, [
      "migration",
      "backlog",
      "apply",
      "--source",
      source,
      "--digest",
      digest,
      "--actor",
      "migration-owner",
      "--actor-kind",
      "human",
      "--json",
    ]);
    if (applied.exitCode !== 0) console.error(applied.stderr);
    expect(applied.exitCode).toBe(0);

    const read = async (reference: string) => {
      const viewed = await quest(store, ["task", "view", reference, "--json"]);
      expect(viewed.exitCode).toBe(0);
      return JSON.parse(viewed.stdout).data;
    };

    // Zone-less input reads as UTC, so the same file imports to the same
    // instant on every machine rather than following the host's chair.
    expect((await read("TASK-1")).createdAt).toBe("2024-03-04T05:06:00.000Z");
    expect((await read("TASK-1")).updatedAt).toBe("2024-05-06T07:08:00.000Z");
    // A bare date becomes midnight UTC: the canonical instant for that day.
    expect((await read("TASK-2")).createdAt).toBe("2024-03-05T00:00:00.000Z");
    // An already-canonical value survives unchanged.
    expect((await read("TASK-3")).createdAt).toBe("2024-03-06T07:08:09.123Z");

    // Unparseable input is dropped rather than becoming a wrong date — and is
    // not lost: the raw source form is still in the provenance blob.
    const unparseable = await read("TASK-4");
    expect(unparseable.createdAt).toBeUndefined();
    expect(unparseable.updatedAt).toBeUndefined();
    expect(JSON.parse(unparseable.summary).backlog.createdAt).toBe(
      "not a date",
    );

    // The point of all of the above: a mixed corpus sorts by time, not by
    // format. Ascending, the unparseable record sorts last as unknown.
    const listed = await quest(store, [
      "task",
      "list",
      "--sort",
      "createdAt:asc",
      "--json",
    ]);
    expect(listed.exitCode).toBe(0);
    const order = JSON.parse(listed.stdout).data.map(
      (task: { title: string }) => task.title,
    );
    expect(order).toEqual([
      "Dated TASK-1",
      "Dated TASK-2",
      "Dated TASK-3",
      "Dated TASK-4",
    ]);
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("imported acceptance criteria and definition-of-done keep their checked state (QCLI-157)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-backlog-ac-checked-"));
  const source = await mkdtemp(join(tmpdir(), "quest-backlog-ac-source-"));
  try {
    const tasks = join(source, "backlog", "tasks");
    await mkdir(tasks, { recursive: true });
    await writeFile(
      join(tasks, "TASK-1.md"),
      `---\nid: TASK-1\ntitle: Fix crash on empty import\nstatus: In Progress\n---\n\n<!-- AC:BEGIN -->\n- [x] #1 Reproduce with empty CSV\n- [ ] #2 Add regression test\n<!-- AC:END -->\n\n<!-- DOD:BEGIN -->\n- [x] #1 Code reviewed\n<!-- DOD:END -->\n\nBody.\n`,
    );
    await writeFile(
      join(tasks, "TASK-2.md"),
      `---\nid: TASK-2\ntitle: Write API reference docs\nstatus: Done\n---\n\n<!-- AC:BEGIN -->\n- [x] #1 Cover all public endpoints\n- [x] #2 Include auth examples\n<!-- AC:END -->\n\nBody.\n`,
    );
    const preview = await quest(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--json",
    ]);
    expect(preview.exitCode).toBe(0);
    const digest = JSON.parse(preview.stdout).data.digest;
    const applied = await quest(store, [
      "migration",
      "backlog",
      "apply",
      "--source",
      source,
      "--digest",
      digest,
      "--actor",
      "migration-owner",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(applied.exitCode).toBe(0);

    const partial = JSON.parse(
      (await quest(store, ["task", "view", "TASK-1", "--json"])).stdout,
    ).data;
    // Before the fix this came back checked:false on every item -- the parsed
    // checkbox state never reached the structured field, only `item.text` did.
    expect(partial.acceptanceCriteria).toEqual([
      {
        index: 0,
        position: 1,
        text: "Reproduce with empty CSV",
        checked: true,
      },
      { index: 1, position: 2, text: "Add regression test", checked: false },
    ]);
    expect(partial.definitionOfDone).toEqual([
      { index: 0, position: 1, text: "Code reviewed", checked: true },
    ]);

    const done = JSON.parse(
      (await quest(store, ["task", "view", "TASK-2", "--json"])).stdout,
    ).data;
    expect(
      done.acceptanceCriteria.every(
        (item: { checked: boolean }) => item.checked,
      ),
    ).toBe(true);
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("migration targets the workspace's configured taskIdPrefix and still guards organic numbering (QCLI-157)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-backlog-prefix-"));
  const source = await mkdtemp(join(tmpdir(), "quest-backlog-prefix-src-"));
  try {
    await Bun.spawn(["git", "init", "-q"], { cwd: store }).exited;
    const init = await questNative(store, [
      "init",
      "--task-id-prefix",
      "FX",
      "--json",
    ]);
    expect(init.exitCode).toBe(0);
    // An organic (never-imported) task already occupies FX-1: the allocator
    // must count past it, and the preview-time collision guard must still
    // cover this prefix, not only a hardcoded "T-".
    const native = await questNative(store, [
      "task",
      "create",
      "Organic task",
      "--actor",
      "person-1",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(JSON.parse(native.stdout)).toMatchObject({ data: { id: "FX-1" } });

    const tasks = join(source, "backlog", "tasks");
    await mkdir(tasks, { recursive: true });
    await writeFile(
      join(tasks, "TASK-1.md"),
      `---\nid: TASK-1\ntitle: Migrated task\nstatus: To Do\n---\n\nBody.\n`,
    );
    const preview = await questNative(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--json",
    ]);
    expect(preview.exitCode).toBe(0);
    // Before the fix this landed at T-1 -- a namespace disconnected from the
    // workspace's own FX- sequence -- regardless of --task-id-prefix.
    expect(JSON.parse(preview.stdout).data.mappings).toEqual([
      expect.objectContaining({
        sourceIdentifier: "TASK-1",
        targetIdentifier: "FX-2",
      }),
    ]);
    const digest = JSON.parse(preview.stdout).data.digest;
    const applied = await questNative(store, [
      "migration",
      "backlog",
      "apply",
      "--source",
      source,
      "--digest",
      digest,
      "--actor",
      "migration-owner",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout).data.survivors).toEqual(["FX-2"]);

    // The collision guard must still refuse a real conflict under the
    // configured prefix, case-insensitively, before any write.
    await writeFile(
      join(tasks, "TASK-2.md"),
      `---\nid: fx-1\ntitle: Collides with the organic task\nstatus: To Do\n---\n\nBody.\n`,
    );
    const collision = await questNative(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--json",
    ]);
    expect(collision.exitCode).toBe(5);
    expect(JSON.parse(collision.stderr)).toMatchObject({
      error_type: "conflict",
    });
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("migration into a fresh same-prefix workspace does not self-collide on its own minted id (QCLI-157)", async () => {
  // A completely fresh workspace, taskIdPrefix matching the Backlog source's
  // own display prefix, zero pre-existing tasks: the realistic day-one
  // cutover shape. The first migrated task's newly minted canonical id
  // ("FX-1") is now the SAME string as the bare Backlog-source alias being
  // registered for that very task -- not a conflict with a different task,
  // just that task's id and its own alias coinciding.
  const store = await mkdtemp(join(tmpdir(), "quest-backlog-self-collide-"));
  const source = await mkdtemp(
    join(tmpdir(), "quest-backlog-self-collide-src-"),
  );
  try {
    await Bun.spawn(["git", "init", "-q"], { cwd: store }).exited;
    const init = await questNative(store, [
      "init",
      "--task-id-prefix",
      "FX",
      "--json",
    ]);
    expect(init.exitCode).toBe(0);

    const tasks = join(source, "backlog", "tasks");
    await mkdir(tasks, { recursive: true });
    await writeFile(
      join(tasks, "FX-1.md"),
      `---\nid: FX-1\ntitle: Migrate reporting pipeline\nstatus: In Progress\n---\n\nBody.\n`,
    );
    await writeFile(
      join(tasks, "FX-1.1.md"),
      `---\nid: FX-1.1\ntitle: Extract schema\nstatus: Done\nparent: FX-1\n---\n\nBody.\n`,
    );
    await writeFile(
      join(tasks, "FX-1.2.md"),
      `---\nid: FX-1.2\ntitle: Backfill rows\nstatus: Done\nparent: FX-1\n---\n\nBody.\n`,
    );

    const preview = await questNative(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--json",
    ]);
    // Before the fix this threw exit 5 "Alias collision: \"FX-1\" conflicts
    // with \"FX-1\"" -- the new id colliding with its own alias, not a real
    // conflict with a different task.
    if (preview.exitCode !== 0) console.error(preview.stderr);
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout).data.mappings).toEqual([
      expect.objectContaining({
        sourceIdentifier: "FX-1",
        targetIdentifier: "FX-1",
      }),
      expect.objectContaining({
        sourceIdentifier: "FX-1.1",
        targetIdentifier: "FX-2",
      }),
      expect.objectContaining({
        sourceIdentifier: "FX-1.2",
        targetIdentifier: "FX-3",
      }),
    ]);

    const digest = JSON.parse(preview.stdout).data.digest;
    const applied = await questNative(store, [
      "migration",
      "backlog",
      "apply",
      "--source",
      source,
      "--digest",
      digest,
      "--actor",
      "migration-owner",
      "--actor-kind",
      "human",
      "--json",
    ]);
    if (applied.exitCode !== 0) console.error(applied.stderr);
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout).data.survivors).toEqual([
      "FX-1",
      "FX-2",
      "FX-3",
    ]);

    // A genuine cross-task collision must still refuse: a second migration
    // batch deliberately colliding with the first migrated task's real id.
    const secondSource = await mkdtemp(
      join(tmpdir(), "quest-backlog-self-collide-src2-"),
    );
    const secondTasks = join(secondSource, "backlog", "tasks");
    await mkdir(secondTasks, { recursive: true });
    await writeFile(
      join(secondTasks, "OTHER-1.md"),
      `---\nid: fx-1\ntitle: Deliberately collides with the migrated FX-1\nstatus: To Do\n---\n\nBody.\n`,
    );
    const stillGuarded = await questNative(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      secondSource,
      "--json",
    ]);
    expect(stillGuarded.exitCode).toBe(5);
    expect(JSON.parse(stillGuarded.stderr)).toMatchObject({
      error_type: "conflict",
    });
    await rm(secondSource, { recursive: true, force: true });
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("a migrated subtask's parentId resolves to the parent's real new id, not the pre-migration source id (QCLI-157)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-backlog-parent-"));
  const source = await mkdtemp(join(tmpdir(), "quest-backlog-parent-src-"));
  try {
    const tasks = join(source, "backlog", "tasks");
    await mkdir(tasks, { recursive: true });
    await writeFile(
      join(tasks, "TASK-1.md"),
      `---\nid: TASK-1\ntitle: Migrate reporting pipeline\nstatus: In Progress\n---\n\nBody.\n`,
    );
    await writeFile(
      join(tasks, "TASK-1.1.md"),
      `---\nid: TASK-1.1\ntitle: Extract and map legacy schema\nstatus: Done\nparent: TASK-1\n---\n\nBody.\n`,
    );
    await writeFile(
      join(tasks, "TASK-1.2.md"),
      `---\nid: TASK-1.2\ntitle: Backfill and validate rows\nstatus: Done\nparent: TASK-1\n---\n\nBody.\n`,
    );
    const preview = await quest(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--json",
    ]);
    expect(preview.exitCode).toBe(0);
    const mappings = JSON.parse(preview.stdout).data.mappings as {
      sourceIdentifier: string;
      targetIdentifier: string;
    }[];
    const parentNewId = mappings.find(
      (m) => m.sourceIdentifier === "TASK-1",
    )?.targetIdentifier;
    expect(parentNewId).toBeDefined();
    const digest = JSON.parse(preview.stdout).data.digest;
    const applied = await quest(store, [
      "migration",
      "backlog",
      "apply",
      "--source",
      source,
      "--digest",
      digest,
      "--actor",
      "migration-owner",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(applied.exitCode).toBe(0);

    const child = JSON.parse(
      (await quest(store, ["task", "view", "TASK-1.1", "--json"])).stdout,
    ).data;
    // Before the fix this stayed "TASK-1" -- the raw pre-migration source id
    // -- even though TASK-1 is a registered alias of the parent's real id.
    expect(child.parentId).toBe(parentNewId);
    expect(child.parentId).not.toBe("TASK-1");

    // The point of resolving it: --parent lookups must actually find the
    // migrated children, not just carry a plausible-looking string.
    const byParent = JSON.parse(
      (
        await quest(store, [
          "task",
          "list",
          "--parent",
          parentNewId as string,
          "--json",
        ])
      ).stdout,
    ).data as { id: string }[];
    expect(byParent.map((t) => t.id).sort()).toEqual(
      mappings
        .filter((m) => m.sourceIdentifier !== "TASK-1")
        .map((m) => m.targetIdentifier)
        .sort(),
    );
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("a case-only id collision with a live task is refused, not silently overwritten (QCLI-155)", async () => {
  // On a case-insensitive filesystem (the macOS default), a Backlog source
  // id that differs from a live Quest task's id only by case is exactly the
  // shape that could silently clobber a file instead of failing loudly.
  const store = await mkdtemp(join(tmpdir(), "quest-backlog-collision-"));
  const source = await mkdtemp(join(tmpdir(), "quest-backlog-collision-src-"));
  try {
    const created = await quest(store, [
      "task",
      "create",
      "Existing",
      "--actor",
      "migration-owner",
      "--actor-kind",
      "human",
      "--id",
      "QCLI-1",
      "--json",
    ]);
    expect(created.exitCode).toBe(0);

    const tasks = join(source, "backlog", "tasks");
    await mkdir(tasks, { recursive: true });
    await writeFile(
      join(tasks, "qcli-1.md"),
      "---\nid: qcli-1\ntitle: Case-variant collider\nstatus: To Do\n---\n\nBody.\n",
    );

    const preview = await quest(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--json",
    ]);
    expect(preview.exitCode).toBe(5);
    expect(JSON.parse(preview.stderr)).toMatchObject({
      error_type: "conflict",
      message:
        'Alias collision: "qcli-1" conflicts with "QCLI-1". If this is from positional renumbering (for example a dotted subtask flattening and shifting a later allocation), --preserve-source-ids --source-family <PREFIX> avoids it by keeping each record\'s own source id instead. If instead this exact id is already a live, unrelated claim in the destination workspace, --preserve-source-ids will not resolve it -- rename or remove the conflicting record in the destination, or rename the id in the source, before retrying.',
    });

    // Refused at preview: nothing was written under the colliding id.
    const listed = await quest(store, ["task", "list", "--json"]);
    expect(JSON.parse(listed.stdout).data).toHaveLength(1);
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("a dotted subtask shifts positional allocation into a same-prefix collision, and the refusal points at --preserve-source-ids (QCLI-166)", async () => {
  // Reproduces opag's 2026-09-02 report against a real opum-agent backlog:
  // flattening OPAG-1.1 consumes a number and shifts every later allocation,
  // so the target minted for it can land on an id a different record's own
  // alias already occupies. This is the same-prefix case (QCLI-157's "does
  // not self-collide on its own minted id" test covers the collision-free
  // shape); adding one dotted subtask is what turns it into a real collision.
  const store = await mkdtemp(join(tmpdir(), "quest-backlog-shift-"));
  const source = await mkdtemp(join(tmpdir(), "quest-backlog-shift-src-"));
  try {
    await Bun.spawn(["git", "init", "-q"], { cwd: store }).exited;
    const init = await questNative(store, [
      "init",
      "--task-id-prefix",
      "OPAG",
      "--json",
    ]);
    expect(init.exitCode).toBe(0);

    const tasks = join(source, "backlog", "tasks");
    await mkdir(tasks, { recursive: true });
    await writeFile(
      join(tasks, "OPAG-1.md"),
      `---\nid: OPAG-1\ntitle: Parent\nstatus: To Do\n---\n\nBody.\n`,
    );
    await writeFile(
      join(tasks, "OPAG-1.1.md"),
      `---\nid: OPAG-1.1\ntitle: Subtask\nstatus: To Do\nparent: OPAG-1\n---\n\nBody.\n`,
    );
    await writeFile(
      join(tasks, "OPAG-2.md"),
      `---\nid: OPAG-2\ntitle: Unrelated sibling\nstatus: To Do\n---\n\nBody.\n`,
    );

    const positional = await questNative(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--json",
    ]);
    expect(positional.exitCode).toBe(5);
    const positionalError = JSON.parse(positional.stderr);
    expect(positionalError.error_type).toBe("conflict");
    expect(positionalError.message).toStartWith("Alias collision:");
    expect(positionalError.message).toContain("--preserve-source-ids");
    expect(positionalError.message).toContain("--source-family <PREFIX>");

    const preserved = await questNative(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--preserve-source-ids",
      "--source-family",
      "OPAG",
      "--json",
    ]);
    expect(preserved.exitCode).toBe(0);
    const mappings = JSON.parse(preserved.stdout).data.mappings as {
      sourceIdentifier: string;
      targetIdentifier: string;
      aliases: readonly string[];
    }[];
    expect(
      mappings.find((m) => m.sourceIdentifier === "OPAG-1")?.targetIdentifier,
    ).toBe("OPAG-1");
    expect(
      mappings.find((m) => m.sourceIdentifier === "OPAG-2")?.targetIdentifier,
    ).toBe("OPAG-2");
    // Dotted subtasks still translate to a fresh flat id even under
    // preservation -- Quest has no dotted canonical id -- with the dotted
    // spelling kept as an alias.
    const subtask = mappings.find((m) => m.sourceIdentifier === "OPAG-1.1");
    expect(subtask?.targetIdentifier).not.toBe("OPAG-1.1");
    expect(subtask?.aliases).toContain("OPAG-1.1");
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("a genuine dual id claim still refuses under --preserve-source-ids, with guidance naming that no flag resolves it (fleet-reported 2026-09-09)", async () => {
  // Unlike the QCLI-166 case above (a dotted subtask's positional shift,
  // which --preserve-source-ids genuinely fixes), this is a plain,
  // non-dotted id the destination workspace already holds a live,
  // unrelated claim to -- --preserve-source-ids cannot resolve two
  // independent records both legitimately named the same thing without
  // silently dropping one side's alias, so it must still refuse, and the
  // refusal must say so rather than repeat advice that already failed.
  const store = await mkdtemp(join(tmpdir(), "quest-backlog-dualclaim-"));
  const source = await mkdtemp(join(tmpdir(), "quest-backlog-dualclaim-src-"));
  try {
    await Bun.spawn(["git", "init", "-q"], { cwd: store }).exited;
    const init = await questNative(store, [
      "init",
      "--task-id-prefix",
      "QCLI",
      "--json",
    ]);
    expect(init.exitCode).toBe(0);
    const created = await questNative(store, [
      "task",
      "create",
      "Pre-existing",
      "--actor",
      "migration-owner",
      "--actor-kind",
      "human",
      "--id",
      "QCLI-1",
      "--json",
    ]);
    expect(created.exitCode).toBe(0);

    const tasks = join(source, "backlog", "tasks");
    await mkdir(tasks, { recursive: true });
    await writeFile(
      join(tasks, "qcli-1.md"),
      "---\nid: QCLI-1\ntitle: Unrelated backlog task\nstatus: To Do\n---\n\nBody.\n",
    );

    const withoutPreserve = await questNative(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--json",
    ]);
    expect(withoutPreserve.exitCode).toBe(5);
    const firstError = JSON.parse(withoutPreserve.stderr);
    expect(firstError.message).toContain(
      "If instead this exact id is already a live, unrelated claim",
    );

    const withPreserve = await questNative(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--preserve-source-ids",
      "--source-family",
      "QCLI",
      "--json",
    ]);
    // Still refused: --preserve-source-ids fixes positional-renumbering
    // shifts, not two records with an independent, equally valid claim to
    // the exact same id.
    expect(withPreserve.exitCode).toBe(5);
    const secondError = JSON.parse(withPreserve.stderr);
    expect(secondError.error_type).toBe("conflict");
    expect(secondError.message).toContain("Backlog id preservation refused");
    expect(secondError.message).toContain(
      "No further flag resolves a remaining id collision here",
    );
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("status and rollback report a never-previewed digest as not_found on exit 3, not validation on exit 6 (QCLI-257)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-backlog-not-found-"));
  try {
    const unknownDigest =
      "sha256:0000000000000000000000000000000000000000000000000000000000000000";

    const status = await quest(store, [
      "migration",
      "backlog",
      "status",
      "--digest",
      unknownDigest,
      "--json",
    ]);
    expect(status.exitCode).toBe(3);
    expect(status.stdout).toBe("");
    expect(JSON.parse(status.stderr)).toEqual({
      error_type: "not_found",
      message: "migration_not_found",
      principal: null,
    });

    // rollback() calls status() internally to load the receipt before it does
    // anything else, so it throws and must classify the identical message the
    // identical way -- this is the sibling call site DEC-2/QCLI-257 covers.
    const rollback = await quest(store, [
      "migration",
      "backlog",
      "rollback",
      "--digest",
      unknownDigest,
      "--actor",
      "migration-owner",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(rollback.exitCode).toBe(3);
    expect(rollback.stdout).toBe("");
    expect(JSON.parse(rollback.stderr)).toEqual({
      error_type: "not_found",
      message: "migration_not_found",
      principal: null,
    });
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});
