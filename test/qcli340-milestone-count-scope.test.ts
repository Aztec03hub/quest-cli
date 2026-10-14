import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./helpers/spawn.ts";

/**
 * QCLI-340, the milestone half of QCLI-339's ruling: `overview` must not
 * report a count whose object is narrower than the object a reader takes it
 * for.
 *
 * `overview` counts milestones as open or closed with `archived !== true` on
 * BOTH filters, so an archived milestone counted as neither. That exclusion
 * is QCLI-140's decision and is correct -- a retired milestone is not open
 * work and is not closed work. What was wrong is that it lived only in a code
 * comment: `open + closed` silently summed to less than the milestones on
 * record, with nothing in the output saying so.
 *
 * So these tests pin BOTH halves, which fail on opposite edits: the archived
 * milestone is reported, AND it is still excluded from open/closed. Folding
 * it back into `closed` would satisfy "the number moved" while reopening
 * QCLI-140.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const ACTOR = ["--actor", "person-1", "--actor-kind", "human"] as const;

function quest(workspace: string, args: readonly string[]) {
  return runCommand([process.execPath, MAIN, ...args], {
    cwd: workspace,
  });
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli340-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

function milestones(root: string) {
  const result = quest(root, ["overview", "--json"]);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout).data.milestones as {
    open: number;
    closed: number;
    archived: number;
  };
}

test("archiving a milestone moves it into the archived count, not out of the output (QCLI-340)", async () => {
  const root = await workspace();
  try {
    expect(
      quest(root, ["milestone", "create", "Release", ...ACTOR, "--json"])
        .exitCode,
    ).toBe(0);

    const before = milestones(root);
    expect(before).toEqual({ open: 1, closed: 0, archived: 0 });

    expect(
      quest(root, ["milestone", "archive", "M-1", ...ACTOR, "--json"]).exitCode,
    ).toBe(0);

    const after = milestones(root);
    // QCLI-140 preserved: still neither open nor closed work.
    expect(after.open).toBe(0);
    expect(after.closed).toBe(0);
    // QCLI-340 fixed: the exclusion is now visible. Before this, the whole
    // object read {open: 0, closed: 0} and a reader could not tell an
    // archived milestone from no milestone at all.
    expect(after.archived).toBe(1);

    // The milestone is genuinely still on record, so `archived` reports a
    // real exclusion rather than a constant. Note the contrast that makes
    // QCLI-340 a defect rather than a style preference: `milestone list`
    // narrows the same way but SAYS SO, both in its help ("excluding
    // archived ones by default") and by offering the flag that widens it.
    // `overview` had neither.
    const hidden = quest(root, ["milestone", "list", "--json"]);
    expect(hidden.exitCode).toBe(0);
    expect(hidden.stdout).not.toContain("M-1");
    const listed = quest(root, [
      "milestone",
      "list",
      "--include-archived",
      "--json",
    ]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("M-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an archived milestone is still not counted as closed work (QCLI-140, not reopened by QCLI-340)", async () => {
  const root = await workspace();
  try {
    quest(root, ["milestone", "create", "Shipped", ...ACTOR, "--json"]);
    quest(root, [
      "milestone",
      "edit",
      "M-1",
      "--status",
      "closed",
      ...ACTOR,
      "--json",
    ]);
    expect(milestones(root)).toEqual({ open: 0, closed: 1, archived: 0 });

    expect(
      quest(root, ["milestone", "archive", "M-1", ...ACTOR, "--json"]).exitCode,
    ).toBe(0);

    // Archiving a CLOSED milestone must not leave it in `closed`. This is the
    // assertion that fails if someone "fixes" the narrowing by folding
    // archived milestones back into the closed count.
    expect(milestones(root)).toEqual({ open: 0, closed: 0, archived: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decision counts are not narrowed the same way, audited rather than assumed (QCLI-340)", async () => {
  const root = await workspace();
  try {
    quest(root, [
      "decision",
      "create",
      "Pick a format",
      "--outcome",
      "JSON",
      ...ACTOR,
      "--json",
    ]);
    const result = quest(root, ["overview", "--json"]);
    expect(result.exitCode).toBe(0);
    const decisions = JSON.parse(result.stdout).data.decisions as Record<
      string,
      number
    >;
    // A Decision record carries no `archived` field at all, and `superseded`
    // is a reported status rather than a hidden exclusion, so every decision
    // on record is already counted. Pinned so a future `archived` on
    // decisions cannot repeat QCLI-340 silently.
    expect(Object.values(decisions).reduce((sum, n) => sum + n, 0)).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the JSON envelope keeps contractVersion at index 1 and principal last (QCLI-340)", async () => {
  const root = await workspace();
  try {
    quest(root, ["milestone", "create", "Release", ...ACTOR, "--json"]);
    const result = quest(root, ["overview", "--json"]);
    expect(result.exitCode).toBe(0);
    const keys = Object.keys(JSON.parse(result.stdout));
    expect(keys[1]).toBe("contractVersion");
    expect(keys.at(-1)).toBe("principal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
