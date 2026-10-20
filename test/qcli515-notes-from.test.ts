import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { type ExecFile, notesCommitFrom } from "../scripts/github-release.mjs";
import { repairHint } from "../scripts/promote-release.mjs";

/**
 * QCLI-515 (opum-doc DEC-204 (3)): `promote-release.mjs --notes-from <sha>`
 * moves only where the release notes are read, and only to a CHANGELOG-only
 * descendant of the tag's commit. Each refusal is proved by name, and so is
 * the accepting case, so a gate that refuses everything cannot pass.
 */

const TAG = "053d8595f2caa34b04abc451d711e62fff5314b4";
const GOOD = "ce33f6d50cd193d2673ceede40fc4e89d5549c99";

// Two reads are made: the tag...sha range, and dev...sha for reachability. The
// mock answers each by its URL, and fails on any other, so a changed address
// cannot slip through as an accepted case.
const compareReturning =
  (answer: unknown, onDev: unknown = { status: "identical" }): ExecFile =>
  async (_file, args) => {
    const url = String(args.at(-1));
    if (url === `repos/opum-ai/quest-cli/compare/${TAG}...${GOOD}`)
      return { stdout: JSON.stringify(answer) };
    if (url === `repos/opum-ai/quest-cli/compare/dev...${GOOD}`)
      return { stdout: JSON.stringify(onDev) };
    throw new Error(`unexpected read: ${url}`);
  };

const changed = (filename: string, extra: object = {}) => ({
  filename,
  status: "modified",
  ...extra,
});

test("accepted: a descendant whose net diff is CHANGELOG.md alone", async () => {
  const outcome = await notesCommitFrom(GOOD, TAG, {
    execFile: compareReturning({
      status: "ahead",
      files: [changed("CHANGELOG.md")],
    }),
  });
  expect(outcome).toEqual({ ok: true, commit: GOOD, tagCommit: TAG });
});

test("refused: a descendant that also touches another file names that file", async () => {
  const outcome = await notesCommitFrom(GOOD, TAG, {
    execFile: compareReturning({
      status: "ahead",
      files: [
        changed("CHANGELOG.md"),
        changed("src/application/tasks/tasks.ts"),
      ],
    }),
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.detail).toContain("src/application/tasks/tasks.ts");
    expect(outcome.detail).not.toContain("CHANGELOG.md,");
  }
});

