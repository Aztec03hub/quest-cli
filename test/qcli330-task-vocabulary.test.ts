import { afterAll, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveVocabularyValue,
  VocabularyValueError,
} from "../src/domain/tasks/vocabulary.ts";

/**
 * QCLI-330, ruled by opum-doc ADR "Make quest's type and priority vocabulary
 * workspace-configured, with a canonical default", with the orchestrator's
 * option-A ruling of 2026-09-28: a workspace with no [tasks] table is OPEN.
 *
 * Each test names the acceptance criterion (or ruling constraint) it
 * exercises. Every CLI case runs the real CLI against a fresh temp
 * workspace; the temp root is realpath'd because on macOS tmpdir() sits
 * behind the /var -> /private/var symlink (QCLI-404).
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const ACTOR = ["--actor", "person-1", "--actor-kind", "human"] as const;
const DEFAULT_TYPES = [
  "feature",
  "bug",
  "chore",
  "docs",
  "enhancement",
  "spike",
];
const DEFAULT_PRIORITIES = ["low", "medium", "high", "critical"];
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function quest(cwd: string, args: readonly string[]) {
  const child = Bun.spawnSync([process.execPath, MAIN, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode ?? 0,
    stdout: child.stdout ? child.stdout.toString() : "",
    stderr: child.stderr ? child.stderr.toString() : "",
  };
}

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qcli330-")));
  roots.push(root);
  return root;
}

/** A freshly initialized workspace: init's own default [tasks] table. */
async function workspace(): Promise<string> {
  const root = await tempRoot();
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  // Positive control: every case below depends on init having run.
  expect(quest(root, ["init", "--json"]).exitCode).toBe(0);
  return root;
}

const tomlPath = (root: string) => join(root, ".quest", "workspace.toml");

async function writeToml(root: string, content: string) {
  await writeFile(tomlPath(root), content);
}

function create(root: string, title: string, ...extra: string[]) {
  return quest(root, ["task", "create", title, ...extra, ...ACTOR, "--json"]);
}

function manifestVocabulary(root: string) {
  const result = quest(root, ["manifest", "--json"]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout).data.taskVocabulary;
}

test("AC1 AC2: a fresh init writes the canonical default [tasks] table, and the type set omits `task`", async () => {
  const root = await workspace();
  const toml = await readFile(tomlPath(root), "utf8");
  expect(toml).toContain(
    '[tasks]\ntypes = ["feature", "bug", "chore", "docs", "enhancement", "spike"]\npriorities = ["low", "medium", "high", "critical"]\n',
  );
  expect(DEFAULT_TYPES).not.toContain("task");
});

test("AC4: the manifest reports a configured workspace's sets under data.taskVocabulary", async () => {
  const root = await workspace();
  expect(manifestVocabulary(root)).toEqual({
    types: DEFAULT_TYPES,
    priorities: DEFAULT_PRIORITIES,
  });
  // Inside data, never a new top-level key: the envelope order is unchanged.
  expect(
    Object.keys(JSON.parse(quest(root, ["manifest", "--json"]).stdout)),
  ).toEqual(["schemaVersion", "contractVersion", "kind", "data", "principal"]);
});

test("AC4: an OPEN field is null in the manifest, never an empty list -- unconfigured and one-field alike", async () => {
  const root = await workspace();
  await writeToml(root, "schemaVersion = 1\n");
  expect(manifestVocabulary(root)).toEqual({ types: null, priorities: null });
  await writeToml(root, 'schemaVersion = 1\n\n[tasks]\ntypes = ["story"]\n');
  expect(manifestVocabulary(root)).toEqual({
    types: ["story"],
    priorities: null,
  });
});

test("AC4: the manifest outside any workspace reports both fields open", async () => {
  const root = await tempRoot();
  expect(manifestVocabulary(root)).toEqual({ types: null, priorities: null });
});

