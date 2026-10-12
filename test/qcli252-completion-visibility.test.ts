import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * QCLI-252. `task complete` never enforced acceptance criteria / definition
 * of done -- deliberately, per `quest instructions task-finalization`'s own
 * philosophy that an honestly-unchecked item beats one checked on faith. The
 * defect was that it stayed completely silent about it: exit 0, no warning,
 * nothing in the record calling out the gap. Two live incidents (the
 * quest-web report that opened this task, and a second fleet session that
 * closed two tasks with 0 of 3 criteria checked via the QCLI-269 numbering
 * trap) showed that silence is what let a genuinely wrong close go
 * unnoticed.
 *
 * This pins the fix: completion still succeeds with unchecked items (advisory
 * stays advisory), but the result stops being silent about it.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const HUMAN = ["--actor", "person-1", "--actor-kind", "human"] as const;

function quest(workspace: string, args: readonly string[]) {
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

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli252-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

test("task complete succeeds with unchecked acceptance criteria and reports the gap instead of staying silent (QCLI-252)", async () => {
  const root = await workspace();
  try {
    quest(root, [
      "task",
      "create",
      "Ship the thing",
      "--acceptance-criteria",
      '["first criterion","second criterion","third criterion"]',
      ...HUMAN,
      "--json",
    ]);
    quest(root, ["task", "edit", "T-1", "--check-ac", "1", ...HUMAN, "--json"]);
    quest(root, ["task", "start", "T-1", ...HUMAN, "--json"]);

    const completed = quest(root, [
      "task",
      "complete",
      "T-1",
      ...HUMAN,
      "--json",
    ]);
    expect(completed.exitCode).toBe(0);

    const envelope = JSON.parse(completed.stdout) as {
      kind: string;
      data: {
        status: string;
        unresolvedAtCompletion?: {
          acceptanceCriteria: readonly { index: number; text: string }[];
          definitionOfDone: readonly { index: number; text: string }[];
        };
      };
    };
    expect(envelope.kind).toBe("task.completed");
    // Advisory stays advisory: the task still completed.
    expect(envelope.data.status).toBe("Done");
    // But the gap is now a named, computed signal, not raw checked:false a
    // caller has to know to look for.
    expect(envelope.data.unresolvedAtCompletion).toEqual({
      acceptanceCriteria: [
        { index: 1, text: "second criterion" },
        { index: 2, text: "third criterion" },
      ],
      definitionOfDone: [],
    });

    // Not silent on stderr either, and worded as a warning so it does not
    // read as a failure (Contract §5 tolerates a "warning"-prefixed line on
    // an otherwise successful stderr).
    expect(completed.stderr).toMatch(/^Warning: /);
    expect(completed.stderr).toContain("T-1");
    expect(completed.stderr).toContain("2 of 3 unchecked");
    expect(completed.stderr).toContain("second criterion");
    expect(completed.stderr).toContain("third criterion");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("task complete with every item checked carries no unresolvedAtCompletion field and stays silent on stderr (QCLI-252)", async () => {
  const root = await workspace();
  try {
    quest(root, [
      "task",
      "create",
      "Fully done",
      "--acceptance-criteria",
      '["only criterion"]',
      ...HUMAN,
      "--json",
    ]);
    quest(root, ["task", "edit", "T-1", "--check-ac", "1", ...HUMAN, "--json"]);
    quest(root, ["task", "start", "T-1", ...HUMAN, "--json"]);

    const completed = quest(root, [
      "task",
      "complete",
      "T-1",
      ...HUMAN,
      "--json",
    ]);
    expect(completed.exitCode).toBe(0);

    const envelope = JSON.parse(completed.stdout) as {
      data: Record<string, unknown>;
    };
    expect("unresolvedAtCompletion" in envelope.data).toBe(false);
    expect(completed.stderr).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("--plain surfaces the same unresolved items on stdout and the warning on stderr (QCLI-252)", async () => {
  const root = await workspace();
  try {
    quest(root, [
      "task",
      "create",
      "Plain mode probe",
      "--acceptance-criteria",
      '["needs proof"]',
      ...HUMAN,
      "--json",
    ]);

    quest(root, ["task", "start", "T-1", ...HUMAN, "--json"]);

    const completed = quest(root, [
      "task",
      "complete",
      "T-1",
      ...HUMAN,
      "--plain",
    ]);
    expect(completed.exitCode).toBe(0);
    expect(completed.stdout).toContain("unresolvedAtCompletion:");
    expect(completed.stdout).toContain("needs proof");
    expect(completed.stderr).toMatch(/^Warning: /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("task edit and task view never carry unresolvedAtCompletion -- the signal is complete-specific (QCLI-252)", async () => {
  const root = await workspace();
  try {
    quest(root, [
      "task",
      "create",
      "Scope check",
      "--acceptance-criteria",
      '["unchecked"]',
      ...HUMAN,
      "--json",
    ]);
    const edited = quest(root, [
      "task",
      "edit",
      "T-1",
      "--description",
      "probe",
      ...HUMAN,
      "--json",
    ]);
    const viewed = quest(root, ["task", "view", "T-1", "--json"]);

    for (const result of [edited, viewed]) {
      const envelope = JSON.parse(result.stdout) as {
        data: Record<string, unknown>;
      };
      expect("unresolvedAtCompletion" in envelope.data).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
