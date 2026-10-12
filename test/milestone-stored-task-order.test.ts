import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The order a milestone stores its `taskIds` in. Linking a task re-sorts the
 * list, and that sort compared the ids as plain strings, so a milestone with
 * eleven tasks stored `T-10` and `T-11` between `T-1` and `T-2`. The stored
 * list now follows the numeric id order every listing uses.
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

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("a milestone stores its linked task ids in numeric order", async () => {
  const root = await mkdtemp(join(tmpdir(), "milestone-task-order-"));
  roots.push(root);
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  quest(root, ["milestone", "create", "release", ...ACTOR, "--json"]);
  for (let n = 1; n <= 11; n += 1)
    quest(root, [
      "task",
      "create",
      `task ${n}`,
      "--milestone",
      "M-1",
      ...ACTOR,
      "--json",
    ]);
  const view = quest(root, ["milestone", "view", "M-1", "--json"]);
  expect(JSON.parse(view.stdout).data.taskIds).toEqual(
    Array.from({ length: 11 }, (_, i) => `T-${i + 1}`),
  );
});