test("AC3: task create refuses an out-of-set type with exit 6, names the allowed set, and writes nothing", async () => {
  const root = await workspace();
  const refused = create(root, "a", "--type", "task");
  expect(refused.exitCode).toBe(6);
  expect(JSON.parse(refused.stderr)).toMatchObject({
    error_type: "validation",
    input: { field: "type", value: "task", allowed: DEFAULT_TYPES },
  });
  const listed = JSON.parse(quest(root, ["task", "list", "--json"]).stdout);
  expect(listed.data).toEqual([]);
});

test("AC3: task create stores a case-only difference in the configured spelling", async () => {
  const root = await workspace();
  const created = create(root, "a", "--type", "Bug", "--priority", "HIGH");
  expect(created.exitCode).toBe(0);
  expect(JSON.parse(created.stdout).data).toMatchObject({
    type: "bug",
    priority: "high",
  });
});

test("AC3: task edit refuses an out-of-set priority and leaves the record byte-identical", async () => {
  const root = await workspace();
  expect(create(root, "a", "--priority", "low").exitCode).toBe(0);
  const record = join(root, ".quest", "tasks", "T-1.json");
  const before = await readFile(record, "utf8");
  const refused = quest(root, [
    "task",
    "edit",
    "T-1",
    "--priority",
    "urgent",
    ...ACTOR,
    "--json",
  ]);
  expect(refused.exitCode).toBe(6);
  expect(JSON.parse(refused.stderr).input).toMatchObject({
    field: "priority",
    value: "urgent",
  });
  expect(await readFile(record, "utf8")).toBe(before);
});

test("AC3: an edit that does not write type or priority lands on a record holding a legacy value", async () => {
  const root = await workspace();
  await writeToml(root, "schemaVersion = 1\n");
  expect(create(root, "a", "--type", "task").exitCode).toBe(0);
  await writeToml(
    root,
    `schemaVersion = 1\n\n[tasks]\ntypes = ${JSON.stringify(DEFAULT_TYPES)}\n`,
  );
  const edited = quest(root, [
    "task",
    "edit",
    "T-1",
    "--title",
    "renamed",
    ...ACTOR,
    "--json",
  ]);
  expect(edited.exitCode).toBe(0);
  expect(JSON.parse(edited.stdout).data).toMatchObject({
    title: "renamed",
    type: "task",
  });
});

test("AC3: task edit-batch fails only the item carrying an out-of-set value", async () => {
  const root = await workspace();
  expect(create(root, "a").exitCode).toBe(0);
  const operations = join(root, "ops.jsonl");
  await writeFile(
    operations,
    [
      { reference: "T-1", operationId: "o1", patch: { priority: "CRITICAL" } },
      { reference: "T-1", operationId: "o2", patch: { type: "nope" } },
      { reference: "T-1", operationId: "o3", patch: { title: "after" } },
    ]
      .map((item) => JSON.stringify(item))
      .join("\n"),
  );
  const result = quest(root, [
    "task",
    "edit-batch",
    "--file",
    operations,
    ...ACTOR,
    "--json",
  ]);
  const items = JSON.parse(result.stdout).data.items;
  expect(items.map((item: { kind: string }) => item.kind)).toEqual([
    "updated",
    "error",
    "updated",
  ]);
  expect(items[0].task.priority).toBe("critical");
  expect(items[1].message).toContain("task_vocabulary_value_invalid");
  expect(items[2].task).toMatchObject({ title: "after", priority: "critical" });
});

test("AC3 (option A): a workspace with no [tasks] table accepts any value, verbatim", async () => {
  const root = await workspace();
  await writeToml(root, "schemaVersion = 1\n");
  const created = create(
    root,
    "a",
    "--type",
    "anything",
    "--priority",
    "Whatever",
  );
  expect(created.exitCode).toBe(0);
  expect(JSON.parse(created.stdout).data).toMatchObject({
    type: "anything",
    priority: "Whatever",
  });
});

test("AC3: an open vocabulary (the default for any caller that reads no workspace.toml, migration included) passes every value through", () => {
  expect(resolveVocabularyValue("type", "task", {})).toBe("task");
  expect(resolveVocabularyValue("priority", "Medium", {})).toBe("Medium");
  expect(() =>
    resolveVocabularyValue("type", "task", { types: ["bug"] }),
  ).toThrow(VocabularyValueError);
});

