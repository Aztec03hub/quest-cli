import { expect, test } from "bun:test";

import {
  hostPlatformTarget,
  PROBE_LIST_ARGS,
  PROBE_LIST_SHAPE_ARGS,
  PROBE_VIEW_ARGS,
  PROBE_VIEW_SHAPE_ARGS,
  probeReleaseBinary,
  releaseProbeEnablement,
} from "../scripts/release-binary-probe.mjs";

/**
 * QCLI-509 / DEC-204. The release gate used to compare each committed
 * binary's digest only against a checksum map regenerated from those same
 * bytes, so a binary stale relative to `src/` passed by construction. The
 * probe adds the missing half: execute the committed binary and require it to
 * answer commands that exist only in the current source tree.
 *
 * The proof DEC-204 asks for is both directions in one run: a deliberately
 * stale binary goes red while a fresh build goes green. The decision logic is
 * exercised here with injected results so the pair is a durable test rather
 * than a one-off measurement; the real both-ways run against the committed
 * binary and a fresh compile is recorded on the task.
 */

type Response = {
  status: number;
  stdout?: string;
  stderr?: string;
};

function sequence(responses: Response[]) {
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return {
        status: response.status,
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
      };
    },
  };
}

const staleResponse = {
  status: 2,
  stderr:
    '{"error_type":"usage","message":"Unrecognized flag --fields. Nothing was written: the rest of this command was not applied either."}\n',
};

const freshResponses: Response[] = [
  { status: 0, stdout: "QCLI-1\nQCLI-2\n" },
  {
    status: 0,
    stdout: '{"data":[{"id":"QCLI-1"},{"id":"QCLI-2"}],"principal":null}\n',
  },
  { status: 0, stdout: "Establish the quest-cli component foundation\n" },
  {
    status: 0,
    stdout:
      '{"data":{"title":"Establish the quest-cli component foundation"},"principal":null}\n',
  },
];

test("the probe is the DEC-204 pair, verbatim, with a JSON shape arm for each", () => {
  expect(PROBE_LIST_ARGS).toEqual(["task", "list", "--fields", "id"]);
  expect(PROBE_LIST_SHAPE_ARGS).toEqual([
    "task",
    "list",
    "--fields",
    "id",
    "--json",
  ]);
  expect(PROBE_VIEW_ARGS("QCLI-1")).toEqual([
    "task",
    "view",
    "QCLI-1",
    "--fields",
    "title",
  ]);
  expect(PROBE_VIEW_SHAPE_ARGS("QCLI-1")).toEqual([
    "task",
    "view",
    "QCLI-1",
    "--fields",
    "title",
    "--json",
  ]);
});

test("both directions in one run: a stale binary goes red while a fresh build goes green", async () => {
  const stale = sequence([staleResponse]);
  const staleResult = await probeReleaseBinary({ run: stale.run });
  expect(staleResult.ok).toBe(false);
  expect(staleResult.probesRun).toBe(1);
  expect(staleResult.problems[0]).toContain("exited 2");
  expect(staleResult.problems[0]).toContain("Unrecognized flag --fields");

  const fresh = sequence(freshResponses);
  const freshResult = await probeReleaseBinary({ run: fresh.run });
  expect(freshResult).toEqual({
    ok: true,
    problems: [],
    probesRun: 4,
    id: "QCLI-1",
  });
  // The view halves are fed the id the list half actually projected.
  expect(fresh.calls[2]).toEqual([
    "task",
    "view",
    "QCLI-1",
    "--fields",
    "title",
  ]);
  expect(fresh.calls[3]).toEqual([
    "task",
    "view",
    "QCLI-1",
    "--fields",
    "title",
    "--json",
  ]);
});

test("a binary that accepts --fields but ignores the projection is caught", async () => {
  const ignoring = sequence([
    { status: 0, stdout: "QCLI-1\tIn Progress\tA whole record\n" },
    {
      status: 0,
      stdout:
        '{"data":[{"id":"QCLI-1","title":"A title","status":"In Progress"}],"principal":null}\n',
    },
    { status: 0, stdout: "QCLI-1\tIn Progress\tA whole record\n" },
    {
      status: 0,
      stdout:
        '{"data":{"id":"QCLI-1","title":"A title","status":"In Progress"},"principal":null}\n',
    },
  ]);
  const result = await probeReleaseBinary({ run: ignoring.run });
  expect(result.ok).toBe(false);
  expect(result.probesRun).toBe(4);
  expect(result.problems).toHaveLength(2);
  expect(result.problems[0]).toContain(
    'a --fields id projection carries exactly ["id"]',
  );
  expect(result.problems[1]).toContain(
    'a --fields title projection carries exactly ["title"]',
  );
});

