import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BOOLEAN_FLAGS,
  JSON_ARRAY_FLAGS,
  REPEATABLE_CREATE_FLAGS,
  REPEATABLE_EDIT_FLAGS,
} from "../src/application/command-parameters.ts";
import { runCommand } from "./helpers/spawn.ts";

/**
 * QCLI-266. A session reading only `quest help <command>` and
 * `quest manifest --json` could not write a valid `task create` on the first
 * try: nothing said the title is positional rather than `--title`, and nothing
 * said `--acceptance-criteria` takes one JSON array while `--label` is a
 * repeatable scalar.
 *
 * The load-bearing detail is TRUNCATION. `usage` did document the positional
 * form -- on line 54 of 56, under the alphabetized field and flag dump. A test
 * that reads the whole output would have passed against the broken build, so
 * the first test below reads only the first 20 lines, which is what a pager,
 * a `head`, or a context-budgeted agent actually sees.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const HELP_WINDOW = 20;

function quest(workspace: string, args: readonly string[]) {
  return runCommand([process.execPath, MAIN, ...args], {
    cwd: workspace,
  });
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "qcli266-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

test("a caller can build a valid task create from the first 20 lines of help plus the manifest (QCLI-266)", async () => {
  const root = await workspace();
  try {
    // Everything below is derived from the two discovery surfaces. Nothing
    // reads `quest instructions`, and nothing hardcodes the argv shape.
    const helpWindow = quest(root, ["help", "task", "create"])
      .stdout.split("\n")
      .slice(0, HELP_WINDOW)
      .join("\n");

    const usage = helpWindow
      .split("\n")
      .find((line) => line.trim().startsWith("usage:"))
      ?.trim()
      .replace(/^usage:\s*/, "");
    expect(usage).toBeDefined();
    // The positional form has to be visible inside the window.
    expect(usage).toContain('"<title>"');

    const manifest = JSON.parse(quest(root, ["manifest", "--json"]).stdout) as {
      data: {
        commands: {
          name: string;
          parameters?: {
            positional: { name: string; required: boolean; value: string }[];
            flags: Record<string, { value: string; repeatable?: true }>;
          };
        }[];
      };
    };
    const create = manifest.data.commands.find((c) => c.name === "task create");
    const parameters = create?.parameters;
    expect(parameters?.positional).toEqual([
      { name: "title", required: true, value: "string" },
    ]);

    // Build the argv the way a generator would: required positionals in
    // order, then flags in the shape the manifest declares.
    const argv = ["task", "create"];
    for (const positional of parameters?.positional ?? [])
      if (positional.required) argv.push(`A ${positional.name}`);
    const push = (flag: string, ...values: string[]) => {
      const spec = parameters?.flags[flag];
      expect({ flag, declared: Boolean(spec) }).toEqual({
        flag,
        declared: true,
      });
      if (spec?.value === "json-array") argv.push(flag, JSON.stringify(values));
      else if (spec?.repeatable)
        for (const value of values) argv.push(flag, value);
      else argv.push(flag, values[0] as string);
    };
    push("--label", "alpha", "beta");
    push("--acceptance-criteria", "observable one", "observable two");
    push("--priority", "medium");
    argv.push("--actor", "person-1", "--actor-kind", "human", "--json");

    const created = quest(root, argv);
    expect({ exitCode: created.exitCode, stderr: created.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const record = JSON.parse(created.stdout).data;
    expect({
      title: record.title,
      labels: record.labels,
      acceptanceCriteria: record.acceptanceCriteria.map(
        (item: { text: string }) => item.text,
      ),
      priority: record.priority,
    }).toEqual({
      title: "A title",
      labels: ["alpha", "beta"],
      acceptanceCriteria: ["observable one", "observable two"],
      priority: "medium",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("help prints summary and usage above the fields and flags dump (QCLI-266)", async () => {
  const root = await workspace();
  try {
    const lines = quest(root, ["help", "task", "create"]).stdout.split("\n");
    const lineOf = (prefix: string) =>
      lines.findIndex((line) => line.trim().startsWith(prefix));

    const summary = lineOf("summary:");
    const usage = lineOf("usage:");
    const fields = lineOf("fields:");
    expect(summary).toBeGreaterThanOrEqual(0);
    expect(usage).toBe(summary + 1);
    // The regression this closes: usage rendered last, because the payload
    // renderer sorted keys alphabetically.
    expect(usage).toBeLessThan(fields);
    expect(usage).toBeLessThan(HELP_WINDOW);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("help flags carry their value shape, per command (QCLI-266)", async () => {
  const root = await workspace();
  try {
    const flagsIn = (args: readonly string[]) =>
      quest(root, args)
        .stdout.split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- --"));

    const create = flagsIn(["help", "task", "create"]);
    expect(create).toContain("- --label <string, repeatable>");
    // QCLI-313 made this shape MORE precise rather than changing what it
    // means: a checklist flag now renders the element shapes it accepts, so
    // the `{index,text,checked}` form is visible in the flag list and not
    // only in the prose. That serves this test's own intent -- flags carry
    // their value shape -- so the assertion moved with it rather than being
    // relaxed. `--plan` below still renders bare `<json-array>`, which is
    // what keeps this from being a blanket rewording.
    expect(create).toContain(
      "- --acceptance-criteria <json-array: string | {index,text,checked}>",
    );
    expect(create).toContain("- --plan <json-array>");
    expect(create).toContain("- --comments <json-objects>");
    // `--type` is one scalar here and a repeatable filter on `task list`.
    // A single global set would get exactly this wrong.
    expect(create).toContain("- --type <string>");

    const list = flagsIn(["help", "task", "list"]);
    expect(list).toContain("- --type <string, repeatable>");
    // A boolean flag takes no value and must not claim one.
    expect(list).toContain("- --ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("the declared flag sets stay disjoint and match the parser (QCLI-266)", () => {
  // The whole point of the shared table is that help, the manifest and the
  // parser cannot disagree. These are the invariants that would let them.
  const jsonArray = new Set<string>(JSON_ARRAY_FLAGS);
  for (const flag of [...REPEATABLE_CREATE_FLAGS, ...REPEATABLE_EDIT_FLAGS])
    expect({ flag, alsoJsonArray: jsonArray.has(flag) }).toEqual({
      flag,
      alsoJsonArray: false,
    });

  const boolean = new Set<string>(BOOLEAN_FLAGS);
  for (const flag of [
    ...REPEATABLE_CREATE_FLAGS,
    ...REPEATABLE_EDIT_FLAGS,
    ...JSON_ARRAY_FLAGS,
  ])
    expect({ flag, alsoBoolean: boolean.has(flag) }).toEqual({
      flag,
      alsoBoolean: false,
    });
});

test("the manifest still carries every key it carried before (QCLI-266)", async () => {
  // `parameters` is additive. The fleet sweep found consumers reading `name`,
  // `kind`, `schemaVersion` and `mutates`; lore-cli's verifyManifest checks
  // exactly those four and tolerates unknown keys. None of them may move.
  const root = await workspace();
  try {
    const manifest = JSON.parse(quest(root, ["manifest", "--json"]).stdout);
    expect(manifest.kind).toBe("manifest.registry");
    const create = manifest.data.commands.find(
      (c: { name: string }) => c.name === "task create",
    );
    expect({
      name: create.name,
      schemaVersion: create.schemaVersion,
      kind: create.kind,
      mutates: create.mutates,
      fieldsIsStringArray:
        Array.isArray(create.fields) &&
        create.fields.every((f: unknown) => typeof f === "string"),
      fieldsStillListsTitle: create.fields.includes("title"),
    }).toEqual({
      name: "task create",
      schemaVersion: 1,
      kind: "task.created",
      mutates: true,
      fieldsIsStringArray: true,
      fieldsStillListsTitle: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
