import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * QCLI-291 / DEC-161. `task list --fields` (QCLI-312) is the ONE projection
 * mechanism; this extends the SAME flag to `task view`, so a caller has one
 * `--fields` across both read commands. The projection is `data` narrowed to
 * EXACTLY the named top-level keys, in the caller's order -- a named-but-absent
 * field is emitted as `null` (key present, never dropped) -- with the human
 * form one TAB-separated line in that order. No `fieldsOmitted` metadata: a
 * projection is the caller's own selection, not a bound.
 *
 * The load-bearing invariant: with no `--fields`, `task view` stays
 * byte-for-byte what it was (revision present, `--max-notes` behavior intact).
 * Every projection assertion is paired with a default-output check that the
 * new machinery did not leak into it. `--fields` composes with `--max-notes`:
 * the note cap is applied first, then the projection.
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
  const root = await mkdtemp(join(tmpdir(), "quest-view-fields-"));
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
// The default read must stay unchanged
// ---------------------------------------------------------------------------

test("the default task view is unprojected: revision present, no notesOmitted", async () => {
  const root = await repository();
  try {
    const result = envelope(root, ["task", "view", "T-1"]);
    // The projection did not leak into the default read: the record carries
    // many more than two keys, and the revision rides along.
    expect(typeof result.data.revision).toBe("string");
    expect(Object.keys(result.data).length).toBeGreaterThan(3);
    expect(result.data.implementationNotes.length).toBe(2);
    // DEC-3: notesOmitted is present only when --max-notes was supplied.
    expect(Object.hasOwn(result.data, "notesOmitted")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the default human form is NOT a tab-separated line", async () => {
  const root = await repository();
  try {
    const plain = RUN(root, [
      "task",
      "view",
      "T-1",
      "--plain",
    ]).stdout.toString();
    // Without --fields the nested default renderer is used, not a TAB row.
    expect(plain.split("\n")[0]).not.toContain("\t");
    expect(plain).toContain("T-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --fields projects data to EXACTLY the named keys
// ---------------------------------------------------------------------------

test("--fields id,status --json projects data to EXACTLY the named keys", async () => {
  const root = await repository();
  try {
    const result = envelope(root, [
      "task",
      "view",
      "T-1",
      "--fields",
      "id,status",
    ]);
    expect(Object.keys(result.data).sort()).toEqual(["id", "status"]);
    expect(result.data.id).toBe("T-1");
    // `revision` was not named, so it is dropped -- the key set is exactly the
    // named set, nothing more.
    expect(Object.hasOwn(result.data, "revision")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a declared field ABSENT from the record is emitted as null with the key PRESENT", async () => {
  const root = await repository();
  try {
    // `assignees` is advertised by `quest manifest --json` for `task view`, yet
    // the fixture task was created without one. The projection must PRESENT it
    // as null rather than drop it: a dropped key is indistinguishable from one
    // the caller never asked for.
    const result = envelope(root, [
      "task",
      "view",
      "T-1",
      "--fields",
      "id,assignees",
    ]);
    expect(Object.keys(result.data).sort()).toEqual(["assignees", "id"]);
    expect(Object.hasOwn(result.data, "assignees")).toBe(true);
    expect(result.data.assignees).toBeNull();
    expect(result.data.assignees).not.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a declared field holding an EMPTY ARRAY is preserved as [], never coerced to null", async () => {
  const root = await repository();
  try {
    // `labels` is declared for `task view`; a task with no labels carries [].
    // The projection does `record[field] ?? null`, and `[]` is NOT nullish, so
    // the empty array must survive as [] -- it is data, not an absence.
    const result = envelope(root, [
      "task",
      "view",
      "T-1",
      "--fields",
      "id,labels",
    ]);
    expect(Object.hasOwn(result.data, "labels")).toBe(true);
    expect(Array.isArray(result.data.labels)).toBe(true);
    expect(result.data.labels).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The human form is one TAB-separated line in the named order
// ---------------------------------------------------------------------------

test("--plain --fields is ONE TAB-separated line in the named order", async () => {
  const root = await repository();
  try {
    const plain = RUN(root, [
      "task",
      "view",
      "T-1",
      "--fields",
      "status,id",
      "--plain",
    ]).stdout.toString();
    const lines = plain.split("\n").filter((line) => line.length > 0);
    // Exactly one record, so exactly one line.
    expect(lines.length).toBe(1);
    const cells = lines[0].split("\t");
    expect(cells.length).toBe(2);
    // The caller named status before id, so the columns are status then id.
    expect(["To Do", "In Progress", "Done"]).toContain(cells[0]);
    expect(cells[1]).toBe("T-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--plain renders an ABSENT projected field as an EMPTY column", async () => {
  const root = await repository();
  try {
    const plain = RUN(root, [
      "task",
      "view",
      "T-1",
      "--fields",
      "id,assignees",
      "--plain",
    ]).stdout.toString();
    const lines = plain.split("\n").filter((line) => line.includes("\t"));
    expect(lines.length).toBe(1);
    const cells = lines[0].split("\t");
    // Two columns, the absent one an empty cell -- not a dropped column.
    expect(cells.length).toBe(2);
    expect(cells[0]).toBe("T-1");
    expect(cells[1]).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Unknown field names and composition with --max-notes
// ---------------------------------------------------------------------------

test("an unknown field is a usage failure that LISTS the valid names", async () => {
  const root = await repository();
  try {
    const result = RUN(root, [
      "task",
      "view",
      "T-1",
      "--fields",
      "nope",
      "--json",
    ]);
    expect(result.exitCode).toBe(2);
    const error = JSON.parse(result.stderr.toString());
    expect(error.error_type).toBe("usage");
    expect(error.message).toContain("nope");
    // The remedy is in the message, not only in the docs.
    expect(error.message).toContain("Valid fields:");
    expect(error.message).toContain("id");
    expect(error.message).toContain("status");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--fields composes with --max-notes 0: the cap runs first, then the projection", async () => {
  const root = await repository();
  try {
    const result = envelope(root, [
      "task",
      "view",
      "T-1",
      "--max-notes",
      "0",
      "--fields",
      "id,implementationNotes,notesOmitted",
    ]);
    expect(Object.keys(result.data).sort()).toEqual([
      "id",
      "implementationNotes",
      "notesOmitted",
    ]);
    // The zero cap dropped both notes; the projection then kept exactly the
    // named keys.
    expect(result.data.implementationNotes).toEqual([]);
    expect(result.data.notesOmitted).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--max-notes 0 with a projection that omits implementationNotes does NOT error", async () => {
  const root = await repository();
  try {
    const result = envelope(root, [
      "task",
      "view",
      "T-1",
      "--max-notes",
      "0",
      "--fields",
      "id",
    ]);
    expect(Object.keys(result.data)).toEqual(["id"]);
    expect(result.data.id).toBe("T-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--max-notes without --fields keeps its own behavior unchanged", async () => {
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
