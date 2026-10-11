import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeTask,
  createTask,
  defaultLifecyclePolicy,
  demoteTask,
  type LifecyclePolicy,
  resolveConfiguredStatus,
  taskState,
} from "../src/domain/tasks/tasks.ts";

/**
 * QCLI-331, ruled by opum-doc ADR "Add a second terminal task status for
 * duplicate, superseded and wont-do outcomes". Retiring a never-worked task
 * used to require stepping it To Do -> In Progress -> Done, recording a start
 * and a completion that never happened. Quest now has a second terminal
 * status, "Closed", reached only by `quest task close` with a REQUIRED
 * resolution; duplicate and superseded also name the surviving task.
 *
 * Every CLI case runs the real CLI against a fresh temp workspace. The temp
 * root is realpath'd because on macOS tmpdir() sits behind the /var ->
 * /private/var symlink (QCLI-404).
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const ACTOR = ["--actor", "person-1", "--actor-kind", "human"] as const;
const roots: string[] = [];

function quest(workspace: string, args: readonly string[]) {
  const child = Bun.spawnSync(["bun", MAIN, ...args], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode ?? 0,
    stdout: child.stdout ? child.stdout.toString() : "",
    stderr: child.stderr ? child.stderr.toString() : "",
  };
}

/** A fresh workspace holding `count` To Do tasks, T-1..T-count. */
async function workspace(count: number): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qcli331-")));
  roots.push(root);
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  expect(quest(root, ["init"]).exitCode).toBe(0);
  for (let index = 1; index <= count; index += 1)
    expect(
      quest(root, ["task", "create", `task ${index}`, ...ACTOR, "--json"])
        .exitCode,
    ).toBe(0);
  return root;
}

function edit(root: string, id: string, status: string) {
  expect(
    quest(root, ["task", "edit", id, "--status", status, ...ACTOR]).exitCode,
  ).toBe(0);
}

function view(root: string, id: string): Record<string, unknown> {
  const result = quest(root, ["task", "view", id, "--json"]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout).data;
}

function close(root: string, id: string, ...flags: string[]) {
  return quest(root, ["task", "close", id, ...flags, ...ACTOR, "--json"]);
}

function recordPath(root: string, location: string, id: string): string {
  return join(root, ".quest", location, `${id}.json`);
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

// ---- the command ----------------------------------------------------------

test("To Do -> close duplicate: Closed, moved to completed/, survivor stored canonically", async () => {
  const root = await workspace(2);
  // A case variant of the survivor id resolves and is stored canonically.
  const result = close(
    root,
    "T-2",
    "--resolution",
    "duplicate",
    "--survivor",
    "t-1",
  );
  expect(result.exitCode).toBe(0);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.kind).toBe("task.closed");
  expect(envelope.data.status).toBe("Closed");
  expect(envelope.data.resolution).toEqual({
    kind: "duplicate",
    survivor: "T-1",
  });
  expect(existsSync(recordPath(root, "completed", "T-2"))).toBe(true);
  expect(existsSync(recordPath(root, "tasks", "T-2"))).toBe(false);
  // Persisted, not just echoed: a fresh read carries it.
  const viewed = view(root, "T-2");
  expect(viewed.status).toBe("Closed");
  expect(viewed.resolution).toEqual({ kind: "duplicate", survivor: "T-1" });
  expect(viewed.path).toBe(".quest/completed/T-2.json");
});

test("In Progress -> close wont-do records no survivor", async () => {
  const root = await workspace(1);
  edit(root, "T-1", "In Progress");
  const result = close(
    root,
    "T-1",
    "--resolution",
    "wont-do",
    "--final-summary",
    "Overtaken by events.",
  );
  expect(result.exitCode).toBe(0);
  const viewed = view(root, "T-1");
  expect(viewed.status).toBe("Closed");
  expect(viewed.resolution).toEqual({ kind: "wont-do" });
  expect(viewed.finalSummary).toBe("Overtaken by events.");
  // Closing asserts no completion, so no completion signal is recorded.
  expect("unresolvedAtCompletion" in viewed).toBe(false);
});

test("Paused -> close superseded", async () => {
  const root = await workspace(2);
  edit(root, "T-2", "In Progress");
  expect(quest(root, ["task", "pause", "T-2", ...ACTOR]).exitCode).toBe(0);
  const result = close(
    root,
    "T-2",
    "--resolution",
    "superseded",
    "--survivor",
    "T-1",
  );
  expect(result.exitCode).toBe(0);
  expect(view(root, "T-2").resolution).toEqual({
    kind: "superseded",
    survivor: "T-1",
  });
});

// ---- refusals -------------------------------------------------------------

