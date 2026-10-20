import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./helpers/spawn.ts";

/**
 * QCLI-355. One nonexistent flag got two contradictory diagnoses depending
 * only on how many times it was passed:
 *
 *   task edit T-1 --add-ac a --add-ac b  ->  "--add-ac may only be provided once."
 *   task edit T-1 --add-ac a             ->  "Unrecognized flag --add-ac. ..."
 *
 * The repeated form asserted that the flag EXISTS and has an arity rule, so
 * the reporter retried it one occurrence per call, four times, before the
 * single form revealed it was never real. It also said neither "nothing was
 * written" nor which flags are accepted.
 *
 * Cause: `flags()` collects arguments without knowing the accepted set, and
 * threw the arity error during collection, before dispatch reached
 * `only()`/`usageFailure`, the code that knows the allowed list. The fix
 * defers the arity verdict to `only()`, which checks the name first.
 *
 * The other half (a KNOWN non-repeatable flag still reports arity) is pinned
 * across every single-value flag by `test/contract/cli-process.test.ts`
 * ("every single-value flag rejects repeats ..."); one case is repeated here
 * so this file reads whole.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const ACTOR = ["--actor", "person-1", "--actor-kind", "human"] as const;

function quest(workspace: string, args: readonly string[]) {
  return runCommand([process.execPath, MAIN, ...args], {
    cwd: workspace,
  });
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli355-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  quest(root, ["task", "create", "alpha", ...ACTOR, "--json"]);
  return root;
}

function diagnostic(result: ReturnType<typeof quest>) {
  return JSON.parse(result.stderr) as { error_type?: string; message?: string };
}

/** Runs `prefix` with `flag value` once and twice, and returns both results. */
function onceAndTwice(
  root: string,
  prefix: readonly string[],
  occurrence: readonly string[],
) {
  return {
    once: quest(root, [...prefix, ...occurrence, ...ACTOR, "--json"]),
    twice: quest(root, [
      ...prefix,
      ...occurrence,
      ...occurrence,
      ...ACTOR,
      "--json",
    ]),
  };
}

test("a repeated unknown flag gets the same unrecognized-flag diagnosis as a single one (QCLI-355)", async () => {
  const root = await workspace();
  try {
    const cases = [
      // The reported case: a value flag task edit does not have.
      { prefix: ["task", "edit", "T-1"], occurrence: ["--add-ac", "a"] },
      // A BOOLEAN flag that exists elsewhere in the CLI but not on task edit:
      // flags() had a second, separate arity throw for booleans.
      { prefix: ["task", "edit", "T-1"], occurrence: ["--include-archived"] },
      // flags() is shared: a different command with its own accepted set.
      { prefix: ["task", "create", "beta"], occurrence: ["--bogus", "x"] },
    ];
    for (const { prefix, occurrence } of cases) {
      const { once, twice } = onceAndTwice(root, prefix, occurrence);
      const flag = occurrence[0];
      expect({ flag, exitCode: twice.exitCode }).toEqual({ flag, exitCode: 2 });
      expect(twice.stdout).toBe("");
      expect(diagnostic(twice).error_type).toBe("usage");
      expect(diagnostic(twice).message).toStartWith(
        `Unrecognized flag ${flag}.`,
      );
      expect(diagnostic(twice).message).toContain("Nothing was written");
      expect(diagnostic(twice).message).toContain("Accepted flags: ");
      // Identical, not merely similar: the count of occurrences must not
      // change what the caller is told.
      expect(twice.stderr).toBe(once.stderr);
    }

    // Nothing was written, as the message says: T-1 is unchanged and no
    // second task was created.
    const view = quest(root, ["task", "view", "T-1", "--json"]);
    expect(JSON.parse(view.stdout).data.acceptanceCriteria).toEqual([]);
    const list = quest(root, ["task", "list", "--json"]);
    expect(
      JSON.parse(list.stdout).data.map((t: { id: string }) => t.id),
    ).toEqual(["T-1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repeated KNOWN non-repeatable flag still reports arity (QCLI-355)", async () => {
  const root = await workspace();
  try {
    const { twice } = onceAndTwice(
      root,
      ["task", "edit", "T-1"],
      ["--title", "renamed"],
    );
    expect(twice.exitCode).toBe(2);
    expect(diagnostic(twice)).toMatchObject({
      error_type: "usage",
      message: "--title may only be provided once.",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repeatable known flag passed twice writes both values (QCLI-355)", async () => {
  const root = await workspace();
  try {
    const result = quest(root, [
      "task",
      "edit",
      "T-1",
      "--add-label",
      "first",
      "--add-label",
      "second",
      ...ACTOR,
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    // Read back from the record, not inferred from the exit code.
    const view = quest(root, ["task", "view", "T-1", "--json"]);
    expect(JSON.parse(view.stdout).data.labels).toEqual(["first", "second"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
