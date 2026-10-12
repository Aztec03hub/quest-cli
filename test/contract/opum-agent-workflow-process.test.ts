import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeStorageName } from "../../src/adapters/claims/local-claim-evidence.ts";
import { runQuest } from "../../src/cli/main.ts";

const correlation = "f54125ae12e541f4b7ba83abb8ba8a35";
const renewal = "0123456789abcdef0123456789abcdef";

let workspace = "";
let repositoryId = "";
let previousCwd = "";

async function quest(arguments_: string[], stdin?: string) {
  if (stdin === undefined)
    return runQuest([...arguments_, "--json"], false, true);
  // Stdin transport: pipe the envelope through the real CLI process.
  const child = Bun.spawn(
    [process.execPath, "run", join("src/cli/main.ts"), ...arguments_, "--json"],
    {
      cwd: `${import.meta.dir}/../..`,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, QUEST_TASK_STORE: workspace },
    },
  );
  child.stdin.write(stdin);
  child.stdin.end();
  const exitCode = await child.exited;
  return {
    exitCode,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

async function writeRelationship(
  id: string,
  record: Record<string, unknown>,
): Promise<void> {
  const directory = join(workspace, ".quest", "relationships");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${safeStorageName(id)}.json`),
    JSON.stringify({ schemaVersion: 1, id, taskId: "T-1", ...record }),
  );
  await commitAll();
}

async function commitAll(): Promise<void> {
  Bun.spawnSync(["git", "add", "-A"], { cwd: workspace });
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
    { cwd: workspace },
  );
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "quest-binding-"));
  previousCwd = process.cwd();
  process.chdir(workspace);
  const init = Bun.spawn(["git", "init", "-q"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await init.exited).toBe(0);
  const commonDirectory = Bun.spawnSync(
    ["git", "rev-parse", "--git-common-dir"],
    {
      cwd: workspace,
      stdout: "pipe",
    },
  )
    .stdout.toString()
    .trim();
  const { realpathSync } = await import("node:fs");
  repositoryId = commonDirectory.startsWith("/")
    ? commonDirectory
    : join(realpathSync(workspace), commonDirectory);
  const initialized = await quest(["init"]);
  expect(initialized.exitCode).toBe(0);
  for (const [id, title] of [
    ["T-1", "Bound task"],
    ["T-2", "Idle task"],
  ] as const) {
    const created = await quest([
      "task",
      "create",
      title,
      "--id",
      id,
      "--actor",
      "human-1",
      "--actor-kind",
      "human",
    ]);
    expect(created.exitCode).toBe(0);
  }
  const edited = await quest([
    "task",
    "edit",
    "T-1",
    "--status",
    "In Progress",
    "--actor",
    "human-1",
    "--actor-kind",
    "human",
  ]);
  expect(edited.exitCode).toBe(0);
  await commitAll();
});

afterAll(async () => {
  process.chdir(previousCwd);
  await rm(workspace, { recursive: true, force: true });
});

function bindingArguments(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    "--contract": "opum-agent-workflow/v1",
    "--task": "T-1",
    "--claim-or-correlation": correlation,
    "--holder": "agent-1",
    "--repository": repositoryId,
    "--base": "origin/dev",
    "--settlement": "origin/dev",
    ...overrides,
  };
  const arguments_: string[] = ["task", "binding"];
  for (const [flag, value] of Object.entries(values)) {
    if (value !== "") arguments_.push(flag, value);
  }
  return arguments_;
}

const EXPECTED_KEYS = [
  "baseRef",
  "contract",
  "expiresAt",
  "holder",
  "issuedAt",
  "relationshipId",
  "relationshipKind",
  "relationshipState",
  "repositoryId",
  "requestId",
  "selectedVersion",
  "settlementRef",
  "taskId",
  "taskState",
].sort();

test("manifest and help expose the read-only binding command", async () => {
  const manifest = await quest(["manifest"]);
  expect(manifest.exitCode).toBe(0);
  const registry = JSON.parse(manifest.stdout);
  const entry = registry.data.commands.find(
    (command: { name: string }) => command.name === "task binding",
  );
  expect(entry).toMatchObject({ kind: "task.binding", mutates: false });
  const help = await quest(["help", "task"]);
  expect(
    JSON.parse(help.stdout).data.commands.some(
      (command: { name: string }) => command.name === "task binding",
    ),
  ).toBe(true);
});

test("flag transport prints the exact closed-key public v1 envelope", async () => {
  await writeRelationship(correlation, {
    kind: "correlation",
    state: "accepted",
    holder: "agent-1",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  const result = await quest(bindingArguments());
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const response = JSON.parse(result.stdout);
  expect(Object.keys(response).sort()).toEqual(EXPECTED_KEYS);
  expect(response.contract).toBe("opum-agent-workflow");
  expect(response.selectedVersion).toBe(1);
  expect(response.requestId).toMatch(/^[0-9a-f]{32}$/);
  expect(response.taskId).toBe("T-1");
  expect(response.taskState).toBe("in_progress");
  expect(response.relationshipId).toBe(correlation);
  expect(response.relationshipState).toBe("accepted");
  expect(response.repositoryId).toBe(repositoryId);
});

test("binds a live claim through its current generation, surviving renewal", async () => {
  const claimsDirectory = join(workspace, ".quest", "claims");
  await mkdir(claimsDirectory, { recursive: true });
  await Bun.write(
    join(claimsDirectory, "actors.json"),
    JSON.stringify([
      { id: "human", kind: "human", roles: ["maintainer"] },
      {
        id: "agent-1",
        kind: "delegated-agent",
        accountableHumanId: "human",
        roles: [],
      },
    ]),
  );
  const events = [
    {
      eventId: correlation,
      operationId: "op-1",
      taskId: "T-1",
      kind: "claimed",
      generation: "g1",
      holderId: "agent-1",
      accountableHumanId: "human",
      at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    },
    {
      eventId: renewal,
      operationId: "op-2",
      taskId: "T-1",
      kind: "renewed",
      generation: "g1",
      holderId: "agent-1",
      accountableHumanId: "human",
      at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    },
  ];
  await writeFile(
    join(claimsDirectory, "T-1.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n"),
  );
  await commitAll();
  await writeRelationship(correlation, {
    kind: "claim",
    state: "accepted",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  const originalIdentity = await quest(bindingArguments());
  expect(originalIdentity.exitCode).toBe(0);
  const response = JSON.parse(originalIdentity.stdout);
  expect(response.relationshipKind).toBe("claim");
  expect(response.relationshipState).toBe("active");
  expect(response.holder).toBe("agent-1");

  // The renewal identity also binds generation g1 via its own record.
  await writeRelationship(renewal, {
    kind: "claim",
    state: "accepted",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  const renewed = await quest(
    bindingArguments({ "--claim-or-correlation": renewal }),
  );
  expect(renewed.exitCode).toBe(0);
  expect(JSON.parse(renewed.stdout).relationshipId).toBe(renewal);

  // A stale identity from a superseded generation is STATE.
  await writeFile(
    join(claimsDirectory, "T-1.jsonl"),
    [
      ...events,
      {
        eventId: "reclaim-1",
        operationId: "op-3",
        taskId: "T-1",
        kind: "reclaimed",
        generation: "g2",
        holderId: "agent-1",
        accountableHumanId: "human",
        at: new Date().toISOString(),
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  // g2's lease is live but our records only bound g1.
  await writeRelationship(correlation, {
    kind: "claim",
    state: "superseded",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  const stale = await quest(bindingArguments());
  expect(JSON.parse(stale.stderr).input.code).toBe("OPUM_WORKFLOW_QUEST_STATE");
});

test("rejects foreign repository, holder, base, and settlement as INCOMPATIBLE", async () => {
  await writeRelationship(correlation, {
    kind: "correlation",
    state: "accepted",
    holder: "agent-1",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  const foreignCases: Record<string, string>[] = [
    { "--repository": "/somewhere/else" },
    { "--holder": "agent-2" },
    { "--base": "origin/main" },
    { "--settlement": "origin/main" },
    { "--contract": "other-workflow/v9" },
  ];
  for (const overrides of foreignCases) {
    const result = await quest(bindingArguments(overrides));
    expect(JSON.parse(result.stderr).input.code).toBe(
      "OPUM_WORKFLOW_QUEST_INCOMPATIBLE",
    );
  }
});

test("missing records are ABSENT; terminal states are STATE", async () => {
  const absent = await quest(
    bindingArguments({ "--claim-or-correlation": "unknown-id" }),
  );
  expect(JSON.parse(absent.stderr).input.code).toBe(
    "OPUM_WORKFLOW_QUEST_ABSENT",
  );

  await writeRelationship(correlation, {
    kind: "correlation",
    state: "done",
    holder: "agent-1",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  const done = await quest(bindingArguments());
  expect(JSON.parse(done.stderr).input.code).toBe("OPUM_WORKFLOW_QUEST_STATE");

  // T-2 stays in To Do: not in progress even with a valid record.
  await writeRelationship("T-2-record", {
    id: "T-2-record",
    taskId: "T-2",
    kind: "correlation",
    state: "accepted",
    holder: "agent-1",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  const idle = await quest(
    bindingArguments({
      "--task": "T-2",
      "--claim-or-correlation": "T-2-record",
    }),
  );
  expect(JSON.parse(idle.stderr).input.code).toBe("OPUM_WORKFLOW_QUEST_STATE");
});

async function makeReadyTask(id: string): Promise<void> {
  const created = await quest([
    "task",
    "create",
    `Task ${id}`,
    "--id",
    id,
    "--actor",
    "human-1",
    "--actor-kind",
    "human",
  ]);
  expect(created.exitCode).toBe(0);
  const edited = await quest([
    "task",
    "edit",
    id,
    "--status",
    "In Progress",
    "--actor",
    "human-1",
    "--actor-kind",
    "human",
  ]);
  expect(edited.exitCode).toBe(0);
}

async function writeTaskRelationship(
  id: string,
  taskId: string,
  record: Record<string, unknown>,
): Promise<void> {
  const directory = join(workspace, ".quest", "relationships");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${safeStorageName(id)}.json`),
    JSON.stringify({ schemaVersion: 1, id, taskId, ...record }),
  );
  await commitAll();
}

