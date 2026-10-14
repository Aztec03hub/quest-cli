import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./helpers/spawn.ts";

/**
 * QCLI-353. `quest task create --title "x"` failed with only "task create
 * received invalid arguments." The title is positional, so `--title` itself
 * was taken as the title and `"x"` then made the flag list unparseable,
 * leaving usageFailure nothing to name. Every command whose first argument
 * is positional (a title or an id) now refuses a flag-shaped first argument
 * and names it, before anything is read or written.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const ACTOR = ["--actor", "person-1", "--actor-kind", "human"] as const;
const roots: string[] = [];

function quest(workspace: string, args: readonly string[]) {
  return runCommand([process.execPath, MAIN, ...args], {
    cwd: workspace,
  });
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli353-"));
  roots.push(root);
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

test("the exact repro: task create --title names --title, and writes nothing", async () => {
  const root = await workspace();
  const result = quest(root, [
    "task",
    "create",
    "--title",
    "some title",
    ...ACTOR,
    "--json",
  ]);
  expect(result.exitCode).toBe(2);
  const error = JSON.parse(result.stderr);
  expect(error.error_type).toBe("usage");
  expect(error.message).not.toBe("task create received invalid arguments.");
  expect(error.message).toContain('"--title"');
  expect(error.message).toContain("quest task create <title>");
  const listed = JSON.parse(quest(root, ["task", "list", "--json"]).stdout);
  expect(listed.data).toEqual([]);
});

test("every positional command names a flag-shaped first argument", async () => {
  const root = await workspace();
  const cases: readonly (readonly string[])[] = [
    ["task", "create"],
    ["task", "view"],
    ["task", "edit"],
    ["task", "complete"],
    ["task", "archive"],
    ["task", "pause"],
    ["task", "start"],
    ["task", "demote"],
    ["draft", "create"],
    ["draft", "view"],
    ["draft", "promote"],
    ["draft", "archive"],
    ["milestone", "create"],
    ["milestone", "view"],
    ["milestone", "edit"],
    ["milestone", "archive"],
    ["milestone", "delete"],
    ["decision", "create"],
    ["decision", "view"],
    ["decision", "edit"],
    ["decision", "delete"],
  ];
  let read = 0;
  for (const command of cases) {
    read++;
    const result = quest(root, [
      ...command,
      "--bogus",
      "x",
      ...ACTOR,
      "--json",
    ]);
    const error = JSON.parse(result.stderr || "{}");
    expect({
      command,
      exit: result.exitCode,
      named: error.message ?? "",
    }).toEqual({
      command,
      exit: 2,
      named: expect.stringContaining(`quest ${command.join(" ")} takes`),
    });
    expect(error.message).toContain('"--bogus"');
  }
  expect(read).toBe(cases.length);
});

test("a normal positional still works, and --help still resolves", async () => {
  const root = await workspace();
  const created = quest(root, [
    "task",
    "create",
    "real title",
    ...ACTOR,
    "--json",
  ]);
  expect(created.exitCode).toBe(0);
  expect(JSON.parse(created.stdout).data.title).toBe("real title");
  expect(quest(root, ["task", "create", "--help"]).exitCode).toBe(0);
  expect(
    quest(root, ["task", "list", "--status", "To Do", "--json"]).exitCode,
  ).toBe(0);
});
