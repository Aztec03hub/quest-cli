import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/**
 * QCLI-436: the `migrate-from-backlog` skill walks the person through
 * `quest migration backlog`, and three of the things it promises are
 * ABSENCES -- preview writes nothing, a digest other than the one just
 * previewed is not applied, and rollback gives the tree back.
 *
 * An absence is the shape a broken run passes for free: a migration that
 * read nothing writes nothing and looks exactly like one that read
 * everything and correctly withheld it. So every absence below is checked
 * beside a positive control in the same test -- the same run has to show
 * it found the records, or applied the digest, or changed something for
 * rollback to give back. Without that, "wrote nothing" is satisfied by a
 * no-op.
 *
 * Everything runs against a throwaway repository with a small backlog/,
 * because the claim is about what the lifecycle does to a working tree.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const SKILL = new URL(
  "../skills/migrate-from-backlog/SKILL.md",
  import.meta.url,
).pathname;
const QUEST_SKILL = new URL("../skills/quest/SKILL.md", import.meta.url)
  .pathname;
const PERSON = ["--actor", "person-1", "--actor-kind", "human"] as const;
/** `--source` names the project directory, not a project name; the fixture is the repo. */
const SOURCE = ".";

/** A task in Backlog.md's own frontmatter shape. */
function backlogTask(id: string, title: string, status: string): string {
  return `---
id: ${id}
title: ${title}
status: ${status}
created_date: '2026-01-01T00:00:00Z'
---

<!-- AC:BEGIN -->
- [ ] #1 ${title} is checked
<!-- AC:END -->
`;
}

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

/** Runs a command that must succeed, and returns its envelope. */
function envelope(workspace: string, args: readonly string[]) {
  const run = quest(workspace, [...args, "--json"]);
  expect({
    args: args.join(" "),
    exitCode: run.exitCode,
    stderr: run.stderr,
  }).toEqual({ args: args.join(" "), exitCode: 0, stderr: "" });

  return JSON.parse(run.stdout) as { kind: string; data: never };
}

/**
 * Every FILE in the working tree, path -> contents. Directories are left out
 * (they are not what a person commits) and so is `.git`, whose bookkeeping
 * moves for reasons that have nothing to do with the migration.
 */
async function tree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of (await readdir(root, { recursive: true })) as string[]) {
    const path = join(root, entry);
    if (relative(root, path).startsWith(".git")) continue;
    if (!(await stat(path)).isFile()) continue;
    files[entry] = await readFile(path, "utf8");
  }

  return files;
}

/** A repository holding a two-record Backlog.md project and a Quest workspace. */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qcli436-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  for (const folder of ["tasks", "completed"]) {
    await mkdir(join(root, "backlog", folder), { recursive: true });
  }
  await writeFile(
    join(root, "backlog", "tasks", "task-1.md"),
    backlogTask("TASK-1", "Active task", "In Progress"),
  );
  await writeFile(
    join(root, "backlog", "completed", "task-2.md"),
    backlogTask("TASK-2", "Completed task", "Done"),
  );
  expect(quest(root, ["init"]).exitCode).toBe(0);

  return root;
}

const previewArgs = ["migration", "backlog", "preview", "--source", SOURCE];
const applyArgs = (digest: string) => [
  "migration",
  "backlog",
  "apply",
  "--source",
  SOURCE,
  "--digest",
  digest,
  ...PERSON,
];

