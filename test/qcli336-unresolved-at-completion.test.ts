import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * QCLI-336. QCLI-252 added `unresolvedAtCompletion` to `task complete`'s own
 * JSON response -- a one-shot signal, computed in the CLI layer and never
 * written to the record. The moment the response was printed, "we knowingly
 * shipped with X open" was unreachable again: not in `task view`, not in
 * `task list`, not in `search`, not in `doctor`.
 *
 * This pins the fix: the same field is now persisted on the task record by
 * `tasks.complete()` itself, survives to later reads, and `task list
 * --unresolved-at-completion` finds every completed task carrying one
 * without reading each completed record by hand.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const HUMAN = ["--actor", "person-1", "--actor-kind", "human"] as const;

function quest(workspace: string, args: readonly string[]) {
  const child = Bun.spawnSync(["bun", MAIN, ...args], {
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
  const root = await mkdtemp(join(tmpdir(), "qcli336-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

test("a completed task's unresolvedAtCompletion survives on task view and task list, not just the completion response (QCLI-336)", async () => {
  const root = await workspace();
  try {
    quest(root, [
      "task",
      "create",
      "Ship the thing",
      "--acceptance-criteria",
      '["first criterion","second criterion"]',
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

    const expectedUnresolved = {
      acceptanceCriteria: [{ index: 1, text: "second criterion" }],
      definitionOfDone: [],
    };

    const viewed = JSON.parse(
      quest(root, ["task", "view", "T-1", "--json"]).stdout,
    ) as { data: { unresolvedAtCompletion?: unknown } };
    expect(viewed.data.unresolvedAtCompletion).toEqual(expectedUnresolved);

    const listed = JSON.parse(
      quest(root, ["task", "list", "--json"]).stdout,
    ) as { data: readonly { id: string; unresolvedAtCompletion?: unknown }[] };
    const listedTask = listed.data.find((task) => task.id === "T-1");
    expect(listedTask?.unresolvedAtCompletion).toEqual(expectedUnresolved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("task list --unresolved-at-completion finds a completed task with open items and excludes one fully resolved (QCLI-336)", async () => {
  const root = await workspace();
  try {
    quest(root, [
      "task",
      "create",
      "Open at close",
      "--acceptance-criteria",
      '["unchecked"]',
      ...HUMAN,
      "--json",
    ]);
    quest(root, ["task", "start", "T-1", ...HUMAN, "--json"]);
    quest(root, ["task", "complete", "T-1", ...HUMAN, "--json"]);

    quest(root, [
      "task",
      "create",
      "Fully resolved at close",
      "--acceptance-criteria",
      '["checked"]',
      ...HUMAN,
      "--json",
    ]);
    quest(root, ["task", "edit", "T-2", "--check-ac", "1", ...HUMAN, "--json"]);
    quest(root, ["task", "start", "T-2", ...HUMAN, "--json"]);
    quest(root, ["task", "complete", "T-2", ...HUMAN, "--json"]);

    quest(root, ["task", "create", "Never completed", ...HUMAN, "--json"]);

    const filtered = JSON.parse(
      quest(root, ["task", "list", "--unresolved-at-completion", "--json"])
        .stdout,
    ) as { data: readonly { id: string }[] };
    expect(filtered.data.map((task) => task.id)).toEqual(["T-1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("editing a completed task's checklist does not change its unresolvedAtCompletion (QCLI-336, QCLI-479)", async () => {
  const root = await workspace();
  try {
    quest(root, [
      "task",
      "create",
      "Closed with a gap",
      "--acceptance-criteria",
      '["unchecked"]',
      ...HUMAN,
      "--json",
    ]);
    quest(root, ["task", "start", "T-1", ...HUMAN, "--json"]);
    quest(root, ["task", "complete", "T-1", ...HUMAN, "--json"]);

    // Checking the item off after the fact does not retroactively rewrite
    // what was open at the moment the task closed.
    quest(root, ["task", "edit", "T-1", "--check-ac", "1", ...HUMAN, "--json"]);

    const viewed = JSON.parse(
      quest(root, ["task", "view", "T-1", "--json"]).stdout,
    ) as {
      data: {
        unresolvedAtCompletion?: {
          acceptanceCriteria: readonly { index: number; text: string }[];
        };
      };
    };
    expect(viewed.data.unresolvedAtCompletion?.acceptanceCriteria).toEqual([
      { index: 0, text: "unchecked" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("quest manifest declares task list's --unresolved-at-completion filter and the unresolvedAtCompletion field on task view/list (QCLI-336)", async () => {
  const root = await workspace();
  try {
    const manifest = JSON.parse(quest(root, ["manifest", "--json"]).stdout) as {
      data: {
        commands: readonly {
          name: string;
          filters?: readonly string[];
          fields?: readonly string[];
        }[];
      };
    };
    const list = manifest.data.commands.find(
      (entry) => entry.name === "task list",
    );
    expect(list?.filters).toContain("unresolved-at-completion");
    expect(list?.fields).toContain("unresolvedAtCompletion");
    const view = manifest.data.commands.find(
      (entry) => entry.name === "task view",
    );
    expect(view?.fields).toContain("unresolvedAtCompletion");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

/**
 * QCLI-479 (opum-doc DEC-172 (4ae)): a COMPLETION REFRESHES the field. It used
 * to be written once, so a task demoted back to an active status, amended and
 * completed again still carried the FIRST completion's snapshot -- including
 * the criterion text as it stood then -- which reads as a current statement
 * about the record when it is really a historical one.
 *
 * Both directions are pinned here: a re-completion with nothing unresolved
 * CLEARS the field, and one that does leave something unresolved carries THAT
 * text. Removing the refresh from `complete()` (returning the record unchanged
 * when nothing is unresolved, and overwriting only when something is) turns
 * the first assertion red and leaves the second green.
 */
test("a re-completion refreshes unresolvedAtCompletion, and clears it when nothing is unresolved (QCLI-479)", async () => {
  const root = await workspace();
  try {
    quest(root, [
      "task",
      "create",
      "Ship it",
      "--acceptance-criteria",
      '["first criterion","second criterion"]',
      ...HUMAN,
      "--json",
    ]);
    quest(root, ["task", "start", "T-1", ...HUMAN, "--json"]);
    quest(root, ["task", "complete", "T-1", ...HUMAN, "--json"]);

    const first = JSON.parse(
      quest(root, ["task", "view", "T-1", "--json"]).stdout,
    ) as { data: { unresolvedAtCompletion?: unknown } };
    expect(first.data.unresolvedAtCompletion).toEqual({
      acceptanceCriteria: [
        { index: 0, text: "first criterion" },
        { index: 1, text: "second criterion" },
      ],
      definitionOfDone: [],
    });

    // Done -> an active status is reachable only through demote. Amend BOTH
    // criteria's text AND check them, so nothing is unresolved now and the
    // first snapshot must NOT survive the second completion.
    expect(
      quest(root, [
        "task",
        "demote",
        "T-1",
        "--to",
        "In Progress",
        ...HUMAN,
        "--json",
      ]).exitCode,
    ).toBe(0);
    quest(root, [
      "task",
      "edit",
      "T-1",
      "--acceptance-criteria",
      '[{"index":0,"text":"reworded one","checked":true},{"index":1,"text":"reworded two","checked":true}]',
      ...HUMAN,
      "--json",
    ]);
    quest(root, ["task", "complete", "T-1", ...HUMAN, "--json"]);

    const again = JSON.parse(
      quest(root, ["task", "view", "T-1", "--json"]).stdout,
    ) as {
      data: {
        unresolvedAtCompletion?: unknown;
        acceptanceCriteria: readonly { text: string; checked: boolean }[];
      };
    };
    // The criteria really were amended, so an absent field below is the
    // refresh and not a fixture that never changed.
    expect(again.data.acceptanceCriteria.map((one) => one.text)).toEqual([
      "reworded one",
      "reworded two",
    ]);
    expect(again.data.unresolvedAtCompletion).toBeUndefined();

    // The other direction: a re-completion that DOES leave something
    // unresolved carries THAT text, not the first completion's.
    quest(root, [
      "task",
      "demote",
      "T-1",
      "--to",
      "In Progress",
      ...HUMAN,
      "--json",
    ]);
    quest(root, [
      "task",
      "edit",
      "T-1",
      "--uncheck-ac",
      "1",
      ...HUMAN,
      "--json",
    ]);
    quest(root, ["task", "complete", "T-1", ...HUMAN, "--json"]);

    const third = JSON.parse(
      quest(root, ["task", "view", "T-1", "--json"]).stdout,
    ) as { data: { unresolvedAtCompletion?: unknown } };
    expect(third.data.unresolvedAtCompletion).toEqual({
      acceptanceCriteria: [{ index: 0, text: "reworded one" }],
      definitionOfDone: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
