import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWorkspacePort } from "../../../src/adapters/workspaces/local-workspaces.ts";
import {
  assertSafeWorkspaceRelativePath,
  discoverWorkspaces,
  enrollWorkspace,
  initializeWorkspace,
  reconfigureWorkspace,
  resolveInitializedWorkspace,
  resolveWorkspaceConfiguration,
  WorkspaceError,
} from "../../../src/application/workspaces/workspaces.ts";

/** QCLI-330: what init writes into every fresh workspace. */
const DEFAULT_TASKS_TOML =
  '\n[tasks]\ntypes = ["feature", "bug", "chore", "docs", "enhancement", "spike"]\npriorities = ["low", "medium", "high", "critical"]\n';
const DEFAULT_VOCABULARY = {
  types: ["feature", "bug", "chore", "docs", "enhancement", "spike"],
  priorities: ["low", "medium", "high", "critical"],
};

async function command(path: string, ...args: string[]): Promise<void> {
  const process = Bun.spawn(["git", "-C", path, ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await process.exited).toBe(0);
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quest-workspace-"));
  await command(root, "init", "-q");
  await command(root, "config", "user.email", "quest@example.test");
  await command(root, "config", "user.name", "Quest Test");
  await writeFile(join(root, "README"), "test\n");
  await command(root, "add", "README");
  await command(root, "commit", "-qm", "initial");
  return root;
}

test("initialization writes only its declared authored path in a non-bare worktree", async () => {
  const root = await repository();
  try {
    const port = new LocalWorkspacePort();
    await initializeWorkspace(port, root);
    expect(await readFile(join(root, ".quest/workspace.toml"), "utf8")).toBe(
      `schemaVersion = 1\n${DEFAULT_TASKS_TOML}`,
    );
    await expect(initializeWorkspace(port, root)).rejects.toMatchObject({
      code: "already_initialized",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enrollment retains a shared Git common directory and distinct worktree paths", async () => {
  const root = await repository();
  const second = `${root}-second`;
  try {
    await command(root, "worktree", "add", "--detach", second);
    const registry = join(root, "registry.json");
    const port = new LocalWorkspacePort();
    const first = await enrollWorkspace(port, registry, root);
    const other = await enrollWorkspace(port, registry, second);
    expect(first.commonDirectory).toBe(other.commonDirectory);
    expect(first.worktreePath).not.toBe(other.worktreePath);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("current-worktree identity is deterministic from a nested directory", async () => {
  const root = await repository();
  try {
    const nested = join(root, "one", "two", "three");
    await mkdir(nested, { recursive: true });
    const port = new LocalWorkspacePort();
    expect((await port.inspect(nested)).worktreePath).toBe(
      (await port.inspect(root)).worktreePath,
    );
    await initializeWorkspace(port, nested);
    expect((await resolveInitializedWorkspace(port, nested)).worktreePath).toBe(
      (await port.inspect(root)).worktreePath,
    );
    expect(await readFile(join(root, ".quest/workspace.toml"), "utf8")).toBe(
      `schemaVersion = 1\n${DEFAULT_TASKS_TOML}`,
    );
    await expect(
      readFile(join(nested, ".quest/workspace.toml"), "utf8"),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace resolution rejects an uninitialized Git worktree without writing", async () => {
  const root = await repository();
  try {
    await expect(
      resolveInitializedWorkspace(new LocalWorkspacePort(), root),
    ).rejects.toMatchObject({ code: "not_initialized" });
    await expect(
      readFile(join(root, ".quest/workspace.toml")),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery is ordered, distinguishes missing entries, and does not repair the registry", async () => {
  const root = await repository();
  const registryDirectory = await mkdtemp(join(tmpdir(), "quest-registry-"));
  try {
    const registry = join(registryDirectory, "registry.json");
    const port = new LocalWorkspacePort();
    await enrollWorkspace(port, registry, root);
    const before = await readFile(registry, "utf8");
    await rm(root, { recursive: true, force: true });
    const entries = await discoverWorkspaces(port, registry);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.state).toBe("missing");
    expect(await readFile(registry, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(registryDirectory, { recursive: true, force: true });
  }
});

test("hostile components and symlink escapes are rejected before initialization writes", async () => {
  for (const value of [
    "../quest",
    "/tmp/quest",
    "a//b",
    "a/../b",
    "A/a",
    "nul\0value",
  ]) {
    expect(() => assertSafeWorkspaceRelativePath(value)).toThrow(
      WorkspaceError,
    );
  }
  const root = await repository();
  const outside = await mkdtemp(join(tmpdir(), "quest-outside-"));
  try {
    await symlink(outside, join(root, ".quest"));
    await expect(
      initializeWorkspace(new LocalWorkspacePort(), root),
    ).rejects.toMatchObject({ code: "unsafe_path" });
    await expect(
      readFile(join(outside, "workspace.toml"), "utf8"),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("declared name and taskIdPrefix round-trip through initialization and configuration reads", async () => {
  const root = await repository();
  try {
    const port = new LocalWorkspacePort();
    await initializeWorkspace(port, root, {
      name: 'My "Special" Project',
      taskIdPrefix: "QCLI",
    });
    expect(await readFile(join(root, ".quest/workspace.toml"), "utf8")).toBe(
      `schemaVersion = 1\nname = "My \\"Special\\" Project"\ntaskIdPrefix = "QCLI"\n${DEFAULT_TASKS_TOML}`,
    );
    expect(await resolveWorkspaceConfiguration(port, root)).toEqual({
      schemaVersion: 1,
      name: 'My "Special" Project',
      taskIdPrefix: "QCLI",
      taskVocabulary: DEFAULT_VOCABULARY,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agentSkillSource round-trips as an [agents] table without disturbing the flat fields (QCLI-236)", async () => {
  const root = await repository();
  try {
    const port = new LocalWorkspacePort();
    await initializeWorkspace(port, root, {
      name: "Quest",
      taskIdPrefix: "QCLI",
      agentSkillSource: "plugin",
    });
    expect(await readFile(join(root, ".quest/workspace.toml"), "utf8")).toBe(
      `schemaVersion = 1\nname = "Quest"\ntaskIdPrefix = "QCLI"\n\n[agents]\nskill_source = "plugin"\n${DEFAULT_TASKS_TOML}`,
    );
    expect(await resolveWorkspaceConfiguration(port, root)).toEqual({
      schemaVersion: 1,
      name: "Quest",
      taskIdPrefix: "QCLI",
      agentSkillSource: "plugin",
      taskVocabulary: DEFAULT_VOCABULARY,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an [agents] table appearing after taskIdPrefix (or absent entirely) is still parsed table-scoped, not confused with an unrelated key (QCLI-236)", async () => {
  const root = await repository();
  try {
    const port = new LocalWorkspacePort();
    await initializeWorkspace(port, root);
    // A skill_source-looking key OUTSIDE any [agents] table must never match.
    await writeFile(
      join(root, ".quest/workspace.toml"),
      'schemaVersion = 1\nskill_source = "plugin"\n',
    );
    expect(await resolveWorkspaceConfiguration(port, root)).toEqual({
      schemaVersion: 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agents.skill_source = "none" round-trips as a first-class value, not an invalid one (QCLI-309)', async () => {
  const root = await repository();
  try {
    const port = new LocalWorkspacePort();
    await initializeWorkspace(port, root, {
      name: "Quest",
      taskIdPrefix: "QCLI",
      agentSkillSource: "none",
    });
    expect(await readFile(join(root, ".quest/workspace.toml"), "utf8")).toBe(
      `schemaVersion = 1\nname = "Quest"\ntaskIdPrefix = "QCLI"\n\n[agents]\nskill_source = "none"\n${DEFAULT_TASKS_TOML}`,
    );
    expect(await resolveWorkspaceConfiguration(port, root)).toEqual({
      schemaVersion: 1,
      name: "Quest",
      taskIdPrefix: "QCLI",
      agentSkillSource: "none",
      taskVocabulary: DEFAULT_VOCABULARY,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid agents.skill_source value fails loud rather than silently defaulting (QCLI-236)", async () => {
  const root = await repository();
  try {
    const port = new LocalWorkspacePort();
    await initializeWorkspace(port, root);
    await writeFile(
      join(root, ".quest/workspace.toml"),
      'schemaVersion = 1\n\n[agents]\nskill_source = "bogus"\n',
    );
    await expect(
      resolveWorkspaceConfiguration(port, root),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconfigureWorkspace changes agentSkillSource independently of name/taskIdPrefix, and a workspace.toml written before this field existed is unaffected until set (QCLI-236)", async () => {
  const root = await repository();
  try {
    const port = new LocalWorkspacePort();
    await initializeWorkspace(port, root, { name: "Old", taskIdPrefix: "OLD" });
    expect(await resolveWorkspaceConfiguration(port, root)).toEqual({
      schemaVersion: 1,
      name: "Old",
      taskIdPrefix: "OLD",
      taskVocabulary: DEFAULT_VOCABULARY,
    });

    await reconfigureWorkspace(port, root, { agentSkillSource: "plugin" });
    expect(await resolveWorkspaceConfiguration(port, root)).toEqual({
      schemaVersion: 1,
      name: "Old",
      taskIdPrefix: "OLD",
      agentSkillSource: "plugin",
      taskVocabulary: DEFAULT_VOCABULARY,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a workspace initialized before name/taskIdPrefix existed reads back with neither field", async () => {
  const root = await repository();
  try {
    const port = new LocalWorkspacePort();
    await initializeWorkspace(port, root);
    // Init now writes the [tasks] table (QCLI-330), so the pre-field file
    // this test is about is written by hand, the way an older Quest left it.
    await writeFile(join(root, ".quest/workspace.toml"), "schemaVersion = 1\n");
    expect(await resolveWorkspaceConfiguration(port, root)).toEqual({
      schemaVersion: 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconfigureWorkspace changes a declared field without touching an existing task record (QCLI-161)", async () => {
  const root = await repository();
  try {
    const port = new LocalWorkspacePort();
    await initializeWorkspace(port, root, { name: "Old", taskIdPrefix: "OLD" });
    const taskPath = join(root, ".quest", "tasks", "OLD-1.json");
    await mkdir(join(root, ".quest", "tasks"), { recursive: true });
    await writeFile(taskPath, '{"id":"OLD-1"}\n');

    await reconfigureWorkspace(port, root, { taskIdPrefix: "NEW" });

    // The field not given (name) survives, unspecified fields are not wiped.
    expect(await resolveWorkspaceConfiguration(port, root)).toEqual({
      schemaVersion: 1,
      name: "Old",
      taskIdPrefix: "NEW",
      taskVocabulary: DEFAULT_VOCABULARY,
    });
    expect(await readFile(taskPath, "utf8")).toBe('{"id":"OLD-1"}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconfigureWorkspace refuses when there is nothing to reconfigure", async () => {
  const root = await repository();
  try {
    await expect(
      reconfigureWorkspace(new LocalWorkspacePort(), root, {
        taskIdPrefix: "NEW",
      }),
    ).rejects.toMatchObject({ code: "not_initialized" });
    await expect(
      readFile(join(root, ".quest/workspace.toml")),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconfigureWorkspace adopts a workspace whose config file alone went missing, recovering its task records without loss (QCLI-161)", async () => {
  const root = await repository();
  try {
    const port = new LocalWorkspacePort();
    await initializeWorkspace(port, root, { taskIdPrefix: "OLD" });
    const taskPath = join(root, ".quest", "tasks", "OLD-1.json");
    await mkdir(join(root, ".quest", "tasks"), { recursive: true });
    await writeFile(taskPath, '{"id":"OLD-1"}\n');
    // Simulate the config file alone being removed -- not the whole
    // directory -- leaving real content behind with no workspace.toml.
    await rm(join(root, ".quest", "workspace.toml"));

    await reconfigureWorkspace(port, root, { taskIdPrefix: "NEW" });

    expect(await resolveWorkspaceConfiguration(port, root)).toEqual({
      schemaVersion: 1,
      taskIdPrefix: "NEW",
      taskVocabulary: DEFAULT_VOCABULARY,
    });
    expect(await readFile(taskPath, "utf8")).toBe('{"id":"OLD-1"}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeWorkspace refuses a directory holding task records but no workspace.toml, rather than treating it as fresh (QCLI-161)", async () => {
  const root = await repository();
  try {
    const port = new LocalWorkspacePort();
    await initializeWorkspace(port, root, { taskIdPrefix: "OLD" });
    const taskPath = join(root, ".quest", "tasks", "OLD-1.json");
    await mkdir(join(root, ".quest", "tasks"), { recursive: true });
    await writeFile(taskPath, '{"id":"OLD-1"}\n');
    await rm(join(root, ".quest", "workspace.toml"));

    await expect(
      initializeWorkspace(port, root, { taskIdPrefix: "NEW" }),
    ).rejects.toMatchObject({ code: "stray_content" });

    // Refused, not silently reinitialized: the record is untouched and
    // still no config exists to claim otherwise.
    expect(await readFile(taskPath, "utf8")).toBe('{"id":"OLD-1"}\n');
    await expect(
      readFile(join(root, ".quest/workspace.toml")),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializeWorkspace refuses a directory holding only question records but no workspace.toml (QCLI-445)", async () => {
  const root = await repository();
  try {
    const port = new LocalWorkspacePort();
    await initializeWorkspace(port, root, { taskIdPrefix: "OLD" });
    const questionPath = join(root, ".quest", "questions", "Q-1.json");
    await mkdir(join(root, ".quest", "questions"), { recursive: true });
    await writeFile(
      questionPath,
      `${JSON.stringify({
        id: "Q-1",
        title: "Only a question",
        options: [
          { key: "A", label: "Yes", description: "y" },
          { key: "B", label: "No", description: "n" },
        ],
        recommended: "A",
        status: "open",
      })}\n`,
    );
    await rm(join(root, ".quest", "workspace.toml"));

    await expect(
      initializeWorkspace(port, root, { taskIdPrefix: "NEW" }),
    ).rejects.toMatchObject({ code: "stray_content" });
    expect(await readFile(questionPath, "utf8")).toContain('"Q-1"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported bare repositories fail before any Quest path is created", async () => {
  const bare = await mkdtemp(join(tmpdir(), "quest-bare-"));
  try {
    await command(bare, "init", "--bare", "-q");
    await expect(
      initializeWorkspace(new LocalWorkspacePort(), bare),
    ).rejects.toMatchObject({ code: "bare_repository" });
  } finally {
    await rm(bare, { recursive: true, force: true });
  }
});
