import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./helpers/spawn.ts";

/**
 * QCLI-311, option 2 (ruled 2026-09-29): completing a task relocates the
 * record, so the commit delivering it is a rename and must carry both sides.
 * The dangerous habit is a repo-wide `git add -A`, which also stages any
 * unrelated tracked file merely missing from the working tree -- measured in
 * this repository on 2026-09-15, when a "tracker-only" commit also deleted
 * npm/quest-darwin-arm64 and only the package-artifact gate caught it.
 *
 * Option 2 keeps the fix on the human surface: a staging hint in the
 * completion's text output, the prose in the task-finalization guide, and NO
 * change to the JSON envelope (a machine-readable field is a contract change,
 * explicitly out of scope for this slice).
 *
 * These tests pin all three halves, plus the recipe itself: the scoped add the
 * hint names is executed against a real repository and the staged set is
 * asserted, because a hint naming a command that does not stage both sides
 * would be worse than none.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const HUMAN = ["--actor", "person-1", "--actor-kind", "human"] as const;

function run(workspace: string, argv: readonly string[]) {
  return runCommand([...argv], {
    cwd: workspace,
  });
}

const quest = (workspace: string, args: readonly string[]) =>
  run(workspace, [process.execPath, MAIN, ...args]);
const git = (workspace: string, args: readonly string[]) =>
  run(workspace, ["git", ...args]);

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli311-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@example.invalid"], {
    cwd: root,
  }).exited;
  await Bun.spawn(["git", "config", "user.name", "test"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

/** Creates and claims a task, leaving it completable and tracked in git. */
function claimedTask(root: string, title: string) {
  quest(root, ["task", "create", title, ...HUMAN, "--json"]);
  const id = "T-1";
  expect(quest(root, ["task", "start", id, ...HUMAN, "--json"]).exitCode).toBe(
    0,
  );
  // Baseline commit: the relocation has to be observable as a change, so the
  // record must be tracked before the completion runs.
  expect(git(root, ["add", "-A", ".quest/"]).exitCode).toBe(0);
  expect(git(root, ["commit", "-qm", "baseline"]).exitCode).toBe(0);
  return id;
}

test("plain completion output names the scoped staging add (QCLI-311)", async () => {
  const root = await workspace();
  try {
    const id = claimedTask(root, "Ship the thing");
    const completed = quest(root, [
      "task",
      "complete",
      id,
      ...HUMAN,
      "--plain",
    ]);
    expect(completed.exitCode).toBe(0);
    expect(completed.stdout).toContain(
      `the record moved to .quest/completed/${id}.json`,
    );
    expect(completed.stdout).toContain("Stage the move before committing");
    expect(completed.stdout).toContain("git add -A .quest/");
    expect(completed.stdout).toContain(
      "not a repo-wide git add -A, which would also stage unrelated deletions.",
    );
    // The unresolved-checklist warning stays the only stderr line, and a
    // clean completion stays silent there.
    expect(completed.stderr).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("the JSON completion envelope is unchanged by the staging hint (QCLI-311)", async () => {
  const root = await workspace();
  try {
    const id = claimedTask(root, "Ship the thing");
    const completed = quest(root, ["task", "complete", id, ...HUMAN, "--json"]);
    expect(completed.exitCode).toBe(0);
    // No machine-readable trace of the hint, in either stream.
    expect(completed.stdout).not.toContain("git add");
    expect(completed.stderr).toBe("");
    const envelope = JSON.parse(completed.stdout) as {
      kind: string;
      data: { id: string; status: string };
    };
    expect(envelope.kind).toBe("task.completed");
    expect(envelope.data).toMatchObject({ id, status: "Done" });
    // The envelope's own shape, including the two positional constraints the
    // shared command contract fixes: contractVersion at index 1, principal
    // last. A field added for this hint would have moved both.
    expect(Object.keys(JSON.parse(completed.stdout) as object)).toEqual([
      "schemaVersion",
      "contractVersion",
      "kind",
      "data",
      "principal",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("the scoped add the hint names actually stages both sides of the move (QCLI-311)", async () => {
  const root = await workspace();
  try {
    const id = claimedTask(root, "Ship the thing");
    expect(
      quest(root, ["task", "complete", id, ...HUMAN, "--json"]).exitCode,
    ).toBe(0);

    const oldPath = `.quest/tasks/${id}.json`;
    const newPath = `.quest/completed/${id}.json`;

    // What the move leaves behind before anything is staged.
    const before = git(root, ["status", "--porcelain"]).stdout;
    expect(before).toContain(`D ${oldPath}`);
    expect(before).toContain("?? .quest/completed/");

    // Control: staging the removal side alone leaves the addition untracked,
    // which is why the hint names a scoped -A rather than -u or a lone path.
    git(root, ["add", "-u", ".quest/"]);
    const afterUpdate = git(root, ["status", "--porcelain"]).stdout;
    expect(afterUpdate).toContain(`D  ${oldPath}`);
    expect(afterUpdate).toContain("?? .quest/completed/");
    git(root, ["reset", "-q"]);

    // The recipe the hint (and the guide) name, executed verbatim.
    expect(git(root, ["add", "-A", ".quest/"]).exitCode).toBe(0);
    const status = git(root, ["status", "--porcelain"]).stdout;
    expect(status).not.toContain("??");
    const staged = git(root, ["diff", "--cached", "--name-only"])
      .stdout.trim()
      .split("\n")
      .sort();
    expect(staged).toEqual([newPath, oldPath].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("the task-finalization guide documents the requirement and the hazard (QCLI-311)", async () => {
  const root = await workspace();
  try {
    const guide = quest(root, ["instructions", "task-finalization"]);
    expect(guide.exitCode).toBe(0);
    expect(guide.stdout).toContain("The commit that carries a completion");
    expect(guide.stdout).toContain("git add -A .quest/");
    expect(guide.stdout).toContain(
      "git add .quest/tasks/<id>.json .quest/completed/<id>.json",
    );
    expect(guide.stdout).toContain("git add -u .quest/");
    expect(guide.stdout).toContain("repo-wide `git add -A`");
    expect(guide.stdout).toContain("git diff --cached --name-status");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
