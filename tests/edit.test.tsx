import { expect, mock, test } from "claude-code/testing";

import { actorArgs, commentArg } from "../hooks/quest";

const PANE = {
  title: "Quest board",
  isFocused: true,
  bodyColumns: 64,
  placement: "dock" as const,
  scroll: { offset: 0, bodyRows: 80 },
  view: {},
};

const ok = (stdout: string, exitCode = 0) => ({
  value: {
    exitCode,
    stdout,
    stderr: "",
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
});

const list = (status: string) =>
  JSON.stringify({
    kind: "task.list",
    data: [
      { id: "OCLI-8", title: "Probes", status, priority: "high", labels: [] },
    ],
  });

const viewOf = (status: string) =>
  JSON.stringify({
    kind: "task.view",
    data: {
      id: "OCLI-8",
      title: "Probes",
      status,
      priority: "high",
      revision: "rev1",
      acceptanceCriteria: [
        { index: 0, position: 1, text: "Each probe passes", checked: false },
      ],
      comments: [
        {
          id: "c-1",
          authorId: "jdnewhouse",
          body: "Looks right",
          createdAt: "2026-10-02T14:00:00.000Z",
        },
      ],
    },
  });

test("commentArg and actorArgs match what quest takes", async () => {
  expect(actorArgs("jdnewhouse")).toEqual([
    "--actor",
    "jdnewhouse",
    "--actor-kind",
    "human",
  ]);
  expect(
    JSON.parse(commentArg("jdnewhouse", "hi", Date.UTC(2026, 9, 2))),
  ).toEqual([
    {
      id: `c-${Date.UTC(2026, 9, 2)}`,
      authorId: "jdnewhouse",
      body: "hi",
      createdAt: "2026-10-02T00:00:00.000Z",
    },
  ]);
});

test("edits in this repo call quest with the actor and the revision guard", async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 2, 14, 30) });
  mock.store(on);
  on("session.root", async () => ({ value: "/tmp/opum-cli" }));
  const calls: string[][] = [];
  on("process.run", async (_$, e) => {
    calls.push([...e.argv]);
    if (e.argv[0] === "git" && e.argv.includes("--git-common-dir"))
      return ok("/tmp/opum-cli/.git\n");
    if (e.argv[0] === "git")
      return ok(" M .quest/tasks/OCLI-8.json\n M .quest/tasks/OCLI-9.json\n");
    if (e.argv.includes("view")) return ok(viewOf("In Progress"));
    if (e.argv.includes("list")) {
      return ok(
        e.init?.cwd === "/tmp/opum-cli"
          ? list("In Progress")
          : JSON.stringify({ kind: "task.list", data: [] }),
      );
    }
    return ok(JSON.stringify({ kind: "task.edit", data: { id: "OCLI-8" } }));
  });

  for (const surface of ["terminal", "desktop"] as const) {
    calls.length = 0;
    const ui = await $.ui.mount({
      plugin: "opum-quest",
      surface,
      component: "Pane",
      requestId: "quest-board",
      props: PANE,
    });
    await ui.press({ key: "tab-list" });
    await ui.press({ key: "refresh" });
    await ui.press({ key: "row:opum-cli:OCLI-8" });
    expect(
      await ui.find({
        type: "Text",
        text: /jdnewhouse, 2026-10-02 14:00: Looks right/,
      }),
    ).toBeDefined();

    await ui.press({ key: "pause" });
    expect(calls).toContainEqual([
      "quest",
      "task",
      "pause",
      "OCLI-8",
      "--actor",
      "jdnewhouse",
      "--actor-kind",
      "human",
      "--json",
    ]);

    await ui.input({ key: "comment", text: "Ship it" });
    const comment = calls.find((argv) => argv.includes("--add-comment"));
    expect(comment?.slice(0, 4)).toEqual(["quest", "task", "edit", "OCLI-8"]);
    expect(comment).toContain("--if-revision");
    expect(comment?.[comment.indexOf("--if-revision") + 1]).toBe("rev1");

    await ui.press({ key: "ac:1" });
    expect(
      calls.some((argv) => argv.includes("--check-ac") && argv.includes("1")),
    ).toBe(true);

    expect(
      await ui.find({
        type: "Text",
        text: /2 tracker changes in opum-cli not committed yet/,
      }),
    ).toBeDefined();
    await ui.unmount();
  }
});

// QCLI-490: the "a task from another repo is read-only" case went with fleet
// mode. The board reads this session's own repository only, so every row it
// draws is one this pane may write -- there is no other repo to be read-only
// about. The guard itself stays in register.tsx, defensive and unreachable now.

test(
  "the actor option decides what a write is recorded as",
  { options: { actor: "someone-else" } },
  async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 9, 2, 14, 30) });
    mock.store(on);
    on("session.root", async () => ({ value: "/tmp/opum-cli" }));
    const calls: string[][] = [];
    on("process.run", async (_$, e) => {
      calls.push([...e.argv]);
      if (e.argv[0] === "git") return ok("");
      if (e.argv.includes("view")) return ok(viewOf("In Progress"));
      if (e.argv.includes("list")) return ok(list("In Progress"));
      return ok(JSON.stringify({ kind: "task.edit", data: { id: "OCLI-8" } }));
    });

    const ui = await $.ui.mount({
      plugin: "opum-quest",
      surface: "terminal",
      component: "Pane",
      requestId: "quest-board",
      props: PANE,
    });
    await ui.press({ key: "tab-list" });
    await ui.press({ key: "refresh" });
    await ui.press({ key: "row:opum-cli:OCLI-8" });
    await ui.press({ key: "pause" });
    expect(calls).toContainEqual([
      "quest",
      "task",
      "pause",
      "OCLI-8",
      "--actor",
      "someone-else",
      "--actor-kind",
      "human",
      "--json",
    ]);
  },
);

/**
 * QCLI-431. `quest task create` takes the next id from the working tree plus
 * every LOCAL ref, so a record that is written but not yet committed is
 * invisible to this repository's other checkouts and a create in one of them
 * mints the same id. The pane cannot close that window -- only landing the
 * record does -- so what it owes the person is the window being legible at the
 * moment it opens.
 */
test("an unlanded record is drawn as the id-collision window it is", async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 2, 14, 30) });
  mock.store(on);
  on("session.root", async () => ({ value: "/tmp/opum-cli" }));
  on("process.run", async (_$, e) => {
    if (e.argv[0] === "git" && e.argv.includes("--git-common-dir"))
      return ok("/tmp/opum-cli/.git\n");
    if (e.argv[0] === "git") return ok("?? .quest/tasks/OCLI-9.json\n");
    if (e.argv.includes("list")) {
      return ok(
        e.init?.cwd === "/tmp/opum-cli"
          ? list("In Progress")
          : JSON.stringify({ kind: "task.list", data: [] }),
      );
    }
    return ok(viewOf("In Progress"));
  });

  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({
      plugin: "opum-quest",
      surface,
      component: "Pane",
      requestId: "quest-board",
      props: PANE,
    });
    await ui.press({ key: "tab-list" });
    expect(
      await ui.find({
        type: "Text",
        text: /other checkouts cannot see the ids in them and can mint the same ones/,
      }),
    ).toBeDefined();
    await ui.unmount();
  }
});
