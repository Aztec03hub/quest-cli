import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * QCLI-342. The overview guide documented the success envelope as
 * `{schemaVersion, kind, data, principal}`, omitting `contractVersion` --
 * which QCLI-289 added and which the shared command contract fixes at index
 * 1. It also said "the envelope", singular, while success and error are two
 * shapes sharing no payload key.
 *
 * That sentence is the highest-traffic one quest ships: this repository's
 * CLAUDE.md requires every agent to run `quest instructions overview` before
 * acting, so it is read immediately before someone writes a jq path. An
 * incomplete key list is the wrong input at exactly that moment.
 *
 * These tests compare the GUIDE TEXT against the envelope the CLI ACTUALLY
 * EMITS, rather than against the source constant, so the two cannot drift
 * apart again without a test going red. Asserting the guide against the
 * source would only prove the file agrees with itself.
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
  const root = await mkdtemp(join(tmpdir(), "qcli342-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  return root;
}

function overviewGuide(root: string): string {
  const result = quest(root, ["instructions", "overview"]);
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

test("the overview guide names every key the CLI actually emits on a success envelope (QCLI-342)", async () => {
  const root = await workspace();
  try {
    // `overview` is the command with NO command-specific additive key, so its
    // envelope is exactly the fixed set the guide enumerates. Asserting
    // against a command that adds one (see below) would conflate two
    // different claims.
    const emitted = quest(root, ["overview", "--json"]);
    expect(emitted.exitCode).toBe(0);
    const keys = Object.keys(JSON.parse(emitted.stdout));
    // Guard: if the envelope ever loses contractVersion this test must fail
    // loudly rather than vacuously pass on an empty key list.
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain("contractVersion");

    const guide = overviewGuide(root);
    for (const key of keys)
      expect(guide, `overview guide omits envelope key ${key}`).toContain(key);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the guide documents the additive slot as a RULE, since an enumeration cannot stay complete (QCLI-342)", async () => {
  const root = await workspace();
  try {
    quest(root, ["task", "create", "alpha", ...ACTOR, "--json"]);
    const listed = quest(root, ["task", "list", "--json"]);
    expect(listed.exitCode).toBe(0);
    const keys = Object.keys(JSON.parse(listed.stdout));

    // `task list` really does carry a key the fixed set does not (DEC-6's
    // `scope`), and it really does sit between `data` and `principal` -- the
    // slot the shared contract reserves. This test is what makes the guide's
    // rule a statement about the product rather than a promise.
    expect(keys).toContain("scope");
    expect(keys.indexOf("scope")).toBeGreaterThan(keys.indexOf("data"));
    expect(keys.at(-1)).toBe("principal");

    const guide = overviewGuide(root);
    expect(guide).toContain("scope");
    expect(guide).toContain("principal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the overview guide names every key the CLI actually emits on an ERROR envelope (QCLI-342)", async () => {
  const root = await workspace();
  try {
    const failed = quest(root, ["task", "view", "NOPE-1", "--json"]);
    expect(failed.exitCode).toBe(3);
    const keys = Object.keys(JSON.parse(failed.stdout || failed.stderr));
    expect(keys.length).toBeGreaterThan(0);

    const guide = overviewGuide(root);
    for (const key of keys)
      expect(guide, `overview guide omits error key ${key}`).toContain(key);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the overview guide says the record is under data, which is the trap it exists to close (QCLI-342)", async () => {
  const root = await workspace();
  try {
    const guide = overviewGuide(root);
    expect(guide).toContain("data");
    // The behaviour the sentence warns about, asserted so the warning is
    // demonstrably about something real: a top-level path matches nothing and
    // renders as null for every field, which reads as an empty record rather
    // than as a path one level too high.
    quest(root, ["task", "create", "alpha", ...ACTOR, "--json"]);
    const viewed = quest(root, ["task", "view", "T-1", "--json"]);
    expect(viewed.exitCode).toBe(0);
    const envelope = JSON.parse(viewed.stdout) as Record<string, unknown>;
    expect(envelope.id).toBeUndefined();
    expect(envelope.title).toBeUndefined();
    expect((envelope.data as Record<string, unknown>).id).toBe("T-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
