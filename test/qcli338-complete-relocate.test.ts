import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;

function quest(cwd: string, args: readonly string[]) {
  const child = Bun.spawnSync([process.execPath, MAIN, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // QCLI-371: an env-less spawn gets the ORIGINAL environment, which drops
    // any preload setting and can reach the machine's real plugins.
    env: { ...process.env, QUEST_AGENT_PLUGINS: "off" },
  });
  return {
    exitCode: child.exitCode ?? 0,
    stdout: child.stdout ? child.stdout.toString() : "",
    stderr: child.stderr ? child.stderr.toString() : "",
  };
}

const ACTOR = ["--actor", "h", "--actor-kind", "human"] as const;

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli338-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init", "--name", "P", "--task-id-prefix", "T"]);
  return root;
}

function view(root: string, id: string) {
  return JSON.parse(quest(root, ["task", "view", id, "--json"]).stdout) as {
    data: {
      status: string;
      path: string;
      unresolvedAtCompletion?: unknown;
      finalSummary?: string;
    };
  };
}

test("task complete relocates a record already at the terminal status, instead of Illegal task transition (QCLI-338 AC1)", async () => {
  const root = await workspace();
  try {
    // The exact shape lore-cli hit: a record moved to Done via `edit --status`
    // (which deliberately does NOT relocate, QCLI-221) while still in tasks/.
    quest(root, ["task", "create", "C", ...ACTOR, "--json"]);
    quest(root, [
      "task",
      "edit",
      "T-1",
      "--status",
      "In Progress",
      ...ACTOR,
      "--json",
    ]);
    const moved = quest(root, [
      "task",
      "edit",
      "T-1",
      "--status",
      "Done",
      ...ACTOR,
      "--json",
    ]);
    expect(moved.exitCode).toBe(0);
    // AC2: `edit --status <terminal>` does NOT relocate (unchanged, QCLI-221).
    expect(view(root, "T-1").data.path).toBe(".quest/tasks/T-1.json");

    // One command, no demote-then-complete dance.
    const done = quest(root, ["task", "complete", "T-1", ...ACTOR, "--json"]);
    expect({ exitCode: done.exitCode, stderr: done.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const after = view(root, "T-1").data;
    expect(after.status).toBe("Done");
    expect(after.path).toBe(".quest/completed/T-1.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the relocate-completion computes unresolvedAtCompletion and applies finalSummary (QCLI-338 AC3, AC4)", async () => {
  const root = await workspace();
  try {
    // A criterion left unchecked: on the normal path this records
    // unresolvedAtCompletion. The ruling (DEC-172 (4ai) A) says this path
    // computes it too -- a first pass through complete() is the record's real
    // completion under QCLI-336's model.
    quest(root, [
      "task",
      "create",
      "C",
      "--acceptance-criteria",
      '["open"]',
      ...ACTOR,
      "--json",
    ]);
    quest(root, [
      "task",
      "edit",
      "T-1",
      "--status",
      "In Progress",
      ...ACTOR,
      "--json",
    ]);
    quest(root, [
      "task",
      "edit",
      "T-1",
      "--status",
      "Done",
      ...ACTOR,
      "--json",
    ]);
    const done = quest(root, [
      "task",
      "complete",
      "T-1",
      "--final-summary",
      "closed out",
      ...ACTOR,
      "--json",
    ]);
    expect(done.exitCode).toBe(0);
    const after = view(root, "T-1").data;
    expect(after.path).toBe(".quest/completed/T-1.json");
    expect(after.finalSummary).toBe("closed out");
    expect(after.unresolvedAtCompletion).toEqual({
      acceptanceCriteria: [{ index: 0, text: "open" }],
      definitionOfDone: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completing a record already in completed/ still refuses exactly as it did before (QCLI-338 AC4)", async () => {
  const root = await workspace();
  try {
    quest(root, ["task", "create", "C", ...ACTOR, "--json"]);
    quest(root, [
      "task",
      "edit",
      "T-1",
      "--status",
      "In Progress",
      ...ACTOR,
      "--json",
    ]);
    quest(root, [
      "task",
      "edit",
      "T-1",
      "--status",
      "Done",
      ...ACTOR,
      "--json",
    ]);
    // First complete relocates (the AC1 fix). A SECOND one hits the
    // already-at-destination record, which must keep the PRE-QCLI-338 refusal
    // -- the skip above is only for a record still stored in tasks/.
    expect(
      quest(root, ["task", "complete", "T-1", ...ACTOR, "--json"]).exitCode,
    ).toBe(0);
    expect(view(root, "T-1").data.path).toBe(".quest/completed/T-1.json");
    const again = quest(root, ["task", "complete", "T-1", ...ACTOR, "--json"]);
    expect(again.exitCode).toBe(6);
    const diagnostic = JSON.parse(again.stderr) as {
      error_type?: string;
      message?: string;
    };
    expect(diagnostic.error_type).toBe("validation");
    expect(diagnostic.message).toMatch(
      /^Illegal task transition: Done -> Done\./,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task complete still refuses a Done record in archive/tasks (QCLI-338 AC1 scope)", async () => {
  const root = await workspace();
  try {
    quest(root, ["task", "create", "C", ...ACTOR, "--json"]);
    quest(root, [
      "task",
      "edit",
      "T-1",
      "--status",
      "In Progress",
      ...ACTOR,
      "--json",
    ]);
    quest(root, [
      "task",
      "edit",
      "T-1",
      "--status",
      "Done",
      ...ACTOR,
      "--json",
    ]);
    const archived = quest(root, [
      "task",
      "archive",
      "T-1",
      ...ACTOR,
      "--json",
    ]);
    expect(archived.exitCode).toBe(0);
    expect(view(root, "T-1").data.path).toBe(".quest/archive/tasks/T-1.json");
    // The relocation this task adds is tasks/ -> completed/ ONLY. A record in
    // archive/tasks is NOT swept into completed/ -- it keeps the pre-QCLI-338
    // refusal, exactly as a record already in completed/ does.
    const done = quest(root, ["task", "complete", "T-1", ...ACTOR, "--json"]);
    expect(done.exitCode).toBe(6);
    expect(view(root, "T-1").data.path).toBe(".quest/archive/tasks/T-1.json");
    expect((JSON.parse(done.stderr) as { message?: string }).message).toMatch(
      /^Illegal task transition: Done -> Done\./,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
