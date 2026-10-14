import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./helpers/spawn.ts";

/**
 * QCLI-397. `task complete` on a Paused task refused with "Task transition
 * uses an unconfigured status." Paused IS configured (it is the workspace's
 * pausedStatus), so the message named the wrong cause and no way out. The
 * refusal stands: whether complete should accept Paused directly is a
 * separate design question. What changes is that it names the current
 * status and `quest task start <id>`, the one legal exit.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const ACTOR = ["--actor", "person-1", "--actor-kind", "human"] as const;
const roots: string[] = [];

function quest(workspace: string, args: readonly string[]) {
  return runCommand([process.execPath, MAIN, ...args], {
    cwd: workspace,
  });
}

/** T-1, paused. */
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli397-"));
  roots.push(root);
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  quest(root, ["task", "create", "parked", ...ACTOR, "--json"]);
  quest(root, ["task", "edit", "T-1", "--status", "In Progress", ...ACTOR]);
  expect(quest(root, ["task", "pause", "T-1", ...ACTOR]).exitCode).toBe(0);
  return root;
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("task complete on a Paused task names Paused and quest task start <id>", async () => {
  const root = await workspace();
  const result = quest(root, ["task", "complete", "T-1", ...ACTOR, "--json"]);
  expect(result.exitCode).toBe(6);
  expect(result.stdout).toBe("");
  const error = JSON.parse(result.stderr);
  expect(error.error_type).toBe("validation");
  expect(error.message).not.toContain("unconfigured status");
  expect(error.message).toContain('T-1 is "Paused"');
  expect(error.message).toContain("quest task start T-1");
  // Refused, not applied: the record is still parked where it was.
  const view = JSON.parse(
    quest(root, ["task", "view", "T-1", "--json"]).stdout,
  );
  expect(view.data.status).toBe("Paused");
});

test("the way out it names works: start, then complete", async () => {
  const root = await workspace();
  expect(quest(root, ["task", "start", "T-1", ...ACTOR]).exitCode).toBe(0);
  const done = quest(root, ["task", "complete", "T-1", ...ACTOR, "--json"]);
  expect(done.exitCode).toBe(0);
  expect(JSON.parse(done.stdout).data.status).toBe("Done");
});

test("task edit --status on a Paused task gives the same guidance", async () => {
  // The same transition refuses both paths, so the fix reaches both.
  const root = await workspace();
  const result = quest(root, [
    "task",
    "edit",
    "T-1",
    "--status",
    "Done",
    ...ACTOR,
    "--json",
  ]);
  expect(result.exitCode).toBe(6);
  expect(JSON.parse(result.stderr).message).toContain("quest task start T-1");
});
