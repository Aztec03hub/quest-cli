import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./helpers/spawn.ts";

/**
 * QCLI-282. QCLI-270 named the actual unrecognized flag for the direct
 * `if (!parsed || !only(...))` dispatch sites but left the positive-gate
 * action dispatchers (migration backlog, milestone/decision, draft) on a
 * shared bottom-of-group fallback. A caller who supplied a valid reference
 * and a fully-formed actor but one extra flag got a generic per-group
 * sentence -- "milestone action is invalid or missing required arguments."
 * -- that named neither the offending flag nor the fact that nothing was
 * written, the same class of misdiagnosis QCLI-270 fixed everywhere else.
 *
 * This pins the extended behaviour (an unrecognized flag is named) and the
 * rejection reasons that still get the original per-group message (a missing
 * reference, an invalid action name), which QCLI-270's requirement carried
 * forward.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;

function quest(workspace: string, args: readonly string[]) {
  return runCommand([process.execPath, MAIN, ...args], {
    cwd: workspace,
  });
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli282-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

function diagnostic(result: ReturnType<typeof quest>) {
  return JSON.parse(result.stderr) as { error_type?: string; message?: string };
}

/**
 * One case per positive-gate group (migration backlog, milestone, decision,
 * draft). Each supplies the action's required reference or positional where
 * it has one, so the branch is entered, then a single flag its allowlist does
 * not contain -- named in the message rather than folded into the fallback.
 * No actor flags are added: they would themselves be unrecognized on the
 * read actions and turn a single named flag into a list.
 */
const NAMED_CASES = [
  ["migration", "backlog", "status", "--digest", "abc", "--bogus=1"],
  ["migration", "backlog", "preview", "--source", "x", "--bogus=1"],
  ["milestone", "list", "--bogus=1"],
  ["milestone", "create", "A title", "--bogus=1"],
  ["decision", "list", "--bogus=1"],
  ["decision", "create", "A decision", "--bogus=1"],
  ["draft", "list", "--bogus=1"],
  ["draft", "create", "A draft", "--bogus=1"],
] as const;

test("an unrecognized flag on a positive-gate action is named (QCLI-282)", async () => {
  const root = await workspace();
  try {
    for (const argv of NAMED_CASES) {
      const result = quest(root, [...argv, "--json"]);
      expect({ argv, exitCode: result.exitCode }).toEqual({
        argv,
        exitCode: 2,
      });
      expect(result.stdout).toBe("");
      const d = diagnostic(result);
      expect({ argv, error_type: d.error_type }).toEqual({
        argv,
        error_type: "usage",
      });
      expect({
        argv,
        names: d.message?.startsWith("Unrecognized flag --bogus."),
      }).toEqual({ argv, names: true });
      expect(d.message).toContain("Nothing was written");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing reference or an invalid action still gets the original message (QCLI-282)", async () => {
  const root = await workspace();
  try {
    const cases = [
      {
        argv: ["milestone", "view"],
        message: "milestone action is invalid or missing required arguments.",
      },
      {
        argv: ["milestone", "frobnicate"],
        message: "milestone action is invalid or missing required arguments.",
      },
      {
        argv: ["decision", "frobnicate"],
        message: "decision action is invalid or missing required arguments.",
      },
      {
        argv: ["draft", "archive"],
        message: "draft action is invalid or missing required arguments.",
      },
      {
        argv: ["draft", "view"],
        message: "draft action is invalid or missing required arguments.",
      },
    ] as const;
    for (const { argv, message } of cases) {
      const result = quest(root, [...argv, "--json"]);
      expect({ argv, exitCode: result.exitCode }).toEqual({
        argv,
        exitCode: 2,
      });
      expect({ argv, ...diagnostic(result) }).toMatchObject({
        argv,
        error_type: "usage",
        message,
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the happy path through a positive-gate action is unaffected (QCLI-282)", async () => {
  const root = await workspace();
  try {
    for (const argv of [
      ["milestone", "list"],
      ["milestone", "list", "--include-archived"],
      ["decision", "list"],
      ["draft", "list"],
      ["draft", "list", "--include-archived"],
    ] as const) {
      const result = quest(root, [...argv, "--json"]);
      expect({ argv, exitCode: result.exitCode }).toEqual({
        argv,
        exitCode: 0,
      });
      expect({ argv, error: result.stderr }).toEqual({ argv, error: "" });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