test("AC6: doctor reports each off-set value in every location, marks a case-only difference, and rewrites nothing", async () => {
  const root = await workspace();
  await writeToml(root, "schemaVersion = 1\n");
  expect(
    create(root, "active", "--type", "task", "--priority", "High").exitCode,
  ).toBe(0);
  expect(create(root, "done", "--type", "spike").exitCode).toBe(0);
  expect(
    quest(root, ["task", "start", "T-2", ...ACTOR, "--json"]).exitCode,
  ).toBe(0);
  expect(
    quest(root, ["task", "complete", "T-2", ...ACTOR, "--json"]).exitCode,
  ).toBe(0);
  await writeToml(
    root,
    `schemaVersion = 1\n\n[tasks]\ntypes = ["bug"]\npriorities = ${JSON.stringify(DEFAULT_PRIORITIES)}\n`,
  );
  const active = join(root, ".quest", "tasks", "T-1.json");
  const completed = join(root, ".quest", "completed", "T-2.json");
  const before = [
    await readFile(active, "utf8"),
    await readFile(completed, "utf8"),
  ];

  const doctor = quest(root, ["doctor", "--json"]);
  expect(doctor.exitCode).toBe(0);
  const data = JSON.parse(doctor.stdout).data;
  expect(data.healthy).toBe(false);
  const issues = data.issues
    .filter(
      (issue: { code: string }) => issue.code === "task_vocabulary_off_set",
    )
    .map(({ hint, ...rest }: { hint: string }) => {
      expect(hint.length).toBeGreaterThan(0);
      return rest;
    });
  expect(issues).toEqual([
    {
      code: "task_vocabulary_off_set",
      taskId: "T-1",
      field: "type",
      value: "task",
    },
    {
      code: "task_vocabulary_off_set",
      taskId: "T-1",
      field: "priority",
      value: "High",
      normalizesTo: "high",
    },
    {
      code: "task_vocabulary_off_set",
      taskId: "T-2",
      field: "type",
      value: "spike",
    },
  ]);
  expect([
    await readFile(active, "utf8"),
    await readFile(completed, "utf8"),
  ]).toEqual(before);
});

test("AC6 (option A): doctor on a workspace with no [tasks] table reports no vocabulary issue", async () => {
  const root = await workspace();
  await writeToml(root, "schemaVersion = 1\n");
  expect(create(root, "a", "--type", "anything").exitCode).toBe(0);
  expect(JSON.parse(quest(root, ["doctor", "--json"]).stdout).data).toEqual({
    healthy: true,
    issues: [],
  });
});

test("ruling constraint 2: re-running init ADDS the default to a workspace that configures neither field", async () => {
  const root = await workspace();
  await writeToml(root, 'schemaVersion = 1\nname = "Kept"\n');
  expect(quest(root, ["init", "--reconfigure", "--json"]).exitCode).toBe(0);
  expect(manifestVocabulary(root)).toEqual({
    types: DEFAULT_TYPES,
    priorities: DEFAULT_PRIORITIES,
  });
  const toml = await readFile(tomlPath(root), "utf8");
  expect(toml).toContain('name = "Kept"');
  expect(toml).toContain(
    '[tasks]\ntypes = ["feature", "bug", "chore", "docs", "enhancement", "spike"]\npriorities = ["low", "medium", "high", "critical"]\n',
  );
});

