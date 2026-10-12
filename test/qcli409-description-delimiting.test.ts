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
    env: { ...process.env, QUEST_AGENT_PLUGINS: "off" },
  });
  return {
    exitCode: child.exitCode ?? 0,
    stdout: child.stdout ? child.stdout.toString() : "",
    stderr: child.stderr ? child.stderr.toString() : "",
  };
}

const ACTOR = ["--actor", "h", "--actor-kind", "human", "--json"] as const;

/** The shape a Backlog migration leaves behind: the original frontmatter,
 *  `status: To Do` and all, embedded inside `description`. */
const EMBEDDED = [
  "---",
  "id: QWEB-9",
  "title: an old title",
  "status: To Do",
  "assignee: someone",
  "---",
  "the migrated body",
].join("\n");

test("the human task list marks multi-line description content so embedded lines cannot read as live fields (QCLI-409 AC0, AC1)", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli409-"));
  try {
    await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
    quest(root, ["init", "--name", "P", "--task-id-prefix", "T"]);
    // The LIVE status is Done, so any bare `status: To Do` line in the render
    // can only be the embedded frontmatter masquerading as a record field.
    const created = quest(root, [
      "task",
      "create",
      "Migrated",
      `--description=${EMBEDDED}`,
      ...ACTOR,
    ]);
    expect({ exitCode: created.exitCode, stderr: created.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    quest(root, ["task", "edit", "T-1", "--status", "In Progress", ...ACTOR]);
    quest(root, ["task", "edit", "T-1", "--status", "Done", ...ACTOR]);

    const human = quest(root, ["task", "list"]).stdout;

    // The live field is the record's own status ...
    expect(human).toContain("status: Done");
    // ... and the embedded `status: To Do` is DELIMITED, prefixed with the
    // block marker under `description:`, so it cannot be mistaken for a field.
    expect(human).toContain("description:");
    expect(human).toContain("| status: To Do");
    expect(human).toContain("| id: QWEB-9");
    // No UNMARKED `status: To Do` line survives: the only one is the marked
    // line above.
    expect(human).not.toMatch(/^(?!\s*\|)\s*status: To Do\s*$/m);
    // A single-line string is NOT delimited (no needless churn).
    expect(human).toContain("title: Migrated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
