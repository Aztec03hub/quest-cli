import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./helpers/spawn.ts";

/**
 * QCLI-339. `overview` counted `taskSnapshot.tasks`, which
 * `LocalTaskRepository.readAll` narrows to `location === "tasks"`. So a
 * SUCCESSFUL `task complete` removed the record from the counts instead of
 * moving them: `total` fell by one and the terminal bucket never grew. A
 * session that completed work and re-read `overview` was handed
 * positive-looking evidence that its write had failed.
 *
 * The sharp version of the defect, and what these tests pin: there are two
 * supported routes to the terminal status and they moved `overview` in
 * OPPOSITE directions. `task complete` relocates to `completed/` and the
 * record vanished from the counts; `task edit --status Done` does not
 * relocate and the record stayed counted. So the terminal bucket was
 * populated exclusively by the route that bypasses relocation -- in a
 * freshly initialized workspace it could only ever hold records completed
 * the way the task-finalization guide says NOT to.
 *
 * Every figure below is cross-checked against the DIRECTORIES, never against
 * `quest search`, which returns archived records and skews counts
 * release-shaped.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const ACTOR = ["--actor", "person-1", "--actor-kind", "human"] as const;

function quest(workspace: string, args: readonly string[]) {
  return runCommand([process.execPath, MAIN, ...args], {
    cwd: workspace,
  });
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli339-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

/** Counted from the filesystem, so no assertion here rests on the CLI's own view. */
function onDisk(root: string, location: string): number {
  try {
    return readdirSync(join(root, ".quest", location)).filter((name) =>
      name.endsWith(".json"),
    ).length;
  } catch {
    return 0;
  }
}

function overview(root: string) {
  const result = quest(root, ["overview", "--json"]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout).data.tasks as {
    total: number;
    byStatus: Record<string, number>;
    byLocation?: Record<string, number>;
  };
}

