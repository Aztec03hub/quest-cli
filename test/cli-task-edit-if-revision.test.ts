import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./helpers/spawn.ts";

/**
 * QCLI-277: `task edit`'s write path had real optimistic-concurrency
 * machinery (every mutation reads a fresh snapshot and writes with
 * `expectedRevision: snapshot.revision`), but no way for a CALLER to supply
 * a revision it captured from an earlier read and have the edit refuse
 * unless the record is still at that revision -- the freshly-read
 * `snapshot.revision` trivially matches every time, since it is read
 * moments before the write in the same call. `--if-revision` is that
 * missing precondition; this file proves both halves: `task view --json`
 * now exposes `revision` to read, and `task edit --if-revision` enforces it
 * to write, reusing the same exit-5 conflict shape an ordinary write race
 * already produces.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;

interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnQuest(workspace: string, args: readonly string[]): SpawnResult {
  return runCommand([process.execPath, MAIN, ...args], {
    cwd: workspace,
    stdin: "ignore",
  });
}

const HUMAN_ACTOR = ["--actor", "human-1", "--actor-kind", "human"] as const;

async function seedWorkspace(): Promise<{
  readonly root: string;
  readonly taskId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "quest-if-revision-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  expect(spawnQuest(root, ["init", "--json"]).exitCode).toBe(0);
  const created = spawnQuest(root, [
    "task",
    "create",
    "If-revision subject",
    ...HUMAN_ACTOR,
    "--json",
  ]);
  expect(created.exitCode).toBe(0);
  return { root, taskId: JSON.parse(created.stdout).data.id };
}

test("`task view --json` exposes `revision`, additive and present alongside every other field", async () => {
  const { root, taskId } = await seedWorkspace();
  try {
    const view = spawnQuest(root, ["task", "view", taskId, "--json"]);
    expect(view.exitCode).toBe(0);
    const data = JSON.parse(view.stdout).data;
    expect(typeof data.revision).toBe("string");
    expect(data.revision.length).toBeGreaterThan(0);
    // Additive: every field `task view` already documented is still there.
    expect(data.id).toBe(taskId);
    expect(data.title).toBe("If-revision subject");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("`task edit --if-revision` with a matching revision succeeds unchanged, exactly like an edit without the flag", async () => {
  const { root, taskId } = await seedWorkspace();
  try {
    const revision = JSON.parse(
      spawnQuest(root, ["task", "view", taskId, "--json"]).stdout,
    ).data.revision;
    const edit = spawnQuest(root, [
      "task",
      "edit",
      taskId,
      "--if-revision",
      revision,
      "--summary",
      "matched revision",
      ...HUMAN_ACTOR,
      "--json",
    ]);
    expect(edit.exitCode).toBe(0);
    expect(JSON.parse(edit.stdout).data.summary).toBe("matched revision");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two concurrent edits from the same read: the first wins, the second is refused via --if-revision (QCLI-277 AC0-AC2)", async () => {
  const { root, taskId } = await seedWorkspace();
  try {
    // Both callers read the SAME revision before either writes.
    const revision = JSON.parse(
      spawnQuest(root, ["task", "view", taskId, "--json"]).stdout,
    ).data.revision;

    // Caller A applies its edit first, using that revision as a precondition.
    const callerA = spawnQuest(root, [
      "task",
      "edit",
      taskId,
      "--if-revision",
      revision,
      "--summary",
      "caller A won",
      ...HUMAN_ACTOR,
      "--json",
    ]);
    expect(callerA.exitCode).toBe(0);
    expect(JSON.parse(callerA.stdout).data.summary).toBe("caller A won");

    // Caller B reasoned from the SAME stale revision (it read before A
    // wrote) and now tries to apply its own edit against it. Without
    // --if-revision this would silently succeed and clobber caller A's
    // update; with it, the record has moved and caller B is refused.
    const callerB = spawnQuest(root, [
      "task",
      "edit",
      taskId,
      "--if-revision",
      revision,
      "--summary",
      "caller B lost",
      ...HUMAN_ACTOR,
      "--json",
    ]);
    expect(callerB.exitCode).toBe(5); // exit 5: conflict, distinguishable from exit 6 validation.
    const diagnostic = JSON.parse(callerB.stderr);
    expect(diagnostic.error_type).toBe("conflict");
    // AC2: the failure response names the current revision so the caller
    // can re-read without a second round trip -- and it must not be the
    // stale revision B supplied, but the store's actual current one.
    expect(typeof diagnostic.input?.actualRevision).toBe("string");
    expect(diagnostic.input.actualRevision).not.toBe(revision);

    // Caller A's write is durably intact -- B's refusal changed nothing.
    const after = JSON.parse(
      spawnQuest(root, ["task", "view", taskId, "--json"]).stdout,
    ).data;
    expect(after.summary).toBe("caller A won");
    // And re-reading gives B exactly the revision the conflict already named.
    expect(after.revision).toBe(diagnostic.input.actualRevision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("omitting --if-revision is unaffected: today's read-then-write-with-freshly-read-revision behavior is unchanged (QCLI-277 AC4)", async () => {
  const { root, taskId } = await seedWorkspace();
  try {
    const first = spawnQuest(root, [
      "task",
      "edit",
      taskId,
      "--summary",
      "no precondition",
      ...HUMAN_ACTOR,
      "--json",
    ]);
    expect(first.exitCode).toBe(0);
    const second = spawnQuest(root, [
      "task",
      "edit",
      taskId,
      "--summary",
      "still no precondition",
      ...HUMAN_ACTOR,
      "--json",
    ]);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout).data.summary).toBe(
      "still no precondition",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("`task edit-batch` supports the same precondition per operation: a stale item fails on its own without blocking its siblings (QCLI-277 AC3)", async () => {
  const { root, taskId } = await seedWorkspace();
  try {
    const revision = JSON.parse(
      spawnQuest(root, ["task", "view", taskId, "--json"]).stdout,
    ).data.revision;
    const second = spawnQuest(root, [
      "task",
      "create",
      "Untouched sibling",
      ...HUMAN_ACTOR,
      "--json",
    ]);
    const secondId = JSON.parse(second.stdout).data.id;

    const ops = [
      {
        reference: taskId,
        operationId: "op-stale",
        ifRevision: revision,
        patch: { summary: "should not apply" },
      },
      {
        reference: secondId,
        operationId: "op-fresh",
        patch: { summary: "unconditional edit still applies" },
      },
    ];
    // Force op-stale to actually be stale before the batch runs by moving
    // THE RECORD IT NAMES. QCLI-310 scoped the precondition to the record, so
    // an edit to `secondId` would correctly leave op-stale's revision valid;
    // the unrelated-write half is the separate test below.
    expect(
      spawnQuest(root, [
        "task",
        "edit",
        taskId,
        "--title",
        "revision bump",
        ...HUMAN_ACTOR,
        "--json",
      ]).exitCode,
    ).toBe(0);

    const file = join(root, "operations.jsonl");
    await writeFile(file, ops.map((o) => JSON.stringify(o)).join("\n"));
    const batch = spawnQuest(root, [
      "task",
      "edit-batch",
      "--file",
      file,
      ...HUMAN_ACTOR,
      "--json",
    ]);
    expect(batch.exitCode).toBe(0); // Batch-level exit stays 0: per-item failures don't abort the batch.
    const data = JSON.parse(batch.stdout).data;
    expect(data.applied).toBe(1);
    expect(data.failed).toBe(1);
    const failed = data.items.find(
      (item: { operationId: string }) => item.operationId === "op-stale",
    );
    expect(failed.kind).toBe("error");
    expect(failed.message).toContain("task_revision_precondition_failed");
    // Named revision, same AC2 spirit extended to the per-item case.
    expect(failed.message).toContain(revision);
    const succeeded = data.items.find(
      (item: { operationId: string }) => item.operationId === "op-fresh",
    );
    expect(succeeded.kind).toBe("updated");
    expect(succeeded.task.summary).toBe("unconditional edit still applies");

    // The stale item never touched the record it targeted.
    const stillUnchanged = JSON.parse(
      spawnQuest(root, ["task", "view", taskId, "--json"]).stdout,
    ).data;
    expect(stillUnchanged.summary).not.toBe("should not apply");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

/**
 * QCLI-310 (reported by the mbpm2 project, relayed by opum-agent). The
 * precondition was workspace-scoped at BOTH ends: `task view --json` emitted
 * the store's whole-workspace revision, and `--if-revision` compared against
 * that same value. So any write anywhere moved the revision a task emitted
 * for itself, and a guarded edit of a record that never changed was refused
 * with exit 5 -- unusable for exactly the concurrent sessions the flag was
 * built for, and contrary to what the help text, the tracker contract and
 * QCLI-277's own acceptance criteria promise ("apply this edit only if THE
 * RECORD is still at the revision I read"). The pair below is the reported
 * reproduction and its control, run separately rather than inferred from one
 * another.
 */
