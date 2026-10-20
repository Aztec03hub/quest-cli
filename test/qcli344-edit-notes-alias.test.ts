import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./helpers/spawn.ts";

/**
 * QCLI-344. `task create` writes `implementationNotes` with
 * `--implementation-notes`; `task edit` wrote the SAME FIELD with `--notes`.
 * A caller moving from create to edit on one record met a rejection for a
 * capability that existed under another spelling.
 *
 * The rejection itself already named the offending flag and listed every
 * accepted one, so the discoverability half was largely served. What it did
 * NOT say is that the rest of the invocation was discarded -- and the
 * reported case paired the bad flag with `--check-ac`, so the observable
 * outcome was an acceptance criterion that silently failed to check.
 * Atomicity is correct and unchanged; the message now states it.
 *
 * Deliberately NOT in scope: a wholesale `--references` on `task edit`. That
 * is a different shape, not the same asymmetry -- edit offers non-destructive
 * `--add-reference`/`--remove-reference`, and DEC-5 recorded the hazard of
 * wholesale replacement discarding checked state on a neighbouring field.
 * Pinned below so the omission reads as a decision.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const ACTOR = ["--actor", "person-1", "--actor-kind", "human"] as const;

function quest(workspace: string, args: readonly string[]) {
  return runCommand([process.execPath, MAIN, ...args], {
    cwd: workspace,
  });
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli344-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

test("task edit --implementation-notes writes the same field as --notes (QCLI-344)", async () => {
  const root = await workspace();
  try {
    quest(root, ["task", "create", "alpha", ...ACTOR, "--json"]);
    quest(root, ["task", "create", "beta", ...ACTOR, "--json"]);

    const viaAlias = quest(root, [
      "task",
      "edit",
      "T-1",
      "--implementation-notes",
      '["same text"]',
      ...ACTOR,
      "--json",
    ]);
    expect(viaAlias.exitCode).toBe(0);
    const canonical = quest(root, [
      "task",
      "edit",
      "T-2",
      "--notes",
      '["same text"]',
      ...ACTOR,
      "--json",
    ]);
    expect(canonical.exitCode).toBe(0);

    // Asserted by comparing the two RECORDS, not by reading the flag list --
    // the claim is that the spellings are equivalent, so the records must be.
    const notes = (raw: string) =>
      JSON.parse(raw).data.implementationNotes as unknown[];
    expect(notes(viaAlias.stdout)).toEqual(["same text"]);
    expect(notes(viaAlias.stdout)).toEqual(notes(canonical.stdout));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supplying both spellings is refused rather than silently resolved (QCLI-344)", async () => {
  const root = await workspace();
  try {
    quest(root, ["task", "create", "alpha", ...ACTOR, "--json"]);
    const both = quest(root, [
      "task",
      "edit",
      "T-1",
      "--notes",
      '["a"]',
      "--implementation-notes",
      '["b"]',
      ...ACTOR,
      "--json",
    ]);
    expect(both.exitCode).not.toBe(0);
    const envelope = JSON.parse(both.stdout || both.stderr);
    expect(envelope.error_type).toBe("usage");
    expect(envelope.message).toContain("not both");
    expect(envelope.message).toContain("Nothing was written");

    // Neither value landed: the alias must not become a new way to lose a
    // write by quietly preferring one side.
    const viewed = quest(root, ["task", "view", "T-1", "--json"]);
    expect(JSON.parse(viewed.stdout).data.implementationNotes).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rejected flag says the rest of the command was discarded, and it really was (QCLI-344)", async () => {
  const root = await workspace();
  try {
    quest(root, [
      "task",
      "create",
      "alpha",
      "--acceptance-criteria",
      '["one"]',
      ...ACTOR,
      "--json",
    ]);

    const rejected = quest(root, [
      "task",
      "edit",
      "T-1",
      "--check-ac",
      "1",
      "--bogus",
      "x",
      ...ACTOR,
      "--json",
    ]);
    expect(rejected.exitCode).toBe(2);
    const message = JSON.parse(rejected.stdout || rejected.stderr)
      .message as string;
    // Two separate claims: which flag was rejected, and that the valid flags
    // beside it did not apply. Only the second was missing, and it is the one
    // that made a discarded --check-ac look like a checkbox that failed.
    expect(message).toContain("--bogus");
    expect(message).toContain("the rest of this command was not applied");

    // Atomicity unchanged: the valid --check-ac genuinely did not apply.
    const viewed = quest(root, ["task", "view", "T-1", "--json"]);
    const criteria = JSON.parse(viewed.stdout).data.acceptanceCriteria as {
      checked: boolean;
    }[];
    expect(criteria[0]?.checked).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task edit still offers no wholesale --references, deliberately (QCLI-344, DEC-5)", async () => {
  const root = await workspace();
  try {
    quest(root, ["task", "create", "alpha", ...ACTOR, "--json"]);
    const wholesale = quest(root, [
      "task",
      "edit",
      "T-1",
      "--references",
      '["a"]',
      ...ACTOR,
      "--json",
    ]);
    expect(wholesale.exitCode).toBe(2);

    // The non-destructive spellings are what edit offers instead, and they
    // work -- so this is a shape decision, not a capability gap.
    const added = quest(root, [
      "task",
      "edit",
      "T-1",
      "--add-reference",
      "a",
      ...ACTOR,
      "--json",
    ]);
    expect(added.exitCode).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
