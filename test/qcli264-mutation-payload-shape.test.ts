import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./helpers/spawn.ts";

/**
 * QCLI-264. Mutating commands used to disagree about where the written record
 * lives in the envelope: `task create`/`edit` put it in `data`, the lifecycle
 * and draft commands nested it under `data.task`/`data.draft` alongside the
 * repository `revision` and a second `kind: "success"`. A caller that read one
 * group could not read the other, and a `^status:` match over `--plain` passed
 * silently on an edit while missing a complete.
 *
 * This pins the agreed shape across every group the ruling covers, so the
 * split cannot come back one command at a time.
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
  return JSON.parse(run.stdout) as {
    kind: string;
    data: Record<string, unknown>;
  };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli264-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

test("every single-record mutating command carries the written record directly in data (QCLI-264)", async () => {
  const root = await workspace();
  try {
    // One command from each group that the ruling converged: create/edit,
    // the task lifecycle, and drafts.
    const cases: {
      readonly label: string;
      readonly argv: readonly string[];
    }[] = [
      { label: "task create", argv: ["task", "create", "Shape probe"] },
      {
        label: "task edit",
        argv: ["task", "edit", "T-1", "--description", "probe"],
      },
      { label: "task start", argv: ["task", "start", "T-1"] },
      { label: "task pause", argv: ["task", "pause", "T-1"] },
      { label: "task start (resume)", argv: ["task", "start", "T-1"] },
      { label: "task complete", argv: ["task", "complete", "T-1"] },
      { label: "task archive", argv: ["task", "archive", "T-1"] },
    ];

    for (const { label, argv } of cases) {
      const { kind, data } = envelope(root, [...argv, ...HUMAN]);
      // The record itself, not a wrapper around it.
      expect({ label, id: data.id, status: typeof data.status }).toEqual({
        label,
        id: "T-1",
        status: "string",
      });
      // No wrapper leaks: no nested record, no repository revision hash, and
      // no second `kind` shadowing the envelope's own semantic kind.
      expect({
        label,
        task: "task" in data,
        draft: "draft" in data,
        revision: "revision" in data,
        nestedKind: "kind" in data,
      }).toEqual({
        label,
        task: false,
        draft: false,
        revision: false,
        nestedKind: false,
      });
      expect(kind.startsWith("task.")).toBe(true);
    }

    // Drafts: create returns the draft, promote returns the task it became.
    const draft = envelope(root, ["draft", "create", "An idea", ...HUMAN]);
    expect({
      kind: draft.kind,
      id: draft.data.id,
      wrapped: "draft" in draft.data || "revision" in draft.data,
    }).toEqual({ kind: "draft.created", id: "D-1", wrapped: false });

    const promoted = envelope(root, ["draft", "promote", "D-1", ...HUMAN]);
    expect({
      kind: promoted.kind,
      status: typeof promoted.data.status,
      wrapped: "task" in promoted.data || "revision" in promoted.data,
    }).toEqual({ kind: "draft.promoted", status: "string", wrapped: false });

    const archivable = envelope(root, [
      "draft",
      "create",
      "To archive",
      ...HUMAN,
    ]);
    const archivedDraft = envelope(root, [
      "draft",
      "archive",
      archivable.data.id as string,
      ...HUMAN,
    ]);
    expect({
      kind: archivedDraft.kind,
      id: archivedDraft.data.id,
      wrapped: "draft" in archivedDraft.data,
    }).toEqual({
      kind: "draft.archived",
      id: archivable.data.id,
      wrapped: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("--plain renders the record's own fields for a lifecycle move, not a wrapper (QCLI-264)", async () => {
  const root = await workspace();
  try {
    quest(root, ["task", "create", "Plain probe", ...HUMAN, "--json"]);
    quest(root, ["task", "start", "T-1", ...HUMAN, "--json"]);

    const edited = quest(root, [
      "task",
      "edit",
      "T-1",
      "--description",
      "probe",
      ...HUMAN,
      "--plain",
    ]);
    const completed = quest(root, [
      "task",
      "complete",
      "T-1",
      ...HUMAN,
      "--plain",
    ]);

    // The reported defect exactly: a top-level `status:` line appeared for an
    // edit and not for a complete.
    const topLevelStatus = (stdout: string) =>
      stdout.split("\n").filter((line) => line.startsWith("status: "));
    expect(topLevelStatus(edited.stdout)).toEqual(["status: In Progress"]);
    expect(topLevelStatus(completed.stdout)).toEqual(["status: Done"]);
    expect(completed.stdout).not.toContain("kind: success");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("task edit-batch keeps its declared revision (QCLI-264 scope)", async () => {
  // The batch envelope is the deliberate exception: `data.revision` is part of
  // its contract, so the QCLI-264 sweep must not strip it along with the
  // lifecycle wrappers.
  //
  // Why it is kept, stated precisely so this pin does not outlive its reason:
  // it is the workspace revision the batch committed at, which a caller needs
  // for its own bounded retry after a conflict, and QCLI-122 has pinned it
  // since it was introduced. NOT because a sibling repo depends on it -- the
  // only fleet read of it (opum-cli-e2e bin/opum-e2e-scale.mjs:312) is one
  // interpolation in a progress log line; that harness pages off its own chunk
  // bookkeeping. An earlier revision of this comment claimed otherwise.
  const root = await workspace();
  try {
    quest(root, ["task", "create", "Batch probe", ...HUMAN, "--json"]);
    const file = join(root, "ops.jsonl");
    await Bun.write(
      file,
      `${JSON.stringify({
        reference: "T-1",
        operationId: "op-1",
        patch: { description: "batched" },
      })}\n`,
    );
    const { kind, data } = envelope(root, [
      "task",
      "edit-batch",
      "--file",
      file,
      ...HUMAN,
    ]);
    expect(kind).toBe("task.batch-updated");
    expect(typeof data.revision).toBe("string");
    expect((data.revision as string).length).toBe(64);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
