import { expect, test } from "bun:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalTaskRepository } from "../src/application/tasks/local-task-repository.ts";
import {
  type BatchTaskRepository,
  TaskService,
} from "../src/application/tasks/tasks.ts";
import {
  createTask,
  createTaskLinkSession,
} from "../src/domain/tasks/tasks.ts";

/**
 * QCLI-122 third-pass red contracts (FMC ea6e837a). Each test pins one
 * reviewed blocker so the corrected implementation proves it by green.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;

function repository(root: string) {
  return new LocalTaskRepository(join(root, ".quest", "tasks"));
}

async function seed(root: string, id: string, title: string, deps?: string[]) {
  await mkdir(join(root, ".quest", "tasks"), { recursive: true });
  const base = createTask(id, { title });
  const record = {
    ...base,
    dependencies: [...base.dependencies, ...(deps ?? [])],
  };
  await writeFile(
    join(root, ".quest", "tasks", `${id}.json`),
    `${JSON.stringify(record)}\n`,
  );
}

function spawnJson(workspace: string, args: readonly string[], stdin?: string) {
  const child = Bun.spawnSync([process.execPath, MAIN, ...args], {
    cwd: workspace,
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode ?? 0,
    stdout: child.stdout ? child.stdout.toString() : "",
    stderr: child.stderr ? child.stderr.toString() : "",
  };
}

test("red: injected read failure after lock acquisition must not leak the lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli122-3-leak-"));
  try {
    class FailingReadRepository extends LocalTaskRepository {
      failNextRead = false;
      async readAll() {
        if (this.failNextRead) throw new Error("injected corrupt store");
        return super.readAll();
      }
      async snapshot() {
        if (this.failNextRead) throw new Error("injected corrupt store");
        return super.snapshot();
      }
    }
    const repo = new FailingReadRepository(join(root, ".quest", "tasks"));
    await seed(root, "T-1", "Leak probe");
    const revision = (await repo.readAll()).revision;
    repo.failNextRead = true;
    let threw = false;
    try {
      await repo.beginTaskBatch(revision);
    } catch (error) {
      threw = (error as Error).message.includes("injected corrupt store");
    }
    repo.failNextRead = false;
    expect(threw).toBe(true);
    // Lock must be gone: an immediate reacquire succeeds.
    const reopened = await repo.beginTaskBatch((await repo.readAll()).revision);
    expect(reopened.kind).toBe("locked");
    if (reopened.kind === "locked") await reopened.session.finish();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("red: journal receipts exist for before-write, after-write-before-mark, and after-mark crash windows", async () => {
  // The journal is best-effort evidence; recovery truthfulness means a
  // recovered session reports exactly what it can prove and never strands
  // the lock. We exercise all three windows via manual journal state.
  const root = await mkdtemp(join(tmpdir(), "qcli122-3-journal-"));
  try {
    const repo = repository(root);
    await seed(root, "T-1", "Journal probe");
    await repo.readAll();
    const journalPath = join(root, ".quest", "tasks", ".batch.journal.jsonl");

    // Window A: crash before any durable write — empty/absent journal but
    // lock present still recovers (pid proven dead because it is fabricated).
    await mkdir(join(root, ".quest", "tasks", ".write.lock"), {
      recursive: true,
    });
    await appendFile(
      journalPath,
      `${JSON.stringify({ schemaVersion: 1, sessionId: "deadbeef01", pid: 999_999_999, at: "2026-01-01T00:00:00.000Z", taskId: null })}\n`,
    );
    const a = await repo.beginTaskBatch((await repo.readAll()).revision);
    expect(a.kind).toBe("locked");
    if (a.kind === "locked") {
      expect(a.recovered?.appliedOperationIds.length).toBe(0);
      await a.session.finish();
    }

    // Window B/C: crashed holder recorded applied operations before dying;
    // receipt lists them and the lock is reclaimed once only.
    await mkdir(join(root, ".quest", "tasks", ".write.lock"), {
      recursive: true,
    });
    await rm(journalPath, { force: true });
    await appendFile(
      journalPath,
      [
        JSON.stringify({
          schemaVersion: 1,
          sessionId: "deadbeef02",
          pid: 999_999_999,
          at: "2026-01-01T00:00:00.000Z",
          operationId: "op-crashed",
          taskId: "T-1",
        }),
        JSON.stringify({
          schemaVersion: 1,
          sessionId: "deadbeef02",
          pid: 999_999_999,
          at: "2026-01-01T00:00:00.001Z",
          operationId: "op-later",
          taskId: "T-1",
        }),
        "",
      ].join("\n"),
    );
    const b = await repository(root).beginTaskBatch(
      (await repository(root).readAll()).revision,
    );
    expect(b.kind).toBe("locked");
    if (b.kind === "locked") {
      expect(b.recovered?.appliedOperationIds).toEqual([
        "op-crashed",
        "op-later",
      ]);
      await b.session.finish();
    }
    void readFile;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("red: repeated edits to the same task compose instead of overwriting", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli122-3-evolve-"));
  try {
    await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
    spawnJson(root, ["init"]);
    const repo = repository(root);
    const service = new TaskService(
      repo,
      undefined,
      undefined,
      undefined,
      repo satisfies BatchTaskRepository,
    );
    await seed(root, "T-1", "Evolve");
    const result = await service.editBatch([
      { reference: "T-1", operationId: "one", patch: { addLabels: ["a"] } },
      { reference: "T-1", operationId: "two", patch: { addLabels: ["b"] } },
    ]);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    const second = result.items[1];
    expect(second.kind).toBe("updated");
    if (second.kind !== "updated") return;
    expect([...second.task.labels].sort()).toEqual(["a", "b"]);
    const view = JSON.parse(
      spawnJson(root, ["task", "view", "T-1", "--json"]).stdout,
    );
    expect([...view.data.labels].sort()).toEqual(["a", "b"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("red: A->B existing edge blocks B->A cycle swap without invalid persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli122-3-cycle-"));
  try {
    const repo = repository(root);
    const service = new TaskService(
      repo,
      undefined,
      undefined,
      undefined,
      repo satisfies BatchTaskRepository,
    );
    await seed(root, "T-1", "A", ["T-2"]);
    await seed(root, "T-2", "B");
    const result = await service.editBatch([
      {
        reference: "T-2",
        operationId: "swap",
        patch: { addDependencies: ["T-1"] },
      },
    ]);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.items[0].kind).toBe("error");
    // No invalid persistence: T-2 on disk keeps zero dependencies.
    const raw = JSON.parse(
      await readFile(join(root, ".quest", "tasks", "T-2.json"), "utf8"),
    );
    expect(raw.dependencies).toEqual([]);
    const linkSessionRows = [createTask("T-1", { title: "A" })];
    expect(createTaskLinkSession(linkSessionRows).size).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("red: empty public operations file returns zero items plus authoritative revision without mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli122-3-empty-"));
  try {
    await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
    spawnJson(root, ["init"]);
    await seed(root, "T-1", "Empty file");
    const file = join(root, "empty.jsonl");
    await writeFile(file, "\n\n");
    const before = JSON.parse(
      spawnJson(root, ["task", "list", "--json"]).stdout,
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
    expect(envelope.data.items).toEqual([]);
    expect(envelope.data.applied).toBe(0);
    expect(envelope.data.failed).toBe(0);
    expect(typeof envelope.data.revision).toBe("string");
    expect(envelope.data.revision.length).toBe(64);
    const after = JSON.parse(
      spawnJson(root, ["task", "list", "--json"]).stdout,
    );
    expect(after).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("red: string-valued array field in patch is rejected, not char-iterated", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli122-3-types-"));
  try {
    await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
    spawnJson(root, ["init"]);
    await seed(root, "T-1", "Types");
    const file = join(root, "badtype.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({
        reference: "T-1",
        operationId: "t1",
        patch: { addLabels: "abc" },
      })}\n`,
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
    expect(run.exitCode).not.toBe(0);
    expect(JSON.parse(run.stderr).error_type).toBe("usage");
    const view = JSON.parse(
      spawnJson(root, ["task", "view", "T-1", "--json"]).stdout,
    );
    expect(view.data.labels).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("red: interleaved milestone edit with repeated tasks preserves input order and terminal revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli122-3-milestone-"));
  try {
    await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
    spawnJson(root, ["init"]);
    const repo = repository(root);
    const service = new TaskService(
      repo,
      undefined,
      undefined,
      undefined,
      repo satisfies BatchTaskRepository,
    );
    await seed(root, "T-1", "Interleave A");
    await seed(root, "T-2", "Interleave B");
    const result = await service.editBatch([
      { reference: "T-1", operationId: "m1", patch: { status: "Done" } },
      { reference: "T-2", operationId: "n1", patch: { addLabels: ["z"] } },
      {
        reference: "T-1",
        operationId: "m2",
        patch: { description: "after done" },
      },
    ]);
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    // Exact input order, one entry per item.
    expect(result.items.map((entry) => entry.operationId)).toEqual([
      "m1",
      "n1",
      "m2",
    ]);
    // Revision is read only at the very end of every write path.
    const authoritative = await repo.readAll();
    expect(result.revision).toBe(authoritative.revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
