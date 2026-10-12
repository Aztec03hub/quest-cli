import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * QCLI-283 (governing ruling: opum-doc DEC-172 (4ak)). `task create` and
 * `task edit` spell the same list fields differently. Create sets a list
 * WHOLESALE with `--label`/`--reference`; edit MUTATES it with
 * `--labels`/`--add-label`/`--remove-label` and
 * `--add-reference`/`--remove-reference`. Before this change, `task edit
 * --label` met the generic "Unrecognized flag" usage failure, which named the
 * offending flag but never the edit-side spelling -- so the create/edit split
 * was silent.
 *
 * The ruling's SELECTED arm is a precise refusal, NOT an alias: the flag still
 * fails at exit 2, but the message now names the edit-side flag to use instead,
 * and the help text plus the manifest's EXISTING flag vocabularies NAME the
 * split. A later reader must not "fix" the exit-2 by adding an alias -- that
 * would widen the public surface to cover the split, which DEC-172 (4ak)
 * deliberately rejected; and opum-doc DEC-172 (4aq) additionally ruled OUT a new
 * manifest field for it, so the manifest names the split through the flags it
 * already advertises rather than through a `refusedFlags` map.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const ACTOR = ["--actor", "person-1", "--actor-kind", "human"] as const;

function quest(workspace: string, args: readonly string[]) {
  const child = Bun.spawnSync(["bun", MAIN, ...args], {
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
  const root = await mkdtemp(join(tmpdir(), "qcli283-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  quest(root, ["init"]);
  quest(root, ["task", "create", "alpha", ...ACTOR, "--json"]);
  return root;
}

/** The usage diagnostic a refusal carries, read from whichever stream holds it. */
function refusal(result: { stdout: string; stderr: string }) {
  const envelope = JSON.parse(result.stdout || result.stderr);
  expect(envelope.error_type).toBe("usage");
  return envelope.message as string;
}

test("`task edit --label` fails at exit 2 AND names the edit-side flags (QCLI-283)", async () => {
  const root = await workspace();
  try {
    const refused = quest(root, [
      "task",
      "edit",
      "T-1",
      "--label",
      "release",
      ...ACTOR,
      "--json",
    ]);
    // The real exit-2 repro: not a silent success.
    expect(refused.exitCode).toBe(2);
    const message = refusal(refused);
    // It names the offending create-side spelling...
    expect(message).toContain("--label");
    // ...and the edit-side flags to use instead, in ONE step.
    expect(message).toContain("--labels");
    expect(message).toContain("--add-label");
    expect(message).toContain("--remove-label");
    // The discard sentence: the rest of the invocation did not apply either.
    expect(message).toContain("Nothing was written");

    // Atomicity unchanged: no label landed.
    const viewed = quest(root, ["task", "view", "T-1", "--json"]);
    expect(JSON.parse(viewed.stdout).data.labels).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("`task edit --reference` fails at exit 2 AND names the edit-side flags (QCLI-283)", async () => {
  const root = await workspace();
  try {
    const refused = quest(root, [
      "task",
      "edit",
      "T-1",
      "--reference",
      "text",
      ...ACTOR,
      "--json",
    ]);
    expect(refused.exitCode).toBe(2);
    const message = refusal(refused);
    expect(message).toContain("--reference");
    expect(message).toContain("--add-reference");
    expect(message).toContain("--remove-reference");

    const viewed = quest(root, ["task", "view", "T-1", "--json"]);
    // An empty list field is omitted from `data`, so read absence as empty.
    expect(JSON.parse(viewed.stdout).data.references ?? []).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("both create-only spellings at once name both edit-side replacements (QCLI-283)", async () => {
  const root = await workspace();
  try {
    const refused = quest(root, [
      "task",
      "edit",
      "T-1",
      "--label",
      "release",
      "--reference",
      "text",
      ...ACTOR,
      "--json",
    ]);
    expect(refused.exitCode).toBe(2);
    const message = refusal(refused);
    for (const flag of [
      "--label",
      "--reference",
      "--add-label",
      "--remove-label",
      "--add-reference",
      "--remove-reference",
    ])
      expect(message).toContain(flag);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the edit-side spellings work -- the split is a naming choice, not a capability gap (QCLI-283)", async () => {
  const root = await workspace();
  try {
    const added = quest(root, [
      "task",
      "edit",
      "T-1",
      "--add-label",
      "release",
      "--add-reference",
      "text",
      ...ACTOR,
      "--json",
    ]);
    expect(added.exitCode).toBe(0);
    const data = JSON.parse(added.stdout).data;
    expect(data.labels).toEqual(["release"]);
    expect(data.references).toEqual(["text"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the task edit help text NAMES the create/edit split (QCLI-283, AC-2 second arm)", async () => {
  const help = Bun.spawnSync(["bun", MAIN, "help", "task", "edit", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(help.exitCode).toBe(0);
  const entry = JSON.parse(help.stdout.toString()).data.commands[0];
  const summary = entry.summary as string;
  expect(summary).toContain("CREATE/EDIT NAMING SPLIT");
  // Both sides of the split are named, not just the edit side.
  expect(summary).toContain("--label");
  expect(summary).toContain("--labels");
  expect(summary).toContain("--reference");
  expect(summary).toContain("--add-reference");
});

test("the manifest NAMES the split via its existing flag vocabularies, with no new field (QCLI-283, DEC-172 (4aq))", async () => {
  const root = await workspace();
  try {
    const commands = JSON.parse(quest(root, ["manifest", "--json"]).stdout).data
      .commands as Array<{
      name: string;
      parameters?: { flags?: Record<string, unknown> };
      [key: string]: unknown;
    }>;
    const edit = commands.find((entry) => entry.name === "task edit");
    const create = commands.find((entry) => entry.name === "task create");

    // The manifest names the EDIT side: the flags edit actually takes.
    const editFlags = Object.keys(edit?.parameters?.flags ?? {});
    expect(editFlags).toContain("--labels");
    expect(editFlags).toContain("--add-label");
    expect(editFlags).toContain("--remove-label");
    expect(editFlags).toContain("--add-reference");
    expect(editFlags).toContain("--remove-reference");

    // ...and the CREATE side is named too, so both halves of the split read off
    // the manifest without a round trip to `quest help`.
    const createFlags = Object.keys(create?.parameters?.flags ?? {});
    expect(createFlags).toContain("--label");
    expect(createFlags).toContain("--reference");

    // The create-only spellings are NOT accepted by edit: a refusal, never an
    // alias.
    expect(editFlags).not.toContain("--label");
    expect(editFlags).not.toContain("--reference");

    // DEC-172 (4aq): the split is NOT carried by a new manifest field. This
    // guards the ruling -- a later reader must not reintroduce `refusedFlags`.
    expect("refusedFlags" in (edit ?? {})).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * QCLI-484 (DEC-172 (4aq)). Three more create-side spellings fell through to
 * the generic refusal with no edit-side redirect, so a caller moving from
 * create to edit was told only that the flag was unrecognized.
 */
test("each create-only spelling edit refuses names its edit-side flags (QCLI-484 AC1)", async () => {
  const root = await workspace();
  try {
    const cases = [
      ["--assignee", "person-2", ["--add-assignee", "--remove-assignee"]],
      ["--dependency", "T-1", ["--add-dependency", "--remove-dependency"]],
      [
        "--modified-file",
        "src/x.ts",
        ["--add-modified-file", "--remove-modified-file"],
      ],
    ] as const;

    for (const [flag, value, replacements] of cases) {
      const refused = quest(root, [
        "task",
        "edit",
        "T-1",
        flag,
        value,
        ...ACTOR,
        "--json",
      ]);
      // The real exit-2 repro, not a silent success.
      expect(refused.exitCode, `${flag} exits 2`).toBe(2);
      const message = refusal(refused);
      expect(message, `${flag} names itself`).toContain(flag);
      for (const replacement of replacements)
        expect(message, `${flag} names ${replacement}`).toContain(replacement);
      expect(message, "the discard sentence").toContain("Nothing was written");
      // ...and with no OTHER unknown flag, it is not re-listed as
      // "Unrecognized" either: a lone create-only spelling is redirected,
      // never doubled (QCLI-484 round-1 review).
      expect(message, `${flag} is not re-listed`).not.toContain("Unrecognized");
    }

    // Atomicity: nothing from any of the three landed.
    const viewed = JSON.parse(
      quest(root, ["task", "view", "T-1", "--json"]).stdout,
    ).data;
    expect(viewed.assignees ?? []).toEqual([]);
    expect(viewed.dependencies ?? []).toEqual([]);
    expect(viewed.modifiedFiles ?? []).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a create-only spelling does not hide another unrecognized flag (QCLI-484 AC4)", async () => {
  const root = await workspace();
  try {
    const refused = quest(root, [
      "task",
      "edit",
      "T-1",
      "--label",
      "release",
      "--badflag",
      "y",
      ...ACTOR,
      "--json",
    ]);
    expect(refused.exitCode).toBe(2);
    const message = refusal(refused);
    // The create-only spelling's redirect...
    expect(message).toContain("--label");
    expect(message).toContain("--add-label");
    // ...AND every other unrecognized flag, in the SAME refusal, so fixing the
    // first does not merely move the caller to the second run.
    expect(message).toContain("--badflag");
    expect(message).toContain("Unrecognized flag");
    expect(message).toContain("Nothing was written");
    // ...and the create-only spelling is NOT re-listed: the clause names only
    // the genuinely-unknown flag. Re-listing --label is QCLI-484's round-1
    // review finding -- the message named it a second time.
    expect(message.match(/Unrecognized flags? [^.]*\./)?.[0]).toBe(
      "Unrecognized flag --badflag.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the docblock and the help name exactly the create-only spellings the map holds (QCLI-484 AC2, AC3)", async () => {
  const help = Bun.spawnSync(["bun", MAIN, "help", "task", "edit", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(help.exitCode).toBe(0);
  const summary = JSON.parse(help.stdout.toString()).data.commands[0]
    .summary as string;

  // The map is the authority: read its key set from the source rather than
  // restating it, so a key added or dropped there moves this test.
  const source = await Bun.file(
    new URL("../src/cli/main.ts", import.meta.url).pathname,
  ).text();
  const at = source.indexOf("const EDIT_FLAG_REDIRECTS");
  const block = source.slice(at, source.indexOf("};", at));
  const docblock = source.slice(source.lastIndexOf("/**", at), at);
  const mapKeys = [...block.matchAll(/^\s*"(--[a-z-]+)":/gmu)]
    .map((match) => match[1])
    .sort();
  expect(mapKeys).toEqual([
    "--assignee",
    "--dependency",
    "--label",
    "--modified-file",
    "--reference",
  ]);

  for (const key of mapKeys) {
    expect(docblock, `the docblock names ${key}`).toContain(key);
    expect(summary, `the help names ${key}`).toContain(key);
  }
  // The help names the edit-side replacements too, so both halves of the split
  // read from it.
  for (const flag of [
    "--labels",
    "--add-label",
    "--remove-label",
    "--add-reference",
    "--remove-reference",
    "--add-assignee",
    "--remove-assignee",
    "--add-dependency",
    "--remove-dependency",
    "--add-modified-file",
    "--remove-modified-file",
  ])
    expect(summary, `the help names ${flag}`).toContain(flag);
});
