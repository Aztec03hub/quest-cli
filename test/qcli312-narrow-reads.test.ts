import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * QCLI-312 / DEC-161. Two halves of "there is no narrow read":
 *
 *   A. `task view --max-notes 0` was REJECTED -- a positive-integer grammar
 *      refused the one value that means "the record without its notes". It is
 *      now accepted, and the zero cap is special-cased because `slice(-0)` is
 *      `slice(0)`: the naive tail slice returned the WHOLE notes array with
 *      notesOmitted 0, i.e. the opposite of what the caller asked for.
 *
 *   B. `task list` had no projection: a caller that wanted three fields paid
 *      for the whole record of every task. `--fields a,b,c` projects each item
 *      to EXACTLY those keys (JSON) or one TAB-separated line per task in the
 *      named order (plain). DEC-161 ruled ONE projection mechanism -- `--fields`
 *      and no `--oneline` -- so the parser/validator is a reusable helper the
 *      identical flag on `task view` (QCLI-291) can share.
 *
 * The load-bearing invariants both halves must NOT break: with no flag, `task
 * view` and `task list` stay byte-for-byte what they were. Every default-output
 * assertion below is therefore paired with a positive check that the new
 * machinery did not leak into it.
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
  const root = await mkdtemp(join(tmpdir(), "quest-narrow-reads-"));
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
// HALF A -- task view --max-notes 0
// ---------------------------------------------------------------------------

