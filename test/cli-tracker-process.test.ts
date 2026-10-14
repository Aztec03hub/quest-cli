import { expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeStorageName } from "../src/adapters/claims/local-claim-evidence.ts";
import { QUEST_VERSION } from "../src/application/version.ts";

const source = join(import.meta.dir, "..", "src", "cli", "main.ts");
const compiled = join(
  import.meta.dir,
  "..",
  "npm",
  `quest-${process.platform}-${process.arch}`,
  "bin",
  process.platform === "win32" ? "quest.exe" : "quest",
);
const conformance = join(
  import.meta.dir,
  "..",
  "fixtures",
  "tracker",
  "v1",
  "conformance.mjs",
);

async function quest(store: string, argv: readonly string[]) {
  const child = Bun.spawn([process.execPath, source, ...argv], {
    cwd: store,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, QUEST_TASK_STORE: store },
  });
  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

async function questWithStdin(
  store: string,
  argv: readonly string[],
  stdinBody: string,
) {
  const child = Bun.spawn([process.execPath, source, ...argv, "--json"], {
    cwd: store,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, QUEST_TASK_STORE: store },
  });
  child.stdin.write(stdinBody);
  await child.stdin.end();
  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

async function compiledQuest(store: string, argv: readonly string[]) {
  const child = Bun.spawn([compiled, ...argv], {
    cwd: store,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, QUEST_TASK_STORE: store },
  });
  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

async function questUntilOutput(store: string, argv: readonly string[]) {
  const child = Bun.spawn([process.execPath, source, ...argv], {
    cwd: store,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, QUEST_TASK_STORE: store },
  });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  child.kill();
  await child.exited;
  return {
    stdout: new TextDecoder().decode(value),
    stderr: await new Response(child.stderr).text(),
  };
}

async function initializeGitWorktree(path: string): Promise<void> {
  const child = Bun.spawn(["git", "init", "--quiet", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
}

async function backlogSourceFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "quest-human-backlog-source-"));
  const tasks = join(root, "backlog", "tasks");
  await mkdir(tasks, { recursive: true });
  await writeFile(
    join(tasks, "TASK-1.md"),
    "---\nid: TASK-1\ntitle: Human output migration\nstatus: To Do\n---\n",
  );
  return root;
}

