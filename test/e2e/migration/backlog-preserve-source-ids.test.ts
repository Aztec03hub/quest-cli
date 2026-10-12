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

async function sourceWith(
  records: Readonly<
    Record<string, { readonly title: string; readonly parentTaskId?: string }>
  >,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quest-preserve-source-"));
  const tasks = join(root, "backlog", "tasks");
  await mkdir(tasks, { recursive: true });
  for (const [id, record] of Object.entries(records)) {
    const parentLine = record.parentTaskId
      ? `\nparent_task_id: ${record.parentTaskId}`
      : "";
    await writeFile(
      join(tasks, `${id}.md`),
      `---\nid: ${id}\ntitle: ${record.title}\nstatus: To Do${parentLine}\n---\n\nBody.\n`,
    );
  }
  return root;
}

/** Writes into two lifecycle folders so the same id is a genuine
 * cross-folder duplicate, the same defect shape as the frozen QCLI-66
 * archive/tasks copy resolved earlier in this repo's own history. */
async function sourceWithCrossFolderDuplicate(
  duplicateId: string,
  clean: Readonly<Record<string, { readonly title: string }>>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quest-preserve-dup-source-"));
  const tasks = join(root, "backlog", "tasks");
  const archived = join(root, "backlog", "archive", "tasks");
  await mkdir(tasks, { recursive: true });
  await mkdir(archived, { recursive: true });
  await writeFile(
    join(tasks, `${duplicateId}.md`),
    `---\nid: ${duplicateId}\ntitle: Live copy\nstatus: To Do\n---\n\nBody.\n`,
  );
  await writeFile(
    join(archived, `${duplicateId}.md`),
    `---\nid: ${duplicateId}\ntitle: Stray archived copy\nstatus: Done\n---\n\nBody.\n`,
  );
  for (const [id, record] of Object.entries(clean))
    await writeFile(
      join(tasks, `${id}.md`),
      `---\nid: ${id}\ntitle: ${record.title}\nstatus: To Do\n---\n\nBody.\n`,
    );
  return root;
}

async function previewAndApply(
  store: string,
  source: string,
  extraFlags: readonly string[],
) {
  const preview = await quest(store, [
    "migration",
    "backlog",
    "preview",
    "--source",
    source,
    ...extraFlags,
    "--json",
  ]);
  if (preview.exitCode !== 0) return { preview, apply: undefined };
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
    ...extraFlags,
    "--json",
  ]);
  return { preview, apply };
}

