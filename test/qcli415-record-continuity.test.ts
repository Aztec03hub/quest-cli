import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./helpers/spawn.ts";

/**
 * QCLI-415, DEC-18 option A (operator-accepted 2026-09-29): a base-relative
 * record-continuity check, so a commit that DROPS a task record cannot pass a
 * repository green.
 *
 * The measured motivation, from DEC-18's own context: ward-cli b2aad11 staged
 * only the deletion half of `task complete`'s relocation, so dev carried no
 * WCLI-9 record at all -- and the Tracker integrity job was green on it and on
 * the next commit, because that job parses a listing and never asks whether
 * anything went missing. A record may legitimately live in any of three
 * locations and moves between them, so "the file is gone" is not by itself a
 * defect; "the id resolves nowhere" is.
 *
 * Every case below runs against real Git commits in a real workspace, because
 * the check's whole input is a commit graph: the base is a ref, the thing it
 * reads is a tree, and the current store is the worktree. A mocked history
 * would not exercise the part that was wrong in the incident.
 *
 * The two-sided proof (AC2/AC3 of QCLI-415): a deliberate drop goes red and
 * names the id, while every legitimate relocation -- complete, archive, demote
 * -- stays green. A check that only had the red half would fail every opened
 * PR; one that only had the green half would be the status quo that missed
 * WCLI-9.
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
  const root = await mkdtemp(join(tmpdir(), "qcli415-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@example.invalid"], {
    cwd: root,
  }).exited;
  await Bun.spawn(["git", "config", "user.name", "test"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

/** A commit of the tracker state as it stands; the check reads refs, so the
 *  state has to be committed for a base to name it. */
function commit(root: string, message: string): string {
  expect(git(root, ["add", "-A", ".quest/"]).exitCode).toBe(0);
  expect(git(root, ["commit", "-qm", message]).exitCode).toBe(0);
  const sha = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
  return sha;
}

function create(root: string, title: string, extra: readonly string[] = []) {
  const result = quest(root, [
    "task",
    "create",
    title,
    ...extra,
    ...HUMAN,
    "--json",
  ]);
  expect(result.exitCode).toBe(0);
}

const started = (root: string, id: string) =>
  expect(quest(root, ["task", "start", id, ...HUMAN, "--json"]).exitCode).toBe(
    0,
  );