/** Refused and not applied: the exit code, and the record left as it was. */
function expectRefused(
  root: string,
  id: string,
  result: ReturnType<typeof quest>,
  exitCode: number,
  messagePart: string,
) {
  expect(result.exitCode).toBe(exitCode);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).message).toContain(messagePart);
  expect(view(root, id).status).toBe("To Do");
  expect("resolution" in view(root, id)).toBe(false);
}

test("wont-do with --survivor is a usage error", async () => {
  const root = await workspace(2);
  expectRefused(
    root,
    "T-2",
    close(root, "T-2", "--resolution", "wont-do", "--survivor", "T-1"),
    2,
    "takes no --survivor",
  );
});

test("duplicate without --survivor is a usage error", async () => {
  const root = await workspace(1);
  expectRefused(
    root,
    "T-1",
    close(root, "T-1", "--resolution", "duplicate"),
    2,
    "requires --survivor",
  );
});

test("a survivor that names no task is not_found (exit 3)", async () => {
  const root = await workspace(1);
  const result = close(
    root,
    "T-1",
    "--resolution",
    "duplicate",
    "--survivor",
    "T-99",
  );
  expectRefused(root, "T-1", result, 3, "T-99");
  expect(JSON.parse(result.stderr).error_type).toBe("not_found");
});

test("a task cannot be its own survivor (exit 6)", async () => {
  const root = await workspace(1);
  expectRefused(
    root,
    "T-1",
    close(root, "T-1", "--resolution", "superseded", "--survivor", "T-1"),
    6,
    "its own survivor",
  );
});

test("a bad or missing --resolution is a usage error naming the three kinds", async () => {
  const root = await workspace(1);
  for (const flags of [["--resolution", "obsolete"], []]) {
    const result = close(root, "T-1", ...flags);
    expectRefused(root, "T-1", result, 2, "duplicate");
    expect(JSON.parse(result.stderr).message).toContain("wont-do");
  }
});

test("closing a Done task is refused and names demote", async () => {
  const root = await workspace(1);
  edit(root, "T-1", "In Progress");
  edit(root, "T-1", "Done");
  const result = close(root, "T-1", "--resolution", "wont-do");
  expect(result.exitCode).toBe(6);
  expect(JSON.parse(result.stderr).message).toContain("quest task demote T-1");
  expect(view(root, "T-1").status).toBe("Done");
  expect("resolution" in view(root, "T-1")).toBe(false);
});

test("closing a Closed task is refused", async () => {
  const root = await workspace(1);
  expect(close(root, "T-1", "--resolution", "wont-do").exitCode).toBe(0);
  const again = close(root, "T-1", "--resolution", "wont-do");
  expect(again.exitCode).toBe(6);
  expect(JSON.parse(again.stderr).message).toContain('already "Closed"');
});

test("task edit --status Closed is refused and names task close", async () => {
  const root = await workspace(1);
  expectRefused(
    root,
    "T-1",
    quest(root, [
      "task",
      "edit",
      "T-1",
      "--status",
      "Closed",
      ...ACTOR,
      "--json",
    ]),
    6,
    "quest task close",
  );
});

test("the To Do -> Done refusal names quest task close", async () => {
  const root = await workspace(1);
  const result = quest(root, [
    "task",
    "edit",
    "T-1",
    "--status",
    "Done",
    ...ACTOR,
    "--json",
  ]);
  expectRefused(
    root,
    "T-1",
    result,
    6,
    "Illegal task transition: To Do -> Done.",
  );
  expect(JSON.parse(result.stderr).message).toContain(
    "quest task close T-1 --resolution",
  );
});

test("edit-batch cannot set Closed, and its refusal names task close", async () => {
  const root = await workspace(1);
  const operations = join(root, "ops.jsonl");
  await writeFile(
    operations,
    `${JSON.stringify({
      reference: "T-1",
      operationId: "close-by-batch",
      patch: { status: "Closed" },
    })}\n`,
  );
  const result = quest(root, [
    "task",
    "edit-batch",
    "--file",
    operations,
    ...ACTOR,
    "--json",
  ]);
  expect(result.exitCode, result.stderr).toBe(2);
  const refusal = JSON.parse(result.stderr);
  expect(refusal.message).toContain("Invalid status value");
  expect(refusal.hint).toContain("quest task close");
  expect(view(root, "T-1").status).toBe("To Do");
});

// ---- leaving Closed, and what Closed means to other readers ---------------