test("task complete MOVES the overview counts instead of removing the record from them (QCLI-339)", async () => {
  const root = await workspace();
  try {
    quest(root, ["task", "create", "alpha", ...ACTOR, "--json"]);
    quest(root, ["task", "create", "beta", ...ACTOR, "--json"]);
    quest(root, [
      "task",
      "edit",
      "T-1",
      "--status",
      "In Progress",
      ...ACTOR,
      "--json",
    ]);

    const before = overview(root);
    expect(before.total).toBe(2);
    expect(before.byStatus).toEqual({ "In Progress": 1, "To Do": 1 });
    expect(before.byLocation).toEqual({
      tasks: 2,
      completed: 0,
      "archive/tasks": 0,
    });
    expect(onDisk(root, "tasks")).toBe(2);
    expect(onDisk(root, "completed")).toBe(0);

    const completed = quest(root, [
      "task",
      "complete",
      "T-1",
      ...ACTOR,
      "--json",
    ]);
    expect(completed.exitCode).toBe(0);

    const after = overview(root);
    // The whole point: a successful write moves a number rather than
    // deleting a row. Before the fix this read `total: 1` with no `Done`.
    expect(after.total).toBe(2);
    expect(after.byStatus).toEqual({ Done: 1, "To Do": 1 });
    expect(after.byLocation).toEqual({
      tasks: 1,
      completed: 1,
      "archive/tasks": 0,
    });

    // Cross-checked against the directories, which is where the numbers live.
    expect(onDisk(root, "tasks")).toBe(1);
    expect(onDisk(root, "completed")).toBe(1);
    expect(after.byLocation?.tasks).toBe(onDisk(root, "tasks"));
    expect(after.byLocation?.completed).toBe(onDisk(root, "completed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("both routes to the terminal status agree in the overview counts (QCLI-339)", async () => {
  const root = await workspace();
  try {
    for (const title of ["alpha", "beta"])
      quest(root, ["task", "create", title, ...ACTOR, "--json"]);
    for (const id of ["T-1", "T-2"])
      quest(root, [
        "task",
        "edit",
        id,
        "--status",
        "In Progress",
        ...ACTOR,
        "--json",
      ]);

    // Route A relocates the record; route B leaves it in tasks/.
    expect(
      quest(root, ["task", "complete", "T-1", ...ACTOR, "--json"]).exitCode,
    ).toBe(0);
    expect(
      quest(root, [
        "task",
        "edit",
        "T-2",
        "--status",
        "Done",
        ...ACTOR,
        "--json",
      ]).exitCode,
    ).toBe(0);

    const result = overview(root);
    // Two Done records exist and BOTH are counted, though they sit in
    // different directories. Before the fix this reported Done: 1 -- and the
    // one it showed was the one completed the wrong way.
    expect(result.byStatus).toEqual({ Done: 2 });
    expect(result.total).toBe(2);
    expect(result.byLocation).toEqual({
      tasks: 1,
      completed: 1,
      "archive/tasks": 0,
    });
    expect(onDisk(root, "tasks")).toBe(1);
    expect(onDisk(root, "completed")).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archived tasks are counted and named, not silently dropped (QCLI-339)", async () => {
  const root = await workspace();
  try {
    quest(root, ["task", "create", "alpha", ...ACTOR, "--json"]);
    expect(
      quest(root, ["task", "archive", "T-1", ...ACTOR, "--json"]).exitCode,
    ).toBe(0);

    const result = overview(root);
    expect(result.total).toBe(1);
    expect(result.byLocation).toEqual({
      tasks: 0,
      completed: 0,
      "archive/tasks": 1,
    });
    expect(onDisk(root, "archive/tasks")).toBe(1);
    // A zero is reported as a zero. An absent key would be ambiguous between
    // "none here" and "this reader could not say" -- DEC-6's rule.
    expect(Object.keys(result.byLocation ?? {})).toEqual([
      "tasks",
      "completed",
      "archive/tasks",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the JSON envelope keeps contractVersion at index 1 and principal last (QCLI-339)", async () => {
  const root = await workspace();
  try {
    quest(root, ["task", "create", "alpha", ...ACTOR, "--json"]);
    const result = quest(root, ["overview", "--json"]);
    expect(result.exitCode).toBe(0);
    const keys = Object.keys(JSON.parse(result.stdout));
    // byLocation is additive INSIDE data, so neither top-level constraint
    // moves. These are two separate assertions on purpose: presence and
    // position fail on different edits.
    expect(keys[1]).toBe("contractVersion");
    expect(keys.at(-1)).toBe("principal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("overview's total equals what task list returns, over the same records (QCLI-329)", async () => {
  const root = await workspace();
  try {
    for (const title of ["open", "done", "archived"])
      expect(
        quest(root, ["task", "create", title, ...ACTOR, "--json"]).exitCode,
      ).toBe(0);
    expect(
      quest(root, [
        "task",
        "edit",
        "T-2",
        "--status",
        "In Progress",
        ...ACTOR,
        "--json",
      ]).exitCode,
    ).toBe(0);
    expect(
      quest(root, ["task", "complete", "T-2", ...ACTOR, "--json"]).exitCode,
    ).toBe(0);
    expect(
      quest(root, ["task", "archive", "T-3", ...ACTOR, "--json"]).exitCode,
    ).toBe(0);
    // Every location populated, so a reader that skips one cannot agree.
    expect([
      onDisk(root, "tasks"),
      onDisk(root, "completed"),
      onDisk(root, "archive/tasks"),
    ]).toEqual([1, 1, 1]);

    const listed = (args: readonly string[]) => {
      const result = quest(root, ["task", "list", ...args, "--json"]);
      expect(result.exitCode).toBe(0);
      return (JSON.parse(result.stdout).data as { id: string }[]).length;
    };
    const result = overview(root);
    expect(result.total).toBe(listed(["--include-archived"]));
    expect(result.total - (result.byLocation?.["archive/tasks"] ?? 0)).toBe(
      listed([]),
    );
    expect(listed([])).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