function check(root: string, base: string) {
  const result = quest(root, [
    "check",
    "--continuity",
    "--base",
    base,
    "--json",
  ]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * AC3's green half. Each entry relocates a tracked record between the base
 * commit and the tip; the check must not mistake any of them for a drop.
 * `prepare` runs BEFORE the base commit, so the base always holds the record
 * in the location the relocation moves it out of.
 */
const RELOCATIONS = [
  [
    "complete",
    (root: string) => started(root, "T-1"),
    () => ["task", "complete", "T-1"],
  ],
  ["archive", () => {}, () => ["task", "archive", "T-1"]],
  [
    "demote",
    (root: string) => {
      started(root, "T-1");
      expect(
        quest(root, ["task", "complete", "T-1", ...HUMAN, "--json"]).exitCode,
      ).toBe(0);
    },
    () => ["task", "demote", "T-1", "--to", "To Do"],
  ],
] as const;

for (const [name, prepare, relocate] of RELOCATIONS) {
  test(`task ${name}'s relocation is not a continuity break (QCLI-415)`, async () => {
    const root = await workspace();
    try {
      create(root, "Ship the thing");
      prepare(root);
      const base = commit(root, "base");
      expect(quest(root, [...relocate(), ...HUMAN, "--json"]).exitCode).toBe(0);
      commit(root, name);
      const result = check(root, base);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout).data;
      expect(data.missing).toEqual([]);
      // The record's own id is part of the checked population, so a green
      // result here really did resolve the relocated record -- not a check
      // that read nothing and found nothing missing.
      expect(data.resolved).toBeGreaterThan(0);
      expect(data.references).toBeGreaterThanOrEqual(data.resolved);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
}

test("a deliberately dropped record goes red and names the id (QCLI-415)", async () => {
  const root = await workspace();
  try {
    create(root, "Keep me");
    create(root, "Drop me");
    const base = commit(root, "base");
    // The ward-cli shape: the record is simply gone, and the deletion is
    // committed on its own.
    await rm(join(root, ".quest/tasks/T-2.json"));
    commit(root, "drop T-2");
    const result = check(root, base);
    expect(result.exitCode).toBe(6);
    const diagnostic = JSON.parse(result.stderr);
    expect(diagnostic.error_type).toBe("drift");
    // Named in the message, not only in a structured field: whoever reads a
    // red CI job reads the message.
    expect(diagnostic.message).toContain("T-2");
    expect(diagnostic.input.missing).toEqual(["T-2"]);
    // The surviving record must not be collateral in the report.
    expect(diagnostic.message).not.toContain("T-1");
    expect(diagnostic.input.resolved).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("an id that resolves only through its alias is still continuous (QCLI-415)", async () => {
  const root = await workspace();
  try {
    // The migrated dotted spellings (QCLI-97.11.1) and the backlog: aliases are
    // exactly this shape: an id that resolves through a record's alias rather
    // than as a canonical id, and the check reads the alias list for the same
    // reason resolution does.
    create(root, "Has an alias", ["--alias", "LEGACY-9"]);
    const base = commit(root, "base");
    started(root, "T-1");
    expect(
      quest(root, ["task", "complete", "T-1", ...HUMAN, "--json"]).exitCode,
    ).toBe(0);
    commit(root, "complete");
    const result = check(root, base);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data.missing).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("an alias that stops resolving is reported by name (QCLI-415)", async () => {
  const root = await workspace();
  try {
    create(root, "Has an alias", ["--alias", "LEGACY-9"]);
    const base = commit(root, "base");
    // No command removes an alias today, so the fixture edits the record
    // directly -- the point is the check's read of the alias list, and a
    // hand-edit is the only way to produce this state.
    const path = join(root, ".quest/tasks/T-1.json");
    const record = JSON.parse(await readFile(path, "utf8")) as {
      aliases: string[];
    };
    record.aliases = [];
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
    commit(root, "drop the alias");
    const result = check(root, base);
    expect(result.exitCode).toBe(6);
    const diagnostic = JSON.parse(result.stderr);
    expect(diagnostic.error_type).toBe("drift");
    expect(diagnostic.message).toContain("LEGACY-9");
    expect(diagnostic.input.missing).toEqual(["LEGACY-9"]);
    // The canonical id still resolves; only the alias is gone.
    expect(diagnostic.message).not.toContain("T-1,");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a base with no records is a failure, not a silent clean (QCLI-415)", async () => {
  const root = await workspace();
  try {
    // A commit before the tracker held any task records. Reading zero records
    // cannot be told apart from a wrong --base by its output alone, so the
    // check refuses to pass -- the positive control DEC-18's item asks for.
    expect(git(root, ["add", "-A", ".quest/"]).exitCode).toBe(0);
    expect(git(root, ["commit", "-qm", "workspace only"]).exitCode).toBe(0);
    const base = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    const result = check(root, base);
    expect(result.exitCode).toBe(6);
    const diagnostic = JSON.parse(result.stderr);
    expect(diagnostic.error_type).toBe("validation");
    expect(diagnostic.message).toContain("read 0 task records");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a base ref that does not resolve is not_found (QCLI-415)", async () => {
  const root = await workspace();
  try {
    create(root, "Ship the thing");
    commit(root, "base");
    const result = check(root, "no-such-ref");
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stderr).error_type).toBe("not_found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("the check reads the MERGE BASE, so a branch behind its base is not charged for later ids (QCLI-415)", async () => {
  const root = await workspace();
  try {
    create(root, "On the branch point");
    const branchPoint = commit(root, "branch point");
    // The base line moves on without this branch: a second record is added
    // there, and the branch never had it.
    create(root, "Added later on the base");
    const baseTip = commit(root, "base moved on");
    expect(
      git(root, ["checkout", "-q", "-b", "feature", branchPoint]).exitCode,
    ).toBe(0);
    const result = check(root, baseTip);
    // Reading baseTip directly would demand T-2, which this branch could not
    // have kept; reading the merge base asks only about T-1.
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).data.missing).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