test("ruling constraint 2: re-running init never changes a configured set, including one that configures a single field", async () => {
  const root = await workspace();
  await writeToml(
    root,
    'schemaVersion = 1\n\n[tasks]\ntypes = ["story", "defect"]\n',
  );
  const before = await readFile(tomlPath(root), "utf8");
  // A bare reconfigure that changes nothing writes nothing at all.
  expect(quest(root, ["init", "--reconfigure", "--json"]).exitCode).toBe(0);
  expect(await readFile(tomlPath(root), "utf8")).toBe(before);
  // A --name change writes (name was absent), and the single configured
  // field survives the rewrite; priorities stay open.
  expect(
    quest(root, ["init", "--reconfigure", "--name", "Renamed", "--json"])
      .exitCode,
  ).toBe(0);
  expect(manifestVocabulary(root)).toEqual({
    types: ["story", "defect"],
    priorities: null,
  });
  const rewritten = await readFile(tomlPath(root), "utf8");
  expect(rewritten).toContain('name = "Renamed"');
  expect(rewritten).toContain('types = ["story", "defect"]');
  expect(rewritten).not.toContain("priorities");
});

test("a malformed [tasks] table fails closed instead of reading as open", async () => {
  const root = await workspace();
  for (const [table, fragment] of [
    ["types = []", "must not be empty"],
    ['types = ["Bug", "bug"]', "twice"],
    ["priorities = [1]", "non-empty strings"],
    ['types = "bug"', "array of strings"],
  ] as const) {
    await writeToml(root, `schemaVersion = 1\n\n[tasks]\n${table}\n`);
    const refused = create(root, "a", "--type", "anything");
    expect(refused.exitCode).toBe(6);
    expect(JSON.parse(refused.stderr).message).toContain(fragment);
  }
  // Nothing was written by any of the refused creates.
  await writeToml(root, "schemaVersion = 1\n");
  expect(
    JSON.parse(quest(root, ["task", "list", "--json"]).stdout).data,
  ).toEqual([]);
});

test("reviewer finding 1: every valid TOML spelling of a [tasks] table reads as configured, and a bare reconfigure never overwrites it", async () => {
  const spellings = [
    'schemaVersion = 1\n\n[tasks] # our set\npriorities = ["p0", "p1"]\n',
    'schemaVersion = 1\n\n[ tasks ]\npriorities = ["p0", "p1"]\n',
    'schemaVersion = 1\n\n["tasks"]\npriorities = ["p0", "p1"]\n',
    'schemaVersion = 1\ntasks = { priorities = ["p0", "p1"] }\n',
    'schemaVersion = 1\ntasks.priorities = ["p0", "p1"]\n',
  ];
  for (const spelling of spellings) {
    const root = await workspace();
    await writeToml(root, spelling);
    const refused = create(root, "a", "--priority", "p9");
    expect(refused.exitCode).toBe(6);
    expect(JSON.parse(refused.stderr).input).toMatchObject({
      field: "priority",
      value: "p9",
      allowed: ["p0", "p1"],
    });
    expect(manifestVocabulary(root)).toEqual({
      types: null,
      priorities: ["p0", "p1"],
    });
    expect(quest(root, ["init", "--reconfigure", "--json"]).exitCode).toBe(0);
    // The exact overwrite the reviewer found: bytes must be untouched.
    expect(await readFile(tomlPath(root), "utf8")).toBe(spelling);
  }
});

test("a [tasks] table that declares neither types nor priorities (including a misspelled key) is refused on writes, survives reads, and names itself in doctor", async () => {
  for (const table of ['type = ["bug"]\n', 'priority = ["high"]\n']) {
    const root = await workspace();
    await writeToml(root, `schemaVersion = 1\n\n[tasks]\n${table}`);
    const refused = create(root, "a", "--type", "bug");
    expect(refused.exitCode).toBe(6);
    expect(JSON.parse(refused.stderr).message).toContain("neither");
    expect(
      JSON.parse(quest(root, ["task", "list", "--json"]).stdout).data,
    ).toEqual([]);
    expect(manifestVocabulary(root)).toEqual({ types: null, priorities: null });
    const doctor = JSON.parse(quest(root, ["doctor", "--json"]).stdout).data;
    expect(doctor.healthy).toBe(false);
    expect(doctor.issues.map((issue: { code: string }) => issue.code)).toEqual([
      "task_vocabulary_invalid",
    ]);
  }
  // A non-table under `tasks` is the same shape of failure.
  const root = await workspace();
  await writeToml(root, 'schemaVersion = 1\ntasks = "nope"\n');
  expect(create(root, "a", "--type", "bug").exitCode).toBe(6);
  expect(quest(root, ["task", "list", "--json"]).exitCode).toBe(0);
});