test("--preserve-source-ids keeps a flat id verbatim, translates a dotted id to a flat id plus parentId and alias, resolves derived parents transitively, and reports records left behind by family", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-preserve-ok-"));
  const source = await sourceWith({
    "ODOC-1": { title: "Flat, preserved verbatim" },
    "ODOC-63": { title: "Flat parent" },
    "ODOC-63.2": {
      title: "Dotted, explicit parent_task_id",
      parentTaskId: "ODOC-63",
    },
    "ODOC-97": { title: "Flat grandparent" },
    "ODOC-97.5": { title: "Dotted, derived parent ODOC-97" },
    "ODOC-97.5.2": {
      title: "Dotted, derived parent ODOC-97.5 (itself dotted)",
    },
    "QCLI-1": { title: "A different family, left behind" },
  });
  try {
    const { preview, apply } = await previewAndApply(store, source, [
      "--preserve-source-ids",
      "--source-family",
      "ODOC",
    ]);
    expect(preview.exitCode).toBe(0);
    const previewData = JSON.parse(preview.stdout).data;
    expect(previewData.excluded).toEqual([
      { sourceIdentifier: "QCLI-1", family: "QCLI" },
    ]);
    const flat = previewData.mappings.find(
      (m: { sourceIdentifier: string }) => m.sourceIdentifier === "ODOC-1",
    );
    expect(flat.targetIdentifier).toBe("ODOC-1");
    for (const dotted of ["ODOC-63.2", "ODOC-97.5", "ODOC-97.5.2"]) {
      const mapping = previewData.mappings.find(
        (m: { sourceIdentifier: string }) => m.sourceIdentifier === dotted,
      );
      expect(mapping.targetIdentifier).not.toBe(dotted);
      expect(mapping.targetIdentifier).toMatch(/^ODOC-\d+$/);
      expect(mapping.aliases).toContain(dotted);
    }

    // QCLI-168: `renumbered` isolates exactly the translated pairs, no more
    // and no fewer -- the flat id and the different-family exclusion must
    // not appear, even though `mappings` itself is unchanged (still 6 rows:
    // ODOC-1, ODOC-63, ODOC-63.2, ODOC-97, ODOC-97.5, ODOC-97.5.2).
    expect(previewData.mappings).toHaveLength(6);
    expect(
      previewData.renumbered
        .map((r: { sourceIdentifier: string }) => r.sourceIdentifier)
        .sort(),
    ).toEqual(["ODOC-63.2", "ODOC-97.5", "ODOC-97.5.2"]);
    for (const entry of previewData.renumbered as readonly {
      sourceIdentifier: string;
      targetIdentifier: string;
      reason: string;
    }[]) {
      expect(entry.reason).toBe("dotted_subtask_translated");
      expect(entry.targetIdentifier).toMatch(/^ODOC-\d+$/);
      expect(entry.targetIdentifier).not.toBe(entry.sourceIdentifier);
    }

    expect(apply?.exitCode).toBe(0);

    const flatTask = JSON.parse(
      (await quest(store, ["task", "view", "ODOC-1", "--json"])).stdout,
    ).data;
    expect(flatTask.id).toBe("ODOC-1");

    const explicitChild = JSON.parse(
      (await quest(store, ["task", "view", "ODOC-63.2", "--json"])).stdout,
    ).data;
    const explicitParent = JSON.parse(
      (await quest(store, ["task", "view", "ODOC-63", "--json"])).stdout,
    ).data;
    expect(explicitChild.parentId).toBe(explicitParent.id);
    expect(explicitChild.id).not.toBe("ODOC-63.2");

    const derivedChild = JSON.parse(
      (await quest(store, ["task", "view", "ODOC-97.5", "--json"])).stdout,
    ).data;
    const derivedParent = JSON.parse(
      (await quest(store, ["task", "view", "ODOC-97", "--json"])).stdout,
    ).data;
    expect(derivedChild.parentId).toBe(derivedParent.id);

    const derivedGrandchild = JSON.parse(
      (await quest(store, ["task", "view", "ODOC-97.5.2", "--json"])).stdout,
    ).data;
    expect(derivedGrandchild.parentId).toBe(derivedChild.id);

    const excludedNotImported = await quest(store, [
      "task",
      "view",
      "QCLI-1",
      "--json",
    ]);
    expect(excludedNotImported.exitCode).not.toBe(0);
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("a preserved id colliding with an existing destination id refuses the whole batch and names every collision", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-preserve-collide-"));
  const first = await sourceWith({
    "ODOC-1": { title: "Seeded first" },
    "ODOC-2": { title: "Seeded second" },
  });
  const second = await sourceWith({
    "ODOC-1": { title: "A different task claiming the same id" },
    "ODOC-2": { title: "Also claiming an occupied id" },
  });
  try {
    const seed = await previewAndApply(store, first, [
      "--preserve-source-ids",
      "--source-family",
      "ODOC",
    ]);
    expect(seed.apply?.exitCode).toBe(0);

    const collide = await previewAndApply(store, second, [
      "--preserve-source-ids",
      "--source-family",
      "ODOC",
    ]);
    expect(collide.preview.exitCode).not.toBe(0);
    const envelope = JSON.parse(collide.preview.stderr);
    expect(envelope.error_type).toBe("conflict");
    const collisions = envelope.input.collisions as readonly {
      candidate: string;
    }[];
    expect(collisions.map((c) => c.candidate).sort()).toEqual([
      "ODOC-1",
      "ODOC-2",
    ]);
    expect(envelope.input.unpreservable).toEqual([]);

    // Refused at batch scope: neither record was written, not even the one
    // that would not have collided on its own.
    const stillOnlyTwo = JSON.parse(
      (await quest(store, ["task", "list", "--json"])).stdout,
    ).data;
    expect(stillOnlyTwo.length).toBe(2);
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("an unresolvable parent or a malformed source id refuses the whole batch and names every record", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-preserve-unresolvable-"));
  const source = await sourceWith({
    "ODOC-1": { title: "Fine on its own" },
    "ODOC-500.1": { title: "Derived parent ODOC-500 does not exist" },
    "ODOC-abc": { title: "Neither flat nor dotted" },
  });
  try {
    const preview = await quest(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--preserve-source-ids",
      "--source-family",
      "ODOC",
      "--json",
    ]);
    expect(preview.exitCode).not.toBe(0);
    const envelope = JSON.parse(preview.stderr);
    expect(envelope.error_type).toBe("conflict");
    expect(envelope.input.collisions).toEqual([]);
    const unpreservable = envelope.input.unpreservable as readonly {
      sourceIdentifier: string;
      reason: string;
    }[];
    expect(
      unpreservable
        .map((entry) => [entry.sourceIdentifier, entry.reason])
        .sort(),
    ).toEqual([
      ["ODOC-500.1", "parent_not_found"],
      ["ODOC-abc", "malformed_source_id"],
    ]);

    const nothingWritten = JSON.parse(
      (await quest(store, ["task", "list", "--json"])).stdout,
    ).data;
    expect(nothingWritten.length).toBe(0);
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("--preserve-source-ids and --source-family must be given together, and --source-family must be a valid prefix", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-preserve-usage-"));
  const source = await sourceWith({ "ODOC-1": { title: "Fine" } });
  try {
    const onlyPreserve = await quest(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--preserve-source-ids",
      "--json",
    ]);
    expect(onlyPreserve.exitCode).not.toBe(0);
    expect(JSON.parse(onlyPreserve.stderr).error_type).toBe("usage");

    const onlyFamily = await quest(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--source-family",
      "ODOC",
      "--json",
    ]);
    expect(onlyFamily.exitCode).not.toBe(0);
    expect(JSON.parse(onlyFamily.stderr).error_type).toBe("usage");

    const badFamily = await quest(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--preserve-source-ids",
      "--source-family",
      "not-valid",
      "--json",
    ]);
    expect(badFamily.exitCode).not.toBe(0);
    expect(JSON.parse(badFamily.stderr).error_type).toBe("usage");
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("QCLI-162: a cross-folder duplicate in a family the run is not importing does not block preservation of the selected family", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-preserve-dup-other-"));
  const source = await sourceWithCrossFolderDuplicate("OCLI-5", {
    "ODOC-1": { title: "Clean, in the selected family" },
  });
  try {
    const { preview, apply } = await previewAndApply(store, source, [
      "--preserve-source-ids",
      "--source-family",
      "ODOC",
    ]);
    expect(preview.exitCode).toBe(0);
    expect(apply?.exitCode).toBe(0);
    const previewData = JSON.parse(preview.stdout).data;
    expect(
      previewData.mappings.map(
        (m: { sourceIdentifier: string }) => m.sourceIdentifier,
      ),
    ).toEqual(["ODOC-1"]);
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("QCLI-162: a cross-folder duplicate inside the selected family still refuses", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-preserve-dup-same-"));
  const source = await sourceWithCrossFolderDuplicate("ODOC-5", {
    "ODOC-1": { title: "Clean, same family as the duplicate" },
  });
  try {
    const preview = await quest(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--preserve-source-ids",
      "--source-family",
      "ODOC",
      "--json",
    ]);
    expect(preview.exitCode).not.toBe(0);
    expect(JSON.parse(preview.stderr).message).toBe(
      "backlog_cross_folder_duplicate_id",
    );
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test("QCLI-162: without --preserve-source-ids the blanket cross-folder duplicate check is unchanged", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-preserve-dup-blanket-"));
  const source = await sourceWithCrossFolderDuplicate("OCLI-5", {
    "ODOC-1": { title: "Clean, but positional mode imports everything" },
  });
  try {
    const preview = await quest(store, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--json",
    ]);
    expect(preview.exitCode).not.toBe(0);
    expect(JSON.parse(preview.stderr).message).toBe(
      "backlog_cross_folder_duplicate_id",
    );
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});
