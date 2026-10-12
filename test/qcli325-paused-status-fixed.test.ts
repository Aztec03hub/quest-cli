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

/**
 * The four prose sites QCLI-325 reworded, each with the shape it must NOT drift
 * back to and the shape it must carry now.
 *
 * They are PER SITE because the fourth -- the task start help, which QCLI-325's
 * round-1 fix reworded and the guard did not cover (QCLI-480) -- says the same
 * thing in different words: "the paused literal is BUILT IN and the workspace
 * cannot configure it". Neither the promise alternations nor the fixed phrase
 * the other three share would genuinely cover it; adding it to the old sites
 * list would have asserted a phrase it does not contain.
 *
 * `before` is that site's real pre-QCLI-325 sentence, kept so the guard can be
 * run against the wording it replaced (QCLI-480 AC1: both directions measured).
 */
const PAUSED_SITES = [
  {
    name: "task status-flow",
    drift: /has one configured/i,
    fixed: /not workspace-configurable/i,
    before:
      "the paused status (if the workspace has one configured) reached only via `task pause`/`task start`",
  },
  {
    name: "task pause",
    drift: /no paused status configured/i,
    fixed: /not workspace-configurable/i,
    before:
      'Pause an In Progress task to the configured paused status ("Paused" by default), recording that work was started rather than resetting it. Disabled if the workspace has no paused status configured.',
  },
  {
    name: "task-finalization guide",
    drift: /configured paused status/i,
    fixed: /not workspace-configurable/i,
    before:
      'parks it at the configured paused status ("Paused" by default) without erasing that work was started',
  },
  {
    name: "task start",
    drift: /does not configure that literal itself/i,
    fixed: /built in and the workspace cannot configure it/i,
    before:
      'the retired pre-0.7.0 default "Blocked" on a record parked before the rename, when the workspace does not configure that literal itself (QCLI-302)',
  },
] as const;

const pausedSiteText = (name: string): string =>
  name === "task-finalization guide"
    ? (questGuides.find((guide) => guide.name === "task-finalization")
        ?.content ?? "")
    : (commandHelp[name as keyof typeof commandHelp]?.summary ?? "");

/** The guard as a PREDICATE, so the same check runs against `before` and now. */
const guardHolds = (
  text: string,
  site: { drift: RegExp; fixed: RegExp },
): boolean =>
  text.length > 0 && !site.drift.test(text) && site.fixed.test(text);

test("the paused-status prose states it is fixed and never promises a knob (QCLI-325 AC2, AC4, QCLI-480 AC1)", () => {
  for (const site of PAUSED_SITES) {
    const text = pausedSiteText(site.name);
    // A site the guard read nothing from must not pass.
    expect({ name: site.name, nonEmpty: text.length > 0 }).toEqual({
      name: site.name,
      nonEmpty: true,
    });
    // The drift this pins: the site once read as a promise of a workspace knob.
    expect({ name: site.name, drift: site.drift.test(text) }).toEqual({
      name: site.name,
      drift: false,
    });
    expect({ name: site.name, fixed: site.fixed.test(text) }).toEqual({
      name: site.name,
      fixed: true,
    });
  }

  // Both directions, MEASURED and counted: every site holds on its current
  // wording, and every site FAILS on the wording it replaced. Dropping a site
  // from the list, or letting one drift back, moves both counts.
  const greenOnCurrent = PAUSED_SITES.filter((site) =>
    guardHolds(pausedSiteText(site.name), site),
  ).map((site) => site.name);
  const redOnBefore = PAUSED_SITES.filter(
    (site) => !guardHolds(site.before, site),
  ).map((site) => site.name);
  expect({
    sites: PAUSED_SITES.length,
    greenOnCurrent,
    redOnBefore,
  }).toEqual({
    sites: 4,
    greenOnCurrent: [
      "task status-flow",
      "task pause",
      "task-finalization guide",
      "task start",
    ],
    redOnBefore: [
      "task status-flow",
      "task pause",
      "task-finalization guide",
      "task start",
    ],
  });
});
