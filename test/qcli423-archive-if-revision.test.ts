import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * QCLI-423. `task archive` took no `--if-revision`, so the operator-request
 * helper's guarded edit followed by an archive (OPAG-799 F1) still had an
 * unguarded window: a record changing between the two steps was archived
 * anyway. These tests pin the added precondition -- the same per-record
 * revision `task view --json` emits and `task edit --if-revision` compares
 * against -- and that a stale value refuses as a conflict (exit 5) without
 * moving the record, distinguishable from usage (exit 2) and validation
 * (exit 6) errors.
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
  const root = await mkdtemp(join(tmpdir(), "qcli423-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  await Bun.spawn(["git", "config", "user.email", "test@example.invalid"], {
    cwd: root,
  }).exited;
  await Bun.spawn(["git", "config", "user.name", "test"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

function createdTask(root: string, title: string, id: string) {
  const created = quest(root, [
    "task",
    "create",
    title,
    "--id",
    id,
    ...HUMAN,
    "--json",
  ]);
  expect(created.exitCode).toBe(0);
  return id;
}

const revisionOf = (root: string, id: string) =>
  JSON.parse(quest(root, ["task", "view", id, "--json"]).stdout).data
    .revision as string;

const exists = (root: string, path: string) =>
  Bun.file(join(root, ".quest", path)).exists();

test("archiving with the current revision proceeds as today and relocates the record (QCLI-423 AC1)", async () => {
  const root = await workspace();
  try {
    const id = createdTask(root, "Ship the thing", "T-1");
    const revision = revisionOf(root, id);
    const archived = quest(root, [
      "task",
      "archive",
      id,
      "--if-revision",
      revision,
      ...HUMAN,
      "--json",
    ]);
    expect(archived.exitCode).toBe(0);
    expect(archived.stderr).toBe("");
    const envelope = JSON.parse(archived.stdout) as {
      kind: string;
      data: { id: string };
    };
    expect(envelope.kind).toBe("task.archived");
    expect(envelope.data.id).toBe(id);
    // The record moved, and only to the archive.
    expect(await exists(root, `archive/tasks/${id}.json`)).toBe(true);
    expect(await exists(root, `tasks/${id}.json`)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a stale revision refuses the archive as a conflict and moves nothing (QCLI-423 AC2)", async () => {
  const root = await workspace();
  try {
    const id = createdTask(root, "Ship the thing", "T-1");
    const current = revisionOf(root, id);
    const SENTINEL = "SENTINEL-qcli423-stale";
    const refused = quest(root, [
      "task",
      "archive",
      id,
      "--if-revision",
      SENTINEL,
      ...HUMAN,
      "--json",
    ]);
    expect(refused.exitCode).toBe(5);
    expect(refused.stdout).toBe("");
    const body = JSON.parse(refused.stderr) as {
      error_type: string;
      message: string;
      input?: { sentRevision?: string; actualRevision?: string };
    };
    expect(body.error_type).toBe("conflict");
    expect(body.message).toContain("does not match the record's current");
    // The QCLI-425 echo: both values, so no argv reconstruction.
    expect(body.input?.sentRevision).toBe(SENTINEL);
    expect(body.input?.actualRevision).toBe(current);
    // Nothing moved: still under tasks/, absent from the archive.
    expect(await exists(root, `tasks/${id}.json`)).toBe(true);
    expect(await exists(root, `archive/tasks/${id}.json`)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("one captured revision value works for edit and archive alike (QCLI-423 AC3)", async () => {
  const root = await workspace();
  try {
    const id = createdTask(root, "Ship the thing", "T-1");
    // Captured once, used first on edit and then -- after a fresh capture,
    // since the edit moved the revision -- on archive.
    const beforeEdit = revisionOf(root, id);
    const edited = quest(root, [
      "task",
      "edit",
      id,
      "--add-note",
      "guarded",
      "--if-revision",
      beforeEdit,
      ...HUMAN,
      "--json",
    ]);
    expect(edited.exitCode).toBe(0);
    const afterEdit = revisionOf(root, id);
    expect(afterEdit).not.toBe(beforeEdit);
    const archived = quest(root, [
      "task",
      "archive",
      id,
      "--if-revision",
      afterEdit,
      ...HUMAN,
      "--json",
    ]);
    expect(archived.exitCode).toBe(0);

    // The negative direction on a second record: a revision that an edit has
    // invalidated is stale for archive too, and the conflict names the SAME
    // per-record series edit compares against.
    const other = createdTask(root, "Other thing", "T-2");
    const beforeOtherEdit = revisionOf(root, other);
    expect(
      quest(root, [
        "task",
        "edit",
        other,
        "--add-note",
        "moved on",
        ...HUMAN,
        "--json",
      ]).exitCode,
    ).toBe(0);
    const afterOtherEdit = revisionOf(root, other);
    const refused = quest(root, [
      "task",
      "archive",
      other,
      "--if-revision",
      beforeOtherEdit,
      ...HUMAN,
      "--json",
    ]);
    expect(refused.exitCode).toBe(5);
    const body = JSON.parse(refused.stderr) as {
      input?: { sentRevision?: string; actualRevision?: string };
    };
    expect(body.input?.sentRevision).toBe(beforeOtherEdit);
    expect(body.input?.actualRevision).toBe(afterOtherEdit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("the guard's exit 5 is distinct from usage (2) and validation (6) (QCLI-423 AC2)", async () => {
  const root = await workspace();
  try {
    const id = createdTask(root, "Ship the thing", "T-1");
    // Usage: an unknown flag is exit 2.
    const unknown = quest(root, [
      "task",
      "archive",
      id,
      "--bogus",
      "x",
      ...HUMAN,
      "--json",
    ]);
    expect(unknown.exitCode).toBe(2);
    // Validation: archiving an already-archived record is exit 6.
    expect(
      quest(root, ["task", "archive", id, ...HUMAN, "--json"]).exitCode,
    ).toBe(0);
    const again = quest(root, ["task", "archive", id, ...HUMAN, "--json"]);
    expect(again.exitCode).toBe(6);
    expect((JSON.parse(again.stderr) as { message: string }).message).toContain(
      "already_at_destination",
    );
    // Conflict: a stale guarded value is exit 5 (same record, guard first).
    const stale = quest(root, [
      "task",
      "archive",
      id,
      "--if-revision",
      "SENTINEL",
      ...HUMAN,
      "--json",
    ]);
    expect(stale.exitCode).toBe(5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("help and the machine registry document the flag (QCLI-423 AC4)", async () => {
  const root = await workspace();
  try {
    const help = quest(root, ["help", "task", "archive"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--if-revision <revision>");
    expect(help.stdout).toContain("--if-revision");
    const manifest = JSON.parse(quest(root, ["manifest", "--json"]).stdout) as {
      data: {
        commands: {
          name: string;
          parameters: { flags: Record<string, { value: string }> };
        }[];
      };
    };
    const entry = manifest.data.commands.find(
      (command) => command.name === "task archive",
    );
    expect(entry).toBeDefined();
    expect(Object.keys(entry?.parameters.flags ?? {})).toContain(
      "--if-revision",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
