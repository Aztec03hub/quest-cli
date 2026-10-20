import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Draft ids and the milestone ids `cleanup` reports order by number, like task
 * ids do: with eleven of them, `D-10` and `M-10` used to land between `-1` and
 * `-2`.
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

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "draft-milestone-sort-"));
  roots.push(root);
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

const ids = (result: ReturnType<typeof quest>) =>
  (JSON.parse(result.stdout).data as { id: string }[]).map((item) => item.id);

const natural = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("draft list orders draft ids by number", async () => {
  const root = await workspace();
  for (let n = 1; n <= 11; n += 1)
    quest(root, ["draft", "create", `draft ${n}`, ...ACTOR, "--json"]);
  expect(ids(quest(root, ["draft", "list", "--json"]))).toEqual(
    natural("D", 11),
  );
});

test("cleanup lists closed empty milestones by number", async () => {
  const root = await workspace();
  for (let n = 1; n <= 11; n += 1) {
    quest(root, ["milestone", "create", `milestone ${n}`, ...ACTOR, "--json"]);
    quest(root, [
      "milestone",
      "edit",
      `M-${n}`,
      "--status",
      "closed",
      ...ACTOR,
      "--json",
    ]);
  }
  const plan = quest(root, ["cleanup", "--dry-run", ...ACTOR, "--json"]);
  expect(JSON.parse(plan.stdout).data.milestoneIds).toEqual(natural("M", 11));
});
