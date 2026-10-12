import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * QCLI-462 / DEC-161 (k). A bound's omission marker must SURVIVE projection.
 *
 * The bug: the `--fields` projection copied only the named fields, so
 * `task view <id> --max-notes 0 --fields implementationNotes --json` returned
 * `data {implementationNotes: []}` with NO `notesOmitted`, while `--max-notes 0`
 * alone returned `notesOmitted: 1`. The cap told the caller notes were cut and
 * then, under a projection that named the capped field, hid that fact.
 *
 * The ruling: when a bound is supplied AND the projection names the bounded
 * field, the marker is emitted BESIDE the projected keys, under the same key
 * name it has in unprojected output. When the projection does not name the
 * bounded field, no marker is emitted -- nothing the caller asked for was cut.
 * `task view --fields` and `task list --fields` behave the same way (one shared
 * projection helper). DEC-161 (h) is unchanged: a projection itself reports no
 * `fieldsOmitted` -- that key is never emitted.
 *
 * The load-bearing invariants that must NOT break: the DEFAULT `task view` (no
 * `--fields`) and `task view --max-notes N` (no `--fields`) are unchanged, and
 * `task list`'s projection stays exactly the named keys (it has no field-level
 * bound -- its `--limit` bounds the array, not a field).
 */

const RUN = (cwd: string, args: readonly string[]) =>
  Bun.spawnSync(
    [
      process.execPath,
      "run",
      join(import.meta.dir, "../src/cli/main.ts"),
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );

function git(cwd: string, ...args: readonly string[]) {
  const child = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${child.stderr.toString()}`);
  return child.stdout.toString().trim();
}

const ACTOR = ["--actor", "t", "--actor-kind", "human", "--json"] as const;

function envelope(cwd: string, args: readonly string[]) {
  const result = RUN(cwd, [...args, "--json"]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout.toString());
}

/** T-1 carries two implementation notes; T-2 carries none. */
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "quest-bound-marker-"));
  git(root, "init", "-q", "-b", "dev", ".");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  RUN(root, ["init", "--name", "Probe", "--task-id-prefix", "T", "--json"]);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  RUN(root, ["task", "create", "first task", ...ACTOR]);
  RUN(root, ["task", "create", "second task", ...ACTOR]);
  RUN(root, ["task", "edit", "T-1", "--add-note", "note one", ...ACTOR]);
  RUN(root, ["task", "edit", "T-1", "--add-note", "note two", ...ACTOR]);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "T-1, T-2");
  return root;
}

// ---------------------------------------------------------------------------
// task view -- the marker is emitted when the bounded field is named
// ---------------------------------------------------------------------------

test("task view --max-notes N --fields implementationNotes,id emits notesOmitted beside the named keys", async () => {
  const root = await repository();
  try {
    const result = envelope(root, [
      "task",
      "view",
      "T-1",
      "--max-notes",
      "1",
      "--fields",
      "implementationNotes,id",
    ]);
    expect(Object.keys(result.data).sort()).toEqual([
      "id",
      "implementationNotes",
      "notesOmitted",
    ]);
    expect(result.data.id).toBe("T-1");
    expect(result.data.implementationNotes).toEqual(["note two"]);
    expect(result.data.notesOmitted).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task view --max-notes N --fields id,status is exactly {id,status} -- NO marker when the bounded field is not named", async () => {
  const root = await repository();
  try {
    const result = envelope(root, [
      "task",
      "view",
      "T-1",
      "--max-notes",
      "1",
      "--fields",
      "id,status",
    ]);
    expect(Object.keys(result.data)).toEqual(["id", "status"]);
    expect(Object.hasOwn(result.data, "notesOmitted")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task view --fields implementationNotes with NO --max-notes is exactly {implementationNotes} -- no bound, no marker", async () => {
  const root = await repository();
  try {
    const result = envelope(root, [
      "task",
      "view",
      "T-1",
      "--fields",
      "implementationNotes",
    ]);
    expect(Object.keys(result.data)).toEqual(["implementationNotes"]);
    // The full, unbounded notes are projected.
    expect(result.data.implementationNotes.length).toBe(2);
    expect(Object.hasOwn(result.data, "notesOmitted")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the exact repro: task view --max-notes 0 --fields implementationNotes is {implementationNotes: [], notesOmitted: 2}", async () => {
  const root = await repository();
  try {
    const result = envelope(root, [
      "task",
      "view",
      "T-1",
      "--max-notes",
      "0",
      "--fields",
      "implementationNotes",
    ]);
    expect(Object.keys(result.data).sort()).toEqual([
      "implementationNotes",
      "notesOmitted",
    ]);
    expect(result.data.implementationNotes).toEqual([]);
    // The marker is copied from the record, not recomputed from the projection.
    expect(result.data.notesOmitted).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// task view -- the DEFAULT and --max-notes-only paths are unchanged
// ---------------------------------------------------------------------------

test("the default task view (no --fields) is UNPROJECTED and carries no notesOmitted", async () => {
  const root = await repository();
  try {
    const result = envelope(root, ["task", "view", "T-1"]);
    // Not projected: the full record, far more than the named-field test set.
    expect(Object.keys(result.data).length).toBeGreaterThan(3);
    expect(typeof result.data.revision).toBe("string");
    expect(result.data.implementationNotes.length).toBe(2);
    // DEC-3: notesOmitted is present only when --max-notes was supplied.
    expect(Object.hasOwn(result.data, "notesOmitted")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task view --max-notes N (no --fields) keeps its own unprojected shape and notesOmitted", async () => {
  const root = await repository();
  try {
    const result = envelope(root, ["task", "view", "T-1", "--max-notes", "1"]);
    expect(result.data.implementationNotes).toEqual(["note two"]);
    expect(result.data.notesOmitted).toBe(1);
    // No projection: the record still carries the full key set and revision.
    expect(typeof result.data.revision).toBe("string");
    expect(Object.keys(result.data).length).toBeGreaterThan(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// task list -- no field-level bound, so its projection is never anything else
// ---------------------------------------------------------------------------

test("task list --fields id,status is exactly {id,status} -- never a marker", async () => {
  const root = await repository();
  try {
    const result = envelope(root, ["task", "list", "--fields", "id,status"]);
    expect(result.data.length).toBe(2);
    for (const item of result.data) {
      expect(Object.keys(item).sort()).toEqual(["id", "status"]);
      expect(Object.hasOwn(item, "notesOmitted")).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task list --fields with --limit stays exactly the named keys, unchanged", async () => {
  const root = await repository();
  try {
    const result = envelope(root, [
      "task",
      "list",
      "--limit",
      "1",
      "--fields",
      "id",
    ]);
    expect(result.data.length).toBe(1);
    expect(Object.keys(result.data[0])).toEqual(["id"]);
    expect(Object.hasOwn(result.data[0], "notesOmitted")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// DEC-161 (h): a projection reports no `fieldsOmitted`, anywhere
// ---------------------------------------------------------------------------

test("no projection anywhere emits a `fieldsOmitted` key", async () => {
  const root = await repository();
  try {
    const outputs = [
      envelope(root, [
        "task",
        "view",
        "T-1",
        "--max-notes",
        "1",
        "--fields",
        "implementationNotes,id",
      ]),
      envelope(root, [
        "task",
        "view",
        "T-1",
        "--max-notes",
        "1",
        "--fields",
        "id,status",
      ]),
      envelope(root, [
        "task",
        "view",
        "T-1",
        "--fields",
        "implementationNotes",
      ]),
      envelope(root, ["task", "list", "--fields", "id,status"]),
    ];
    for (const output of outputs) {
      expect(Object.hasOwn(output, "fieldsOmitted")).toBe(false);
      expect(JSON.stringify(output)).not.toContain("fieldsOmitted");
      const data = output.data;
      const records = Array.isArray(data) ? data : [data];
      for (const record of records)
        expect(Object.hasOwn(record, "fieldsOmitted")).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The human (TAB-separated) form is the named columns ONLY -- the marker is a
// JSON-side sibling, not a column
// ---------------------------------------------------------------------------

test("task view --max-notes --fields --plain renders exactly the named columns, the marker is NOT a column", async () => {
  const root = await repository();
  try {
    const plain = RUN(root, [
      "task",
      "view",
      "T-1",
      "--max-notes",
      "1",
      "--fields",
      "implementationNotes,id",
      "--plain",
    ]).stdout.toString();
    const lines = plain.split("\n").filter((line) => line.includes("\t"));
    expect(lines.length).toBe(1);
    const cells = lines[0].split("\t");
    // implementationNotes (a JSON array) then id -- exactly the two named
    // fields, no third cell for notesOmitted.
    expect(cells.length).toBe(2);
    expect(cells[0]).toBe(JSON.stringify(["note two"]));
    expect(cells[1]).toBe("T-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