test("an empty listing fails rather than passing on a probe that read nothing", async () => {
  const empty = sequence([
    { status: 0, stdout: "" },
    { status: 0, stdout: '{"data":[],"principal":null}\n' },
  ]);
  const result = await probeReleaseBinary({ run: empty.run });
  expect(result.ok).toBe(false);
  expect(result.probesRun).toBe(2);
  expect(result.problems[0]).toContain("returned no tasks");
});

test("a view envelope with no data key fails rather than passing on an unread record", async () => {
  const dataLess = sequence([
    { status: 0, stdout: "QCLI-1\n" },
    { status: 0, stdout: '{"data":[{"id":"QCLI-1"}],"principal":null}\n' },
    { status: 0, stdout: "A title\n" },
    {
      status: 0,
      stdout: '{"schemaVersion":1,"kind":"task.view","principal":null}\n',
    },
  ]);
  const result = await probeReleaseBinary({ run: dataLess.run });
  expect(result.ok).toBe(false);
  expect(result.probesRun).toBe(4);
  expect(result.problems).toHaveLength(1);
  expect(result.problems[0]).toContain("carried no data to project");
});

test("a null data field is the same read-nothing failure, not a thrown TypeError", async () => {
  const nullData = sequence([
    { status: 0, stdout: "QCLI-1\n" },
    { status: 0, stdout: '{"data":[{"id":"QCLI-1"}],"principal":null}\n' },
    { status: 0, stdout: "A title\n" },
    {
      status: 0,
      stdout:
        '{"schemaVersion":1,"kind":"task.view","data":null,"principal":null}\n',
    },
  ]);
  const result = await probeReleaseBinary({ run: nullData.run });
  expect(result.ok).toBe(false);
  expect(result.probesRun).toBe(4);
  expect(result.problems).toHaveLength(1);
  expect(result.problems[0]).toContain("carried no data to project");
});

test("a view half that fails is reported after the list half passed", async () => {
  const brokenView = sequence([
    { status: 0, stdout: "QCLI-1\n" },
    { status: 0, stdout: '{"data":[{"id":"QCLI-1"}],"principal":null}\n' },
    {
      status: 3,
      stderr: '{"error_type":"not_found","message":"task_not_found"}',
    },
    {
      status: 3,
      stderr: '{"error_type":"not_found","message":"task_not_found"}',
    },
  ]);
  const result = await probeReleaseBinary({ run: brokenView.run });
  expect(result.ok).toBe(false);
  expect(result.probesRun).toBe(4);
  expect(result.problems).toHaveLength(2);
  expect(result.problems[0]).toContain("exited 3");
  expect(result.problems[0]).toContain("task_not_found");
});

test("a non-JSON answer is reported rather than parsed into a pass", async () => {
  const notJson = sequence([
    { status: 0, stdout: "QCLI-1\n" },
    { status: 0, stdout: "not an envelope\n" },
  ]);
  const result = await probeReleaseBinary({ run: notJson.run });
  expect(result.ok).toBe(false);
  expect(result.probesRun).toBe(2);
  expect(result.problems[0]).toContain("did not print a JSON envelope");
});

test("the probe is release-scoped: only the native qualification job or an explicit opt-in enables it", () => {
  expect(hostPlatformTarget("darwin", "arm64")).toBe("darwin-arm64");
  expect(hostPlatformTarget("linux", "x64")).toBe("linux-x64");
  expect(hostPlatformTarget("freebsd", "x64")).toBeNull();

  expect(releaseProbeEnablement({ env: {}, target: "linux-x64" })).toEqual({
    enabled: false,
    reason:
      "not the native qualification job for linux-x64 (QUEST_QUALIFICATION_TARGET=unset)",
  });
  expect(
    releaseProbeEnablement({
      env: { QUEST_QUALIFICATION_TARGET: "linux-x64" },
      target: "linux-x64",
    }).enabled,
  ).toBe(true);
  // A cross platform job must not execute a binary it cannot run.
  expect(
    releaseProbeEnablement({
      env: { QUEST_QUALIFICATION_TARGET: "darwin-arm64" },
      target: "linux-x64",
    }).enabled,
  ).toBe(false);
  expect(
    releaseProbeEnablement({
      env: { QUEST_RELEASE_BINARY_PROBE: "1" },
      target: "linux-x64",
    }).enabled,
  ).toBe(true);
  expect(releaseProbeEnablement({ env: {}, target: null }).enabled).toBe(false);
});
