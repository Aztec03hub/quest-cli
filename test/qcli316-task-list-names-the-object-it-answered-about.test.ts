import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commandHelp } from "../src/application/command-help.ts";

/**
 * QCLI-316 / DEC-6. `quest task list --status "In Progress"` reads the
 * checked-out ref's `.quest/` and nothing else, while the rule that sends a
 * session to it -- check nothing is still open before reporting clear -- asks
 * about the REPOSITORY. The two diverge for exactly the tasks most likely to
 * be forgotten, the ones still on an unmerged branch, and the failure
 * direction is the bad one: AN EMPTY LIST READS AS THE CHECK PASSING RATHER
 * THAN AS THE CHECK NOT RUNNING.
 *
 * Reported by opum-doc, who ran it on `dev` right after a merge and got an
 * empty list while one of their own tasks was In Progress with an open PR.
 * They caught it only because an independent source disagreed with the empty
 * list -- which is the detection lesson, since neither the exit code nor the
 * output would ever have shown it.
 *
 * THE NOTICE IS A SET DIFFERENCE, NOT A COUNT. The naive version printed every
 * task record on every other ref -- 122 lines in their repository, ~4,500
 * across 20 refs here -- essentially all of which the current ref already
 * held. A notice that fires constantly is tuned out by its second appearance.
 * After the difference: one line for them, ZERO here. Its APPEARANCE is the
 * signal, so the tests below pin BOTH halves -- it fires when it must, and it
 * is quiet when it must be. Proving only the quiet half would ship a notice
 * indistinguishable from one that never fires, which is the trap this suite
 * exists to avoid elsewhere too.
 */

