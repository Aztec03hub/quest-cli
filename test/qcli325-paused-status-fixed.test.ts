import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { questGuides } from "../src/application/agents/guides.ts";
import { commandHelp } from "../src/application/command-help.ts";
import { commandManifest } from "../src/application/command-contract.ts";

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;

async function quest(cwd: string, args: readonly string[]) {
  const child = Bun.spawn(["bun", MAIN, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // QCLI-371: an env-less spawn gets the ORIGINAL environment, which drops
    // any preload setting and can reach the machine's real plugins.
    env: { ...Bun.env },
  });
  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}

/**
 * QCLI-325 (opum-doc relay 570, DEC-172 (4af)): pausedStatus is documented as
 * FIXED for now. No user-reachable knob sets it -- createTaskService passes the
 * default policy as a constant and nothing reads workspace.toml for lifecycle
 * config -- so the prose must not promise one, and the status-flow OUTPUT must
 * say plainly that the value is not the reader's to change.
 */

test("task status-flow output says the paused status is built-in and not user-changeable (QCLI-325 AC3)", async () => {
  const store = await mkdtemp(join(tmpdir(), "qcli325-"));
  try {
    await Bun.spawn(["git", "init", "--quiet", store], {
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
    expect(
      (await quest(store, ["init", "--name", "P", "--task-id-prefix", "T"]))
        .exitCode,
    ).toBe(0);
    const result = await quest(store, ["task", "status-flow", "--json"]);
    expect(result.exitCode).toBe(0);
    const flow = JSON.parse(result.stdout) as {
      data: { pausedStatus?: string; pausedStatusConfigurable?: boolean };
    };
    expect(flow.data.pausedStatus).toBe("Paused");
    // AC3: a reader can tell from this output ALONE -- no source, no asking.
    expect(flow.data.pausedStatusConfigurable).toBe(false);
    // QCLI-325: the new key is on a MACHINE surface, so it must be DECLARED in
    // the manifest or the change ships the same under-declaration class
    // QCLI-461 closed for task list/view/search. No existing test compares
    // status-flow's declared `fields` to the keys it emits, so it is pinned
    // here. (A full emitted-subset-of-declared check for status-flow is a
    // separate gap -- closedStatus and resolutions are still undeclared.)
    const declared =
      commandManifest.commands.find(
        (command) => command.name === "task status-flow",
      )?.fields ?? [];
    expect(declared).toContain("pausedStatus");
    expect(declared).toContain("pausedStatusConfigurable");
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("the paused-status prose states it is fixed and never promises a knob (QCLI-325 AC2, AC4)", () => {
  const sites = [
    ["task status-flow", commandHelp["task status-flow"]?.summary ?? ""],
    ["task pause", commandHelp["task pause"]?.summary ?? ""],
    [
      "task-finalization guide",
      questGuides.find((guide) => guide.name === "task-finalization")
        ?.content ?? "",
    ],
  ] as const;
  for (const [name, text] of sites) {
    expect({ name, nonEmpty: text.length > 0 }).toEqual({
      name,
      nonEmpty: true,
    });
    // The drift this pins: each site once read as a promise that a workspace
    // MAY configure the paused status.
    expect({
      name,
      promisesAKnob:
        /has one configured|configured paused status|no paused status configured/i.test(
          text,
        ),
    }).toEqual({ name, promisesAKnob: false });
    expect({
      name,
      saysFixed: /not workspace-configurable/i.test(text),
    }).toEqual({ name, saysFixed: true });
  }
});