function createTask(root: string, title: string): string {
  const created = spawnQuest(root, [
    "task",
    "create",
    title,
    ...HUMAN_ACTOR,
    "--json",
  ]);
  expect(created.exitCode).toBe(0);
  return JSON.parse(created.stdout).data.id;
}

test("the reported reproduction: editing an unrelated task does not invalidate a captured revision (QCLI-310 AC1)", async () => {
  const { root, taskId } = await seedWorkspace();
  try {
    const otherId = createTask(root, "Unrelated neighbour");
    const revision = revisionOf(root, taskId);

    // The reporter's second session writes a DIFFERENT task, exactly as in
    // their reproduction.
    const unrelated = spawnQuest(root, [
      "task",
      "edit",
      otherId,
      "--add-note",
      "written by another session",
      ...HUMAN_ACTOR,
      "--json",
    ]);
    expect(unrelated.exitCode).toBe(0);

    // The captured revision describes the record, so it has not moved.
    expect(revisionOf(root, taskId)).toBe(revision);

    // AC1: the final command of the reproduction returns exit 0, because the
    // record it guards was never written to. Before QCLI-310 this was exit 5.
    const guarded = spawnQuest(root, [
      "task",
      "edit",
      taskId,
      "--if-revision",
      revision,
      "--summary",
      "guarded edit",
      ...HUMAN_ACTOR,
      "--json",
    ]);
    expect(guarded.exitCode).toBe(0);
    expect(JSON.parse(guarded.stdout).data.summary).toBe("guarded edit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the control, as its own run: the guarded record moving still conflicts and names its own current revision (QCLI-310 AC2)", async () => {
  const { root, taskId } = await seedWorkspace();
  try {
    const otherId = createTask(root, "Unrelated neighbour");
    const revision = revisionOf(root, taskId);

    // An unrelated write FIRST, so the refusal below cannot be attributed to
    // the workspace merely having moved.
    expect(
      spawnQuest(root, [
        "task",
        "edit",
        otherId,
        "--add-note",
        "unrelated write",
        ...HUMAN_ACTOR,
        "--json",
      ]).exitCode,
    ).toBe(0);
    expect(revisionOf(root, taskId)).toBe(revision);

    // Now move the guarded record itself.
    expect(
      spawnQuest(root, [
        "task",
        "edit",
        taskId,
        "--add-note",
        "the record itself moved",
        ...HUMAN_ACTOR,
        "--json",
      ]).exitCode,
    ).toBe(0);

    const guarded = spawnQuest(root, [
      "task",
      "edit",
      taskId,
      "--if-revision",
      revision,
      "--summary",
      "should conflict",
      ...HUMAN_ACTOR,
      "--json",
    ]);
    expect(guarded.exitCode).toBe(5);
    const diagnostic = JSON.parse(guarded.stderr);
    expect(diagnostic.error_type).toBe("conflict");
    expect(diagnostic.input.actualRevision).not.toBe(revision);
    // The named revision is the record's own new one, so a caller retries
    // without a second round trip -- and it is reachable from a plain read.
    expect(revisionOf(root, taskId)).toBe(diagnostic.input.actualRevision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edit-batch: an unrelated task's write leaves every item's precondition valid, and the batch applies (QCLI-310)", async () => {
  const { root, taskId } = await seedWorkspace();
  try {
    const secondId = createTask(root, "Second guarded task");
    const revision = revisionOf(root, taskId);
    const secondRevision = revisionOf(root, secondId);

    const unrelatedId = createTask(root, "Unrelated neighbour");
    expect(
      spawnQuest(root, [
        "task",
        "edit",
        unrelatedId,
        "--add-note",
        "unrelated write",
        ...HUMAN_ACTOR,
        "--json",
      ]).exitCode,
    ).toBe(0);

    const file = join(root, "operations-unrelated.jsonl");
    await writeFile(
      file,
      [
        {
          reference: taskId,
          operationId: "op-a",
          ifRevision: revision,
          patch: { summary: "guarded A" },
        },
        {
          reference: secondId,
          operationId: "op-b",
          ifRevision: secondRevision,
          patch: { summary: "guarded B" },
        },
      ]
        .map((o) => JSON.stringify(o))
        .join("\n"),
    );

    const batch = spawnQuest(root, [
      "task",
      "edit-batch",
      "--file",
      file,
      ...HUMAN_ACTOR,
      "--json",
    ]);
    expect(batch.exitCode).toBe(0);
    const data = JSON.parse(batch.stdout).data;
    // Both items carried a precondition captured before the unrelated write
    // and both must still apply. Before QCLI-310 both failed.
    expect(data.applied).toBe(2);
    expect(data.failed).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * QCLI-374 (reported by opum-cli-e2e TASK-90). The single-edit path folded
 * the patch before checking --if-revision, and folding throws the QCLI-297
 * removal miss when a concurrent writer already removed the value. So the
 * race this precondition exists to report surfaced as exit-6 validation,
 * and a caller retrying on `conflict` (lore-cli LCLI-522) never retried.
 * Enumerated over every by-value removal flag, as QCLI-297 is, because the
 * miss is shared by all of them.
 */
const BY_VALUE_REMOVALS = [
  "--remove-note",
  "--remove-plan",
  "--remove-label",
  "--remove-assignee",
  "--remove-reference",
  "--remove-modified-file",
  "--remove-dependency",
  "--remove-comment",
] as const;

function revisionOf(root: string, taskId: string): string {
  return JSON.parse(spawnQuest(root, ["task", "view", taskId, "--json"]).stdout)
    .data.revision;
}

test("the reported race: a second writer removes the same label, and the stale removal is a conflict, not a miss (QCLI-374)", async () => {
  const { root, taskId } = await seedWorkspace();
  try {
    for (const [add, remove, value] of [
      ["--add-label", "--remove-label", "doc:S"],
      ["--add-assignee", "--remove-assignee", "bob"],
    ] as const) {
      expect(
        spawnQuest(root, ["task", "edit", taskId, add, value, ...HUMAN_ACTOR])
          .exitCode,
      ).toBe(0);
      const read = revisionOf(root, taskId);
      expect(
        spawnQuest(root, [
          "task",
          "edit",
          taskId,
          remove,
          value,
          ...HUMAN_ACTOR,
        ]).exitCode,
      ).toBe(0);
      const stale = spawnQuest(root, [
        "task",
        "edit",
        taskId,
        remove,
        value,
        "--if-revision",
        read,
        ...HUMAN_ACTOR,
        "--json",
      ]);
      expect(stale.exitCode).toBe(5);
      expect(JSON.parse(stale.stderr).error_type).toBe("conflict");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every by-value removal that misses under a stale --if-revision is a conflict, and under a current one is still the QCLI-297 miss (QCLI-374)", async () => {
  const { root, taskId } = await seedWorkspace();
  try {
    for (const flag of BY_VALUE_REMOVALS) {
      const read = revisionOf(root, taskId);
      expect(
        spawnQuest(root, [
          "task",
          "edit",
          taskId,
          "--add-note",
          `moved before ${flag}`,
          ...HUMAN_ACTOR,
        ]).exitCode,
      ).toBe(0);
      const stale = spawnQuest(root, [
        "task",
        "edit",
        taskId,
        flag,
        "absent-value",
        "--if-revision",
        read,
        ...HUMAN_ACTOR,
        "--json",
      ]);
      expect({ flag, exit: stale.exitCode }).toEqual({ flag, exit: 5 });

      const current = spawnQuest(root, [
        "task",
        "edit",
        taskId,
        flag,
        "absent-value",
        "--if-revision",
        revisionOf(root, taskId),
        ...HUMAN_ACTOR,
        "--json",
      ]);
      expect({ flag, exit: current.exitCode }).toEqual({ flag, exit: 6 });
      expect(JSON.parse(current.stderr).error_type).toBe("validation");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  // 40 CLI spawns: 3s locally, past the 5s default on a loaded CI runner
  // once source-gates began running this file (QCLI-375).
}, 30_000);