test("preview writes nothing, and says what it found (QCLI-436)", async () => {
  const root = await fixture();
  try {
    const before = await tree(root);
    const { kind, data } = envelope(root, previewArgs);
    const after = await tree(root);

    // The absence, and the control beside it: the run has to have READ the
    // project, or "wrote nothing" would pass for a preview doing nothing.
    expect(after).toEqual(before);
    expect(kind).toBe("migration.backlog-preview");
    const mappings = (data as unknown as { mappings: unknown[] }).mappings;
    expect(mappings.length).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a digest from a changed source is refused, and the current one applies (QCLI-436)", async () => {
  const root = await fixture();
  try {
    const first = envelope(root, previewArgs);
    const staleDigest = (first.data as unknown as { digest: string }).digest;

    // The source moves under the preview, which is what makes the digest
    // stale -- a digest is only good for the source state it was minted from.
    await writeFile(
      join(root, "backlog", "tasks", "task-3.md"),
      backlogTask("TASK-3", "Added after the preview", "To Do"),
    );

    const refused = quest(root, [
      ...applyArgs(staleDigest),
      "--json",
    ] as string[]);
    expect(refused.exitCode).not.toBe(0);
    // Measured, not assumed: `apply` re-derives the plan from the source as it
    // now stands, so a stale digest fails the approval check rather than the
    // fingerprint one that would follow it -- the plan it rebuilt no longer
    // hashes to what was approved. Either way the write is refused.
    expect(refused.stdout + refused.stderr).toContain(
      "migration_approval_digest_mismatch",
    );
    // The refusal left the tree alone: a guard that refuses after writing is
    // not a guard.
    expect((await tree(root))["backlog/tasks/task-3.md"]).toBeDefined();

    // The control: re-previewed against the source as it now stands, the
    // digest applies. Without this the refusal above could be any failure.
    const second = envelope(root, previewArgs);
    const freshDigest = (second.data as unknown as { digest: string }).digest;
    expect(freshDigest).not.toBe(staleDigest);
    const applied = envelope(root, applyArgs(freshDigest));
    expect(applied.kind).toBe("migration.backlog-applied");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status reports the applied mappings (QCLI-436)", async () => {
  const root = await fixture();
  try {
    const digest = (
      envelope(root, previewArgs).data as unknown as { digest: string }
    ).digest;
    envelope(root, applyArgs(digest));

    const { kind, data } = envelope(root, [
      "migration",
      "backlog",
      "status",
      "--digest",
      digest,
    ]);
    const status = data as unknown as {
      digest: string;
      mappings?: unknown[];
      phase?: string;
    };
    // The control is the digest coming back: a status that reported nothing
    // would satisfy a weaker check.
    expect(kind).toBe("migration.backlog-status");
    expect(status.digest).toBe(digest);
    expect(JSON.stringify(status)).toContain("TASK-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rollback gives the tree back (QCLI-436)", async () => {
  const root = await fixture();
  try {
    const before = await tree(root);
    const digest = (
      envelope(root, previewArgs).data as unknown as { digest: string }
    ).digest;
    envelope(root, applyArgs(digest));

    // The control: the apply has to have changed the tree, or "restored"
    // would be indistinguishable from "never did anything".
    const applied = await tree(root);
    expect(applied).not.toEqual(before);
    expect(
      Object.keys(applied).filter((one) => one.startsWith(".quest/tasks/")),
    ).not.toEqual([]);

    envelope(root, [
      "migration",
      "backlog",
      "rollback",
      "--digest",
      digest,
      ...PERSON,
    ]);

    // Rollback gives the records back, and EVERYTHING that was there before is
    // there again unchanged -- including the Backlog source, which the
    // lifecycle never touches.
    //
    // Stated as "everything before is still here" rather than "the tree is
    // equal", because the tree is NOT equal and pretending otherwise would be
    // the test lying: a rolled-back migration leaves its own receipt under
    // .quest/migrations/ (that is how `status --digest` can still answer) and
    // an empty .quest/planning.json. Neither is a record, and neither is
    // something rollback should take away.
    const after = await tree(root);
    for (const [path, contents] of Object.entries(before)) {
      expect({ path, contents: after[path] }).toEqual({ path, contents });
    }
    // What it did undo: the migrated records are gone rather than left behind
    // half-rolled-back.
    expect(
      Object.keys(after).filter((one) => one.startsWith(".quest/tasks/")),
    ).toEqual([]);
    expect(
      Object.keys(after).filter((one) => one.startsWith(".quest/migrations/")),
    ).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the skill states what it never does, and names the whole lifecycle (QCLI-436)", async () => {
  const skill = await readFile(SKILL, "utf8");

  // Controls first, so a check below cannot pass on an empty or wrong file:
  // the skill has to be the migration skill, naming all four steps and the
  // two approval points.
  for (const named of [
    "migration backlog preview",
    "migration backlog apply",
    "migration backlog status",
    "migration backlog rollback",
    "AskUserQuestion",
    "--actor-kind human",
  ]) {
    expect({ named, found: skill.includes(named) }).toEqual({
      named,
      found: true,
    });
  }

  // The three refusals, each stated rather than left to inference.
  expect(skill).toContain("Never deletes `backlog/`");
  expect(skill).toContain("Never commits.");
  expect(skill).toMatch(
    /Never applies a digest other than the one just previewed/,
  );
  // And the one thing a person must be told rather than shielded from: the
  // source is theirs to remove, so the skill has to hand that back by name.
  expect(skill).toMatch(/person's to remove/);

  // The quest skill points at it, so migration intent finds it without the
  // general skill growing a migration section.
  expect(await readFile(QUEST_SKILL, "utf8")).toContain("migrate-from-backlog");
});

test("the skill's id choice is a real branch of the lifecycle (QCLI-436)", async () => {
  const root = await fixture();
  try {
    // The skill offers keeping Backlog's own ids; that path has to work, or
    // the choice it asks the person to make is not one.
    const args = [
      ...previewArgs,
      "--preserve-source-ids",
      "--source-family",
      "TASK",
    ];
    const { data } = envelope(root, args);
    const mappings = (
      data as unknown as { mappings: { targetIdentifier: string }[] }
    ).mappings;
    expect(mappings.map((one) => one.targetIdentifier).sort()).toEqual([
      "TASK-1",
      "TASK-2",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
