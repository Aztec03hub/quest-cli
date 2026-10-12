import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * QCLI-346. `task create` threw `task_already_exists` for a taken id, and the
 * CLI mapped that to `conflict` with "read the latest task state and retry".
 *
 * That mapping is correct for exactly one of the two cases it covers. An
 * AUTO-ALLOCATED id losing a race to a concurrent writer is a real conflict:
 * a retry recomputes a fresh id and succeeds. An id the caller passed with
 * `--id` is fixed, so the prescribed retry can never succeed -- opum-cli-e2e
 * followed the hint three times against an id held by an ARCHIVED record.
 *
 * The archived case is the one worth pinning rather than a generic duplicate:
 * a completed or archived holder is invisible to `task list`, and `doctor`
 * reported healthy throughout, so every signal a caller can reach said the
 * workspace was fine. The error now names the holding path for that reason.
 *
 * The auto-allocated branch is covered here too, because the fix is a
 * NARROWING -- the risk it carries is over-reaching into the conflict case,
 * which a test of the explicit path alone cannot see.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const ACTOR = ["--actor", "person-1", "--actor-kind", "human"] as const;

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

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli346-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

test("an explicit --id held by an ARCHIVED record is validation, and names where it is held (QCLI-346)", async () => {
  const root = await workspace();
  try {
    expect(
      quest(root, [
        "task",
        "create",
        "first",
        "--id",
        "T-89",
        ...ACTOR,
        "--json",
      ]).exitCode,
    ).toBe(0);
    expect(
      quest(root, ["task", "archive", "T-89", ...ACTOR, "--json"]).exitCode,
    ).toBe(0);

    const collision = quest(root, [
      "task",
      "create",
      "collision",
      "--id",
      "T-89",
      ...ACTOR,
      "--json",
    ]);

    // Exit 6, not the exit 5 a conflict carries.
    expect(collision.exitCode).toBe(6);
    const error = JSON.parse(collision.stderr) as Record<string, unknown>;
    expect(error.error_type).toBe("validation");
    expect(error.message).toContain("T-89");

    // The hint must not send the caller into the retry that cannot work.
    expect(String(error.hint)).not.toContain("retry");
    expect(String(error.hint)).toContain(".quest/archive/tasks/T-89.json");
    expect(error.input).toMatchObject({
      id: "T-89",
      heldAt: ".quest/archive/tasks/T-89.json",
    });

    // The reserved slot's position is normative, not incidental (QCLI-289).
    expect(Object.keys(error).at(-1)).toBe("principal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit --id held by a LIVE record is validation too, not only the archived case (QCLI-346)", async () => {
  const root = await workspace();
  try {
    quest(root, ["task", "create", "live", "--id", "T-5", ...ACTOR, "--json"]);
    const collision = quest(root, [
      "task",
      "create",
      "dup",
      "--id",
      "T-5",
      ...ACTOR,
      "--json",
    ]);
    expect(collision.exitCode).toBe(6);
    const error = JSON.parse(collision.stderr) as Record<string, unknown>;
    expect(error.error_type).toBe("validation");
    expect(String(error.hint)).toContain(".quest/tasks/T-5.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the auto-allocated path is untouched: no --id still allocates and succeeds (QCLI-346)", async () => {
  const root = await workspace();
  try {
    quest(root, [
      "task",
      "create",
      "first",
      "--id",
      "T-89",
      ...ACTOR,
      "--json",
    ]);
    quest(root, ["task", "archive", "T-89", ...ACTOR, "--json"]);

    // Allocation is refs-aware and spans every retention location, so it must
    // step OVER the archived T-89 rather than collide with it. Without --id
    // the new branch is not entered at all.
    const auto = quest(root, ["task", "create", "auto", ...ACTOR, "--json"]);
    expect(auto.exitCode).toBe(0);
    const created = JSON.parse(auto.stdout) as {
      data: { id: string };
    };
    expect(created.data.id).not.toBe("T-89");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
