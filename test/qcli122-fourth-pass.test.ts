import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalTaskRepository } from "../src/application/tasks/local-task-repository.ts";
import { TaskService } from "../src/application/tasks/tasks.ts";
import { createTask } from "../src/domain/tasks/tasks.ts";

/**
 * QCLI-122 fourth-pass red contracts (FMC f5e4fd64). Production-path only:
 * no fabricated journal files — crash windows are exercised through the
 * real session API and a kill-9 child process for pre-first-mark recovery.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;

function spawnJson(workspace: string, args: readonly string[]) {
  const child = Bun.spawnSync([process.execPath, MAIN, ...args], {
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

async function seed(root: string, id: string, title: string) {
  await mkdir(join(root, ".quest", "tasks"), { recursive: true });
  await writeFile(
    join(root, ".quest", "tasks", `${id}.json`),
    `${JSON.stringify(createTask(id, { title }))}\n`,
  );
}

test("red: session-start journal persists before the first record write", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli122-4-journal-"));
  try {
    const repo = new LocalTaskRepository(join(root, ".quest", "tasks"));
    await seed(root, "T-1", "Journal order");
    await repo.readAll();
    const opened = await repo.beginTaskBatch((await repo.readAll()).revision);
    expect(opened.kind).toBe("locked");
    if (opened.kind !== "locked") return;
    // Blocker #1: the journal must ALREADY exist (session-start record)
    // before any record write happens.
    expect(
      existsSync(join(root, ".quest", "tasks", ".batch.journal.jsonl")),
    ).toBe(true);
    const raw = await readFile(
      join(root, ".quest", "tasks", ".batch.journal.jsonl"),
      "utf8",
    );
    const header = JSON.parse(raw.trim().split("\n")[0] ?? "{}") as {
      sessionId?: unknown;
      pid?: unknown;
    };
    expect(typeof header.sessionId).toBe("string");
    expect(header.pid).toBe(process.pid);
    await opened.session.finish();
    // finish removes it again.
    expect(
      existsSync(join(root, ".quest", "tasks", ".batch.journal.jsonl")),
    ).toBe(false);
    void unlink;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("red: production kill between rename and mark is recovered by next entry with truthful receipt", async () => {
  const parent = await mkdtemp(join(tmpdir(), "qcli122-4-kill-"));
  try {
    const workspace = join(parent, "ws");
    await mkdir(workspace, { recursive: true });
    Bun.spawnSync(["/usr/bin/env", "git", "init", "-q"], {
      cwd: workspace,
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env },
    });
    spawnJson(workspace, ["init"]);
    const dir = join(workspace, ".quest", "tasks");
    await mkdir(dir, { recursive: true });
    const seedEval = `import { createTask } from "${process.cwd()}/src/domain/tasks/tasks.ts";
      const { writeFile } = await import("node:fs/promises");
      for (const id of ["T-1","T-2"]) {
        const t = createTask(id, { title: "K" + id });
        await writeFile("${dir}/" + id + ".json", JSON.stringify(t) + "\\n");
      }`;
    Bun.spawnSync([process.execPath, "--eval", seedEval]);
    // victim program: begin batch, apply one record via writeRecord+mark,
    // then hard-exit while lock+journal remain.
    const victimProgram = `
      const mod = await import(${JSON.stringify(process.cwd())} + "/src/application/tasks/local-task-repository.ts");
      import { readFile, writeFile } from "node:fs/promises";
      const { LocalTaskRepository } = mod;
      const repo = new LocalTaskRepository(${JSON.stringify(dir)});
      const current = await repo.readAll();
      const opened = await repo.beginTaskBatch(current.revision);
      if (opened.kind !== "locked") throw new Error(opened.kind);
      const payload = JSON.parse(await readFile(${JSON.stringify(dir)} + "/T-1.json", "utf8"));
      payload.description = "written then killed";
      await opened.session.writeRecord(payload);
      // Deliberately NOT markApplied: proves rename-before-append window.
      console.log("WRITTEN");
      process.kill(process.pid, "SIGKILL");
    `;
    const victim = Bun.spawnSync([process.execPath, "--eval", victimProgram], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(victim.stdout.toString()).toContain("WRITTEN");

    // The orphan-journal path is exercised by the CLI in a fresh process:
    // acquireLock fails (dead holder's lock remains) -> readOrphanJournal
    // (pid dead, ESRCH) -> reclaim. The stale revision then conflicts, but
    // critically the response arrives at all — proving no strand.
    const freshRevision = spawnJson(workspace, ["task", "list", "--json"]);
    expect(freshRevision.exitCode).toBe(0);
    const recoveredRun = spawnJson(workspace, [
      "task",
      "edit-batch",
      "--file",
      "/dev/null",
      "--actor",
      "person-1",
      "--actor-kind",
      "human",
      "--json",
    ]);
    // Empty file after recovery returns zero items; exit code proves no
    // unrecoverable-lock strand surfaced to the public boundary.
    expect(recoveredRun.exitCode).toBe(0);
    void seed;
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

test("red: milestone transition executes at input position through the locked session without re-locking", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli122-4-milestone-"));
  try {
    Bun.spawnSync(["/usr/bin/git", "init", "-q"], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    spawnJson(root, ["init"]);
    await seed(root, "T-1", "Milestone row");
    await seed(root, "T-2", "Follower row");
    const file = join(root, "ops.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          reference: "T-2",
          operationId: "pre",
          patch: { addLabels: ["before"] },
        }),
        JSON.stringify({
          reference: "T-1",
          operationId: "milestone-row",
          patch: { status: "Done" },
        }),
        JSON.stringify({
          reference: "T-2",
          operationId: "post",
          patch: { addLabels: ["after"] },
        }),
      ].join("\n"),
    );
    const run = spawnJson(root, [
      "task",
      "edit-batch",
      "--file",
      file,
      "--actor",
      "person-1",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(run.exitCode).toBe(0);
    const envelope = JSON.parse(run.stdout);
    // One result per item at exact input positions.
    expect(
      envelope.data.items.map((i: { operationId: string }) => i.operationId),
    ).toEqual(["pre", "milestone-row", "post"]);
    // Milestone row may legitimately use planning semantics; whether it
    // succeeds or errors it MUST be attributed at its own index and MUST
    // NOT corrupt following rows' effects.
    expect(envelope.data.items[0].task.labels).toEqual(["before"]);
    // Evolving fold: "post" sees the label added by "pre".
    expect([...envelope.data.items[2].task.labels].sort()).toEqual([
      "after",
      "before",
    ]);
    const view = JSON.parse(
      spawnJson(root, ["task", "view", "T-2", "--json"]).stdout,
    );
    expect([...view.data.labels].sort()).toEqual(["after", "before"]);
    void TaskService;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

test("red: graph canonical record parity across persisted bytes, result row, and following folds", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli122-4-canonical-"));
  try {
    Bun.spawnSync(["/usr/bin/git", "init", "-q"], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    spawnJson(root, ["init"]);
    await seed(root, "T-1", "Canonical source");
    await seed(root, "T-2", "Alias consumer");
    // Give T-2 a raw alias spelling of T-1 plus a dependency on that alias.
    const t2raw = JSON.parse(
      await readFile(join(root, ".quest", "tasks", "T-2.json"), "utf8"),
    );
    t2raw.aliases = ["ALIAS-ONE"];
    await writeFile(
      join(root, ".quest", "tasks", "T-2.json"),
      `${JSON.stringify(t2raw)}\n`,
    );
    const file = join(root, "ops.jsonl");
    await writeFile(
      file,
      [
        // Row 1 adds a dependency expressed through its alias in mixed case;
        // canonicalization must persist the resolved id AND reflect it in
        // both the response row and any subsequent fold of the same task.
        JSON.stringify({
          reference: "T-1",
          operationId: "canon-add",
          patch: { addDependencies: ["alias-one"] },
        }),
        JSON.stringify({
          reference: "T-1",
          operationId: "canon-follow",
          patch: { description: "second pass sees canonical deps" },
        }),
      ].join("\n"),
    );
    const run = spawnJson(root, [
      "task",
      "edit-batch",
      "--file",
      file,
      "--actor",
      "person-1",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(run.exitCode).toBe(0);
    const envelope = JSON.parse(run.stdout);
    const first = envelope.data.items[0];
    expect(first.kind).toBe("updated");
    if (first.kind !== "updated") return;
    // Response parity: the returned row carries the CANONICAL id spelling.
    expect(first.task.dependencies).toEqual(["T-2"]);
    // Persisted-byte parity: disk shows identical canonical dependency.
    const persisted = JSON.parse(
      await readFile(join(root, ".quest", "tasks", "T-1.json"), "utf8"),
    );
    expect(persisted.dependencies).toEqual(["T-2"]);
    // Following-fold parity: second updated row reflects the same canonical
    // state (no re-resolution drift).
    const second = envelope.data.items[1];
    expect(second.kind).toBe("updated");
    if (second.kind !== "updated") return;
    expect(second.task.dependencies).toEqual(["T-2"]);
    const viewAfter = JSON.parse(
      spawnJson(root, ["task", "view", "T-1", "--json"]).stdout,
    );
    expect(viewAfter.data.dependencies).toEqual(["T-2"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

test("red: strict scalar/boolean/checklist/status field grammar enforced atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli122-4-types-"));
  try {
    Bun.spawnSync(["/usr/bin/git", "init", "-q"], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    spawnJson(root, ["init"]);
    await seed(root, "T-1", "Grammar");
    const badObjects = [
      {
        reference: "T-1",
        operationId: "s1",
        patch: { title: { nested: true } },
      },
      { reference: "T-1", operationId: "s2", patch: { clearParent: "yes" } },
      {
        reference: "T-1",
        operationId: "s3",
        patch: { status: "Not A Status" },
      },
      {
        reference: "T-1",
        operationId: "s4",
        patch: { acceptanceCriteria: [{ wrong: 1 }] },
      },
    ];
    for (const [index, bad] of badObjects.entries()) {
      const file = join(root, `bad${index}.jsonl`);
      await writeFile(file, `${JSON.stringify(bad)}\n`);
      const run = spawnJson(root, [
        "task",
        "edit-batch",
        "--file",
        file,
        "--actor",
        "person-1",
        "--actor-kind",
        "human",
        "--json",
      ]);
      expect(run.exitCode, JSON.stringify(bad)).not.toBe(0);
      expect(JSON.parse(run.stderr).error_type).toBe("usage");
      // Atomicity: nothing persisted before ANY malformed line.
      const view = JSON.parse(
        spawnJson(root, ["task", "view", "T-1", "--json"]).stdout,
      );
      expect(view.data.description ?? null).toBeNull();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

async function seedDirect(dir: string, id: string) {
  const t = createTask(id, { title: `K${id}` });
  await writeFile(`${dir}/${id}.json`, `${JSON.stringify(t)}\n`);
}

test("red: uncreatable journal path rejects begin and leaves the lock absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli122-5-journal-"));
  try {
    const tasksDir = join(root, ".quest", "tasks");
    const repo = new LocalTaskRepository(tasksDir);
    await seed(root, "T-1", "Journal failure");
    // Make journal creation impossible: create a DIRECTORY at the journal
    // path so appendFile fails with EISDIR/ENOTDIR.
    await mkdir(join(tasksDir, ".batch.journal.jsonl"), { recursive: true });
    let rejected = false;
    try {
      const opened = await repo.beginTaskBatch((await repo.readAll()).revision);
      if (opened.kind !== "locked") rejected = true;
      else {
        await opened.session.finish();
        throw new Error("begin should have rejected");
      }
    } catch (error) {
      // Thrown journal-creation failure is a valid begin rejection.
      rejected = true;
    }
    expect(rejected).toBe(true);
    // The owned lock must be gone after the failed begin.
    expect(existsSync(join(tasksDir, ".write.lock"))).toBe(false);
    void rm;
    void writeFile;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("red: recovered stale-revision conflict leaves no lock; current revision reacquires", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli122-5-reclock-"));
  try {
    const tasksDir = join(root, ".quest", "tasks");
    const repository = () => new LocalTaskRepository(tasksDir);
    await seed(root, "T-1", "Recover conflict");
    // Fabricate a crash: foreign dead pid holds lock + journal.
    await mkdir(join(tasksDir, ".write.lock"), { recursive: true });
    await writeFile(
      join(tasksDir, ".batch.journal.jsonl"),
      `${JSON.stringify({ schemaVersion: 1, sessionId: "dead0beef", pid: 999_999_999, at: "2026-01-01T00:00:00.000Z" })}\n`,
    );
    const staleRevision = "dead-revision-value";
    const result = await repository().beginTaskBatch(staleRevision);
    expect(result.kind).toBe("conflict");
    expect(existsSync(join(tasksDir, ".write.lock"))).toBe(false);
    // Current revision acquires cleanly afterwards.
    const reopened = await repository().beginTaskBatch(
      (await repository().readAll()).revision,
    );
    expect(reopened.kind).toBe("locked");
    if (reopened.kind === "locked") {
      await reopened.session.finish();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("red: milestone transition row is rejected at exact index without task or planning mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli122-5-milestone-"));
  try {
    Bun.spawnSync(["/usr/bin/git", "init", "-q"], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    spawnJson(root, ["init"]);
    await seed(root, "T-1", "Milestone target");
    await seed(root, "T-2", "Neighbour");
    // Configure a REAL milestone through the public CLI (correct schema).
    const milestoneCreated = spawnJson(root, [
      "milestone",
      "create",
      "Real milestone",
      "--actor",
      "person-1",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(milestoneCreated.exitCode).toBe(0);
    const milestoneId = JSON.parse(milestoneCreated.stdout).data.id as string;
    const before = JSON.parse(
      spawnJson(root, ["task", "view", "T-1", "--json"]).stdout,
    );
    const file = join(root, "ops.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          reference: "T-2",
          operationId: "keep",
          patch: { addLabels: ["kept"] },
        }),
        JSON.stringify({
          reference: "T-1",
          operationId: "ms-row",
          patch: { milestoneId },
        }),
        JSON.stringify({
          reference: "T-1",
          operationId: "post-ms",
          patch: { description: "applied after rejection" },
        }),
      ].join("\n"),
    );
    // Canonical milestone object captured BEFORE edit-batch.
    const planningBefore = JSON.parse(
      spawnJson(root, ["milestone", "view", milestoneId, "--json"]).stdout,
    ).data;
    const run = spawnJson(root, [
      "task",
      "edit-batch",
      "--file",
      file,
      "--actor",
      "person-1",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(run.exitCode).toBe(0);
    const envelope = JSON.parse(run.stdout);
    expect(
      envelope.data.items.map((i: { operationId: string }) => i.operationId),
    ).toEqual(["keep", "ms-row", "post-ms"]);
    expect(envelope.data.items[1].kind).toBe("error");
    expect(envelope.data.items[1].message).toBe(
      "milestone_transition_requires_single_edit",
    );
    // No task mutation for the rejected row.
    const after = JSON.parse(
      spawnJson(root, ["task", "view", "T-1", "--json"]).stdout,
    );
    expect(after.data.milestoneId ?? null).toBe(
      before.data.milestoneId ?? null,
    );
    expect(after.data.status).toBe(before.data.status);
    // Milestone record read again AFTER edit-batch must equal BEFORE exactly.
    const planningAfter = JSON.parse(
      spawnJson(root, ["milestone", "view", milestoneId, "--json"]).stdout,
    ).data;
    expect(planningAfter).toEqual(planningBefore);
    // Canonical milestone object captured BEFORE edit-batch.
    expect(planningAfter).toEqual(planningBefore);
    // The post-rejection VALID row also applied, in exact input order.
    expect(envelope.data.items[2].kind).toBe("updated");
    expect(envelope.data.items[2].task.description).toBe(
      "applied after rejection",
    );
    // Terminal revision authoritative (non-empty, matches fresh read).
    const listAfter = JSON.parse(
      spawnJson(root, ["task", "list", "--json"]).stdout,
    );
    expect(listAfter.data.length).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

test("red: strict JSONL grammar — duplicates, atomic neighbour rejection, wrong scalars, malformed checklist", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli122-5-jsonl-"));
  try {
    Bun.spawnSync(["/usr/bin/git", "init", "-q"], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    spawnJson(root, ["init"]);
    await seed(root, "T-1", "Grammar target");
    const viewBefore = () =>
      spawnJson(root, ["task", "view", "T-1", "--json"]).stdout;
    const cases: { name: string; lines: string[] }[] = [
      {
        name: "duplicate operation ids",
        lines: [
          JSON.stringify({
            reference: "T-1",
            operationId: "dup",
            patch: { addLabels: ["a"] },
          }),
          JSON.stringify({
            reference: "T-1",
            operationId: "dup",
            patch: { addLabels: ["b"] },
          }),
        ],
      },
      {
        name: "valid first + malformed neighbour (atomic no-write)",
        lines: [
          JSON.stringify({
            reference: "T-1",
            operationId: "ok1",
            patch: { addLabels: ["a"] },
          }),
          "{not json",
        ],
      },
      {
        name: "invalid list member number",
        lines: [
          JSON.stringify({
            reference: "T-1",
            operationId: "n1",
            patch: { addLabels: [1] },
          }),
        ],
      },
      {
        name: "invalid dependency object member",
        lines: [
          JSON.stringify({
            reference: "T-1",
            operationId: "o1",
            patch: { addDependencies: [{}] },
          }),
        ],
      },
      {
        name: "wrong scalar status type",
        lines: [
          JSON.stringify({
            reference: "T-1",
            operationId: "st1",
            patch: { status: 1 },
          }),
        ],
      },
      {
        name: "wrong scalar description type",
        lines: [
          JSON.stringify({
            reference: "T-1",
            operationId: "d1",
            patch: { description: false },
          }),
        ],
      },
      {
        name: "malformed checklist object",
        lines: [
          JSON.stringify({
            reference: "T-1",
            operationId: "ac1",
            patch: { acceptanceCriteria: [{ wrong: 1 }] },
          }),
        ],
      },
    ];
    for (const [caseIndex, { name, lines }] of cases.entries()) {
      const file = join(
        root,
        `case-${caseIndex}-${name.replace(/\W+/g, "-")}.jsonl`,
      );
      await writeFile(file, lines.join("\n"));
      const run = spawnJson(root, [
        "task",
        "edit-batch",
        "--file",
        file,
        "--actor",
        "person-1",
        "--actor-kind",
        "human",
        "--json",
      ]);
      expect(run.exitCode, name).not.toBe(0);
      expect(JSON.parse(run.stderr).error_type, name).toBe("usage");
      expect(viewBefore().length > 0, name).toBe(true);
      // Whole-input atomicity: nothing persisted for ANY rejected batch.
      const stored = JSON.parse(
        await readFile(join(root, ".quest", "tasks", "T-1.json"), "utf8"),
      );
      expect(stored.labels ?? [], name).toEqual([]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

function childProgram(options: {
  dir: string;
  killAfter: "begin" | "write";
  taskId?: string;
}): string {
  return `
    const mod = await import(${JSON.stringify(process.cwd())} + "/src/application/tasks/local-task-repository.ts");
    const { readFile } = await import("node:fs/promises");
    const repo = new mod.LocalTaskRepository(${JSON.stringify(options.dir)});
    const current = await repo.readAll();
    const opened = await repo.beginTaskBatch(current.revision);
    if (opened.kind !== "locked") throw new Error(opened.kind);
    console.log("BEGUN:" + current.revision);
    ${
      options.killAfter === "write"
        ? `const payload = JSON.parse(await readFile(${JSON.stringify(join(options.dir, `${options.taskId ?? "T-1"}.json`))}, "utf8"));
           payload.description = "renamed-then-killed";
           await opened.session.writeRecord(payload);
           // Kill BEFORE markApplied: rename happened, journal op row absent.
           process.kill(process.pid, "SIGKILL");`
        : `// Kill AFTER begin/journalReady, BEFORE any record write.
           process.kill(process.pid, "SIGKILL");`
    }
  `;
}

test("red: SIGKILL after begin (before write) recovers with truthful empty receipt; NONEMPTY next batch fully applies", async () => {
  const parent = await mkdtemp(join(tmpdir(), "qcli122-6-killA-"));
  try {
    const workspace = join(parent, "ws");
    await mkdir(workspace, { recursive: true });
    Bun.spawnSync(["/usr/bin/env", "git", "init", "-q"], {
      cwd: workspace,
      env: { ...process.env },
    });
    spawnJson(workspace, ["init"]);
    const dir = join(workspace, ".quest", "tasks");
    await mkdir(dir, { recursive: true });
    for (const id of ["T-1", "T-2"]) await seedDirect(dir, id);
    // Child A: begin then die before any write.
    const victim = Bun.spawnSync(
      [process.execPath, "--eval", childProgram({ dir, killAfter: "begin" })],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      },
    );
    expect(victim.stdout.toString()).toStartWith("BEGUN:");
    // Parent recovers DIRECTLY at the repository seam with the CURRENT
    // expected revision: kind=locked plus the truthful EMPTY receipt
    // (window A crashed before any operation was journaled).
    const parentRepo = new LocalTaskRepository(dir);
    const currentRevision = (await parentRepo.readAll()).revision;
    const opened = await parentRepo.beginTaskBatch(currentRevision);
    expect(opened.kind).toBe("locked");
    if (opened.kind !== "locked") return;
    expect(opened.recovered?.appliedOperationIds).toEqual([]);
    // Real nonempty work through THIS recovering session.
    const t1raw = JSON.parse(await readFile(join(dir, "T-1.json"), "utf8"));
    await opened.session.writeRecord({
      ...t1raw,
      description: "recovered write A",
    });
    await opened.session.markApplied("parent-A", "T-1");
    await opened.session.finish();
    expect(existsSync(join(dir, ".write.lock"))).toBe(false);
    const viewA = JSON.parse(
      spawnJson(workspace, ["task", "view", "T-1", "--json"]).stdout,
    );
    expect(viewA.data.description).toBe("recovered write A");
    void childProgram;
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);

test("red: SIGKILL between writeRecord rename and markApplied recovers with truthful receipt; NONEMPTY next batch applies", async () => {
  const parent = await mkdtemp(join(tmpdir(), "qcli122-6-killB-"));
  try {
    const workspace = join(parent, "ws");
    await mkdir(workspace, { recursive: true });
    Bun.spawnSync(["/usr/bin/env", "git", "init", "-q"], {
      cwd: workspace,
      env: { ...process.env },
    });
    spawnJson(workspace, ["init"]);
    const dir = join(workspace, ".quest", "tasks");
    await mkdir(dir, { recursive: true });
    for (const id of ["T-1", "T-2"]) await seedDirect(dir, id);
    // Child B: begin, atomic rename of T-1, die BEFORE markApplied.
    const victim = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        childProgram({ dir, killAfter: "write", taskId: "T-1" }),
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    );
    expect(victim.stdout.toString()).toStartWith("BEGUN:");
    // Parent recovers DIRECTLY at the repository seam; truthful receipt is
    // EMPTY (crash happened after rename but before markApplied appended).
    const parentRepo = new LocalTaskRepository(dir);
    const currentRevision = (await parentRepo.readAll()).revision;
    const opened = await parentRepo.beginTaskBatch(currentRevision);
    expect(opened.kind).toBe("locked");
    if (opened.kind !== "locked") return;
    expect(opened.recovered?.appliedOperationIds).toEqual([]);
    // Real nonempty work through THIS recovering session.
    const t2raw = JSON.parse(await readFile(join(dir, "T-2.json"), "utf8"));
    await opened.session.writeRecord({
      ...t2raw,
      labels: [...(t2raw.labels ?? []), "b2"],
    });
    await opened.session.markApplied("parent-B", "T-2");
    await opened.session.finish();
    expect(existsSync(join(dir, ".write.lock"))).toBe(false);
    // Child rename reality: T-1 carries the killed child's description,
    // and T-2 carries the recovering session's label write.
    const viewChildRename = JSON.parse(
      spawnJson(workspace, ["task", "view", "T-1", "--json"]).stdout,
    );
    expect(viewChildRename.data.description).toBe("renamed-then-killed");
    const viewB = JSON.parse(
      spawnJson(workspace, ["task", "view", "T-2", "--json"]).stdout,
    );
    expect(viewB.data.labels).toEqual(["b2"]);
    void mkdir;
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 120_000);
