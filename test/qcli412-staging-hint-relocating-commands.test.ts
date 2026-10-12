import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * QCLI-412 (filed under QCLI-311's slice, ruled execution 2026-09-29): four
 * commands relocate a record -- `complete`, `close` and `archive` out of
 * .quest/tasks/, and `demote` back into it -- and QCLI-311's staging hint
 * covered only `complete`. Three destinations are involved, so a hint that
 * assumed .quest/completed/ would name the wrong path for `archive` and for
 * `demote` while looking entirely correct for the two that share it.
 *
 * The destination in the hint is read from the mutation's own `relocatedTo`,
 * never from a command-to-directory table in the CLI, and `demote` relocates
 * ONLY when the record was stored outside `tasks` -- so the conditional case
 * is the one a table would also get wrong. Each assertion below is paired
 * with the file's real location on disk: a hint naming a path the command did
 * not use would be worse than no hint, which is QCLI-311's own argument.
 *
 * Like QCLI-311, this is human surface only. The JSON envelope is unchanged
 * for every command touched, and its two positional constraints --
 * contractVersion at index 1, principal last -- are asserted per command
 * because a field added for a hint would move both.
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

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli412-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@example.invalid"], {
    cwd: root,
  }).exited;
  await Bun.spawn(["git", "config", "user.name", "test"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

/** A workspace holding one task at the given point in its life. */
async function withTask(via: (root: string, id: string) => void) {
  const root = await workspace();
  quest(root, ["task", "create", "Ship the thing", ...HUMAN, "--json"]);
  const id = "T-1";
  via(root, id);
  return root;
}

const started = (root: string, id: string) => {
  expect(quest(root, ["task", "start", id, ...HUMAN, "--json"]).exitCode).toBe(
    0,
  );
};
const done = (root: string, id: string) => {
  started(root, id);
  expect(
    quest(root, ["task", "complete", id, ...HUMAN, "--json"]).exitCode,
  ).toBe(0);
};

/** [name, argv builder, where the record must end up, the state it starts in] */
const RELOCATING = [
  ["complete", (id: string) => ["task", "complete", id], "completed", started],
  [
    "close",
    (id: string) => ["task", "close", id, "--resolution", "wont-do"],
    "completed",
    () => {},
  ],
  [
    "archive",
    (id: string) => ["task", "archive", id],
    "archive/tasks",
    () => {},
  ],
  [
    "demote",
    (id: string) => ["task", "demote", id, "--to", "To Do"],
    "tasks",
    done,
  ],
] as const;

for (const [name, argv, location, prepare] of RELOCATING) {
  test(`task ${name} names the destination it actually used (QCLI-412)`, async () => {
    const root = await withTask(prepare);
    try {
      const id = "T-1";
      const result = quest(root, [...argv(id), ...HUMAN, "--plain"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        `the record moved to .quest/${location}/${id}.json`,
      );
      expect(result.stdout).toContain("git add -A .quest/");
      // The hint is only worth printing if it describes what happened.
      expect(existsSync(join(root, `.quest/${location}/${id}.json`))).toBe(
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  test(`task ${name} keeps its JSON envelope unchanged (QCLI-412)`, async () => {
    const root = await withTask(prepare);
    try {
      const id = "T-1";
      const result = quest(root, [...argv(id), ...HUMAN, "--json"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("git add");
      expect(result.stderr).toBe("");
      expect(Object.keys(JSON.parse(result.stdout) as object)).toEqual([
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
}

test("a demote that does not relocate prints no staging hint (QCLI-412)", async () => {
  // The conditional case: the record is already at .quest/tasks/, so demote
  // is a status write with no rename behind it. Printing the hint here would
  // tell the caller to stage a move that never happened.
  const root = await withTask(started);
  try {
    const result = quest(root, [
      "task",
      "demote",
      "T-1",
      "--to",
      "To Do",
      ...HUMAN,
      "--plain",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("the record moved to");
    expect(result.stdout).not.toContain("git add");
    expect(existsSync(join(root, ".quest/tasks/T-1.json"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("the hint names the destination, not the command's usual one (QCLI-412)", async () => {
  // Directly targets the defect a hardcoded .quest/completed/ would produce:
  // two relocating commands share that destination and the other two do not.
  const root = await withTask(() => {});
  try {
    const archived = quest(root, [
      "task",
      "archive",
      "T-1",
      ...HUMAN,
      "--plain",
    ]);
    expect(archived.exitCode).toBe(0);
    expect(archived.stdout).toContain(".quest/archive/tasks/T-1.json");
    expect(archived.stdout).not.toContain(".quest/completed/");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
