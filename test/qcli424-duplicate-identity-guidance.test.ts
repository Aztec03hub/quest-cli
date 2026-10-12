import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * QCLI-424. QCLI-261's duplicate-identity hint named one cause -- a partial
 * `git add` that staged a move's addition but not its deletion -- while a
 * second, plausibly more common cause produces the identical fail-closed
 * state: a lifecycle move left uncommitted on a branch, followed by an
 * operation that discards the tracked deletion (`git switch -f`,
 * `git reset --hard`, `git restore`/`git checkout` of .quest) while the
 * untracked completed/ copy survives. The stale tasks/ copy then sits beside
 * the completed/ copy and every quest command exits 5.
 *
 * These tests pin the second cause's guidance, and they EXECUTE the recovery
 * it names -- remove the stale copy AND land the move -- because removing the
 * stale copy alone lets the next restoring operation recreate the duplicate.
 * The plain-switch control pins the operative verb: it is the DISCARD, not
 * the switch, that produces the duplicate.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const HUMAN = ["--actor", "person-1", "--actor-kind", "human"] as const;

function run(workspace: string, argv: readonly string[]) {
  const child = Bun.spawnSync([...argv], {
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

const quest = (workspace: string, args: readonly string[]) =>
  run(workspace, [process.execPath, MAIN, ...args]);
const git = (workspace: string, args: readonly string[]) =>
  run(workspace, ["git", ...args]);

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli424-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@example.invalid"], {
    cwd: root,
  }).exited;
  await Bun.spawn(["git", "config", "user.name", "test"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

/**
 * Creates and claims a task, then commits the baseline the move is measured
 * against -- the tasks/ copy must be tracked at HEAD for the completion to
 * leave the observable ` D .quest/tasks/<id>.json` deletion.
 */
function claimedTask(root: string) {
  quest(root, ["task", "create", "Ship the thing", ...HUMAN, "--json"]);
  const id = "T-1";
  expect(quest(root, ["task", "start", id, ...HUMAN, "--json"]).exitCode).toBe(
    0,
  );
  expect(git(root, ["add", "-A", ".quest/"]).exitCode).toBe(0);
  expect(git(root, ["commit", "-qm", "baseline"]).exitCode).toBe(0);
  return id;
}

/** The measured shape: complete uncommitted, then discard the tracked deletion. */
function duplicateViaReset(root: string) {
  const id = "T-1";
  expect(
    quest(root, ["task", "complete", id, ...HUMAN, "--json"]).exitCode,
  ).toBe(0);
  const moved = git(root, ["status", "--porcelain"]).stdout;
  expect(moved).toContain(`D .quest/tasks/${id}.json`);
  expect(moved).toContain("?? .quest/completed/");
  expect(git(root, ["reset", "--hard", "-q"]).exitCode).toBe(0);
  const duplicated = git(root, ["status", "--porcelain"]).stdout;
  // The tracked deletion is gone from the worktree; the untracked addition
  // survived the reset, which is what makes the id exist twice.
  expect(duplicated).not.toContain("D .quest/tasks/");
  expect(duplicated).toContain("?? .quest/completed/");
  return id;
}

function conflictBody(root: string) {
  const failed = quest(root, ["task", "list", "--json"]);
  expect(failed.exitCode).toBe(5);
  // Error envelopes go to stderr with an empty stdout -- `failure()` in
  // src/cli/main.ts returns `stdout: ""` and the JSON on stderr.
  expect(failed.stdout).toBe("");
  return JSON.parse(failed.stderr.trim()) as {
    error_type: string;
    message: string;
    hint: string;
    input?: { duplicates?: { id: string; paths: string[] }[] };
  };
}

const relative = (path: string) => path.replaceAll("\\", "/");

test("the duplicate-identity hint names the discarded-deletion cause and its half-complete recovery (QCLI-424)", async () => {
  const root = await workspace();
  try {
    claimedTask(root);
    duplicateViaReset(root);
    const body = conflictBody(root);
    expect(body.error_type).toBe("conflict");
    expect(body.message).toBe("task_lifecycle_duplicate_identity");
    // QCLI-261's cause and its compare-and-remove guidance are retained.
    expect(body.hint).toContain("partial `git add`");
    expect(body.hint).toContain("sanctioned exception");
    // The second cause is named, with the operations that produce it.
    expect(body.hint).toContain("made on a branch and left uncommitted");
    expect(body.hint).toContain("discards the tracked deletion");
    expect(body.hint).toContain("git switch -f");
    expect(body.hint).toContain("git reset --hard");
    expect(body.hint).toContain("git restore");
    // The matching recovery: removing the stale copy is HALF of it -- the
    // move must be landed too, and the hint says why.
    expect(body.hint).toContain("removing the stale tasks/<id>.json");
    expect(body.hint).toContain("land the move as well");
    expect(body.hint).toContain("commit the deletion and the addition");
    expect(body.hint).toContain("recreate the duplicate");
    // The duplicate detail still names both real paths (QCLI-261).
    const duplicates = body.input?.duplicates ?? [];
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].id).toBe("T-1");
    expect(
      duplicates[0].paths.some((p) =>
        relative(p).endsWith(".quest/tasks/T-1.json"),
      ),
    ).toBe(true);
    expect(
      duplicates[0].paths.some((p) =>
        relative(p).endsWith(".quest/completed/T-1.json"),
      ),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("the recovery the hint names: rm the stale copy, land the move, and the duplicate stays gone (QCLI-424)", async () => {
  const root = await workspace();
  try {
    const id = claimedTask(root);
    duplicateViaReset(root);
    expect(conflictBody(root).error_type).toBe("conflict");

    // Removing the stale copy alone unblocks the very next command...
    await rm(join(root, ".quest", "tasks", `${id}.json`));
    const unblocked = quest(root, ["task", "view", id, "--json"]);
    expect(unblocked.exitCode).toBe(0);
    expect(
      (JSON.parse(unblocked.stdout) as { data: { status: string } }).data
        .status,
    ).toBe("Done");

    // ...and the control the hint's second half is about: with the move still
    // unlanded, the next restoring operation recreates the duplicate.
    expect(git(root, ["reset", "--hard", "-q"]).exitCode).toBe(0);
    expect(conflictBody(root).error_type).toBe("conflict");

    // The recovery executed verbatim: remove the stale copy AND land the move
    // by committing both sides of the rename.
    await rm(join(root, ".quest", "tasks", `${id}.json`));
    expect(git(root, ["add", "-A", ".quest/"]).exitCode).toBe(0);
    const staged = git(root, ["diff", "--cached", "--name-status"]).stdout;
    expect(staged).toContain(`A\t.quest/completed/${id}.json`);
    expect(staged).toContain(`D\t.quest/tasks/${id}.json`);
    expect(git(root, ["commit", "-qm", "land the move"]).exitCode).toBe(0);

    // Landed: a further restoring operation must NOT recreate it.
    expect(git(root, ["reset", "--hard", "-q"]).exitCode).toBe(0);
    expect(git(root, ["status", "--porcelain"]).stdout.trim()).toBe("");
    const view = quest(root, ["task", "view", id, "--json"]);
    expect(view.exitCode).toBe(0);
    expect(
      (JSON.parse(view.stdout) as { data: { status: string } }).data.status,
    ).toBe("Done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a plain switch carries the uncommitted move; only a discarding operation duplicates it (QCLI-424)", async () => {
  const root = await workspace();
  try {
    const id = claimedTask(root);
    const primary = git(root, ["branch", "--show-current"]).stdout.trim();
    expect(git(root, ["branch", "other"]).exitCode).toBe(0);
    expect(
      quest(root, ["task", "complete", id, ...HUMAN, "--json"]).exitCode,
    ).toBe(0);

    // A plain switch carries the unstaged deletion and the untracked addition
    // together, so the tree stays consistent and the record is found under
    // completed/ -- no duplicate, no conflict.
    expect(git(root, ["switch", "other"]).exitCode).toBe(0);
    expect(git(root, ["status", "--porcelain"]).stdout).toContain(
      `D .quest/tasks/${id}.json`,
    );
    const consistent = quest(root, ["task", "view", id, "--json"]);
    expect(consistent.exitCode).toBe(0);
    expect(
      (JSON.parse(consistent.stdout) as { data: { status: string } }).data
        .status,
    ).toBe("Done");

    // The force switch back is the discarding operation: it restores the
    // tracked deletion's file from HEAD while the untracked copy survives.
    expect(git(root, ["switch", "-f", primary]).exitCode).toBe(0);
    expect(conflictBody(root).error_type).toBe("conflict");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("the restore-shape duplicate names its shape in one hint sentence, prose only (QCLI-429, DEC-92 A)", async () => {
  const root = await workspace();
  try {
    claimedTask(root);
    duplicateViaReset(root);
    const body = conflictBody(root);
    expect(body.hint).toContain("Detected shape for T-1");
    expect(body.hint).toContain("this is cause (2)");
    // Prose only, per DEC-92 A: the envelope gains NO field.
    expect(Object.keys(body).sort()).toEqual(
      ["error_type", "hint", "input", "message", "principal"].sort(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a duplicate that is not the restore shape gets no shape sentence (QCLI-429)", async () => {
  const root = await workspace();
  try {
    const id = claimedTask(root);
    // Land the move fully, then recreate the pre-move copy as an UNTRACKED
    // file. The duplicate now has no pre-move copy at HEAD, so the shape
    // sentence must stay absent: the hint is exactly today's.
    expect(
      quest(root, ["task", "complete", id, ...HUMAN, "--json"]).exitCode,
    ).toBe(0);
    expect(git(root, ["add", "-A", ".quest/"]).exitCode).toBe(0);
    expect(git(root, ["commit", "-qm", "land the move"]).exitCode).toBe(0);
    const old = git(root, ["show", `HEAD~1:.quest/tasks/${id}.json`]).stdout;
    await Bun.write(join(root, ".quest", "tasks", `${id}.json`), old);
    const body = conflictBody(root);
    expect(body.error_type).toBe("conflict");
    expect(body.hint).not.toContain("Detected shape");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
