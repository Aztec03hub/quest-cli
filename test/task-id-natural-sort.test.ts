import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareTaskIds } from "../src/domain/tasks/tasks.ts";

/**
 * Task ids order by their number, not by their characters. With eleven or more
 * tasks, `T-10` used to land between `T-1` and `T-2` in the default listing, in
 * `--sort id` and in the `--ready` order, because the ids were compared as
 * plain strings.
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
  };
}

/** T-1 to T-12, all To Do. */
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "task-id-sort-"));
  roots.push(root);
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  for (let n = 1; n <= 12; n += 1)
    quest(root, ["task", "create", `task ${n}`, ...ACTOR, "--json"]);
  return root;
}

const ids = (result: ReturnType<typeof quest>) =>
  (JSON.parse(result.stdout).data as { id: string }[]).map((task) => task.id);

const natural = Array.from({ length: 12 }, (_, i) => `T-${i + 1}`);

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("task list orders ids by number by default and with --sort id", async () => {
  const root = await workspace();
  expect(ids(quest(root, ["task", "list", "--json"]))).toEqual(natural);
  expect(ids(quest(root, ["task", "list", "--sort", "id", "--json"]))).toEqual(
    natural,
  );
  expect(
    ids(quest(root, ["task", "list", "--sort", "id:desc", "--json"])),
  ).toEqual([...natural].reverse());
});

test("compareTaskIds reads numbers as numbers and stays a total order", () => {
  const sorted = (ids: string[]) => [...ids].sort(compareTaskIds);
  expect(sorted(["T-10", "T-9", "T-1", "T-2"])).toEqual([
    "T-1",
    "T-2",
    "T-9",
    "T-10",
  ]);
  expect(sorted(["SM-1", "QCLI-10", "QCLI-9"])).toEqual([
    "QCLI-9",
    "QCLI-10",
    "SM-1",
  ]);
  expect(sorted(["QCLI-97.11.1", "QCLI-97.2", "QCLI-97"])).toEqual([
    "QCLI-97",
    "QCLI-97.2",
    "QCLI-97.11.1",
  ]);
  // Leading zeros read as the same number, so the raw text breaks the tie.
  expect(compareTaskIds("T-7", "T-007")).not.toBe(0);
  expect(compareTaskIds("T-7", "T-007")).toBe(-compareTaskIds("T-007", "T-7"));
  expect(compareTaskIds("T-3", "T-3")).toBe(0);
});

test("task list --ready keeps the numeric id order", async () => {
  const root = await workspace();
  expect(ids(quest(root, ["task", "list", "--ready", "--json"]))).toEqual(
    natural,
  );
});