test("the installed executable routes persistent tracker reads and writes as JSON subprocess records", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-tracker-"));
  try {
    expect(await quest(store, ["--version"])).toMatchObject({
      exitCode: 0,
      stdout: `${QUEST_VERSION}\n`,
      stderr: "",
    });
    const manifest = await quest(store, ["manifest", "--json"]);
    expect(JSON.parse(manifest.stdout).data.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "task create", mutates: true }),
      ]),
    );
    const created = await quest(store, [
      "task",
      "create",
      "argv; safe",
      "--label",
      "one",
      "--label",
      "alpha",
      "--doc",
      "docs/example.md",
      "--doc",
      "docs/other.md",
      "--actor",
      "person-1",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(created.exitCode).toBe(0);
    const createdTask = JSON.parse(created.stdout).data;
    expect(createdTask).toMatchObject({
      title: "argv; safe",
      labels: ["one", "alpha"],
      documentation: ["docs/example.md", "docs/other.md"],
    });
    expect(createdTask.id).toMatch(/^T-[1-9][0-9]*$/);
    const listed = await quest(store, [
      "task",
      "list",
      "--label",
      "one",
      "--label",
      "alpha",
      "--json",
    ]);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      kind: "task.list",
      data: [{ id: createdTask.id }],
    });
    const edited = await quest(store, [
      "task",
      "edit",
      createdTask.id,
      "--add-label",
      "two",
      "--add-label",
      "three",
      "--remove-label",
      "one",
      "--remove-label",
      "alpha",
      "--doc",
      "docs/edited-a.md",
      "--doc",
      "docs/edited-b.md",
      "--actor",
      "agent-1",
      "--actor-kind",
      "delegated-agent",
      "--accountable-human",
      "person-1",
      "--json",
    ]);
    expect(JSON.parse(edited.stdout)).toMatchObject({
      kind: "task.updated",
      data: {
        labels: ["two", "three"],
        documentation: ["docs/edited-a.md", "docs/edited-b.md"],
      },
    });
    const dashValue = await quest(store, [
      "task",
      "create",
      "dash value",
      "--description",
      "--starts-with-dashes",
      "--actor",
      "person-1",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(dashValue).toMatchObject({ exitCode: 2, stdout: "" });
    expect(JSON.parse(dashValue.stderr)).toMatchObject({
      error_type: "usage",
      message:
        "--description requires a value; use --description=<value> if the value begins with --.",
    });

    const secondTask = JSON.parse(
      (
        await quest(store, [
          "task",
          "create",
          "second",
          "--actor",
          "person-1",
          "--actor-kind",
          "human",
          "--json",
        ])
      ).stdout,
    ).data;
    const milestone = await quest(store, [
      "milestone",
      "create",
      "repeated task refs",
      "--task",
      createdTask.id,
      "--task",
      secondTask.id,
      "--actor",
      "person-1",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(milestone.exitCode).toBe(0);
    const milestoneId = JSON.parse(milestone.stdout).data.id as string;
    const viewedMilestone = await quest(store, [
      "milestone",
      "view",
      milestoneId,
      "--json",
    ]);
    expect(JSON.parse(viewedMilestone.stdout)).toMatchObject({
      data: { taskIds: [createdTask.id, secondTask.id] },
    });
    const thirdTask = JSON.parse(
      (
        await quest(store, [
          "task",
          "create",
          "third",
          "--actor",
          "person-1",
          "--actor-kind",
          "human",
          "--json",
        ])
      ).stdout,
    ).data;
    const added = await quest(store, [
      "milestone",
      "edit",
      milestoneId,
      "--add-task",
      thirdTask.id,
      "--add-task",
      thirdTask.id,
      "--actor",
      "person-1",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(JSON.parse(added.stdout)).toMatchObject({
      kind: "milestone.updated",
      data: { taskIds: [createdTask.id, secondTask.id, thirdTask.id] },
    });
    const removed = await quest(store, [
      "milestone",
      "edit",
      milestoneId,
      "--remove-task",
      createdTask.id,
      "--remove-task",
      createdTask.id,
      "--actor",
      "person-1",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(JSON.parse(removed.stdout)).toMatchObject({
      kind: "milestone.updated",
      data: { taskIds: [secondTask.id, thirdTask.id] },
    });
    const replaced = await quest(store, [
      "milestone",
      "edit",
      milestoneId,
      "--replace-task",
      createdTask.id,
      "--replace-task",
      thirdTask.id,
      "--replace-task",
      createdTask.id,
      "--actor",
      "person-1",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(JSON.parse(replaced.stdout)).toMatchObject({
      kind: "milestone.updated",
      data: { taskIds: [createdTask.id, thirdTask.id] },
    });
    for (const argv of [
      ["--task", thirdTask.id],
      ["--replace-task", thirdTask.id, "--add-task", secondTask.id],
      ["--add-task", thirdTask.id, "--remove-task", thirdTask.id],
    ]) {
      const invalid = await quest(store, [
        "milestone",
        "edit",
        milestoneId,
        ...argv,
        "--actor",
        "person-1",
        "--actor-kind",
        "human",
        "--json",
      ]);
      expect(invalid.exitCode).toBe(2);
      expect(JSON.parse(invalid.stderr)).toMatchObject({ error_type: "usage" });
    }
    const decision = JSON.parse(
      (
        await quest(store, [
          "decision",
          "create",
          "unchanged decision",
          "--outcome",
          "original outcome",
          "--actor",
          "person-1",
          "--actor-kind",
          "human",
          "--json",
        ])
      ).stdout,
    ).data;
    for (const flag of [
      "--add-task",
      "--remove-task",
      "--replace-task",
    ] as const) {
      const invalid = await quest(store, [
        "decision",
        "edit",
        decision.id,
        flag,
        thirdTask.id,
        "--actor",
        "person-1",
        "--actor-kind",
        "human",
        "--json",
      ]);
      expect(invalid.exitCode).toBe(2);
      expect(JSON.parse(invalid.stderr)).toMatchObject({ error_type: "usage" });
    }
    const viewedDecision = JSON.parse(
      (await quest(store, ["decision", "view", decision.id, "--json"])).stdout,
    );
    expect(viewedDecision).toMatchObject({
      data: { id: decision.id, outcome: "original outcome" },
    });
    const denied = await quest(store, ["task", "create", "no actor", "--json"]);
    expect(denied.exitCode).toBe(4);
    expect(JSON.parse(denied.stderr)).toMatchObject({ error_type: "denied" });
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("inline free-text flag values preserve literal dash-prefixed bytes in storage", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-inline-values-"));
  const human = ["--actor", "person-1", "--actor-kind", "human", "--json"];
  try {
    const description = "--description=first=equals";
    const task = JSON.parse(
      (
        await quest(store, [
          "task",
          "create",
          "Inline task",
          `--description=${description}`,
          ...human,
        ])
      ).stdout,
    ).data;
    expect(
      JSON.parse(
        (await quest(store, ["task", "view", task.id, "--json"])).stdout,
      ),
    ).toMatchObject({ data: { description } });

    const milestone = JSON.parse(
      (
        await quest(store, [
          "milestone",
          "create",
          "Inline milestone",
          ...human,
        ])
      ).stdout,
    ).data.id as string;
    const title = "--title=first=equals";
    expect(
      JSON.parse(
        (
          await quest(store, [
            "milestone",
            "edit",
            milestone,
            `--title=${title}`,
            ...human,
          ])
        ).stdout,
      ),
    ).toMatchObject({ data: { title } });
    expect(
      JSON.parse(
        (await quest(store, ["milestone", "view", milestone, "--json"])).stdout,
      ),
    ).toMatchObject({ data: { title } });

    const context = "--context=first=equals";
    const outcome = "--outcome=first=equals";
    const decision = JSON.parse(
      (
        await quest(store, [
          "decision",
          "create",
          "Inline decision",
          `--context=${context}`,
          `--outcome=${outcome}`,
          ...human,
        ])
      ).stdout,
    ).data.id as string;
    expect(
      JSON.parse(
        (await quest(store, ["decision", "view", decision, "--json"])).stdout,
      ),
    ).toMatchObject({ data: { context, outcome } });
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("concurrent task writers expose only readable retryable conflicts", async () => {
  const actor = ["--actor", "person-1", "--actor-kind", "human", "--json"];
  for (let round = 0; round < 5; round += 1) {
    const store = await mkdtemp(join(tmpdir(), "quest-contention-"));
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, writer) =>
          quest(store, [
            "task",
            "create",
            `Concurrent ${round}-${writer}`,
            ...actor,
          ]),
        ),
      );
      const failures = results.filter((result) => result.exitCode !== 0);
      expect(failures.length).toBeGreaterThan(0);
      for (const result of failures) {
        expect(result).toMatchObject({ exitCode: 5, stdout: "" });
        expect(result.stderr).not.toContain("dependency_target_ambiguous");
        expect(JSON.parse(result.stderr)).toMatchObject({
          error_type: "conflict",
          message:
            "Task state changed concurrently; the operation was not applied.",
          hint: "Read the latest task state and retry the operation.",
        });
      }
      const doctor = await quest(store, ["doctor", "--json"]);
      expect(doctor).toMatchObject({ exitCode: 0, stderr: "" });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  }
}, 30_000);

test("task-store permission failures are denied without mutation", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-permissions-"));
  const taskDirectory = join(store, ".quest", "tasks");
  const actor = ["--actor", "person-1", "--actor-kind", "human", "--json"];
  try {
    const created = await quest(store, [
      "task",
      "create",
      "Before permissions",
      ...actor,
    ]);
    expect(created).toMatchObject({ exitCode: 0, stderr: "" });
    await chmod(taskDirectory, 0o555);

    const denied = await quest(store, [
      "task",
      "create",
      "Must not persist",
      ...actor,
    ]);
    expect(denied).toMatchObject({ exitCode: 4, stdout: "" });
    expect(JSON.parse(denied.stderr)).toMatchObject({
      error_type: "denied",
      message: expect.stringContaining("Quest cannot access required storage"),
      hint: "Check the task-store filesystem permissions and retry.",
    });

    const listed = await quest(store, ["task", "list", "--json"]);
    expect(listed).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(listed.stdout).data).toEqual([
      expect.objectContaining({ title: "Before permissions" }),
    ]);
  } finally {
    await chmod(taskDirectory, 0o755).catch(() => undefined);
    await rm(store, { recursive: true, force: true });
  }
});

test("the compiled binary rejects missing and duplicate status values", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-compiled-flags-"));
  try {
    for (const [argv, message] of [
      [
        ["task", "list", "--status", "--json"],
        "--status requires a value; use --status=<value> if the value begins with --.",
      ],
      [
        ["task", "list", "--status", "To Do", "--status", "Done", "--json"],
        "--status may only be provided once.",
      ],
    ] as const) {
      const result = await compiledQuest(store, argv);
      expect(result).toMatchObject({ exitCode: 2, stdout: "" });
      expect(JSON.parse(result.stderr)).toMatchObject({
        error_type: "usage",
        message,
      });
    }
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("the versioned fixture runs without importing Quest source", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-conformance-"));
  try {
    const child = Bun.spawn([process.execPath, conformance], {
      cwd: store,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...Bun.env,
        QUEST_TASK_STORE: store,
        QUEST_EXECUTABLE: process.execPath,
        QUEST_EXECUTABLE_ARGS: JSON.stringify([source]),
      },
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toContain(
      "Tracker conformance fixture v1 passed.",
    );
    expect(await new Response(child.stderr).text()).toBe("");
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("a live storage lock produces a bounded conflict diagnostic", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-lock-diagnostic-"));
  try {
    await mkdir(join(store, ".quest", "tasks", ".write.lock"), {
      recursive: true,
    });
    const started = performance.now();
    const result = await quest(store, [
      "task",
      "create",
      "blocked",
      "--actor",
      "person-1",
      "--actor-kind",
      "human",
      "--json",
    ]);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.exitCode).toBe(5);
    expect(JSON.parse(result.stderr)).toMatchObject({ error_type: "conflict" });
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("public lifecycle, draft, and planning routes preserve their declared envelopes", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-parity-routes-"));
  const human = ["--actor", "person-1", "--actor-kind", "human", "--json"];
  try {
    const task = JSON.parse(
      (await quest(store, ["task", "create", "Lifecycle task", ...human]))
        .stdout,
    ).data;
    expect(
      JSON.parse(
        (
          await quest(store, [
            "task",
            "edit",
            task.id,
            "--status",
            "In Progress",
            ...human,
          ])
        ).stdout,
      ),
    ).toMatchObject({ kind: "task.updated", data: { id: task.id } });
    expect(
      JSON.parse(
        (await quest(store, ["task", "complete", task.id, ...human])).stdout,
      ),
    ).toMatchObject({
      kind: "task.completed",
      data: { id: task.id, status: "Done" },
    });
    expect(
      JSON.parse(
        (await quest(store, ["task", "archive", task.id, ...human])).stdout,
      ),
    ).toMatchObject({
      kind: "task.archived",
      data: { id: task.id },
    });

    const draft = JSON.parse(
      (await quest(store, ["draft", "create", "Draft", ...human])).stdout,
    ).data;
    // QCLI-264 converged the mutating routes on the bare record and QCLI-265
    // did the same for the reads: `draft view` now carries the draft's own
    // fields with `location` inline, as `task view` carries `path`.
    expect(
      JSON.parse(
        (await quest(store, ["draft", "view", draft.id, "--json"])).stdout,
      ),
    ).toMatchObject({
      kind: "draft.view",
      data: { id: draft.id, location: "drafts" },
    });
    expect(
      JSON.parse(
        (await quest(store, ["draft", "promote", draft.id, ...human])).stdout,
      ),
    ).toMatchObject({
      kind: "draft.promoted",
      data: { id: "T-2" },
    });

    const milestone = JSON.parse(
      (await quest(store, ["milestone", "create", "M1", ...human])).stdout,
    ).data.id as string;
    expect(
      JSON.parse(
        (await quest(store, ["milestone", "view", milestone, "--json"])).stdout,
      ),
    ).toMatchObject({ kind: "milestone.view", data: { id: milestone } });
    const decision = JSON.parse(
      (await quest(store, ["decision", "create", "D1", ...human])).stdout,
    ).data.id as string;
    expect(
      JSON.parse(
        (await quest(store, ["decision", "view", decision, "--json"])).stdout,
      ),
    ).toMatchObject({ kind: "decision.view", data: { id: decision } });
    expect(
      JSON.parse(
        (
          await quest(store, [
            "milestone",
            "edit",
            milestone,
            "--title",
            "M1 edited",
            ...human,
          ])
        ).stdout,
      ),
    ).toMatchObject({
      kind: "milestone.updated",
      data: { id: milestone, title: "M1 edited" },
    });
    expect(
      JSON.parse(
        (
          await quest(store, [
            "decision",
            "edit",
            decision,
            "--outcome",
            "Decided",
            ...human,
          ])
        ).stdout,
      ),
    ).toMatchObject({
      kind: "decision.updated",
      data: { id: decision, outcome: "Decided" },
    });
    const deletedMilestone = JSON.parse(
      (
        await quest(store, [
          "milestone",
          "create",
          "Delete milestone",
          ...human,
        ])
      ).stdout,
    ).data.id as string;
    expect(
      JSON.parse(
        (
          await quest(store, [
            "milestone",
            "delete",
            deletedMilestone,
            ...human,
          ])
        ).stdout,
      ),
    ).toMatchObject({
      kind: "milestone.deleted",
      data: { id: deletedMilestone },
    });
    const deletedDecision = JSON.parse(
      (await quest(store, ["decision", "create", "Delete decision", ...human]))
        .stdout,
    ).data.id as string;
    expect(
      JSON.parse(
        (await quest(store, ["decision", "delete", deletedDecision, ...human]))
          .stdout,
      ),
    ).toMatchObject({
      kind: "decision.deleted",
      data: { id: deletedDecision },
    });
    for (const [argv, kind] of [
      [["overview", "--json"], "project.overview"],
      [["board", "--json"], "project.board"],
      [["doctor", "--json"], "project.doctor"],
      [["search", "M1", "--all", "--json"], "search.results"],
    ] as const) {
      const result = await quest(store, argv);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ kind });
    }
    const cleanup = await quest(store, ["cleanup", "--dry-run", ...human]);
    expect(JSON.parse(cleanup.stdout)).toMatchObject({
      kind: "project.cleanup",
    });
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

async function invokeEveryManifestPayloadCommand(mode: "--plain" | "--json") {
  const store = await mkdtemp(join(tmpdir(), "quest-human-output-"));
  // A directory of its own: `init`/`init --reconfigure` need a worktree
  // whose Quest content state they actually control, and `store` already
  // carries task/draft/etc fixtures from QUEST_TASK_STORE writes below that
  // never went through `quest init` -- exactly the "content, no config"
  // state `init` now (correctly) refuses to treat as fresh (QCLI-161).
  const freshWorkspace = await mkdtemp(join(tmpdir(), "quest-fresh-init-"));
  const backlogSource = await backlogSourceFixture();
  const actor = ["--actor", "person-1", "--actor-kind", "human"];
  try {
    await initializeGitWorktree(store);
    await initializeGitWorktree(freshWorkspace);
    const manifest = JSON.parse(
      (await quest(store, ["manifest", "--json"])).stdout,
    ).data.commands as readonly {
      readonly name: string;
      readonly kind: string | null;
    }[];
    const created = JSON.parse(
      (await quest(store, ["task", "create", "Existing", ...actor, "--json"]))
        .stdout,
    ).data.id as string;
    const draft = JSON.parse(
      (
        await quest(store, [
          "draft",
          "create",
          "Existing draft",
          ...actor,
          "--json",
        ])
      ).stdout,
    ).data.id as string;
    const archivableDraft = JSON.parse(
      (
        await quest(store, [
          "draft",
          "create",
          "Archivable draft",
          ...actor,
          "--json",
        ])
      ).stdout,
    ).data.id as string;
    const milestone = JSON.parse(
      (
        await quest(store, [
          "milestone",
          "create",
          "Existing milestone",
          ...actor,
          "--json",
        ])
      ).stdout,
    ).data.id as string;
    const milestoneToArchive = JSON.parse(
      (
        await quest(store, [
          "milestone",
          "create",
          "Archived milestone",
          ...actor,
          "--json",
        ])
      ).stdout,
    ).data.id as string;
    const milestoneToDelete = JSON.parse(
      (
        await quest(store, [
          "milestone",
          "create",
          "Deleted milestone",
          ...actor,
          "--json",
        ])
      ).stdout,
    ).data.id as string;
    const decision = JSON.parse(
      (
        await quest(store, [
          "decision",
          "create",
          "Existing decision",
          ...actor,
          "--json",
        ])
      ).stdout,
    ).data.id as string;
    const decisionToDelete = JSON.parse(
      (
        await quest(store, [
          "decision",
          "create",
          "Deleted decision",
          ...actor,
          "--json",
        ])
      ).stdout,
    ).data.id as string;
    // QCLI-445: two open questions, one to answer and one to withdraw, since
    // answering and withdrawing are the record's two mutually-exclusive
    // terminal states and a single question cannot exercise both.
    const questionToAnswer = JSON.parse(
      (
        await quest(store, [
          "question",
          "ask",
          "--title",
          "Existing question",
          "--option",
          "A=Yes:y",
          "--option",
          "B=No:n",
          "--recommend",
          "A",
          ...actor,
          "--json",
        ])
      ).stdout,
    ).data.id as string;
    const questionToWithdraw = JSON.parse(
      (
        await quest(store, [
          "question",
          "ask",
          "--title",
          "Withdrawable question",
          "--option",
          "A=Yes:y",
          "--option",
          "B=No:n",
          "--recommend",
          "A",
          ...actor,
          "--json",
        ])
      ).stdout,
    ).data.id as string;
    const bound = JSON.parse(
      (await quest(store, ["task", "create", "Bound", ...actor, "--json"]))
        .stdout,
    ).data.id as string;
    await quest(store, [
      "task",
      "edit",
      bound,
      "--status",
      "In Progress",
      "--add-reference",
      "binding-correlation",
      ...actor,
      "--json",
    ]);

    const relationshipsDirectory = join(store, ".quest", "relationships");
    await mkdir(relationshipsDirectory, { recursive: true });
    const commonDirectory = Bun.spawnSync(
      ["git", "rev-parse", "--git-common-dir"],
      { cwd: store, stdout: "pipe" },
    )
      .stdout.toString()
      .trim();
    const repositoryId = commonDirectory.startsWith("/")
      ? commonDirectory
      : join(realpathSync(store), commonDirectory);
    await writeFile(
      join(
        relationshipsDirectory,
        `${safeStorageName("binding-correlation")}.json`,
      ),
      JSON.stringify({
        schemaVersion: 1,
        id: "binding-correlation",
        taskId: bound,
        kind: "correlation",
        state: "accepted",
        holder: "person-1",
        baseRef: "origin/dev",
        settlementRef: "origin/dev",
      }),
    );
    Bun.spawnSync(["git", "add", "-A"], { cwd: store });
    Bun.spawnSync(
      [
        "git",
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-m",
        "evidence",
      ],
      { cwd: store },
    );

    const migrationDigest = JSON.parse(
      (
        await quest(store, [
          "migration",
          "backlog",
          "preview",
          "--source",
          backlogSource,
          "--json",
        ])
      ).stdout,
    ).data.digest as string;

    const invocations: Record<string, readonly string[]> = {
      manifest: ["manifest", "--plain"],
      version: ["version"],
      help: ["--help", "--plain"],
      init: ["init", "--plain"],
      "init --reconfigure": [
        "init",
        "--reconfigure",
        "--task-id-prefix",
        "T",
        "--plain",
      ],
      instructions: ["instructions", "--plain"],
      "instructions --list": ["instructions", "--list", "--plain"],
      "instructions <guide>": ["instructions", "overview", "--plain"],
      agents: ["agents", "--update-instructions", "--plain"],
      completion: ["completion", "bash", "--plain"],
      "migration backlog preview": [
        "migration",
        "backlog",
        "preview",
        "--source",
        backlogSource,
        "--plain",
      ],
      "migration backlog apply": [
        "migration",
        "backlog",
        "apply",
        "--source",
        backlogSource,
        "--digest",
        migrationDigest,
        ...actor,
        "--plain",
      ],
      "migration backlog status": [
        "migration",
        "backlog",
        "status",
        "--digest",
        migrationDigest,
        "--plain",
      ],
      "migration backlog rollback": [
        "migration",
        "backlog",
        "rollback",
        "--digest",
        migrationDigest,
        ...actor,
        "--plain",
      ],
      "task status-flow": ["task", "status-flow", "--plain"],
      "task binding": [
        "task",
        "binding",
        "--contract",
        "opum-agent-workflow/v1",
        "--task",
        bound,
        "--claim-or-correlation",
        "binding-correlation",
        "--holder",
        "person-1",
        "--repository",
        repositoryId,
        "--base",
        "origin/dev",
        "--settlement",
        "origin/dev",
        "--plain",
      ],
      "task list": ["task", "list", "--plain"],
      // QCLI-417: an EXPLICIT population, because this fixture has no origin
      // remote and the default population would (correctly) exit 3. Reading
      // HEAD keeps the smoke test about the envelope and the renderer rather
      // than about a forge or a remote.
      "task list --across-refs": [
        "task",
        "list",
        "--across-refs",
        "--ref",
        "HEAD",
        "--plain",
      ],
      "task view": ["task", "view", created, "--plain"],
      search: ["search", "Existing", "--plain"],
      "search --all": ["search", "Existing", "--all", "--plain"],
      "task create": ["task", "create", "Plain create", ...actor, "--plain"],
      "task edit": [
        "task",
        "edit",
        created,
        "--status",
        "In Progress",
        ...actor,
        "--plain",
      ],
      "task edit-batch": (() => {
        const operations = join(store, `ops-${safeStorageName(created)}.jsonl`);
        writeFileSync(
          operations,
          [
            JSON.stringify({
              reference: created,
              operationId: "batch-1",
              patch: { addLabels: ["batched"] },
            }),
            "",
          ].join("\n"),
        );
        return [
          "task",
          "edit-batch",
          "--file",
          operations,
          ...actor,
          "--plain",
        ];
      })(),
      "task pause": ["task", "pause", created, ...actor, "--plain"],
      "task start": ["task", "start", created, ...actor, "--plain"],
      "task complete": ["task", "complete", created, ...actor, "--plain"],
      "task archive": ["task", "archive", created, ...actor, "--plain"],
      "task demote": [
        "task",
        "demote",
        created,
        "--to",
        "To Do",
        ...actor,
        "--plain",
      ],
      // Runs after demote in manifest order, so `created` is back at To Do.
      "task close": [
        "task",
        "close",
        created,
        "--resolution",
        "wont-do",
        ...actor,
        "--plain",
      ],
      "draft create": ["draft", "create", "Plain draft", ...actor, "--plain"],
      "draft list": ["draft", "list", "--plain"],
      "draft view": ["draft", "view", draft, "--plain"],
      "draft promote": ["draft", "promote", draft, ...actor, "--plain"],
      "draft archive": [
        "draft",
        "archive",
        archivableDraft,
        ...actor,
        "--plain",
      ],
      "milestone list": ["milestone", "list", "--plain"],
      "milestone view": ["milestone", "view", milestone, "--plain"],
      "milestone create": [
        "milestone",
        "create",
        "Plain milestone",
        ...actor,
        "--plain",
      ],
      "milestone edit": [
        "milestone",
        "edit",
        milestone,
        "--title",
        "Edited milestone",
        ...actor,
        "--plain",
      ],
      "milestone delete": [
        "milestone",
        "delete",
        milestoneToDelete,
        ...actor,
        "--plain",
      ],
      "milestone archive": [
        "milestone",
        "archive",
        milestoneToArchive,
        ...actor,
        "--plain",
      ],
      "decision list": ["decision", "list", "--plain"],
      "decision view": ["decision", "view", decision, "--plain"],
      "decision create": [
        "decision",
        "create",
        "Plain decision",
        ...actor,
        "--plain",
      ],
      "decision edit": [
        "decision",
        "edit",
        decision,
        "--outcome",
        "Edited decision",
        ...actor,
        "--plain",
      ],
      "decision delete": [
        "decision",
        "delete",
        decisionToDelete,
        ...actor,
        "--plain",
      ],
      // QCLI-445: manifest order runs ask before answer/withdraw, so `ask`
      // creates a fresh question and the other two target the fixtures above.
      "question ask": [
        "question",
        "ask",
        "--title",
        "Plain question",
        "--option",
        "A=Yes:y",
        "--option",
        "B=No:n",
        "--recommend",
        "A",
        ...actor,
        "--plain",
      ],
      "question answer": [
        "question",
        "answer",
        questionToAnswer,
        "--choice",
        "A",
        ...actor,
        "--plain",
      ],
      "question withdraw": [
        "question",
        "withdraw",
        questionToWithdraw,
        "--reason",
        "no longer needed",
        ...actor,
        "--plain",
      ],
      "question list": ["question", "list", "--plain"],
      "question view": ["question", "view", questionToAnswer, "--plain"],
      overview: ["overview", "--plain"],
      board: ["board", "--plain"],
      "board export": [
        "board",
        "export",
        join(store, "board-export.md"),
        "--plain",
      ],
      doctor: ["doctor", "--plain"],
      // QCLI-415: base-relative, so it reads a ref. HEAD is the evidence
      // commit made above, whose tree carries the fixture records; every
      // command the loop ran before this one either added a record or moved
      // one between the three locations, and a move still resolves.
      check: ["check", "--continuity", "--base", "HEAD", "--plain"],
      cleanup: ["cleanup", "--dry-run", ...actor, "--plain"],
      browser: ["browser", "--plain"],
    };

    const outputs = new Map<string, string>();
    for (const entry of manifest) {
      const recipe = invocations[entry.name];
      expect(
        recipe,
        `missing invocation recipe for ${entry.name}`,
      ).toBeDefined();
      const argv = recipe?.map((argument) =>
        argument === "--plain" ? mode : argument,
      );
      expect(argv).toBeDefined();
      const result =
        entry.name === "browser"
          ? await questUntilOutput(store, argv ?? [])
          : entry.name === "task binding"
            ? await questWithStdin(
                store,
                ["task", "binding", "--contract", "opum-agent-workflow/v1"],
                JSON.stringify({
                  contract: "opum-agent-workflow",
                  supportedVersions: [1],
                  requestId: "0".repeat(32),
                  taskId: bound,
                }),
              )
            : await (async () => {
                const cwd =
                  entry.name === "init" || entry.name === "init --reconfigure"
                    ? freshWorkspace
                    : store;
                const invocation = await quest(cwd, argv ?? []);
                if (invocation.exitCode !== 0)
                  throw new Error(`${entry.name}: ${invocation.stderr}`);
                expect(invocation.exitCode, entry.name).toBe(0);
                return invocation;
              })();
      const diagnostic = result.stderr
        ? (JSON.parse(result.stderr) as { readonly error_type?: string })
        : undefined;
      expect(diagnostic?.error_type, entry.name).not.toBe("usage");
      outputs.set(entry.name, result.stdout);
    }
    return { manifest, outputs };
  } finally {
    await rm(store, { recursive: true, force: true });
    await rm(freshWorkspace, { recursive: true, force: true });
    await rm(backlogSource, { recursive: true, force: true });
  }
}

test("every manifest payload command renders more than its kind in plain mode", async () => {
  const { manifest, outputs } =
    await invokeEveryManifestPayloadCommand("--plain");
  for (const entry of manifest.filter(
    (command): command is { readonly name: string; readonly kind: string } =>
      command.kind !== null,
  )) {
    const stdout = outputs.get(entry.name);
    expect(stdout, entry.name).toBeDefined();
    expect(stdout, entry.name).not.toBe(`${entry.kind}\n`);
    expect(stdout?.trim(), entry.name).not.toBe("");
    // QCLI-273: the plain renderer must never leak an UNSET optional field as
    // the literal word `undefined` -- QCLI-272's divergence, where --json
    // (JSON.stringify drops an undefined-valued property) was right and
    // --plain (Object.entries keeps it) printed `undefined`. This harness
    // already runs EVERY manifest payload command in --plain and --json, so
    // this one assertion closes the class structurally for all of them, which
    // is why the per-test pairing helper this task weighed was declined (see
    // the task record).
    expect(stdout ?? "", entry.name).not.toContain("undefined");
  }
}, 15_000);

test("every manifest payload command declares principal null as its last JSON key", async () => {
  const { manifest, outputs } =
    await invokeEveryManifestPayloadCommand("--json");
  for (const entry of manifest.filter(
    (command): command is { readonly name: string; readonly kind: string } =>
      command.kind !== null,
  )) {
    const stdout = outputs.get(entry.name);
    expect(stdout, entry.name).toBeDefined();
    const envelope = JSON.parse(stdout ?? "") as Record<string, unknown>;
    if (entry.name === "task binding") {
      // The public opum-agent-workflow/v1 envelope is its own closed shape.
      expect(envelope.contract, entry.name).toBe("opum-agent-workflow");
      continue;
    }
    expect(envelope.principal, entry.name).toBeNull();
    expect(Object.keys(envelope).at(-1), entry.name).toBe("principal");
  }
}, 15_000);

test("task edit can mutate title, priority, type and ordinal (QCLI-133)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-edit-fields-"));
  const human = ["--actor", "h", "--actor-kind", "human", "--json"];
  try {
    const created = await quest(store, [
      "task",
      "create",
      "Typo titel",
      "--priority",
      "High",
      "--type",
      "bug",
      "--ordinal",
      "5",
      ...human,
    ]);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout).data).toMatchObject({
      id: "T-1",
      title: "Typo titel",
      priority: "High",
      type: "bug",
      ordinal: 5,
    });

    // All four previously exited 2 with "task edit received invalid arguments".
    const edited = await quest(store, [
      "task",
      "edit",
      "T-1",
      "--title",
      "Fixed title",
      "--priority",
      "Low",
      "--type",
      "feature",
      "--ordinal",
      "10",
      ...human,
    ]);
    expect(edited.exitCode).toBe(0);
    expect(JSON.parse(edited.stdout).data).toMatchObject({
      id: "T-1",
      title: "Fixed title",
      priority: "Low",
      type: "feature",
      ordinal: 10,
    });

    // The rename keeps the record's identity rather than forcing a replacement.
    const viewed = await quest(store, ["task", "view", "T-1", "--json"]);
    expect(JSON.parse(viewed.stdout).data).toMatchObject({
      id: "T-1",
      title: "Fixed title",
      aliases: [],
    });

    // Each field is independently settable, not all-or-nothing.
    const titleOnly = await quest(store, [
      "task",
      "edit",
      "T-1",
      "--title",
      "Third title",
      ...human,
    ]);
    expect(titleOnly.exitCode).toBe(0);
    expect(JSON.parse(titleOnly.stdout).data).toMatchObject({
      title: "Third title",
      priority: "Low",
      type: "feature",
      ordinal: 10,
    });
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("task edit --ordinal rejects a non-integer exactly as create does (QCLI-133)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-edit-ordinal-"));
  const human = ["--actor", "h", "--actor-kind", "human", "--json"];
  try {
    await quest(store, ["task", "create", "T", ...human]);
    for (const argv of [
      ["task", "create", "Other", "--ordinal", "1.5", ...human],
      ["task", "edit", "T-1", "--ordinal", "1.5", ...human],
    ]) {
      const result = await quest(store, argv);
      expect(result).toMatchObject({ exitCode: 2, stdout: "" });
      expect(JSON.parse(result.stderr)).toMatchObject({
        error_type: "usage",
        message: "--ordinal must be an integer.",
      });
    }
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("the published manifest advertises the four newly editable fields (QCLI-133)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-edit-manifest-"));
  try {
    const manifest = await quest(store, ["manifest", "--json"]);
    const registry = JSON.parse(manifest.stdout);
    // Both edit transports share one fold, so both must advertise the fields.
    for (const name of ["task edit", "task edit-batch"]) {
      const entry = registry.data.commands.find(
        (command: { name: string }) => command.name === name,
      );
      for (const field of ["title", "priority", "type", "ordinal"]) {
        expect(entry.fields, `${name} advertises ${field}`).toContain(field);
      }
    }
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("the published manifest advertises every task list filter (QCLI-139)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-list-manifest-"));
  try {
    const manifest = await quest(store, ["manifest", "--json"]);
    const registry = JSON.parse(manifest.stdout);
    const entry = registry.data.commands.find(
      (command: { name: string }) => command.name === "task list",
    );
    expect([...entry.filters].sort()).toEqual([
      "assignee",
      "exclude-status",
      "fields",
      "include-archived",
      "label",
      "limit",
      "milestone",
      "parent",
      "priority",
      "ready",
      "search",
      "sort",
      "status",
      "type",
      "unassigned",
      "unresolved-at-completion",
    ]);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("task list --ready returns only dependency-unblocked tasks (QCLI-139)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-list-ready-"));
  const human = ["--actor", "h", "--actor-kind", "human", "--json"];
  try {
    await quest(store, ["task", "create", "Blocker", ...human]);
    await quest(store, [
      "task",
      "create",
      "Blocked",
      "--dependency",
      "T-1",
      ...human,
    ]);
    const listed = await quest(store, ["task", "list", "--ready", "--json"]);
    expect(listed).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(listed.stdout).data).toEqual([
      expect.objectContaining({ id: "T-1" }),
    ]);
    await quest(store, [
      "task",
      "edit",
      "T-1",
      "--status",
      "In Progress",
      ...human,
    ]);
    await quest(store, ["task", "edit", "T-1", "--status", "Done", ...human]);
    const readyAfterCompletion = await quest(store, [
      "task",
      "list",
      "--ready",
      "--json",
    ]);
    expect(JSON.parse(readyAfterCompletion.stdout).data).toEqual([
      expect.objectContaining({ id: "T-2" }),
    ]);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("task list --ready composes with --label (QCLI-139)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-list-ready-label-"));
  const human = ["--actor", "h", "--actor-kind", "human", "--json"];
  try {
    await quest(store, [
      "task",
      "create",
      "Ready backend",
      "--label",
      "backend",
      ...human,
    ]);
    // Depends on the backend task, which the frontend label filter excludes.
    await quest(store, [
      "task",
      "create",
      "Blocked frontend",
      "--label",
      "frontend",
      "--dependency",
      "T-1",
      ...human,
    ]);
    const listed = await quest(store, [
      "task",
      "list",
      "--ready",
      "--label",
      "backend",
      "--json",
    ]);
    expect(JSON.parse(listed.stdout).data).toEqual([
      expect.objectContaining({ id: "T-1" }),
    ]);
    // Readiness is computed over the whole collection before the label filter
    // runs. Computing it after would drop the T-1 edge and call T-2 ready.
    const blocked = await quest(store, [
      "task",
      "list",
      "--ready",
      "--label",
      "frontend",
      "--json",
    ]);
    expect(JSON.parse(blocked.stdout).data).toEqual([]);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("task list selection filters compose: exclude-status, assignee, unassigned, milestone, parent, priority, type, search (QCLI-139)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-list-filters-"));
  const human = ["--actor", "h", "--actor-kind", "human", "--json"];
  try {
    await quest(store, [
      "task",
      "create",
      "Alpha",
      "--priority",
      "high",
      "--type",
      "feature",
      "--assignee",
      "person-1",
      ...human,
    ]);
    await quest(store, [
      "task",
      "create",
      "Beta",
      "--priority",
      "low",
      "--type",
      "bug",
      "--parent",
      "T-1",
      ...human,
    ]);
    await quest(store, [
      "task",
      "edit",
      "T-1",
      "--status",
      "In Progress",
      ...human,
    ]);
    await quest(store, ["task", "edit", "T-1", "--status", "Done", ...human]);

    const excludeDone = await quest(store, [
      "task",
      "list",
      "--exclude-status",
      "Done",
      "--json",
    ]);
    expect(JSON.parse(excludeDone.stdout).data).toEqual([
      expect.objectContaining({ id: "T-2" }),
    ]);

    const byAssignee = await quest(store, [
      "task",
      "list",
      "--assignee",
      "person-1",
      "--json",
    ]);
    expect(JSON.parse(byAssignee.stdout).data).toEqual([
      expect.objectContaining({ id: "T-1" }),
    ]);

    const unassigned = await quest(store, [
      "task",
      "list",
      "--unassigned",
      "--json",
    ]);
    expect(JSON.parse(unassigned.stdout).data).toEqual([
      expect.objectContaining({ id: "T-2" }),
    ]);

    const byParent = await quest(store, [
      "task",
      "list",
      "--parent",
      "T-1",
      "--json",
    ]);
    expect(JSON.parse(byParent.stdout).data).toEqual([
      expect.objectContaining({ id: "T-2" }),
    ]);

    const byPriority = await quest(store, [
      "task",
      "list",
      "--priority",
      "high",
      "--json",
    ]);
    expect(JSON.parse(byPriority.stdout).data).toEqual([
      expect.objectContaining({ id: "T-1" }),
    ]);

    const byType = await quest(store, [
      "task",
      "list",
      "--type",
      "bug",
      "--json",
    ]);
    expect(JSON.parse(byType.stdout).data).toEqual([
      expect.objectContaining({ id: "T-2" }),
    ]);

    const bySearch = await quest(store, [
      "task",
      "list",
      "--search",
      "Alpha",
      "--json",
    ]);
    expect(JSON.parse(bySearch.stdout).data).toEqual([
      expect.objectContaining({ id: "T-1" }),
    ]);

    const assigneeAndUnassigned = await quest(store, [
      "task",
      "list",
      "--assignee",
      "person-1",
      "--unassigned",
      "--json",
    ]);
    expect(assigneeAndUnassigned).toMatchObject({ exitCode: 2, stdout: "" });
    expect(JSON.parse(assigneeAndUnassigned.stderr)).toMatchObject({
      error_type: "usage",
      message: "task list --assignee and --unassigned cannot be combined.",
    });
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("task list --sort and --limit apply after every other filter (QCLI-139)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-list-sort-limit-"));
  const human = ["--actor", "h", "--actor-kind", "human", "--json"];
  try {
    await quest(store, [
      "task",
      "create",
      "Alpha",
      "--priority",
      "low",
      ...human,
    ]);
    await quest(store, [
      "task",
      "create",
      "Beta",
      "--priority",
      "high",
      ...human,
    ]);
    await quest(store, [
      "task",
      "create",
      "Gamma",
      "--priority",
      "high",
      ...human,
    ]);
    await quest(store, [
      "task",
      "create",
      "Delta",
      "--priority",
      "medium",
      ...human,
    ]);
    // T-1 low, T-2 high, T-3 high, T-4 medium. Priority sorts by rank, not
    // alphabetically: as strings the order is high, high, low, medium, which
    // puts the lowest priority ahead of medium. Ties break by ascending id.
    const ascending = await quest(store, [
      "task",
      "list",
      "--sort",
      "priority",
      "--json",
    ]);
    expect(
      JSON.parse(ascending.stdout).data.map((t: { id: string }) => t.id),
    ).toEqual(["T-2", "T-3", "T-4", "T-1"]);
    const sorted = await quest(store, [
      "task",
      "list",
      "--sort",
      "priority:desc",
      "--json",
    ]);
    expect(
      JSON.parse(sorted.stdout).data.map((t: { id: string }) => t.id),
    ).toEqual(["T-1", "T-4", "T-2", "T-3"]);
    // Limit truncates the sorted ordering, not the id ordering.
    const limited = await quest(store, [
      "task",
      "list",
      "--sort",
      "priority:asc",
      "--limit",
      "1",
      "--json",
    ]);
    expect(JSON.parse(limited.stdout).data).toEqual([
      expect.objectContaining({ id: "T-2" }),
    ]);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("task list rejects invalid --sort and --limit values (QCLI-139)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-list-sort-invalid-"));
  try {
    for (const [argv, message] of [
      [
        ["task", "list", "--sort", "bogus", "--json"],
        "--sort must be one of id, title, status, priority, type, ordinal, createdAt, updatedAt, optionally suffixed with :asc or :desc.",
      ],
      [
        ["task", "list", "--limit", "0", "--json"],
        "--limit must be a positive integer.",
      ],
      [
        ["task", "list", "--limit", "abc", "--json"],
        "--limit must be a positive integer.",
      ],
    ] as const) {
      const result = await quest(store, argv);
      expect(result).toMatchObject({ exitCode: 2, stdout: "" });
      expect(JSON.parse(result.stderr)).toMatchObject({
        error_type: "usage",
        message,
      });
    }
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("task list --status and --label behave exactly as before (QCLI-139 regression)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-list-regression-"));
  const human = ["--actor", "h", "--actor-kind", "human", "--json"];
  try {
    await quest(store, [
      "task",
      "create",
      "Alpha",
      "--label",
      "backend",
      ...human,
    ]);
    await quest(store, [
      "task",
      "create",
      "Beta",
      "--label",
      "frontend",
      ...human,
    ]);
    const byStatus = await quest(store, [
      "task",
      "list",
      "--status",
      "To Do",
      "--json",
    ]);
    expect(
      JSON.parse(byStatus.stdout).data.map((t: { id: string }) => t.id),
    ).toEqual(["T-1", "T-2"]);
    const byLabel = await quest(store, [
      "task",
      "list",
      "--label",
      "backend",
      "--json",
    ]);
    expect(JSON.parse(byLabel.stdout).data).toEqual([
      expect.objectContaining({ id: "T-1" }),
    ]);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("task list selection flags fold case, accept comma lists, and union repeats (QCLI-139)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-list-selection-"));
  const human = ["--actor", "h", "--actor-kind", "human", "--json"];
  try {
    await quest(store, [
      "task",
      "create",
      "Parent",
      "--alias",
      "PARENT-ALIAS",
      "--priority",
      "High",
      "--type",
      "Feature",
      "--assignee",
      "Person-1",
      ...human,
    ]);
    await quest(store, [
      "task",
      "create",
      "Child",
      "--parent",
      "T-1",
      "--priority",
      "Low",
      "--type",
      "bug",
      "--assignee",
      "person-2",
      ...human,
    ]);
    const ids = async (argv: readonly string[]) =>
      JSON.parse((await quest(store, [...argv, "--json"])).stdout).data.map(
        (task: { id: string }) => task.id,
      );

    // Priority and type are free-form authored strings; a case mismatch used
    // to return a silent empty list.
    expect(await ids(["task", "list", "--priority", "high"])).toEqual(["T-1"]);
    expect(await ids(["task", "list", "--type", "FEATURE"])).toEqual(["T-1"]);

    // Repeatable or comma-separated, like the tracker Quest is at parity with.
    expect(await ids(["task", "list", "--type", "bug,feature"])).toEqual([
      "T-1",
      "T-2",
    ]);
    expect(
      await ids(["task", "list", "--type", "bug", "--type", "feature"]),
    ).toEqual(["T-1", "T-2"]);
    expect(
      await ids(["task", "list", "--exclude-status", "In Progress,Done"]),
    ).toEqual(["T-1", "T-2"]);

    // A repeated --assignee is a union, not an intersection.
    expect(
      await ids([
        "task",
        "list",
        "--assignee",
        "person-1",
        "--assignee",
        "person-2",
      ]),
    ).toEqual(["T-1", "T-2"]);

    // --parent folds case and aliases, like every other task reference.
    for (const reference of ["T-1", "t-1", "parent-alias"])
      expect(await ids(["task", "list", "--parent", reference])).toEqual([
        "T-2",
      ]);

    const empty = await quest(store, ["task", "list", "--type", ",", "--json"]);
    expect(empty).toMatchObject({ exitCode: 2, stdout: "" });
    expect(JSON.parse(empty.stderr)).toMatchObject({
      error_type: "usage",
      message: "--type requires at least one value.",
    });
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("milestone archive retires a milestone and list hides it by default (QCLI-140)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-milestone-archive-"));
  const human = ["--actor", "h", "--actor-kind", "human", "--json"];
  try {
    await quest(store, ["task", "create", "Shipped work", ...human]);
    await quest(store, [
      "milestone",
      "create",
      "Release 1",
      "--status",
      "closed",
      "--task",
      "T-1",
      ...human,
    ]);
    await quest(store, ["milestone", "create", "Release 2", ...human]);

    const archived = await quest(store, [
      "milestone",
      "archive",
      "M-1",
      ...human,
    ]);
    expect(archived.exitCode).toBe(0);
    const envelope = JSON.parse(archived.stdout);
    expect(envelope.kind).toBe("milestone.archived");
    // The task reference survives; that is the difference from delete.
    expect(envelope.data).toMatchObject({
      id: "M-1",
      status: "closed",
      taskIds: ["T-1"],
      archived: true,
    });

    const ids = async (argv: readonly string[]) =>
      JSON.parse((await quest(store, [...argv, "--json"])).stdout).data.map(
        (item: { id: string }) => item.id,
      );
    expect(await ids(["milestone", "list"])).toEqual(["M-2"]);
    expect(await ids(["milestone", "list", "--include-archived"])).toEqual([
      "M-1",
      "M-2",
    ]);
    expect(
      JSON.parse(
        (await quest(store, ["milestone", "view", "M-1", "--json"])).stdout,
      ).data,
    ).toMatchObject({ archived: true, taskIds: ["T-1"] });

    // AC3: delete keeps its destructive behaviour and its reference guard.
    const deleted = await quest(store, [
      "milestone",
      "delete",
      "M-1",
      ...human,
    ]);
    expect(deleted.exitCode).toBe(6);
    expect(JSON.parse(deleted.stderr)).toMatchObject({
      message: "milestone_has_task_references",
    });
    const deletedEmpty = await quest(store, [
      "milestone",
      "delete",
      "M-2",
      ...human,
    ]);
    expect(deletedEmpty.exitCode).toBe(0);
    expect(await ids(["milestone", "list", "--include-archived"])).toEqual([
      "M-1",
    ]);

    // Archiving twice, and archiving a decision, are both rejected.
    const again = await quest(store, ["milestone", "archive", "M-1", ...human]);
    expect(again.exitCode).toBe(6);
    expect(JSON.parse(again.stderr)).toMatchObject({
      message: "milestone_lifecycle_already_at_destination",
    });
    const missingActor = await quest(store, [
      "milestone",
      "archive",
      "M-1",
      "--json",
    ]);
    expect(missingActor.exitCode).toBe(4);
    const decisionArchive = await quest(store, [
      "decision",
      "archive",
      "DEC-1",
      ...human,
    ]);
    expect(decisionArchive.exitCode).toBe(2);
    expect(JSON.parse(decisionArchive.stderr)).toMatchObject({
      error_type: "usage",
      message: "decision action is invalid or missing required arguments.",
    });

    // Only the archived M-1 remains at this point. Archived milestones keep
    // their ids, so auto-id allocation must still see them: allocating from
    // the visible list alone finds nothing, reuses M-1, and every subsequent
    // create fails with milestone_already_exists.
    const afterArchive = await quest(store, [
      "milestone",
      "create",
      "Release 3",
      ...human,
    ]);
    expect(afterArchive.exitCode).toBe(0);
    expect(JSON.parse(afterArchive.stdout).data.id).toBe("M-2");

    // Editing an archived milestone does not quietly un-archive it.
    await quest(store, [
      "milestone",
      "edit",
      "M-1",
      "--title",
      "Release 1, retired",
      ...human,
    ]);
    expect(
      JSON.parse(
        (await quest(store, ["milestone", "view", "M-1", "--json"])).stdout,
      ).data,
    ).toMatchObject({ title: "Release 1, retired", archived: true });
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("instructions serves guides and --list without changing the bare form (QCLI-141)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-instructions-guides-"));
  try {
    // AC2: the bare form is still the managed block, byte for byte. Every
    // existing caller and `agents --check` depend on it.
    const bare = await quest(store, ["instructions", "--json"]);
    expect(bare.exitCode).toBe(0);
    const bareEnvelope = JSON.parse(bare.stdout);
    expect(bareEnvelope.kind).toBe("agent.instructions");
    expect(bareEnvelope.data.content).toContain(
      "<!-- quest:agent-instructions:begin -->",
    );

    const listed = await quest(store, ["instructions", "--list", "--json"]);
    expect(listed.exitCode).toBe(0);
    const listEnvelope = JSON.parse(listed.stdout);
    expect(listEnvelope.kind).toBe("agent.guides");
    expect(
      listEnvelope.data.guides.map((guide: { name: string }) => guide.name),
    ).toEqual([
      "overview",
      "task-creation",
      "task-execution",
      "task-finalization",
      "workspace",
    ]);
    // AC1: every entry carries a one-line purpose.
    for (const guide of listEnvelope.data.guides) {
      expect(guide.summary.length).toBeGreaterThan(0);
      expect(guide.summary).not.toContain("\n");
    }

    // Each guide is distinct content, not the same block five times.
    const bodies = new Set<string>();
    for (const name of listEnvelope.data.guides.map(
      (guide: { name: string }) => guide.name,
    )) {
      const served = await quest(store, ["instructions", name, "--json"]);
      expect({ name, exitCode: served.exitCode }).toEqual({
        name,
        exitCode: 0,
      });
      const envelope = JSON.parse(served.stdout);
      expect(envelope.kind).toBe("agent.guide");
      expect(envelope.data.name).toBe(name);
      bodies.add(envelope.data.content);
    }
    expect(bodies.size).toBe(5);

    // AC3: no "all" guide, and the error says what to do instead.
    const all = await quest(store, ["instructions", "all", "--json"]);
    expect(all.exitCode).toBe(3);
    const diagnostic = JSON.parse(all.stderr);
    expect(diagnostic).toMatchObject({ error_type: "not_found" });
    expect(diagnostic.hint).toContain("--list");
    expect(diagnostic.hint).toContain('no "all" guide');

    const both = await quest(store, [
      "instructions",
      "overview",
      "--list",
      "--json",
    ]);
    expect(both.exitCode).toBe(2);
    expect(JSON.parse(both.stderr)).toMatchObject({ error_type: "usage" });

    // A malformed flag is a usage error, not "unknown guide -x": a leading
    // dash is a flag however many dashes it has.
    for (const flag of ["--nope", "-x", "-l"]) {
      const bogus = await quest(store, ["instructions", flag, "--json"]);
      expect({ flag, exitCode: bogus.exitCode }).toEqual({ flag, exitCode: 2 });
      expect(JSON.parse(bogus.stderr)).toMatchObject({ error_type: "usage" });
    }

    // The guide argument is positional and may precede or follow --json.
    const flagFirst = await quest(store, [
      "instructions",
      "--json",
      "overview",
    ]);
    expect(flagFirst.exitCode).toBe(0);
    expect(JSON.parse(flagFirst.stdout).data.name).toBe("overview");
    const trailing = await quest(store, ["instructions", "overview", "extra"]);
    expect(trailing.exitCode).toBe(2);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("tasks carry createdAt and updatedAt, and updatedAt advances on write (QCLI-137)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-timestamps-"));
  const human = ["--actor", "h", "--actor-kind", "human", "--json"];
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  try {
    const created = JSON.parse(
      (await quest(store, ["task", "create", "Stamped", ...human])).stdout,
    ).data;
    expect(created.createdAt).toMatch(iso);
    expect(created.updatedAt).toBe(created.createdAt);

    // Both surfaces the manifest declares them on return them.
    const viewed = JSON.parse(
      (await quest(store, ["task", "view", "T-1", "--json"])).stdout,
    ).data;
    expect(viewed.createdAt).toBe(created.createdAt);
    const [listed] = JSON.parse(
      (await quest(store, ["task", "list", "--json"])).stdout,
    ).data;
    expect(listed.createdAt).toBe(created.createdAt);

    const edited = JSON.parse(
      (
        await quest(store, [
          "task",
          "edit",
          "T-1",
          "--title",
          "Restamped",
          "--status",
          "In Progress",
          ...human,
        ])
      ).stdout,
    ).data;
    expect(edited.createdAt).toBe(created.createdAt);
    expect(edited.updatedAt > created.updatedAt).toBe(true);
    expect(edited.updatedAt).toMatch(iso);

    // A status transition is a write. QCLI-264: task.completed carries the
    // record directly in data, the same as task.updated.
    const completed = JSON.parse(
      (await quest(store, ["task", "complete", "T-1", ...human])).stdout,
    ).data;
    expect(completed.updatedAt > edited.updatedAt).toBe(true);
    expect(completed.createdAt).toBe(created.createdAt);

    // So is a lifecycle move, which takes a different write path entirely.
    const archived = JSON.parse(
      (await quest(store, ["task", "archive", "T-1", ...human])).stdout,
    ).data;
    expect(archived.updatedAt > completed.updatedAt).toBe(true);
    expect(archived.createdAt).toBe(created.createdAt);

    // And the sort fields QCLI-139 had to drop are back. T-1 is archived by
    // now, so order these on two fresh records.
    await quest(store, ["task", "create", "Second", ...human]);
    await quest(store, ["task", "create", "Third", ...human]);
    await quest(store, [
      "task",
      "edit",
      "T-2",
      "--summary",
      "touched last",
      ...human,
    ]);
    const ids = async (argv: readonly string[]) =>
      JSON.parse((await quest(store, [...argv, "--json"])).stdout).data.map(
        (task: { id: string }) => task.id,
      );
    expect(await ids(["task", "list", "--sort", "createdAt"])).toEqual([
      "T-2",
      "T-3",
    ]);
    expect(await ids(["task", "list", "--sort", "createdAt:desc"])).toEqual([
      "T-3",
      "T-2",
    ]);
    // T-2 was created first but edited last, so the two orderings differ --
    // which is what makes this assertion prove updatedAt is a real field and
    // not an alias for createdAt.
    expect(await ids(["task", "list", "--sort", "updatedAt:desc"])).toEqual([
      "T-2",
      "T-3",
    ]);

    // Promotion creates a task, so it stamps like create does. Without this
    // the record could never acquire a createdAt at all.
    await quest(store, ["draft", "create", "An idea", ...human]);
    const promoted = JSON.parse(
      (await quest(store, ["draft", "promote", "D-1", ...human])).stdout,
    ).data;
    expect(promoted.createdAt).toMatch(iso);
    expect(promoted.updatedAt).toBe(promoted.createdAt);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("every key a task read emits is manifest-declared, and every declared field is emitted (QCLI-137, QCLI-461)", async () => {
  // The defect this closes was a manifest promising createdAt/updatedAt on
  // `task list`, `task view` and `search` that nothing ever wrote. This is
  // that class, generalized: a task with every settable field must carry
  // every field those three read surfaces declare.
  const store = await mkdtemp(join(tmpdir(), "quest-manifest-fields-"));
  const human = ["--actor", "h", "--actor-kind", "human", "--json"];
  try {
    await quest(store, ["task", "create", "Dependency", ...human]);
    await quest(store, ["milestone", "create", "Release", ...human]);
    const created = JSON.parse(
      (
        await quest(store, [
          "task",
          "create",
          "Fully populated",
          "--summary",
          "s",
          "--description",
          "d",
          "--priority",
          "high",
          "--type",
          "feature",
          "--ordinal",
          "7",
          "--alias",
          "FULL",
          "--label",
          "l",
          "--doc",
          "docs/x.md",
          "--acceptance-criteria",
          '["ac"]',
          "--definition-of-done",
          '["dod"]',
          "--plan",
          '["p"]',
          "--implementation-notes",
          '["n"]',
          "--assignee",
          "person-1",
          "--reference",
          "src/x.ts",
          "--modified-file",
          "src/y.ts",
          "--dependency",
          "T-1",
          "--parent",
          "T-1",
          "--milestone",
          "M-1",
          "--final-summary",
          "done",
          ...human,
        ])
      ).stdout,
    ).data;

    const manifest = JSON.parse(
      (await quest(store, ["manifest", "--json"])).stdout,
    ).data.commands as {
      name: string;
      fields?: string[];
      mutates?: boolean;
    }[];
    const viewed = JSON.parse(
      (await quest(store, ["task", "view", created.id, "--json"])).stdout,
    ).data;
    // QCLI-461 (review round 1): the rich task above reaches most declared
    // keys but NOT the conditional ones. A task completed with an unchecked
    // item carries `unresolvedAtCompletion`, and a closed task carries
    // `resolution`; both are built here so the payload-subset-of-declared
    // assertion below actually exercises them -- dropping either from a
    // declared set must go RED rather than unnoticed. (`claim` is reachable
    // only through the `task binding` flow, which its own suite covers.)
    const unresolved = JSON.parse(
      (
        await quest(store, [
          "task",
          "create",
          "Unresolved",
          "--acceptance-criteria",
          '["x"]',
          ...human,
        ])
      ).stdout,
    ).data as { id: string };
    await quest(store, [
      "task",
      "edit",
      unresolved.id,
      "--status",
      "In Progress",
      ...human,
    ]);
    await quest(store, ["task", "complete", unresolved.id, ...human]);
    const closed = JSON.parse(
      (await quest(store, ["task", "create", "Closed", ...human])).stdout,
    ).data as { id: string };
    await quest(store, [
      "task",
      "close",
      closed.id,
      "--resolution",
      "wont-do",
      ...human,
    ]);
    const unresolvedView = JSON.parse(
      (await quest(store, ["task", "view", unresolved.id, "--json"])).stdout,
    ).data;
    const closedView = JSON.parse(
      (await quest(store, ["task", "view", closed.id, "--json"])).stdout,
    ).data;
    // QCLI-276 / DEC-3: `notesOmitted` is the one manifest-declared "task
    // view" field that is NOT always emitted -- it is additive and only
    // appears when `--max-notes` was supplied, present even at 0. The
    // generic loop below carves it out of the always-present check and this
    // pair asserts the conditional shape directly instead.
    const viewedWithMaxNotes = JSON.parse(
      (
        await quest(store, [
          "task",
          "view",
          created.id,
          "--max-notes",
          "999",
          "--json",
        ])
      ).stdout,
    ).data;
    expect(Object.hasOwn(viewed, "notesOmitted")).toBe(false);
    expect(viewedWithMaxNotes.notesOmitted).toBe(0);
    const listed = JSON.parse(
      (await quest(store, ["task", "list", "--json"])).stdout,
    ).data.find((task: { id: string }) => task.id === created.id);

    const searched = JSON.parse(
      (await quest(store, ["search", "Fully", "--json"])).stdout,
    ).data.find((task: { id: string }) => task.id === created.id);

    // QCLI-445 review: a question view/list payload, so the complete-fields
    // check below covers the question family as well as the task reads.
    const askedQuestion = JSON.parse(
      (
        await quest(store, [
          "question",
          "ask",
          "--title",
          "Ship 0.14.0?",
          "--option",
          "A=Yes:ship",
          "--option",
          "B=No:wait",
          "--recommend",
          "A",
          ...human,
        ])
      ).stdout,
    ).data as { id: string };
    const questionViewed = JSON.parse(
      (await quest(store, ["question", "view", askedQuestion.id, "--json"]))
        .stdout,
    ).data;
    const questionListed = JSON.parse(
      (await quest(store, ["question", "list", "--json"])).stdout,
    ).data[0];

    // Only the read surfaces. `task create` and `task edit` also carry a
    // `fields` list, but theirs is the settable-input vocabulary — it holds
    // `addLabels` and `clearParent` and omits `id` and `status` — so an
    // output-key assertion does not apply to it.
    //
    // QCLI-461: the declared `fields` is the COMPLETE top-level key set a
    // payload can carry, so the direction asserted is payload-subset-of-
    // declared -- every key the payload actually carries must be declared.
    // The former assertion here checked the OPPOSITE direction (every declared
    // key present, with exceptions carved out for the conditional ones), which
    // a curated subset satisfies while the record carries more: that is how
    // the manifest came to under-declare both records.
    // QCLI-461: records that carry the CONDITIONAL keys the rich task does not
    // -- so dropping `unresolvedAtCompletion` or `resolution` from a declared
    // set is caught here rather than passing unnoticed.
    const payloads: readonly (readonly [string, object])[] = [
      ["task view", viewed],
      ["task view", viewedWithMaxNotes],
      ["task view", unresolvedView],
      ["task view", closedView],
      ["task list", listed],
      ["search", searched],
      ["question view", questionViewed],
      ["question list", questionListed],
    ];
    // QCLI-445 review: every non-mutating command that declares `fields` must
    // be classified -- either checked above (a record read whose declared set is
    // the COMPLETE key set) or named here as a CURATED SUBSET, to which the
    // payload-subset rule does not apply. Deriving the population from the
    // manifest, rather than from a fixed list, is what stops the next family
    // (this one included) from slipping past the check unnoticed.
    const CURATED_FIELDS_READS = new Set<string>([
      "instructions",
      "instructions --list",
      "instructions <guide>",
      "migration backlog preview",
      "migration backlog status",
      "task status-flow",
      "task binding",
      "task list --across-refs",
      "draft view",
      "milestone list",
      "milestone view",
      "decision list",
      "decision view",
      "board export",
    ]);
    const checkedNames = new Set(payloads.map(([name]) => name));
    const unclassified = manifest
      .filter((entry) => entry.mutates === false && entry.fields !== undefined)
      .map((entry) => entry.name)
      .filter(
        (name) => !checkedNames.has(name) && !CURATED_FIELDS_READS.has(name),
      );
    expect({ unclassified }).toEqual({ unclassified: [] });
    for (const [name, payload] of payloads) {
      const declared = manifest.find((entry) => entry.name === name)?.fields;
      expect({ name, declared: declared !== undefined }).toEqual({
        name,
        declared: true,
      });
      const undeclared = Object.keys(payload).filter(
        (field) => !(declared ?? []).includes(field),
      );
      expect({ name, undeclared }).toEqual({ name, undeclared: [] });
    }

    // QCLI-137 (kept, scoped): a declared field that NOTHING emits is a
    // phantom promise -- the defect that task closed. The payloads above reach
    // every declared read key EXCEPT `claim` and `source`, written only by the
    // `task binding` and migration flows; those two are named so the exclusion
    // is visible rather than silent.
    const reached = new Set<string>();
    for (const payload of [
      viewed,
      viewedWithMaxNotes,
      listed,
      searched,
      unresolvedView,
      closedView,
    ])
      for (const field of Object.keys(payload as object)) reached.add(field);
    const reachableElsewhere = ["claim", "source"];
    for (const name of ["task view", "task list", "search"] as const) {
      const declared =
        manifest.find((entry) => entry.name === name)?.fields ?? [];
      const phantom = declared.filter(
        (field) => !reached.has(field) && !reachableElsewhere.includes(field),
      );
      expect({ name, phantom }).toEqual({ name, phantom: [] });
    }
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("task edit can set a final summary on an existing task (QCLI-147)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-final-summary-"));
  const human = ["--actor", "h", "--actor-kind", "human", "--json"];
  try {
    await quest(store, ["task", "create", "Needs closing", ...human]);
    const edited = JSON.parse(
      (
        await quest(store, [
          "task",
          "edit",
          "T-1",
          "--final-summary",
          "Fixed the fold; 14 tests cover it.",
          ...human,
        ])
      ).stdout,
    ).data;
    expect(edited.finalSummary).toBe("Fixed the fold; 14 tests cover it.");

    // It persists, and a later edit that does not mention it leaves it alone.
    await quest(store, ["task", "edit", "T-1", "--summary", "s", ...human]);
    const viewed = JSON.parse(
      (await quest(store, ["task", "view", "T-1", "--json"])).stdout,
    ).data;
    expect(viewed.finalSummary).toBe("Fixed the fold; 14 tests cover it.");

    // Replacing it works, which is the whole point: create-only meant a
    // summary written once could never be corrected.
    const rewritten = JSON.parse(
      (
        await quest(store, [
          "task",
          "edit",
          "T-1",
          "--final-summary",
          "Corrected.",
          ...human,
        ])
      ).stdout,
    ).data;
    expect(rewritten.finalSummary).toBe("Corrected.");

    // And through the batch transport, which shares the same fold.
    const operations = join(store, "ops.jsonl");
    await writeFile(
      operations,
      JSON.stringify({
        reference: "T-1",
        operationId: "op-1",
        patch: { finalSummary: "From the batch." },
      }),
    );
    const batch = await quest(store, [
      "task",
      "edit-batch",
      "--file",
      operations,
      ...human,
    ]);
    expect(batch.exitCode).toBe(0);
    expect(JSON.parse(batch.stdout).data.items).toEqual([
      expect.objectContaining({ kind: "updated", reference: "T-1" }),
    ]);
    expect(
      JSON.parse((await quest(store, ["task", "view", "T-1", "--json"])).stdout)
        .data.finalSummary,
    ).toBe("From the batch.");

    // A non-string is a parse-time usage error, not a coerced write.
    await writeFile(
      operations,
      JSON.stringify({
        reference: "T-1",
        operationId: "op-2",
        patch: { finalSummary: 42 },
      }),
    );
    const rejected = await quest(store, [
      "task",
      "edit-batch",
      "--file",
      operations,
      ...human,
    ]);
    expect(rejected.exitCode).toBe(2);
    expect(JSON.parse(rejected.stderr).message).toContain("finalSummary");

    // Single-value, like every other scalar replace.
    const repeated = await quest(store, [
      "task",
      "edit",
      "T-1",
      "--final-summary",
      "a",
      "--final-summary",
      "b",
      ...human,
    ]);
    expect(repeated.exitCode).toBe(2);
    expect(JSON.parse(repeated.stderr)).toMatchObject({
      error_type: "usage",
      message: "--final-summary may only be provided once.",
    });

    // An empty value stores an empty summary, exactly as --summary does.
    // There is no --clear-final-summary; Backlog has one, Quest does not.
    const emptied = JSON.parse(
      (
        await quest(store, [
          "task",
          "edit",
          "T-1",
          "--final-summary=",
          ...human,
        ])
      ).stdout,
    ).data;
    expect(emptied.finalSummary).toBe("");
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("final summary can be cleared and appended, not only replaced (QCLI-149)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-final-summary-ops-"));
  const human = ["--actor", "h", "--actor-kind", "human", "--json"];
  const summary = async () =>
    JSON.parse((await quest(store, ["task", "view", "T-1", "--json"])).stdout)
      .data.finalSummary;
  try {
    await quest(store, ["task", "create", "Closing", ...human]);
    await quest(store, [
      "task",
      "edit",
      "T-1",
      "--final-summary",
      "First pass.",
      ...human,
    ]);

    // Appending extends rather than replaces, and joins as a paragraph: a
    // summary extended after review reads as a second paragraph.
    await quest(store, [
      "task",
      "edit",
      "T-1",
      "--append-final-summary",
      "Review found two things.",
      ...human,
    ]);
    expect(await summary()).toBe("First pass.\n\nReview found two things.");

    // Repeatable, and appends in CLI order after a replacement in the same
    // command, matching --append-plan and --append-notes.
    await quest(store, [
      "task",
      "edit",
      "T-1",
      "--final-summary",
      "Rewritten.",
      "--append-final-summary",
      "Then this.",
      "--append-final-summary",
      "And this.",
      ...human,
    ]);
    expect(await summary()).toBe("Rewritten.\n\nThen this.\n\nAnd this.");

    // Appending to a task that never had one does not lead with a blank line.
    await quest(store, ["task", "create", "Fresh", ...human]);
    await quest(store, [
      "task",
      "edit",
      "T-2",
      "--append-final-summary",
      "Only paragraph.",
      ...human,
    ]);
    expect(
      JSON.parse((await quest(store, ["task", "view", "T-2", "--json"])).stdout)
        .data.finalSummary,
    ).toBe("Only paragraph.");

    await quest(store, [
      "task",
      "edit",
      "T-1",
      "--clear-final-summary",
      ...human,
    ]);
    expect(await summary()).toBe("");

    // Clear is exclusive, and the error names the corrective combination.
    for (const argv of [
      ["--clear-final-summary", "--final-summary", "x"],
      ["--clear-final-summary", "--append-final-summary", "x"],
    ]) {
      const conflicting = await quest(store, [
        "task",
        "edit",
        "T-1",
        ...argv,
        ...human,
      ]);
      expect(conflicting.exitCode).toBe(2);
      expect(JSON.parse(conflicting.stderr)).toMatchObject({
        error_type: "usage",
        message:
          "--clear-final-summary cannot be combined with a final summary value.",
      });
    }

    // Both reach edit-batch through the shared fold.
    const operations = join(store, "ops.jsonl");
    await writeFile(
      operations,
      [
        JSON.stringify({
          reference: "T-1",
          operationId: "op-1",
          patch: {
            finalSummary: "Batched.",
            appendFinalSummary: ["Extended."],
          },
        }),
        JSON.stringify({
          reference: "T-2",
          operationId: "op-2",
          patch: { clearFinalSummary: true },
        }),
      ].join("\n"),
    );
    expect(
      (
        await quest(store, [
          "task",
          "edit-batch",
          "--file",
          operations,
          ...human,
        ])
      ).exitCode,
    ).toBe(0);
    expect(await summary()).toBe("Batched.\n\nExtended.");
    expect(
      JSON.parse((await quest(store, ["task", "view", "T-2", "--json"])).stdout)
        .data.finalSummary,
    ).toBe("");

    // The batch grammar types both: a list for append, a boolean for clear.
    for (const patch of [
      { appendFinalSummary: "not a list" },
      { clearFinalSummary: "yes" },
    ]) {
      await writeFile(
        operations,
        JSON.stringify({ reference: "T-1", operationId: "op-x", patch }),
      );
      const rejected = await quest(store, [
        "task",
        "edit-batch",
        "--file",
        operations,
        ...human,
      ]);
      expect({ patch, exitCode: rejected.exitCode }).toEqual({
        patch,
        exitCode: 2,
      });
      // Assert which rejection: exit 2 alone would also pass for "unknown
      // patch key", i.e. if the manifest entry had been dropped.
      expect(JSON.parse(rejected.stderr).message).toMatch(
        /must be a boolean|Invalid list value/,
      );
    }
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("board export writes a readable Markdown artifact (QCLI-143)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-board-export-"));
  const human = ["--actor", "h", "--actor-kind", "human", "--json"];
  const target = join(store, "board.md");
  try {
    await quest(store, ["task", "create", "First task", ...human]);
    await quest(store, ["task", "create", "Second task", ...human]);
    await quest(store, [
      "task",
      "edit",
      "T-2",
      "--status",
      "In Progress",
      ...human,
    ]);
    await quest(store, [
      "milestone",
      "create",
      "Release 1",
      "--task",
      "T-1",
      ...human,
    ]);

    const exported = await quest(store, ["board", "export", target, "--json"]);
    expect(exported.exitCode).toBe(0);
    expect(JSON.parse(exported.stdout)).toMatchObject({
      kind: "project.board-export",
      data: { path: target },
    });

    const markdown = await readFile(target, "utf8");
    // Titles, not bare ids: board --json already gives ids, and a column of
    // ids is not something a reader can use.
    expect(markdown).toContain("- **T-1** First task");
    expect(markdown).toContain("- **T-2** Second task");
    expect(markdown).toContain("- **M-1** Release 1 — open (T-1)");
    // Lifecycle order, not alphabetical: a board reads To Do, In Progress.
    expect(markdown.indexOf("## To Do")).toBeLessThan(
      markdown.indexOf("## In Progress"),
    );
    expect(markdown.indexOf("## In Progress")).toBeLessThan(
      markdown.indexOf("## Done"),
    );
    expect(markdown).toContain("## Done (0)");
    expect(markdown).toContain("_No tasks._");

    // It writes outside the task store, so it never clobbers silently.
    const refused = await quest(store, ["board", "export", target, "--json"]);
    expect(refused.exitCode).toBe(5);
    expect(JSON.parse(refused.stderr)).toMatchObject({
      error_type: "conflict",
    });
    expect(JSON.parse(refused.stderr).hint).toContain("--force");

    await quest(store, ["task", "create", "Third task", ...human]);
    const forced = await quest(store, [
      "board",
      "export",
      target,
      "--force",
      "--json",
    ]);
    expect(forced.exitCode).toBe(0);
    expect(await readFile(target, "utf8")).toContain("Third task");

    // A missing parent directory is a clean diagnostic, not a stack trace.
    const nested = await quest(store, [
      "board",
      "export",
      join(store, "no-such-dir", "board.md"),
      "--json",
    ]);
    expect(nested.exitCode).toBe(6);
    expect(JSON.parse(nested.stderr)).toMatchObject({
      error_type: "validation",
    });

    const noTarget = await quest(store, ["board", "export", "--json"]);
    expect(noTarget.exitCode).toBe(2);

    // Plain `board` is unchanged.
    const board = await quest(store, ["board", "--json"]);
    expect(board.exitCode).toBe(0);
    expect(JSON.parse(board.stdout).kind).toBe("project.board");
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});