function envelope(taskId: string, requestId: string): string {
  return JSON.stringify({
    contract: "opum-agent-workflow",
    supportedVersions: [1],
    requestId,
    taskId,
  });
}

async function spawnRawStdin(
  extraFlags: readonly string[],
  stdinBody: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../../src/cli/main.ts", import.meta.url).pathname,
      "task",
      "binding",
      "--contract",
      "opum-agent-workflow/v1",
      ...extraFlags,
      "--json",
    ],
    {
      cwd: workspace,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...Bun.env, QUEST_TASK_STORE: workspace },
    },
  );
  child.stdin.write(stdinBody);
  await child.stdin.end();
  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

async function spawnBindingFor(
  taskId: string,
  requestId: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return spawnRawStdin([], envelope(taskId, requestId));
}

test("stdin transport resolves tasks exclusively from the pinned snapshot", async () => {
  await makeReadyTask("T-5");
  // Uncommitted hostile replacement cannot influence the pinned read.
  const taskPath = join(workspace, ".quest", "tasks", "T-5.json");
  const originalTask = await Bun.file(taskPath).text();
  try {
    await writeFile(taskPath, '{"id":"EVIL"}');
    const result = await spawnBindingFor("T-5", "f".repeat(32));
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).input.code).toBe(
      "OPUM_WORKFLOW_QUEST_ABSENT",
    );
  } finally {
    // Restore the committed worktree content so later operations are healthy.
    await writeFile(taskPath, originalTask);
  }
});