test("reviewer finding 2: a bad agents.skill_source never fails task reads or writes when no [tasks] table exists, and agents --check still refuses it", async () => {
  const root = await workspace();
  await writeToml(
    root,
    'schemaVersion = 1\n\n[agents]\nskill_source = "bogus"\n',
  );
  expect(quest(root, ["task", "list", "--json"]).exitCode).toBe(0);
  expect(manifestVocabulary(root)).toEqual({ types: null, priorities: null });
  const created = create(root, "a", "--type", "anything");
  expect(created.exitCode).toBe(0);
  expect(JSON.parse(quest(root, ["doctor", "--json"]).stdout).data).toEqual({
    healthy: true,
    issues: [],
  });
  // The vocabulary fix must not have weakened the agents check's own guard.
  const agents = quest(root, [
    "agents",
    "--check",
    "--target",
    "claude",
    "--json",
  ]);
  expect(agents.exitCode).toBe(6);
});

test("a malformed [tasks] table refuses every write, while every read carries on and doctor names the problem", async () => {
  const root = await workspace();
  await writeToml(root, "schemaVersion = 1\n");
  expect(create(root, "a").exitCode).toBe(0);
  await writeToml(root, "schemaVersion = 1\n\n[tasks]\ntypes = []\n");

  expect(quest(root, ["task", "list", "--json"]).exitCode).toBe(0);
  expect(quest(root, ["task", "view", "T-1", "--json"]).exitCode).toBe(0);
  expect(manifestVocabulary(root)).toEqual({ types: null, priorities: null });

  const doctor = JSON.parse(quest(root, ["doctor", "--json"]).stdout).data;
  expect(doctor.healthy).toBe(false);
  expect(doctor.issues).toEqual([
    expect.objectContaining({
      code: "task_vocabulary_invalid",
    }),
  ]);

  const refused = create(root, "b", "--type", "bug");
  expect(refused.exitCode).toBe(6);
  expect(JSON.parse(refused.stderr).message).toContain("must not be empty");
  const edit = quest(root, [
    "task",
    "edit",
    "T-1",
    "--title",
    "renamed",
    ...ACTOR,
    "--json",
  ]);
  expect(edit.exitCode).toBe(6);
  const operations = join(root, "ops.jsonl");
  await writeFile(
    operations,
    JSON.stringify({
      reference: "T-1",
      operationId: "o1",
      patch: { title: "x" },
    }),
  );
  const batch = quest(root, [
    "task",
    "edit-batch",
    "--file",
    operations,
    ...ACTOR,
    "--json",
  ]);
  expect(batch.exitCode).toBe(6);
  // Nothing was written by any of the refusals.
  expect(
    JSON.parse(quest(root, ["task", "list", "--json"]).stdout).data,
  ).toEqual([expect.objectContaining({ id: "T-1", title: "a" })]);
});

test("reviewer finding 3: a reconfigure that changes nothing writes nothing, so comments and unknown tables survive", async () => {
  const root = await workspace();
  const authored =
    '# leading comment\nschemaVersion = 1\nname = "Kept"\n\n# our vocabulary\n[tasks]\ntypes = ["story"]\n\n[projection]\nowner = "someone"\n';
  await writeToml(root, authored);
  expect(quest(root, ["init", "--reconfigure", "--json"]).exitCode).toBe(0);
  expect(await readFile(tomlPath(root), "utf8")).toBe(authored);
  expect(
    quest(root, ["init", "--reconfigure", "--name", "Kept", "--json"]).exitCode,
  ).toBe(0);
  expect(await readFile(tomlPath(root), "utf8")).toBe(authored);
});