test("demote Closed -> To Do withdraws the resolution and moves the record back", async () => {
  const root = await workspace(2);
  expect(
    close(root, "T-2", "--resolution", "duplicate", "--survivor", "T-1")
      .exitCode,
  ).toBe(0);
  const demoted = quest(root, [
    "task",
    "demote",
    "T-2",
    "--to",
    "To Do",
    ...ACTOR,
    "--json",
  ]);
  expect(demoted.exitCode).toBe(0);
  const viewed = view(root, "T-2");
  expect(viewed.status).toBe("To Do");
  expect("resolution" in viewed).toBe(false);
  expect(existsSync(recordPath(root, "tasks", "T-2"))).toBe(true);
  expect(existsSync(recordPath(root, "completed", "T-2"))).toBe(false);
  // The raw record carries no resolution either, not just the view.
  expect(
    "resolution" in
      JSON.parse(readFileSync(recordPath(root, "tasks", "T-2"), "utf8")),
  ).toBe(false);
});

test("a To Do task whose only dependency is Closed is ready", async () => {
  const root = await workspace(1);
  expect(
    quest(root, [
      "task",
      "create",
      "dependent",
      "--dependency",
      "T-1",
      ...ACTOR,
    ]).exitCode,
  ).toBe(0);
  const ready = () =>
    (
      JSON.parse(quest(root, ["task", "list", "--ready", "--json"]).stdout)
        .data as { id: string }[]
    ).map((task) => task.id);
  // Positive control: an unfinished dependency holds it back first.
  expect(ready()).toEqual(["T-1"]);
  expect(close(root, "T-1", "--resolution", "wont-do").exitCode).toBe(0);
  expect(ready()).toEqual(["T-2"]);
});

test("task list --status Closed finds a closed task", async () => {
  const root = await workspace(2);
  expect(close(root, "T-1", "--resolution", "wont-do").exitCode).toBe(0);
  const listed = quest(root, ["task", "list", "--status", "Closed", "--json"]);
  expect(listed.exitCode).toBe(0);
  expect(
    (JSON.parse(listed.stdout).data as { id: string }[]).map((task) => task.id),
  ).toEqual(["T-1"]);
});

test("status-flow names the closed status and resolutions, and keeps terminalStatuses within statuses", async () => {
  const root = await workspace(0);
  const result = quest(root, ["task", "status-flow", "--json"]);
  expect(result.exitCode).toBe(0);
  const envelope = JSON.parse(result.stdout);
  // Only `data` grows; the envelope keys are untouched.
  expect(Object.keys(envelope)).toEqual([
    "schemaVersion",
    "contractVersion",
    "kind",
    "data",
    "principal",
  ]);
  expect(envelope.data).toEqual({
    statuses: ["To Do", "In Progress", "Done"],
    terminalStatuses: ["Done"],
    pausedStatus: "Paused",
    // QCLI-325: reported beside pausedStatus, false while it is built in.
    pausedStatusConfigurable: false,
    closedStatus: "Closed",
    resolutions: ["duplicate", "superseded", "wont-do"],
  });
  // Pinned on purpose (shape B): every published lore-cli refuses the
  // tracker as drift, before every tracker operation, when terminalStatuses
  // is not a subset of statuses, and opum-cli-e2e relies on the same
  // invariant. Closed is reported as closedStatus instead, until a tolerant
  // lore is the floor and a later release moves it into terminalStatuses.
  for (const status of envelope.data.terminalStatuses)
    expect(envelope.data.statuses).toContain(status);
  expect(envelope.data.terminalStatuses).not.toContain("Closed");
});

// ---- doctor ---------------------------------------------------------------

/** Rewrites a record's JSON in place, the way a hand edit would. */
async function handEdit(
  path: string,
  change: (record: Record<string, unknown>) => Record<string, unknown>,
) {
  const record = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, `${JSON.stringify(change(record))}\n`);
}