test("stdin transport binds a committed correlation record end-to-end", async () => {
  await makeReadyTask("T-6");
  await writeTaskRelationship("stdin-corr-1", "T-6", {
    kind: "correlation",
    state: "accepted",
    holder: "agent-1",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  const result = await spawnBindingFor("T-6", "a".repeat(32));
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const response = JSON.parse(result.stdout);
  expect(Object.keys(response).sort()).toEqual(EXPECTED_KEYS);
  expect(response.contract).toBe("opum-agent-workflow");
  expect(response.selectedVersion).toBe(1);
  expect(response.requestId).toBe("a".repeat(32));
  expect(response.taskId).toBe("T-6");
  expect(response.taskState).toBe("in_progress");
  expect(response.relationshipKind).toBe("correlation");
  expect(response.relationshipState).toBe("accepted");
  expect(response.holder).toBe("agent-1");
});

test("stdin transport binds a live claim through CAS replay", async () => {
  await makeReadyTask("T-7");
  const claimsDirectory = join(workspace, ".quest", "claims");
  await mkdir(claimsDirectory, { recursive: true });
  await Bun.write(
    join(claimsDirectory, "actors.json"),
    JSON.stringify([
      { id: "human", kind: "human", roles: ["maintainer"] },
      {
        id: "agent-1",
        kind: "delegated-agent",
        accountableHumanId: "human",
        roles: [],
      },
    ]),
  );
  await writeFile(
    join(claimsDirectory, "T-7.jsonl"),
    [
      {
        eventId: "claim-t7",
        operationId: "op-t7-1",
        taskId: "T-7",
        kind: "claimed",
        generation: "g1",
        holderId: "agent-1",
        accountableHumanId: "human",
        at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
      {
        eventId: "renew-t7",
        operationId: "op-t7-2",
        taskId: "T-7",
        kind: "renewed",
        generation: "g1",
        holderId: "agent-1",
        accountableHumanId: "human",
        at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  await commitAll();
  await writeTaskRelationship("stdin-claim-1", "T-7", {
    kind: "claim",
    state: "accepted",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  const result = await spawnBindingFor("T-7", "9".repeat(32));
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const response = JSON.parse(result.stdout);
  expect(response.relationshipKind).toBe("claim");
  expect(response.relationshipState).toBe("active");
  expect(response.holder).toBe("agent-1");
});

test("stdin transport binds the deployed facade envelope carrying claimOrCorrelation", async () => {
  await makeReadyTask("T-20");
  await writeTaskRelationship("facade-corr-1", "T-20", {
    kind: "correlation",
    state: "delivered",
    holder: "agent-1",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  const result = await spawnRawStdin(
    [],
    JSON.stringify({
      contract: "opum-agent-workflow",
      supportedVersions: [1],
      requestId: "b".repeat(32),
      taskId: "T-20",
      claimOrCorrelation: "90183b29cf6140488471282be868b328",
    }),
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const response = JSON.parse(result.stdout);
  expect(Object.keys(response).sort()).toEqual(EXPECTED_KEYS);
  expect(response.requestId).toBe("b".repeat(32));
  expect(response.taskId).toBe("T-20");
  expect(response.taskState).toBe("in_progress");
  expect(response.relationshipKind).toBe("correlation");
  expect(response.relationshipState).toBe("delivered");
  expect(response.holder).toBe("agent-1");
});

test("stdin transport still rejects unknown envelope fields beyond the facade correlation", async () => {
  await makeReadyTask("T-21");
  const result = await spawnRawStdin(
    [],
    JSON.stringify({
      contract: "opum-agent-workflow",
      supportedVersions: [1],
      requestId: "c".repeat(32),
      taskId: "T-21",
      hostileField: "x",
    }),
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).input.code).toBe(
    "OPUM_WORKFLOW_QUEST_INCOMPATIBLE",
  );
});

test("stdin transport rejects a non-string claimOrCorrelation transport field", async () => {
  await makeReadyTask("T-22");
  const result = await spawnRawStdin(
    [],
    JSON.stringify({
      contract: "opum-agent-workflow",
      supportedVersions: [1],
      requestId: "d".repeat(32),
      taskId: "T-22",
      claimOrCorrelation: 12345,
    }),
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).input.code).toBe(
    "OPUM_WORKFLOW_QUEST_INCOMPATIBLE",
  );
});

test("stdin transport rejects an unsupported contract selector", async () => {
  await makeReadyTask("T-23");
  const result = await spawnRawStdin(
    [],
    JSON.stringify({
      contract: "opum-agent-workflow/v2",
      supportedVersions: [1],
      requestId: "e".repeat(32),
      taskId: "T-23",
    }),
  );
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).input.code).toBe(
    "OPUM_WORKFLOW_QUEST_INCOMPATIBLE",
  );
});

test("stdin transport refuses duplicate, escaped-duplicate, and trailing input", async () => {
  // Top-level duplicate key (JSON.parse alone would silently last-write-win).
  const dupBody =
    '{"contract":"opum-agent-workflow","supportedVersions":[1],"requestId":"' +
    "c".repeat(32) +
    '","taskId":"T-6","requestId":"' +
    "d".repeat(32) +
    '"}';
  const dup = await spawnRawStdin([], dupBody);
  expect(dup.exitCode).not.toBe(0);
  expect(JSON.parse(dup.stderr).input.code).toBe(
    "OPUM_WORKFLOW_QUEST_INCOMPATIBLE",
  );

  // Nested-object duplicate keys are caught by the recursive scanner.
  const nestedDupBody =
    '{"contract":"opum-agent-workflow","supportedVersions":[1],"requestId":"' +
    "c".repeat(32) +
    '","taskId":"T-6","extra":{"a":1,"a":2}}';
  const nestedDup = await spawnRawStdin([], nestedDupBody);
  expect(nestedDup.exitCode).not.toBe(0);
  expect(JSON.parse(nestedDup.stderr).input.code).toBe(
    "OPUM_WORKFLOW_QUEST_INCOMPATIBLE",
  );

  // Escaped-equivalent names decode to the same member name.
  const escapedBody =
    '{"contract":"opum-agent-workflow","supportedVersions":[1],"requestId":"' +
    "c".repeat(32) +
    '","\\u0074askId":"T-6","taskId":"T-6"}';
  const escaped = await spawnRawStdin([], escapedBody);
  expect(escaped.exitCode).not.toBe(0);
  expect(JSON.parse(escaped.stderr).input.code).toBe(
    "OPUM_WORKFLOW_QUEST_INCOMPATIBLE",
  );

  // Trailing content after the envelope is refused.
  const trailing = await spawnRawStdin(
    [],
    `${envelope("T-6", "e".repeat(32))} {"x":1}`,
  );
  expect(trailing.exitCode).not.toBe(0);
  expect(JSON.parse(trailing.stderr).input.code).toBe(
    "OPUM_WORKFLOW_QUEST_INCOMPATIBLE",
  );

  // Malformed unicode escape is refused before any semantic validation.
  const badEscapeBody =
    '{"contract":"opum-agent-workflow","supportedVersions":[1],"requestId":"' +
    "c".repeat(32) +
    '","taskId":"T-\\u12g4"}';
  const badEscape = await spawnRawStdin([], badEscapeBody);
  expect(badEscape.exitCode).not.toBe(0);
  expect(JSON.parse(badEscape.stderr).input.code).toBe(
    "OPUM_WORKFLOW_QUEST_INCOMPATIBLE",
  );
});

test("any binding flag combined with a non-empty piped envelope is a usage refusal", async () => {
  const bindingFlags = [
    "--task",
    "--claim-or-correlation",
    "--holder",
    "--repository",
    "--base",
    "--settlement",
  ];
  for (const flag of bindingFlags) {
    const result = await spawnRawStdin(
      [flag, "x"],
      envelope("T-6", "b".repeat(32)),
    );
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stderr).error_type).toBe("usage");
  }
});

test("complete flag set over an empty pipe stays byte-compatible flag mode", async () => {
  await writeRelationship(correlation, {
    kind: "correlation",
    state: "accepted",
    holder: "agent-1",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  const result = await spawnRawStdin(bindingArguments().slice(4), "");
  expect(result.exitCode, result.stderr.slice(0, 400)).toBe(0);
  expect(result.stderr).toBe("");
  const response = JSON.parse(result.stdout);
  expect(Object.keys(response).sort()).toEqual(EXPECTED_KEYS);
  expect(response.taskId).toBe("T-1");
});

test("partial flag set without a piped envelope is a usage refusal", async () => {
  const result = await spawnRawStdin(["--task", "T-1"], "");
  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(result.stderr).error_type).toBe("usage");
});

test("stdin transport accepts pretty-printed and whitespace-padded envelopes", async () => {
  const pretty = spawnRawStdin(
    [],
    `${JSON.stringify(
      {
        contract: "opum-agent-workflow",
        supportedVersions: [1],
        requestId: "7".repeat(32),
        taskId: "T-6",
      },
      null,
      2,
    )}\n`,
  );
  const padded = spawnRawStdin(
    [],
    '{ "contract" : "opum-agent-workflow" ,\n' +
      '  "supportedVersions" : [ 1 ] ,\n' +
      '  "requestId" : "' +
      "8".repeat(32) +
      '" ,\n' +
      '  "taskId" : "T-6" }\n',
  );
  for (const result of await Promise.all([pretty, padded])) {
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const response = JSON.parse(result.stdout);
    expect(response.contract).toBe("opum-agent-workflow");
    expect(response.selectedVersion).toBe(1);
    expect(response.taskId).toBe("T-6");
    expect(Object.keys(response).sort()).toEqual(EXPECTED_KEYS);
  }
});

test("terminal claim never shadows a live correlation; alone it is STATE", async () => {
  await makeReadyTask("T-9");
  // Terminal/superseded claim record plus a live correlation: the live
  // correlation must be selected successfully.
  await writeTaskRelationship("claim-t9-superseded", "T-9", {
    kind: "claim",
    state: "superseded",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  await writeTaskRelationship("corr-t9-live", "T-9", {
    kind: "correlation",
    state: "accepted",
    holder: "agent-1",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  const both = await spawnBindingFor("T-9", "4".repeat(32));
  expect(both.exitCode).toBe(0);
  expect(both.stderr).toBe("");
  const response = JSON.parse(both.stdout);
  expect(response.relationshipKind).toBe("correlation");
  expect(response.relationshipId).toBe("corr-t9-live");

  // A terminal claim record alone surfaces the stable STATE diagnostic.
  await makeReadyTask("T-10");
  await writeTaskRelationship("claim-t10-done", "T-10", {
    kind: "claim",
    state: "done",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  const doneOnly = await spawnBindingFor("T-10", "5".repeat(32));
  expect(JSON.parse(doneOnly.stderr).input.code).toBe(
    "OPUM_WORKFLOW_QUEST_STATE",
  );

  // Two genuinely live records still refuse as ambiguous.
  await makeReadyTask("T-11");
  await writeTaskRelationship("corr-t11-a", "T-11", {
    kind: "correlation",
    state: "accepted",
    holder: "agent-1",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  await writeTaskRelationship("corr-t11-b", "T-11", {
    kind: "correlation",
    state: "working",
    holder: "agent-1",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  const ambiguous = await spawnBindingFor("T-11", "6".repeat(32));
  expect(JSON.parse(ambiguous.stderr).input.code).toBe(
    "OPUM_WORKFLOW_QUEST_INCOMPATIBLE",
  );
});

test("stdin transport reports terminal relationship state as STATE", async () => {
  await makeReadyTask("T-8");
  await writeTaskRelationship("terminal-corr", "T-8", {
    kind: "correlation",
    state: "done",
    holder: "agent-1",
    baseRef: "origin/dev",
    settlementRef: "origin/dev",
  });
  const result = await spawnBindingFor("T-8", "1".repeat(32));
  expect(JSON.parse(result.stderr).input.code).toBe(
    "OPUM_WORKFLOW_QUEST_STATE",
  );
});
