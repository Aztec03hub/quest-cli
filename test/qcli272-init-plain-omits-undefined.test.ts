import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const source = join(import.meta.dir, "..", "src", "cli", "main.ts");

async function quest(store: string, argv: readonly string[]) {
  const child = Bun.spawn([process.execPath, source, ...argv], {
    cwd: store,
    stdout: "pipe",
    stderr: "pipe",
    // QCLI-371: an env-less spawn gets the ORIGINAL environment, which drops
    // the preload's QUEST_AGENT_PLUGINS=off and reaches the real claude.
    env: { ...Bun.env },
  });
  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

// QCLI-272: reported via a scripted `quest init` whose --plain summary
// printed the literal word "undefined" for agentSkillSource and
// instructionsByTarget -- both legitimately unselected on this invocation,
// not dropped. --json on the same invocation has always omitted them
// correctly; this reproduces the exact scripted-flag shape that leaked in
// --plain and pins the fix at the CLI-process level, not just the unit
// level in cli-empty-list-render.test.ts.
test("quest init --plain never prints the literal word undefined for an unselected optional field", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-init-plain-"));
  try {
    await Bun.spawn(["git", "init", "--quiet", store], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;

    const plain = await quest(store, [
      "init",
      "--name",
      "cometx",
      "--task-id-prefix",
      "ctx",
      "--agent-instructions",
      "--target",
      "claude",
      "--plain",
    ]);
    expect(plain.exitCode).toBe(0);
    expect(plain.stderr).toBe("");
    expect(plain.stdout).not.toContain("undefined");

    // --json on the identical invocation shape has always been correct;
    // asserting it here pins that the fix did not change what gets
    // *written*, only how the already-correct data renders in --plain.
    const store2 = await mkdtemp(join(tmpdir(), "quest-init-json-"));
    try {
      await Bun.spawn(["git", "init", "--quiet", store2], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited;
      const json = await quest(store2, [
        "init",
        "--name",
        "cometx",
        "--task-id-prefix",
        "ctx",
        "--agent-instructions",
        "--target",
        "claude",
        "--json",
      ]);
      expect(json.exitCode).toBe(0);
      const data = JSON.parse(json.stdout).data;
      expect(Object.hasOwn(data.configuration, "agentSkillSource")).toBe(false);
      expect(Object.hasOwn(data, "instructionsByTarget")).toBe(false);
    } finally {
      await rm(store2, { recursive: true, force: true });
    }
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});
