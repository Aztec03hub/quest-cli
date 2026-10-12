import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ADAPTER_REQUIRED_MANIFEST_COMMANDS,
  QUEST_ADAPTER_PINNED_VERSION,
  TRACKER_CONTRACT_VERSION,
} from "../../../src/contract/tracker/index.ts";
import { QUEST_VERSION } from "../../../src/application/version.ts";

const source = join(import.meta.dir, "..", "..", "..", "src", "cli", "main.ts");

async function quest(
  argv: readonly string[],
  options?: { env?: Record<string, string>; cwd?: string },
) {
  const child = Bun.spawn([process.execPath, source, ...argv], {
    cwd: options?.cwd ?? "/tmp",
    stdout: "pipe",
    stderr: "pipe",
    ...(options?.env ? { env: { ...Bun.env, ...options.env } } : {}),
  });
  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

test("the adapter boundary pins the exact authorized Quest package version", () => {
  // QUEST_VERSION is a plain `string` (the built binary overrides it at build
  // time), so the matcher's received type is widened; the assertion is still
  // exact equality.
  expect<string>(QUEST_ADAPTER_PINNED_VERSION).toBe(QUEST_VERSION);
});

test("the live binary reports the pinned version through public discovery", async () => {
  const version = await quest(["--version"]);
  expect(version).toMatchObject({ exitCode: 0, stderr: "" });
  expect(version.stdout).toBe(`${QUEST_ADAPTER_PINNED_VERSION}\n`);
});

test("the live manifest registry satisfies the adapter boundary descriptors", async () => {
  const manifest = await quest(["manifest", "--json"]);
  expect(manifest.exitCode).toBe(0);
  const envelope = JSON.parse(manifest.stdout);
  expect(envelope).toMatchObject({
    schemaVersion: TRACKER_CONTRACT_VERSION,
    kind: "manifest.registry",
    principal: null,
  });

  const commands = envelope.data.commands as readonly Record<string, unknown>[];
  const live = new Map<string, Record<string, unknown>>(
    commands.map((entry) => [String(entry.name), entry]),
  );
  for (const required of ADAPTER_REQUIRED_MANIFEST_COMMANDS) {
    const entry = live.get(required.name);
    if (entry === undefined)
      throw new Error(`missing descriptor: ${required.name}`);
    expect(entry).toMatchObject({
      schemaVersion: TRACKER_CONTRACT_VERSION,
      kind: required.kind,
      mutates: required.mutates,
    });
    const requiredFields = (required as { fields?: readonly string[] }).fields;
    if (requiredFields !== undefined) {
      expect(new Set((entry.fields as string[]) ?? [])).toEqual(
        new Set(requiredFields),
      );
    }
  }
});

test("the live task.status-flow payload matches the pinned schema-1 contract", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-adapter-boundary-"));
  try {
    await Bun.spawn(["git", "init", "--quiet", store], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    const initialized = await quest(["init"], {
      env: { QUEST_TASK_STORE: store },
      cwd: store,
    });
    expect(initialized.exitCode).toBe(0);
    const flow = await quest(["task", "status-flow", "--json"], {
      env: { QUEST_TASK_STORE: store },
      cwd: store,
    });
    expect(flow.exitCode).toBe(0);
    const envelope = JSON.parse(flow.stdout);
    expect(envelope).toMatchObject({
      schemaVersion: TRACKER_CONTRACT_VERSION,
      kind: "task.status-flow",
      data: {
        statuses: ["To Do", "In Progress", "Done"],
        terminalStatuses: ["Done"],
      },
      principal: null,
    });
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});