test("refused: a sha that does not descend from the tag commit, by status", async () => {
  for (const status of ["diverged", "behind", "identical"]) {
    const outcome = await notesCommitFrom(GOOD, TAG, {
      execFile: compareReturning({ status, files: [changed("CHANGELOG.md")] }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.detail).toContain("does not descend");
      expect(outcome.detail).toContain(JSON.stringify(status));
    }
  }
});

test("accepted: a sha behind dev's tip is still part of dev's history", async () => {
  const outcome = await notesCommitFrom(GOOD, TAG, {
    execFile: compareReturning(
      { status: "ahead", files: [changed("CHANGELOG.md")] },
      { status: "behind" },
    ),
  });
  expect(outcome.ok).toBe(true);
});

test("refused: a sha that is not part of dev's history (a fork-only commit)", async () => {
  for (const status of ["ahead", "diverged"]) {
    const outcome = await notesCommitFrom(GOOD, TAG, {
      execFile: compareReturning(
        { status: "ahead", files: [changed("CHANGELOG.md")] },
        { status },
      ),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok)
      expect(outcome.detail).toContain("not part of dev's history");
  }
});

test("refused: a dev comparison that cannot be read does not default to accepted", async () => {
  const outcome = await notesCommitFrom(GOOD, TAG, {
    execFile: async (_file, args) => {
      if (String(args.at(-1)).includes("/compare/dev..."))
        throw Object.assign(new Error("boom"), {
          stderr: "gh: Not Found (HTTP 404)\n",
        });
      return {
        stdout: JSON.stringify({
          status: "ahead",
          files: [changed("CHANGELOG.md")],
        }),
      };
    },
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok)
    expect(outcome.detail).toContain("could not be compared with dev");
});

test("refused: a rename onto CHANGELOG.md, and a CHANGELOG.md that was added", async () => {
  for (const file of [
    changed("CHANGELOG.md", { status: "renamed", previous_filename: "OLD.md" }),
    changed("CHANGELOG.md", { status: "added" }),
  ]) {
    const outcome = await notesCommitFrom(GOOD, TAG, {
      execFile: compareReturning({ status: "ahead", files: [file] }),
    });
    expect(outcome.ok).toBe(false);
  }
});

test("refused: an empty, missing or truncated file list is not trusted", async () => {
  const truncated = Array.from({ length: 300 }, () => changed("CHANGELOG.md"));
  for (const files of [[], undefined, truncated]) {
    const outcome = await notesCommitFrom(GOOD, TAG, {
      execFile: compareReturning({ status: "ahead", files }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain("changed-file list");
  }
});

test("refused: anything but a full 40-hex commit, and the tag's own commit", async () => {
  const neverCalled: ExecFile = async () => {
    throw new Error("the compare must not run");
  };
  for (const sha of ["dev", "v0.14.1", "ce33f6d", GOOD.toUpperCase(), ""]) {
    const outcome = await notesCommitFrom(sha, TAG, { execFile: neverCalled });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain("40-hex");
  }
  const own = await notesCommitFrom(TAG, TAG, { execFile: neverCalled });
  expect(own.ok).toBe(false);
  if (!own.ok) expect(own.detail).toContain("the tag's own commit");
});

test("refused: a compare that cannot be read says so and does not default", async () => {
  const outcome = await notesCommitFrom(GOOD, TAG, {
    execFile: async () => {
      throw Object.assign(new Error("boom"), {
        stderr: "gh: Not Found (HTTP 404)\n",
      });
    },
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.detail).toContain("Not Found (HTTP 404)");
});

test("wiring: only the notes read moves; the bundle gate stays on the tag peel", () => {
  const source = readFileSync(
    new URL("../scripts/promote-release.mjs", import.meta.url),
    "utf8",
  );
  expect(source).toContain("releaseNotesFor(version, { commit: notesCommit })");
  expect(source).toContain("notesCommitFrom(notesFrom, peeled.commit)");
  // The qualified-bundle gate is still keyed to the tag peel.
  expect(source).toMatch(/commit: peeled\.commit,/);
  // The flag defaults to the tag peel when it is absent.
  expect(source).toContain("let notesCommit = peeled.commit;");
  // An empty --notes-from (an unset shell variable) is refused, not ignored.
  expect(source).toContain("if (notesFrom !== undefined) {");
});

test("repair hint: the hand-cut route when notes came from --notes-from, the tool otherwise", () => {
  const plain = repairHint("0.14.1", undefined);
  expect(plain).toContain("github-release.mjs --version 0.14.1 --create");
  const handCut = repairHint("0.14.1", GOOD);
  expect(handCut).not.toContain("Repair with: node scripts/github-release.mjs");
  expect(handCut).toContain("Do NOT use github-release.mjs --create");
  expect(handCut).toContain(`gh release create v0.14.1 --verify-tag`);
  expect(handCut).toContain(GOOD);
});

// DEC-204 (3a): the net range may be CHANGELOG.md plus tracker records under
// .quest/ and nothing else. Tracker writes land on dev between the tag and a
// changelog fix, so a CHANGELOG-only range refuses the commit this flag is for.
const accepts = (files: object[]) =>
  notesCommitFrom(GOOD, TAG, {
    execFile: compareReturning({ status: "ahead", files }),
  });

test("accepted: CHANGELOG.md plus tracker records under .quest/", async () => {
  const outcome = await accepts([
    changed(".quest/tasks/QCLI-499.json"),
    changed("CHANGELOG.md"),
    { filename: ".quest/tasks/QCLI-515.json", status: "added" },
    {
      filename: ".quest/old.json",
      status: "renamed",
      previous_filename: ".quest/new.json",
    },
  ]);
  expect(outcome.ok).toBe(true);
});

test("refused: a path that only looks like the tracker, by name", async () => {
  for (const filename of [
    ".questions/x.json",
    "quest/x.json",
    "x/.quest/a.json",
    ".quest",
  ]) {
    const outcome = await accepts([changed("CHANGELOG.md"), changed(filename)]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain(filename);
  }
});

test("refused: a tracker file renamed in from outside .quest/", async () => {
  const outcome = await accepts([
    changed("CHANGELOG.md"),
    {
      filename: ".quest/tasks/A.json",
      status: "renamed",
      previous_filename: "src/a.ts",
    },
  ]);
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.detail).toContain(".quest/tasks/A.json");
});

test("refused: CHANGELOG.md absent, added, removed or renamed in the net range", async () => {
  for (const files of [
    [changed(".quest/tasks/QCLI-499.json")],
    [{ filename: "CHANGELOG.md", status: "added" }],
    [{ filename: "CHANGELOG.md", status: "removed" }],
    [
      {
        filename: "CHANGELOG.md",
        status: "renamed",
        previous_filename: "OLD.md",
      },
    ],
  ]) {
    const outcome = await accepts(files);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain("CHANGELOG.md");
  }
});

// The REAL ranges, read from the GitHub API on 2026-10-20 and recorded as
// fixtures (test/fixtures/qcli515), not typed by hand: the unit tests above
// mock `files` and could not see that the real 0.14.1 range carries a tracker
// record beside CHANGELOG.md.
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/qcli515/${name}`, import.meta.url)),
      "utf8",
    ),
  );

const realRange = (name: string, sha: string): ExecFile => {
  const range = fixture(name);
  return async (_file, args) => {
    const url = String(args.at(-1));
    if (url === `repos/opum-ai/quest-cli/compare/${TAG}...${sha}`)
      return { stdout: JSON.stringify(range) };
    if (url === `repos/opum-ai/quest-cli/compare/dev...${sha}`)
      return { stdout: JSON.stringify({ status: "behind" }) };
    throw new Error(`unexpected read: ${url}`);
  };
};

test("real range 053d8595...ce33f6d5 (the #632 commit) is accepted", async () => {
  const range = fixture("compare-053d8595-ce33f6d5.json");
  // The shape this exists for: a tracker record beside the changelog fix.
  expect(
    range.files.map((f: { filename: string }) => f.filename).sort(),
  ).toEqual([".quest/tasks/QCLI-499.json", "CHANGELOG.md"]);
  const outcome = await notesCommitFrom(GOOD, TAG, {
    execFile: realRange("compare-053d8595-ce33f6d5.json", GOOD),
  });
  expect(outcome).toEqual({ ok: true, commit: GOOD, tagCommit: TAG });
});

test("real range 053d8595...b1f173c0 (a branch that changes code) is refused, naming the code", async () => {
  const head = "b1f173c0af35ea4da095aba3d8c0c1e5858adc1a";
  const outcome = await notesCommitFrom(head, TAG, {
    execFile: realRange("compare-053d8595-b1f173c0-refusal.json", head),
  });
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.detail).toContain("scripts/promote-release.mjs");
    expect(outcome.detail).toContain("test/qcli515-notes-from.test.ts");
    expect(outcome.detail).not.toContain(".quest/tasks/QCLI-499.json");
  }
});
