import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * QCLI-392. `task pause` parks a task at the configured paused status, but
 * `task list --status Paused` refused that status as "not configured": the
 * list filter resolved against the ladder (`statuses`) only, and the paused
 * status is deliberately off the ladder. So the one status the tool assigns
 * outside the ladder could not be used to find what it assigned.
 *
 * The fix is scoped to the list FILTERS. `task edit --status Paused` still
 * refuses, because `task pause` is the only legal entry into it (QCLI-229).
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const ACTOR = ["--actor", "person-1", "--actor-kind", "human"] as const;
const roots: string[] = [];

function quest(workspace: string, args: readonly string[]) {
  const child = Bun.spawnSync([process.execPath, MAIN, ...args], {
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

/** T-1 paused, T-2 in progress, T-3 to do. */
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli392-"));
  roots.push(root);
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  for (const title of ["parked", "working", "waiting"])
    quest(root, ["task", "create", title, ...ACTOR, "--json"]);
  for (const id of ["T-1", "T-2"])
    quest(root, ["task", "edit", id, "--status", "In Progress", ...ACTOR]);
  const paused = quest(root, ["task", "pause", "T-1", ...ACTOR, "--json"]);
  expect(paused.exitCode).toBe(0);
  return root;
}

const ids = (result: ReturnType<typeof quest>) =>
  (JSON.parse(result.stdout).data as { id: string }[]).map((task) => task.id);

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("task list --status <paused status> lists exactly the paused tasks", async () => {
  const root = await workspace();
  const flow = JSON.parse(
    quest(root, ["task", "status-flow", "--json"]).stdout,
  ).data;
  expect(flow.pausedStatus).toBe("Paused");
  for (const spelling of ["Paused", "paused"]) {
    const result = quest(root, [
      "task",
      "list",
      "--status",
      spelling,
      "--json",
    ]);
    expect({ spelling, exit: result.exitCode, stderr: result.stderr }).toEqual({
      spelling,
      exit: 0,
      stderr: "",
    });
    expect(ids(result)).toEqual(["T-1"]);
  }
  const excluded = quest(root, [
    "task",
    "list",
    "--exclude-status",
    "Paused",
    "--json",
  ]);
  expect(excluded.exitCode).toBe(0);
  expect(ids(excluded)).toEqual(["T-2", "T-3"]);
});

test("a status that is neither a ladder status nor the paused status is still refused", async () => {
  const root = await workspace();
  for (const flag of ["--status", "--exclude-status"]) {
    const result = quest(root, ["task", "list", flag, "Parked", "--json"]);
    expect(result.exitCode).toBe(6);
    expect(JSON.parse(result.stderr).error_type).toBe("validation");
  }
});

test("task edit --status Paused is still refused: task pause stays the only way in", async () => {
  const root = await workspace();
  const result = quest(root, [
    "task",
    "edit",
    "T-2",
    "--status",
    "Paused",
    ...ACTOR,
    "--json",
  ]);
  expect(result.exitCode).toBe(6);
  const view = JSON.parse(
    quest(root, ["task", "view", "T-2", "--json"]).stdout,
  ).data;
  expect(view.status).toBe("In Progress");
});