test("task view --max-notes 0 is ACCEPTED, returns no notes, and reports all omitted", async () => {
  const root = await repository();
  try {
    const result = envelope(root, ["task", "view", "T-1", "--max-notes", "0"]);
    // The defect was exit 2 ("--max-notes must be a positive integer") for the
    // one cap that means "none of them".
    expect(result.data.implementationNotes).toEqual([]);
    // The zero cap dropped BOTH notes. `slice(-0)` would have kept both and
    // reported notesOmitted 0 -- the bug this branch exists for.
    expect(result.data.notesOmitted).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a positive --max-notes still takes the tail slice", async () => {
  const root = await repository();
  try {
    const result = envelope(root, ["task", "view", "T-1", "--max-notes", "1"]);
    expect(result.data.implementationNotes.map((note: string) => note)).toEqual(
      ["note two"],
    );
    expect(result.data.notesOmitted).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the default task view returns every note and carries NO notesOmitted key", async () => {
  const root = await repository();
  try {
    const result = envelope(root, ["task", "view", "T-1"]);
    expect(result.data.implementationNotes.length).toBe(2);
    // DEC-3: notesOmitted is present whenever --max-notes was supplied, absent
    // otherwise. The unbounded read must not gain the key.
    expect(Object.hasOwn(result.data, "notesOmitted")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HALF B -- task list --fields
// ---------------------------------------------------------------------------

test("--fields projects each JSON item to EXACTLY the named keys", async () => {
  const root = await repository();
  try {
    const full = envelope(root, ["task", "list"]);
    const projected = envelope(root, [
      "task",
      "list",
      "--fields",
      "id,status,title",
    ]);
    // Same order as the default listing -- the projection is a per-item
    // narrowing, not a re-sort or a re-filter.
    expect(projected.data.map((t: { id: string }) => t.id)).toEqual(
      full.data.map((t: { id: string }) => t.id),
    );
    for (const item of projected.data) {
      // EXACTLY the named set: no extra keys, none missing.
      expect(Object.keys(item).sort()).toEqual(["id", "status", "title"]);
    }
    // The default listing is NOT narrowed -- proof the flag did not leak.
    expect(Object.keys(full.data[0]).length).toBeGreaterThan(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--plain --fields is one TAB-separated line per task, in the named order", async () => {
  const root = await repository();
  try {
    const plain = RUN(root, [
      "task",
      "list",
      "--fields",
      "status,id",
      "--plain",
    ]).stdout.toString();
    const lines = plain.split("\n").filter((line) => line.includes("\t"));
    expect(lines.length).toBe(2);
    // The caller named status before id, so the columns are status then id.
    const first = lines[0].split("\t");
    expect(first.length).toBe(2);
    expect(["Done", "To Do", "In Progress"]).toContain(first[0]);
    expect(first[1]).toMatch(/^T-\d+$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a declared field ABSENT from a record is emitted as null with the key PRESENT", async () => {
  const root = await repository();
  try {
    // `assignees` is advertised by `quest manifest --json` for `task list`,
    // yet the fixture tasks were created without one, so the record carries no
    // such key. The projection must PRESENT it as null rather than drop it: a
    // dropped key is indistinguishable from one the caller never asked for, so
    // the key SET would no longer be the named set.
    const projected = envelope(root, [
      "task",
      "list",
      "--fields",
      "id,assignees",
    ]);
    expect(projected.data.length).toBe(2);
    for (const item of projected.data) {
      // Present AND null -- not an absent key, and not `undefined`.
      expect(Object.keys(item)).toContain("assignees");
      expect(Object.hasOwn(item, "assignees")).toBe(true);
      expect(item.assignees).toBeNull();
      expect(item.assignees).not.toBeUndefined();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--plain renders an ABSENT projected field as an EMPTY column, one row per task", async () => {
  const root = await repository();
  try {
    const plain = RUN(root, [
      "task",
      "list",
      "--fields",
      "id,assignees",
      "--plain",
    ]).stdout.toString();
    const lines = plain.split("\n").filter((line) => line.includes("\t"));
    // One row per task; each ends in an empty second cell (the trailing TAB),
    // not a dropped column.
    expect(lines.length).toBe(2);
    for (const line of lines) {
      const cells = line.split("\t");
      expect(cells.length).toBe(2);
      expect(cells[0]).toMatch(/^T-\d+$/);
      expect(cells[1]).toBe("");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a declared field holding an EMPTY ARRAY is preserved as [], never coerced to null", async () => {
  const root = await repository();
  try {
    // `labels` is declared for `task list`; a task with no labels carries [].
    // The projection does `record[field] ?? null`, and `[]` is NOT nullish, so
    // the empty array must survive as [] -- it is data, not an absence.
    const projected = envelope(root, ["task", "list", "--fields", "id,labels"]);
    expect(projected.data.length).toBe(2);
    for (const item of projected.data) {
      expect(Object.hasOwn(item, "labels")).toBe(true);
      expect(Array.isArray(item.labels)).toBe(true);
      expect(item.labels).toEqual([]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty --fields projection keeps the established (empty) marker", async () => {
  const root = await repository();
  try {
    const plain = RUN(root, [
      "task",
      "list",
      "--search",
      "zzz-no-such-title",
      "--fields",
      "id",
      "--plain",
    ]).stdout.toString();
    expect(plain).toContain("(empty)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unknown field is a usage failure that LISTS the valid names", async () => {
  const root = await repository();
  try {
    const result = RUN(root, ["task", "list", "--fields", "nope", "--json"]);
    expect(result.exitCode).toBe(2);
    const error = JSON.parse(result.stderr.toString());
    expect(error.error_type).toBe("usage");
    expect(error.message).toContain("nope");
    // The remedy is in the message, not only in the docs.
    expect(error.message).toContain("Valid fields:");
    expect(error.message).toContain("id");
    expect(error.message).toContain("status");
    expect(error.message).toContain("title");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--fields composes with the existing filters", async () => {
  const root = await repository();
  try {
    const result = envelope(root, [
      "task",
      "list",
      "--status",
      "To Do",
      "--fields",
      "id,status",
    ]);
    for (const item of result.data) expect(item.status).toBe("To Do");
    expect(result.data.length).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the default task list is unchanged and its envelope key order still ends at principal", async () => {
  const root = await repository();
  try {
    const result = envelope(root, ["task", "list"]);
    expect(Object.keys(result)).toEqual([
      "schemaVersion",
      "contractVersion",
      "kind",
      "data",
      "scope",
      "principal",
    ]);
    // Without --fields the nested human form is the default: a bare `-` bullet,
    // not a tab-separated line.
    const plain = RUN(root, ["task", "list", "--plain"]).stdout.toString();
    expect(plain).toContain("-");
    expect(plain.split("\n")[0]).not.toContain("\t");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC1 -- the projection is a MEASURED byte reduction, not an asserted one
// ---------------------------------------------------------------------------

/**
 * Three tasks, each carrying ~11 KB of implementationNotes, so the FULL
 * listing is well past 20 KB and the byte comparison below cannot be satisfied
 * by two near-empty strings. `repository()`'s two small tasks are too short to
 * measure against; this is a dedicated bulky fixture.
 */
async function bulkyRepository() {
  const root = await mkdtemp(join(tmpdir(), "quest-narrow-reads-bulk-"));
  git(root, "init", "-q", "-b", "dev", ".");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  RUN(root, ["init", "--name", "Probe", "--task-id-prefix", "T", "--json"]);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  const note = (label: string) =>
    `${label}: ${"the quick brown fox jumps over the lazy dog. ".repeat(80)}`;
  for (let index = 1; index <= 3; index += 1) {
    RUN(root, ["task", "create", `task ${index}`, ...ACTOR]);
    const id = `T-${index}`;
    for (const ordinal of ["one", "two", "three"])
      RUN(root, [
        "task",
        "edit",
        id,
        "--add-note",
        note(`note-${ordinal}-${id}`),
        ...ACTOR,
      ]);
  }
  git(root, "add", "-A");
  git(root, "commit", "-qm", "three bulky tasks");
  return root;
}

test("AC1: --fields is a MEASURED byte reduction on a large three-task listing", async () => {
  const root = await bulkyRepository();
  try {
    const full = RUN(root, ["task", "list", "--limit", "3", "--plain"]);
    const projected = RUN(root, [
      "task",
      "list",
      "--limit",
      "3",
      "--fields",
      "id,status,title",
      "--plain",
    ]);
    const fullBytes = Buffer.byteLength(full.stdout);
    const projectedBytes = Buffer.byteLength(projected.stdout);
    // The full listing is COMFORTABLY large -- the comparison below is not
    // vacuous.
    expect(fullBytes).toBeGreaterThan(20000);
    // A LARGE reduction: an order of magnitude, not a rounding.
    expect(projectedBytes * 10).toBeLessThan(fullBytes);
    // Both sides actually carried the rows (a broken run would compare empties).
    expect(full.stdout.toString()).toContain("T-1");
    const projectedLines = projected.stdout
      .toString()
      .split("\n")
      .filter((line) => line.includes("\t"));
    expect(projectedLines.length).toBe(3);

    // The --json projection narrows the KEY SET the same way, so both output
    // modes are covered by the measurement.
    const projectedJson = envelope(root, [
      "task",
      "list",
      "--limit",
      "3",
      "--fields",
      "id,status,title",
    ]);
    expect(projectedJson.data.length).toBe(3);
    for (const item of projectedJson.data)
      expect(Object.keys(item).sort()).toEqual(["id", "status", "title"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
