import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * QCLI-279. `task create`'s id allocator used to compute "next available"
 * purely from the checked-out tree's own `.quest/tasks` (plus `completed`
 * and `archive/tasks`). Reproduced three times on this task's own filing:
 * once as a race between two branches neither of which had merged the
 * other's task record, and twice more from a detached HEAD sitting behind
 * a branch that had since moved -- both hide a higher id the working tree
 * has never seen, and the allocator then silently mints a duplicate.
 *
 * The fix scans every local ref (branches and remote-tracking refs) for the
 * same three subdirectories and takes the true global maximum, not just the
 * checked-out tree's. These two tests reproduce the two trigger shapes
 * directly against the real CLI binary and a real Git repository; a third
 * confirms the fix degrades to exactly today's behavior when there is no
 * Git repository to consult at all.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;

function quest(workspace: string, args: readonly string[]) {
  const child = Bun.spawnSync([process.execPath, MAIN, ...args], {
    cwd: workspace,
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode ?? 0,
    stdout: child.stdout ? child.stdout.toString() : "",
    stderr: child.stderr ? child.stderr.toString() : "",
  };
}

function git(workspace: string, args: readonly string[]) {
  const child = Bun.spawnSync(["git", ...args], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode ?? 0,
    stdout: child.stdout ? child.stdout.toString().trim() : "",
    stderr: child.stderr ? child.stderr.toString() : "",
  };
}

async function gitWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli279-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  quest(root, ["init"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  return root;
}

function createTask(workspace: string, title: string): { id: string } {
  const result = quest(workspace, [
    "task",
    "create",
    title,
    "--actor",
    "tester",
    "--actor-kind",
    "human",
    "--json",
  ]);
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
    exitCode: 0,
    stderr: "",
  });
  return JSON.parse(result.stdout).data as { id: string };
}

function sequenceOf(id: string): number {
  const match = /-(\d+)$/.exec(id);
  if (!match) throw new Error(`Not a canonical id: ${id}`);
  return Number(match[1]);
}

test("task create does not reallocate an id that exists only on an unmerged sibling branch (QCLI-279)", async () => {
  const root = await gitWorkspace();
  try {
    git(root, ["checkout", "-q", "-b", "feature-x"]);
    const onFeature = createTask(root, "Feature-branch task");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "feature task"]);

    // Back to main, which never merged feature-x. main's own working tree
    // carries no task records at all -- the bug allocated purely from that
    // empty local view and handed back the id feature-x already used.
    git(root, ["checkout", "-q", "main"]);
    const onMain = createTask(root, "Main-branch task");

    expect(onMain.id).not.toBe(onFeature.id);
    expect(sequenceOf(onMain.id)).toBeGreaterThan(sequenceOf(onFeature.id));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("task create from a detached HEAD behind a branch that has since moved does not reallocate the branch's newer id (QCLI-279)", async () => {
  const root = await gitWorkspace();
  try {
    const first = createTask(root, "First task");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "first task"]);
    const stale = git(root, ["rev-parse", "HEAD"]).stdout;

    const second = createTask(root, "Second task");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "second task"]);
    expect(sequenceOf(second.id)).toBeGreaterThan(sequenceOf(first.id));

    // Detach at the commit before "second" existed -- the working tree here
    // has never seen it, but main (still a real ref) has moved past it.
    git(root, ["checkout", "-q", stale]);
    const detached = createTask(root, "Detached task");

    expect(detached.id).not.toBe(second.id);
    expect(sequenceOf(detached.id)).toBeGreaterThan(sequenceOf(second.id));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("task create still allocates sequential ids in a plain, non-Git task store (QCLI-279)", async () => {
  const store = await mkdtemp(join(tmpdir(), "qcli279-plain-"));
  const previous = process.env.QUEST_TASK_STORE;
  process.env.QUEST_TASK_STORE = store;
  try {
    const first = createTask(store, "First plain task");
    const second = createTask(store, "Second plain task");
    expect(sequenceOf(second.id)).toBe(sequenceOf(first.id) + 1);
  } finally {
    if (previous === undefined) delete process.env.QUEST_TASK_STORE;
    else process.env.QUEST_TASK_STORE = previous;
    await rm(store, { recursive: true, force: true });
  }
}, 60_000);