test("migration imports priority and type verbatim, never validated, and doctor reports them", async () => {
  const root = await workspace();
  const source = await tempRoot();
  const tasks = join(source, "backlog", "tasks");
  await mkdir(tasks, { recursive: true });
  await writeFile(
    join(tasks, "TASK-1.md"),
    "---\nid: TASK-1\ntitle: Imported verbatim\nstatus: To Do\npriority: High\ntype: Story\n---\n",
  );
  const preview = JSON.parse(
    quest(root, [
      "migration",
      "backlog",
      "preview",
      "--source",
      source,
      "--json",
    ]).stdout,
  );
  expect(preview.kind).toBe("migration.backlog-preview");
  const applied = quest(root, [
    "migration",
    "backlog",
    "apply",
    "--source",
    source,
    "--digest",
    preview.data.digest,
    ...ACTOR,
    "--json",
  ]);
  expect(applied.exitCode).toBe(0);
  const imported = JSON.parse(
    quest(root, ["task", "view", "T-1", "--json"]).stdout,
  ).data;
  expect(imported).toMatchObject({ priority: "High", type: "Story" });
  const doctor = JSON.parse(quest(root, ["doctor", "--json"]).stdout).data;
  const issues = doctor.issues
    .filter(
      (issue: { code: string }) => issue.code === "task_vocabulary_off_set",
    )
    .map(({ hint, ...rest }: { hint: string }) => {
      expect(hint.length).toBeGreaterThan(0);
      return rest;
    });
  expect(issues).toEqual([
    {
      code: "task_vocabulary_off_set",
      taskId: "T-1",
      field: "type",
      value: "Story",
    },
    {
      code: "task_vocabulary_off_set",
      taskId: "T-1",
      field: "priority",
      value: "High",
      normalizesTo: "high",
    },
  ]);
});

test("a syntactically invalid workspace.toml fails closed only when a tasks declaration of any spelling is present", async () => {
  // A dotted tasks line in an unparseable file: still a declared vocabulary,
  // so writes refuse and a reconfigure can never overwrite it.
  const dotted = await workspace();
  await writeToml(
    dotted,
    'schemaVersion = 1\nname = "broken\ntasks.priorities = ["p0", "p1"]\n',
  );
  expect(create(dotted, "a", "--priority", "p9").exitCode).toBe(6);
  expect(quest(dotted, ["task", "list", "--json"]).exitCode).toBe(0);
  expect(manifestVocabulary(dotted)).toEqual({ types: null, priorities: null });
  const reconfigure = quest(dotted, ["init", "--reconfigure", "--json"]);
  expect(reconfigure.exitCode).toBe(6);
  expect(await readFile(tomlPath(dotted), "utf8")).toBe(
    'schemaVersion = 1\nname = "broken\ntasks.priorities = ["p0", "p1"]\n',
  );

  // The inline spelling is the same shape.
  const inline = await workspace();
  await writeToml(inline, 'tasks = { priorities = ["p0", "p1"] }\nx = [1, 2\n');
  expect(create(inline, "a", "--priority", "p9").exitCode).toBe(6);
  expect(quest(inline, ["task", "list", "--json"]).exitCode).toBe(0);

  // Invalid TOML with NO tasks declaration anywhere stays open, exactly as
  // it was before QCLI-330.
  const unrelated = await workspace();
  await writeToml(unrelated, 'schemaVersion = 1\nname = "broken\n');
  const created = create(unrelated, "a", "--type", "anything");
  expect(created.exitCode).toBe(0);
  expect(quest(unrelated, ["task", "list", "--json"]).exitCode).toBe(0);
});

test("a bad agents.skill_source cannot mask a broken [tasks] table into reading as open", async () => {
  const root = await workspace();
  await writeToml(
    root,
    'schemaVersion = 1\n\n[agents]\nskill_source = "bogus"\n\n[tasks]\ntypes = []\n',
  );
  const refused = create(root, "a", "--type", "bug");
  expect(refused.exitCode).toBe(6);
  expect(JSON.parse(refused.stderr).message).toContain("must not be empty");
  expect(quest(root, ["task", "list", "--json"]).exitCode).toBe(0);
});