const RUN = (cwd: string, args: readonly string[]) =>
  Bun.spawnSync(
    [
      process.execPath,
      "run",
      join(import.meta.dir, "../src/cli/main.ts"),
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );

function git(cwd: string, ...args: readonly string[]) {
  const child = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${child.stderr.toString()}`);
  return child.stdout.toString().trim();
}

const ACTOR = ["--actor", "t", "--actor-kind", "human", "--json"] as const;

function envelope(cwd: string, args: readonly string[]) {
  // `--json` is appended here rather than at each call site: off a TTY the CLI
  // auto-selects the human renderer, so a listing helper that forgets it parses
  // "(empty)" as JSON and fails with a syntax error that looks like a CLI bug.
  const result = RUN(cwd, [...args, "--json"]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

/** dev holds T-1; an unmerged `feature` holds T-2, In Progress. */
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "quest-listing-scope-"));
  git(root, "init", "-q", "-b", "dev", ".");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  RUN(root, ["init", "--name", "Probe", "--task-id-prefix", "T", "--json"]);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  RUN(root, ["task", "create", "on dev", ...ACTOR]);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "T-1");
  return root;
}

function branchOff(root: string) {
  git(root, "checkout", "-q", "-b", "feature");
  RUN(root, ["task", "create", "on the branch only", ...ACTOR]);
  RUN(root, ["task", "edit", "T-2", "--status", "In Progress", ...ACTOR]);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "T-2");
  git(root, "checkout", "-q", "dev");
}

test("a task record on an unmerged branch is NAMED when the listing comes back empty", async () => {
  const root = await repository();
  try {
    branchOff(root);
    const result = envelope(root, ["task", "list", "--status", "In Progress"]);

    // The listing itself is honestly empty -- this branch has nothing In
    // Progress. The defect was never a wrong list; it was an empty one read
    // as an answer about the repository.
    expect(result.data).toEqual([]);
    expect(result.scope.branch).toBe("dev");
    expect(result.scope.otherRefsRead).toBe(true);
    // Exactly the record dev cannot see. Not "3 records exist elsewhere",
    // which is the count the set difference exists to avoid.
    expect(result.scope.unseenTaskIds).toEqual(["T-2"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the notice goes quiet once the branch is merged -- it is not always-on", async () => {
  const root = await repository();
  try {
    branchOff(root);
    git(root, "merge", "-q", "feature", "-m", "merge");
    const result = envelope(root, ["task", "list", "--status", "In Progress"]);
    // Now the answer is HERE, so there is nothing to warn about. A notice
    // proven only in its firing direction would be indistinguishable from one
    // that fires unconditionally, and one that fires unconditionally is one
    // nobody reads by its second appearance.
    expect(result.data.map((task: { id: string }) => task.id)).toEqual(["T-2"]);
    expect(result.scope.branch).toBe("dev");
    expect(result.scope.otherRefsRead).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-empty listing still names the object it answered about", async () => {
  const root = await repository();
  try {
    const result = envelope(root, ["task", "list"]);
    expect(result.data.map((task: { id: string }) => task.id)).toEqual(["T-1"]);
    // The branch is named on EVERY listing -- "which object did this answer
    // about" is a question every result owes an answer to, and it costs one
    // rev-parse. The cross-ref read is what is reserved for the empty case.
    expect(result.scope.branch).toBe("dev");
    expect(result.scope.otherRefsRead).toBe(false);
    expect(result.scope.unseenTaskIds).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The one implementation detail opum-doc flagged as load-bearing and which the
 * tests above cannot reach: THE SUBTRAHEND MUST SPAN `tasks/`, `completed/`
 * AND `archive/tasks/`.
 *
 * A record legitimately sits in `tasks/` on a branch and `completed/` on dev --
 * it was finished and closed after the branch was cut. Comparing only `tasks/`
 * would find the id missing from dev's `tasks/` and report it as an unseen,
 * still-open task: a PHANTOM. In a repository with 80+ completed records that
 * fires on nearly every ref, which is exactly how a silent notice becomes a
 * noisy one and then an ignored one.
 */
test("a task completed here is not a phantom just because a branch still has it in tasks/", async () => {
  const root = await repository();
  try {
    git(root, "checkout", "-q", "-b", "feature");
    git(root, "checkout", "-q", "dev");
    // T-1 moves tasks/ -> completed/ on dev, while `feature` still carries it
    // under tasks/ at the commit it was cut from.
    RUN(root, ["task", "edit", "T-1", "--status", "In Progress", ...ACTOR]);
    RUN(root, ["task", "complete", "T-1", ...ACTOR]);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "T-1 done");

    const result = envelope(root, ["task", "list", "--status", "In Progress"]);
    expect(result.data).toEqual([]);
    expect(result.scope.otherRefsRead).toBe(true);
    // The whole point: T-1 is not missing, it is COMPLETED here. A tasks/-only
    // comparison would name it.
    expect(result.scope.unseenTaskIds).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("`scope` is additive and `principal` stays the last top-level key", async () => {
  const root = await repository();
  try {
    const result = envelope(root, ["task", "list"]);
    // The shared command contract fixes `principal` as the LAST top-level
    // key, and presence and position are separate constraints there -- only
    // presence is obvious, which is why this asserts order rather than
    // membership. A consumer that does not know `scope` reads the same
    // `data` it always did.
    expect(Object.keys(result)).toEqual([
      "schemaVersion",
      "contractVersion",
      "kind",
      "data",
      "scope",
      "principal",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the human rendering says it, not only the JSON", async () => {
  const root = await repository();
  try {
    branchOff(root);
    const plain = RUN(root, [
      "task",
      "list",
      "--status",
      "In Progress",
      "--plain",
    ]).stdout.toString();
    expect(plain).toContain("Answered about branch dev");
    expect(plain).toContain("T-2");
    expect(plain).toContain("not an answer about the repository");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("help states what an empty list is a claim about", () => {
  const summary = commandHelp["task list"]?.summary ?? "";
  expect(summary).toContain("CHECKED-OUT");
  expect(summary).toContain("scope");
  expect(summary).toContain("unseenTaskIds");
  // The detection lesson from the original report: the empty list was caught
  // only because an independent source disagreed with it.
  expect(summary).toContain("gh pr list");
});
