import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./helpers/spawn.ts";

/**
 * QCLI-265, the half QCLI-264 deliberately left alone. Two divergences
 * remained after the lifecycle and draft mutations were converged:
 *
 *   milestone/decision create|edit|archive|delete -> {record, result}
 *   draft view / draft list                       -> {draft, location}
 *
 * `result` was the same mutation wrapper QCLI-264 unwrapped elsewhere, and
 * `draft view` was the only read in the CLI where the record was not the
 * payload -- `task view`/`task list` already carried `path` inline. Both now
 * carry the record itself.
 *
 * The point of pinning reads and writes in one file is that "where is the
 * record in data" should have exactly one answer. A per-command test cannot
 * fail when a NEW command picks the wrong shape; this one is written so the
 * next command added has an obvious thing to match.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const HUMAN = ["--actor", "person-1", "--actor-kind", "human"] as const;

function quest(workspace: string, args: readonly string[]) {
  return runCommand([process.execPath, MAIN, ...args], {
    cwd: workspace,
  });
}

function envelope(workspace: string, args: readonly string[]) {
  const run = quest(workspace, [...args, "--json"]);
  expect({ args: args.join(" "), exitCode: run.exitCode }).toEqual({
    args: args.join(" "),
    exitCode: 0,
  });
  return JSON.parse(run.stdout) as { kind: string; data: unknown };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli265-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

/**
 * The wrapper keys no payload may carry: a nested record or a write
 * receipt. `revision` stays listed because it is still banned as that
 * write-mutation receipt everywhere -- the sole, explicit exception is
 * `task view` (QCLI-277), asserted below where it cannot be missed.
 */
const WRAPPERS = ["task", "draft", "record", "result", "revision"] as const;

function wrapperKeys(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object") return [];
  return WRAPPERS.filter((key) => key in (value as Record<string, unknown>));
}

test("planning mutations carry the record itself, not {record, result} (QCLI-265)", async () => {
  const root = await workspace();
  try {
    const cases = [
      { label: "milestone create", argv: ["milestone", "create", "M1"] },
      {
        label: "milestone edit",
        argv: ["milestone", "edit", "M-1", "--title", "M1 edited"],
      },
      { label: "milestone archive", argv: ["milestone", "archive", "M-1"] },
      { label: "decision create", argv: ["decision", "create", "D1"] },
      {
        label: "decision edit",
        argv: ["decision", "edit", "DEC-1", "--title", "D1 edited"],
      },
      { label: "decision delete", argv: ["decision", "delete", "DEC-1"] },
    ];

    for (const { label, argv } of cases) {
      const { kind, data } = envelope(root, [...argv, ...HUMAN]);
      const record = data as Record<string, unknown>;
      expect({
        label,
        id: typeof record.id,
        title: typeof record.title,
      }).toEqual({ label, id: "string", title: "string" });
      expect({ label, wrappers: wrapperKeys(data) }).toEqual({
        label,
        wrappers: [],
      });
      expect(kind).toBe(
        `${argv[0]}.${argv[1] === "create" ? "created" : argv[1] === "edit" ? "updated" : argv[1] === "archive" ? "archived" : "deleted"}`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("draft reads carry the draft with location inline, like task reads carry path (QCLI-265)", async () => {
  const root = await workspace();
  try {
    quest(root, ["draft", "create", "An idea", ...HUMAN, "--json"]);

    const view = envelope(root, ["draft", "view", "D-1"]);
    const draft = view.data as Record<string, unknown>;
    expect({
      kind: view.kind,
      id: draft.id,
      title: draft.title,
      location: draft.location,
      wrappers: wrapperKeys(view.data),
    }).toEqual({
      kind: "draft.view",
      id: "D-1",
      title: "An idea",
      location: "drafts",
      wrappers: [],
    });

    const list = envelope(root, ["draft", "list"]);
    const rows = list.data as Record<string, unknown>[];
    expect({
      kind: list.kind,
      length: rows.length,
      id: rows[0]?.id,
      location: rows[0]?.location,
      wrappers: wrapperKeys(rows[0]),
    }).toEqual({
      kind: "draft.list",
      length: 1,
      id: "D-1",
      location: "drafts",
      wrappers: [],
    });

    // The archived draft is still distinguishable, which is what `location`
    // is for -- flattening must not cost that.
    quest(root, ["draft", "archive", "D-1", ...HUMAN, "--json"]);
    const archived = envelope(root, ["draft", "list", "--include-archived"]);
    expect((archived.data as Record<string, unknown>[])[0]?.location).toBe(
      "archive/drafts",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("every read and every write puts the record in data, across all four groups (QCLI-264 + QCLI-265)", async () => {
  // The whole invariant in one place. A command added later that picks a
  // wrapper shape has to fail something, and this is the something.
  const root = await workspace();
  try {
    quest(root, ["task", "create", "A task", ...HUMAN, "--json"]);
    quest(root, ["draft", "create", "An idea", ...HUMAN, "--json"]);
    quest(root, ["milestone", "create", "M1", ...HUMAN, "--json"]);
    quest(root, ["decision", "create", "D1", ...HUMAN, "--json"]);

    const single = [
      ["task", "view", "T-1"],
      ["draft", "view", "D-1"],
      ["milestone", "view", "M-1"],
      ["decision", "view", "DEC-1"],
      ["task", "edit", "T-1", "--description", "x", ...HUMAN],
      ["task", "start", "T-1", ...HUMAN],
      ["task", "complete", "T-1", ...HUMAN],
      ["milestone", "edit", "M-1", "--title", "M2", ...HUMAN],
      ["decision", "edit", "DEC-1", "--title", "D2", ...HUMAN],
    ];
    for (const argv of single) {
      const { data } = envelope(root, argv);
      // QCLI-277: `task view` alone is allowed to carry `revision` -- a
      // legitimate additive field, like `path` (QCLI-220), that a caller
      // captures and later supplies back as `task edit --if-revision`'s
      // precondition. It is not the internal write-mutation wrapper this
      // list otherwise still catches: every other read and write here
      // still must not carry it.
      const isTaskView = argv[0] === "task" && argv[1] === "view";
      expect({
        argv: argv.slice(0, 3).join(" "),
        id: typeof (data as Record<string, unknown>).id,
        wrappers: wrapperKeys(data),
      }).toEqual({
        argv: argv.slice(0, 3).join(" "),
        id: "string",
        wrappers: isTaskView ? ["revision"] : [],
      });
    }

    const collections = [
      ["task", "list"],
      ["draft", "list"],
      ["milestone", "list"],
      ["decision", "list"],
      ["search", "a"],
    ];
    for (const argv of collections) {
      const { data } = envelope(root, argv);
      expect(Array.isArray(data)).toBe(true);
      for (const row of data as Record<string, unknown>[]) {
        expect({ argv: argv.join(" "), wrappers: wrapperKeys(row) }).toEqual({
          argv: argv.join(" "),
          wrappers: [],
        });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