test("doctor reports each inconsistent resolution shape and rewrites none of them", async () => {
  // Crafted directly in a TEMP workspace, never in this repository's .quest/.
  const root = await workspace(5);
  // T-1: Closed, no resolution. T-2: Closed, duplicate with no survivor.
  // T-3: Closed, well-formed, survivor that does not exist.
  // T-4: To Do, carrying a resolution. T-5: a clean closed record.
  expect(close(root, "T-5", "--resolution", "wont-do").exitCode).toBe(0);
  const shapes: Record<string, Record<string, unknown>> = {
    "T-1": { status: "Closed" },
    "T-2": { status: "Closed", resolution: { kind: "duplicate" } },
    "T-3": {
      status: "Closed",
      resolution: { kind: "duplicate", survivor: "T-99" },
    },
    "T-4": { resolution: { kind: "wont-do" } },
  };
  for (const [id, change] of Object.entries(shapes))
    await handEdit(recordPath(root, "tasks", id), (record) => ({
      ...record,
      ...change,
    }));
  const before = Object.keys(shapes).map((id) =>
    readFileSync(recordPath(root, "tasks", id), "utf8"),
  );

  const doctor = quest(root, ["doctor", "--json"]);
  expect(doctor.exitCode).toBe(0);
  const data = JSON.parse(doctor.stdout).data as {
    healthy: boolean;
    issues: { code: string; taskId: string; [key: string]: unknown }[];
  };
  expect(data.healthy).toBe(false);
  expect(data.issues.map((issue) => [issue.code, issue.taskId])).toEqual([
    ["task_resolution_invalid", "T-1"],
    ["task_resolution_invalid", "T-2"],
    ["task_resolution_survivor_not_found", "T-3"],
    ["task_resolution_invalid", "T-4"],
  ]);
  const byId = new Map(data.issues.map((issue) => [issue.taskId, issue]));
  expect(byId.get("T-1")?.hint).toContain("no resolution");
  expect(byId.get("T-2")?.hint).toContain("requires a survivor");
  expect(byId.get("T-2")?.resolution).toEqual({ kind: "duplicate" });
  expect(byId.get("T-3")?.survivor).toBe("T-99");
  expect(byId.get("T-4")?.status).toBe("To Do");
  expect(byId.get("T-4")?.hint).toContain("not the closed status");
  // Report only: every record is byte-for-byte what it was.
  expect(
    Object.keys(shapes).map((id) =>
      readFileSync(recordPath(root, "tasks", id), "utf8"),
    ),
  ).toEqual(before);
});

test("a clean workspace with a closed task reports no resolution issue", async () => {
  const root = await workspace(3);
  expect(
    close(root, "T-2", "--resolution", "duplicate", "--survivor", "T-1")
      .exitCode,
  ).toBe(0);
  edit(root, "T-3", "In Progress");
  expect(quest(root, ["task", "pause", "T-3", ...ACTOR]).exitCode).toBe(0);
  const doctor = JSON.parse(quest(root, ["doctor", "--json"]).stdout).data;
  expect(doctor).toEqual({ healthy: true, issues: [] });
});

// ---- prospective only (AC3) -----------------------------------------------

test("a record without a resolution still parses and round-trips byte-stable", async () => {
  // The In-Progress-then-Done workaround, as it was used before this change.
  const root = await workspace(1);
  edit(root, "T-1", "In Progress");
  expect(quest(root, ["task", "complete", "T-1", ...ACTOR]).exitCode).toBe(0);
  const fixtures = [readFileSync(recordPath(root, "completed", "T-1"), "utf8")];
  // AC3 names these records; read-only here, never written.
  const quest_ = new URL("../.quest/", import.meta.url).pathname;
  for (const id of ["QCLI-259", "QCLI-97", "QCLI-200", "QCLI-201"]) {
    const location = ["tasks", "completed", "archive/tasks"].find((where) =>
      existsSync(join(quest_, where, `${id}.json`)),
    );
    expect(location, id).toBeDefined();
    fixtures.push(
      readFileSync(join(quest_, location as string, `${id}.json`), "utf8"),
    );
  }
  // Positive control: all five were actually read.
  expect(fixtures.length).toBe(5);
  for (const raw of fixtures) {
    const parsed = JSON.parse(raw);
    expect("resolution" in parsed).toBe(false);
    expect(`${JSON.stringify(taskState(parsed))}\n`).toBe(raw);
  }
});

// ---- domain rules, independent of the CLI's own argv checks --------------

const policy = defaultLifecyclePolicy;
const todo = (id = "T-1") => createTask(id, { title: "t" }, policy);

test("domain: closeTask requires a survivor for duplicate and superseded", () => {
  for (const kind of ["duplicate", "superseded"])
    expect(() => closeTask(todo(), { kind }, policy)).toThrow(
      "requires a survivor",
    );
});

test("domain: closeTask refuses a survivor for wont-do, and the task as its own survivor", () => {
  expect(() =>
    closeTask(todo(), { kind: "wont-do", survivor: "T-2" }, policy),
  ).toThrow("takes no survivor");
  expect(() =>
    closeTask(todo(), { kind: "duplicate", survivor: "t-1" }, policy),
  ).toThrow("its own survivor");
});

test("domain: a demote of a Done record never gains a resolution", () => {
  const done = taskState({ ...todo(), status: "Done" });
  const demoted = demoteTask(done, "completed", "To Do", policy);
  expect("resolution" in demoted).toBe(false);
});

test("domain: the closed status is validated against the ladder and the paused status", () => {
  const withClosed = (closedStatus: string): LifecyclePolicy => ({
    ...policy,
    closedStatus,
  });
  for (const [closedStatus, message] of [
    [" ", "cannot be blank"],
    ["Done", "collide with a ladder status"],
    ["Paused", "collide with the paused status"],
  ] as const)
    expect(() =>
      resolveConfiguredStatus("To Do", withClosed(closedStatus)),
    ).toThrow(message);
});
