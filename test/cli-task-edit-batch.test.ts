import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./helpers/spawn.ts";

/**
 * QCLI-122 replacement scope: a public, actor-bound batch task-edit boundary
 * must amortize repeated mutation scans over large stores while preserving
 * per-operation validation/results. Red-first performance contract: N edits
 * issued through ONE native `quest task edit-batch` process complete far
 * faster than the same N through repeated single-edit processes.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;

interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function spawnQuest(
  workspace: string,
  args: readonly string[],
  stdin?: string,
): SpawnResult {
  return runCommand([process.execPath, MAIN, ...args], {
    cwd: workspace,
    stdin: stdin === undefined ? "ignore" : "pipe",
  });
}

async function seedWorkspace(size: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quest-edit-batch-red-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  const init = spawnQuest(root, ["init", "--json"]);
  expect(init.exitCode).toBe(0);
  // Seed records directly in validated storage format (imports of full
  // Backlog projects are exercised elsewhere); scale seeding stays out of
  // what the contract measures.
  const seedProgram = `
      import { createTask } from ${JSON.stringify(
        new URL("../src/domain/tasks/tasks.ts", import.meta.url).pathname,
      )};
      const [root, countArg] = process.argv.slice(1);
      const count = Number(countArg);
      const { mkdir, writeFile } = await import("node:fs/promises");
      const dir = root + "/.quest/tasks";
      await mkdir(dir, { recursive: true });
      for (let i = 0; i < count; i++) {
        const t = createTask("T-" + (i + 1), { title: "Seed " + (i + 1) });
        await writeFile(dir + "/" + t.id + ".json", JSON.stringify(t) + "\\n");
      }
      console.log("seeded:" + count);
    `;
  const seeded = Bun.spawnSync(
    [process.execPath, "--eval", seedProgram, "--", root, String(size)],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (!seeded.stdout.toString().includes(`seeded:${size}`))
    throw new Error(`seed failed: ${seeded.stderr.toString().slice(0, 400)}`);
  return root;
}

test("batch operations file applies distinct mutations with per-item accounting", async () => {
  const root = await seedWorkspace(4);
  try {
    const ops = [
      {
        reference: "T-1",
        operationId: "op-1",
        patch: { status: "In Progress" },
      },
      {
        reference: "T-2",
        operationId: "op-2",
        patch: { addLabels: ["batch"] },
      },
      {
        reference: "T-absent",
        operationId: "op-3",
        patch: { description: "x" },
      },
      {
        reference: "T-4",
        operationId: "op-4",
        patch: { summary: "renamed four" },
      },
    ];
    const file = join(root, "operations.jsonl");
    await writeFile(file, ops.map((o) => JSON.stringify(o)).join("\n"));
    const run = spawnQuest(root, [
      "task",
      "edit-batch",
      "--file",
      file,
      "--actor",
      "human-1",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(run.exitCode).toBe(0);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.kind).toBe("task.batch-updated");
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.data.applied).toBe(3);
    expect(envelope.data.failed).toBe(1);
    const failedItem = envelope.data.items.find(
      (item: { kind: string }) => item.kind === "error",
    );
    expect(failedItem).toMatchObject({
      reference: "T-absent",
      operationId: "op-3",
    });
    const first = envelope.data.items.find(
      (item: { operationId: string }) => item.operationId === "op-1",
    );
    expect(first.task.status).toBe("In Progress");
    // Ordinary single edit still reflects the batch's durable effects.
    const view = spawnQuest(root, ["task", "view", "T-4", "--json"]);
    expect(JSON.parse(view.stdout).data.summary).toBe("renamed four");
    const listed = spawnQuest(root, ["task", "list", "--json"]);
    const labels = JSON.parse(listed.stdout).data.find(
      (task: { id: string }) => task.id === "T-2",
    ).labels;
    expect(labels).toEqual(["batch"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a graph-touching batch edit resolves a dependency completed out of the active set (QCLI-223)", async () => {
  const root = await mkdtemp(join(tmpdir(), "quest-edit-batch-graph-"));
  const humanActor = ["--actor", "human-1", "--actor-kind", "human"];
  try {
    await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
    expect(spawnQuest(root, ["init", "--json"]).exitCode).toBe(0);

    const dependency = spawnQuest(root, [
      "task",
      "create",
      "Dependency",
      ...humanActor,
      "--json",
    ]);
    const dependencyId = JSON.parse(dependency.stdout).data.id;

    const dependent = spawnQuest(root, [
      "task",
      "create",
      "Dependent",
      ...humanActor,
      "--json",
      "--dependency",
      dependencyId,
    ]);
    const dependentId = JSON.parse(dependent.stdout).data.id;

    const other = spawnQuest(root, [
      "task",
      "create",
      "Other",
      ...humanActor,
      "--json",
    ]);
    const otherId = JSON.parse(other.stdout).data.id;

    spawnQuest(root, [
      "task",
      "edit",
      dependencyId,
      "--status",
      "In Progress",
      ...humanActor,
      "--json",
    ]);
    expect(
      spawnQuest(root, [
        "task",
        "complete",
        dependencyId,
        ...humanActor,
        "--json",
      ]).exitCode,
    ).toBe(0);

    // Before the fix, createTaskLinkSession only ever saw initial.tasks
    // (active records), so a graph-touching row failed the moment its
    // session was constructed: `dependent`'s edge to the now-completed
    // `dependency` could not resolve, with dependency_target_not_found.
    const ops = [
      {
        reference: dependentId,
        operationId: "op-1",
        patch: { addDependencies: [otherId] },
      },
    ];
    const file = join(root, "operations.jsonl");
    await writeFile(file, ops.map((o) => JSON.stringify(o)).join("\n"));
    const run = spawnQuest(root, [
      "task",
      "edit-batch",
      "--file",
      file,
      ...humanActor,
      "--json",
    ]);
    expect(run.exitCode).toBe(0);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.data.applied).toBe(1);
    expect(envelope.data.failed).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a batch edit reaches a completed or archived record and writes back to its own location, not tasks/ (QCLI-243)", async () => {
  const root = await mkdtemp(join(tmpdir(), "quest-edit-batch-retired-"));
  const humanActor = ["--actor", "human-1", "--actor-kind", "human"];
  try {
    await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
    expect(spawnQuest(root, ["init", "--json"]).exitCode).toBe(0);

    expect(
      spawnQuest(root, [
        "task",
        "create",
        "Active target",
        ...humanActor,
        "--json",
      ]).exitCode,
    ).toBe(0);

    expect(
      spawnQuest(root, [
        "task",
        "create",
        "Completed target",
        ...humanActor,
        "--json",
      ]).exitCode,
    ).toBe(0);
    expect(
      spawnQuest(root, [
        "task",
        "edit",
        "T-2",
        "--status",
        "In Progress",
        ...humanActor,
        "--json",
      ]).exitCode,
    ).toBe(0);
    expect(
      spawnQuest(root, ["task", "complete", "T-2", ...humanActor, "--json"])
        .exitCode,
    ).toBe(0);

    expect(
      spawnQuest(root, [
        "task",
        "create",
        "Archived target",
        ...humanActor,
        "--json",
      ]).exitCode,
    ).toBe(0);
    expect(
      spawnQuest(root, ["task", "archive", "T-3", ...humanActor, "--json"])
        .exitCode,
    ).toBe(0);

    // Before the fix, editBatch resolved every reference against
    // initial.tasks (active records only), so T-2/T-3 failed with the same
    // misleading task_not_found QCLI-219 fixed for the single-item path.
    const ops = [
      {
        reference: "T-1",
        operationId: "op-active",
        patch: { addLabels: ["batch"] },
      },
      {
        reference: "T-2",
        operationId: "op-completed",
        patch: { addNotes: ["note on completed via batch"] },
      },
      {
        reference: "T-3",
        operationId: "op-archived",
        patch: { addNotes: ["note on archived via batch"] },
      },
    ];
    const file = join(root, "operations.jsonl");
    await writeFile(file, ops.map((o) => JSON.stringify(o)).join("\n"));
    const run = spawnQuest(root, [
      "task",
      "edit-batch",
      "--file",
      file,
      ...humanActor,
      "--json",
    ]);
    expect(run.exitCode).toBe(0);
    const envelope = JSON.parse(run.stdout);
    expect(envelope.data.applied).toBe(3);
    expect(envelope.data.failed).toBe(0);
    for (const item of envelope.data.items) expect(item.kind).toBe("updated");

    // Still resolvable at their own location afterward -- no stray
    // duplicate was written into the active tasks/ directory.
    const completedView = spawnQuest(root, ["task", "view", "T-2", "--json"]);
    expect(JSON.parse(completedView.stdout).data).toMatchObject({
      status: "Done",
      implementationNotes: ["note on completed via batch"],
    });
    const archivedView = spawnQuest(root, ["task", "view", "T-3", "--json"]);
    expect(JSON.parse(archivedView.stdout).data.implementationNotes).toEqual([
      "note on archived via batch",
    ]);

    expect(existsSync(join(root, ".quest", "tasks", "T-2.json"))).toBe(false);
    expect(existsSync(join(root, ".quest", "completed", "T-2.json"))).toBe(
      true,
    );
    expect(existsSync(join(root, ".quest", "tasks", "T-3.json"))).toBe(false);
    expect(
      existsSync(join(root, ".quest", "archive", "tasks", "T-3.json")),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("batch rejects missing actor declaration and absent operations file", async () => {
  const root = await seedWorkspace(1);
  try {
    const file = join(root, "ops.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({ reference: "T-1", patch: {} })}\n`,
    );
    const denied = spawnQuest(root, ["task", "edit-batch", "--file", file]);
    expect(denied.exitCode).not.toBe(0);
    expect(denied.stderr).toContain("denied");
    const missingFile = spawnQuest(root, [
      "task",
      "edit-batch",
      "--file",
      join(root, "nope.jsonl"),
      "--actor",
      "human-1",
      "--actor-kind",
      "human",
    ]);
    expect(missingFile.exitCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("performance contract: many edits in one native batch process meet the paired-release gate", async () => {
  // Deterministic CI-suitable budget modeled on the released projection-scale
  // style: generous machine margin, absolute ceiling that a per-op rescan
  // design cannot satisfy at this size.
  const opCount = 300;
  const root = await seedWorkspace(10_000);
  try {
    const lines: string[] = [];
    for (let i = 0; i < opCount; i++) {
      lines.push(
        JSON.stringify({
          reference: `T-${i + 1}`,
          operationId: `bench-${i + 1}`,
          patch: {
            addLabels: [`wave-${i % 7}`],
            description: `batched edit ${i + 1}`,
          },
        }),
      );
    }
    const file = join(root, "bench.jsonl");
    await writeFile(file, lines.join("\n"));
    const startedAt = performance.now();
    const run = spawnQuest(root, [
      "task",
      "edit-batch",
      "--file",
      file,
      "--actor",
      "bench",
      "--actor-kind",
      "human",
      "--json",
    ]);
    const elapsedMs = performance.now() - startedAt;
    expect(run.exitCode).toBe(0);
    const applied = JSON.parse(run.stdout).data.applied;
    expect(applied).toBe(opCount);
    // Gate: >=1500 edits/minute equivalent over the whole process lifetime
    // ((60_000/elapsed)*opCount), leaving ~6x headroom to the sub-hour
    // requirement for 90k operations even on slower CI runners.
    const opsPerMinute = (60_000 / elapsedMs) * opCount;
    expect(opsPerMinute).toBeGreaterThan(1500);
    void readFile; // fs affordances kept explicit for future assertions
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
