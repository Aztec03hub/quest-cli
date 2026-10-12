import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * QCLI-290. QCLI-279 made ONE of three id allocators refs-aware and
 * deliberately left the other two alone pending a real reproduction. That
 * reproduction arrived on 2026-09-14: two sessions independently minted
 * `DEC-3` from branches neither of which carried the other's record.
 *
 * These tests reproduce the two trigger shapes -- an unmerged sibling
 * branch, and a detached HEAD behind a branch that has since moved --
 * against real processes and a real Git repository, for each of the three
 * remaining id families. A deliberately constructed collision is the right
 * instrument here rather than the live incident, which is not reproducible
 * on demand; that is the choice QCLI-279's own suite made.
 *
 * Two of them exist for reasons no draft-side test can cover, because
 * milestones and decisions share one `.quest/planning.json` where tasks and
 * drafts get a file each:
 *
 *   - "does not advance the milestone counter" pins the prefix filter. Both
 *     families live in the same document, so a scan that took the maximum of
 *     everything it read would let `DEC-9` mint `M-10`.
 *   - "a corrupt planning.json on one ref" pins the GRANULARITY of the
 *     degradation. Three refs, one of them unparseable: the answer is only
 *     right if the scan skips that ref and still reads the others. A guard
 *     coarse enough to abandon the whole scan on the first parse failure
 *     falls back to the local-only view, which is the un-fixed behavior --
 *     so an assertion that merely required "sequential" would have passed
 *     against the bug. It asserts the exact id instead.
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
  const root = await mkdtemp(join(tmpdir(), "qcli290-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "t@t"]);
  git(root, ["config", "user.name", "t"]);
  quest(root, ["init"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "base"]);
  return root;
}

/** Creates one record of the given family and returns its allocated id. */
function create(
  workspace: string,
  family: "draft" | "milestone" | "decision",
  title: string,
): { id: string } {
  const result = quest(workspace, [
    family,
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

function commit(workspace: string, message: string) {
  git(workspace, ["add", "-A"]);
  git(workspace, ["commit", "-q", "-m", message]);
}

function sequenceOf(id: string): number {
  const match = /-(\d+)$/.exec(id);
  if (!match) throw new Error(`Not a canonical id: ${id}`);
  return Number(match[1]);
}

for (const family of ["draft", "milestone", "decision"] as const) {
  test(`${family} create does not reallocate an id that exists only on an unmerged sibling branch (QCLI-290)`, async () => {
    const root = await gitWorkspace();
    try {
      git(root, ["checkout", "-q", "-b", "feature-x"]);
      const onFeature = create(root, family, "Feature-branch record");
      commit(root, "feature record");

      // main never merged feature-x, so its working tree has no record of
      // this family at all -- the bug allocated from that empty local view
      // and handed back the id feature-x had already used.
      git(root, ["checkout", "-q", "main"]);
      const onMain = create(root, family, "Main-branch record");

      expect(onMain.id).not.toBe(onFeature.id);
      expect(sequenceOf(onMain.id)).toBeGreaterThan(sequenceOf(onFeature.id));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test(`${family} create from a detached HEAD behind a branch that has since moved does not reallocate the branch's newer id (QCLI-290)`, async () => {
    const root = await gitWorkspace();
    try {
      const first = create(root, family, "First record");
      commit(root, "first record");
      const stale = git(root, ["rev-parse", "HEAD"]).stdout;

      const second = create(root, family, "Second record");
      commit(root, "second record");
      expect(sequenceOf(second.id)).toBeGreaterThan(sequenceOf(first.id));

      // Detached at the commit before "second" existed. This tree has never
      // seen it; main, still a real ref, has moved past it.
      git(root, ["checkout", "-q", stale]);
      const detached = create(root, family, "Detached record");

      expect(detached.id).not.toBe(second.id);
      expect(sequenceOf(detached.id)).toBeGreaterThan(sequenceOf(second.id));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
}

test("a decision on a sibling branch does not advance the milestone counter, though both live in the same planning.json (QCLI-290)", async () => {
  const root = await gitWorkspace();
  try {
    git(root, ["checkout", "-q", "-b", "feature-x"]);
    // Nine decisions and no milestone: a scan that took the maximum of every
    // id it read out of planning.json, rather than filtering by prefix,
    // would carry 9 across and mint M-10 on main.
    let last = "";
    for (let index = 0; index < 9; index += 1)
      last = create(root, "decision", `Decision ${index}`).id;
    expect(last).toBe("DEC-9");
    commit(root, "nine decisions");

    git(root, ["checkout", "-q", "main"]);
    const milestone = create(root, "milestone", "First milestone");

    expect(milestone.id).toBe("M-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a corrupt planning.json on one ref does not suppress a higher id on another (QCLI-290)", async () => {
  const root = await gitWorkspace();
  try {
    create(root, "decision", "First decision");
    commit(root, "first decision");

    // A sibling that legitimately carries a higher id.
    git(root, ["checkout", "-q", "-b", "higher"]);
    let highest = "";
    for (let index = 0; index < 4; index += 1)
      highest = create(root, "decision", `Higher decision ${index}`).id;
    expect(highest).toBe("DEC-5");
    commit(root, "four more decisions");

    // And a sibling whose planning document cannot be parsed at all.
    git(root, ["checkout", "-q", "main"]);
    git(root, ["checkout", "-q", "-b", "broken"]);
    await writeFile(join(root, ".quest", "planning.json"), "{not json", "utf8");
    commit(root, "corrupt planning document");

    git(root, ["checkout", "-q", "main"]);
    const next = create(root, "decision", "Next decision");

    // DEC-6 requires BOTH halves: skipping the corrupt ref, and still
    // reading the good one. A guard coarse enough to abandon the whole scan
    // on the first parse failure degrades to the local-only view and mints
    // DEC-2 -- which is the un-fixed behavior wearing a passing test.
    expect(next.id).toBe("DEC-6");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("draft and planning ids still allocate sequentially in a plain, non-Git task store (QCLI-290)", async () => {
  const store = await mkdtemp(join(tmpdir(), "qcli290-plain-"));
  const previous = process.env.QUEST_TASK_STORE;
  process.env.QUEST_TASK_STORE = store;
  try {
    for (const family of ["draft", "milestone", "decision"] as const) {
      const first = create(store, family, `First plain ${family}`);
      const second = create(store, family, `Second plain ${family}`);
      expect(sequenceOf(second.id)).toBe(sequenceOf(first.id) + 1);
    }
  } finally {
    if (previous === undefined) delete process.env.QUEST_TASK_STORE;
    else process.env.QUEST_TASK_STORE = previous;
    await rm(store, { recursive: true, force: true });
  }
}, 60_000);
