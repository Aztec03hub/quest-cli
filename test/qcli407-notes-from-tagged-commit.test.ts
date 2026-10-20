import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  changelogSection,
  ensureGitHubRelease,
  releaseNotesFor,
} from "../scripts/github-release.mjs";

/**
 * QCLI-407, twin of lore-cli LCLI-639. The release notes used to be read from
 * the CHECKOUT's CHANGELOG.md, so an uncommitted edit -- or work that landed
 * after the tag -- became the body of a new release. They are now read at the
 * commit v<version> peels to, through the GitHub API, on every path: the
 * pre-move refusal, the cut, and the standalone repair tool.
 *
 * Only pre-change symbols are imported at module scope (changelogSection,
 * releaseNotesFor), so this file RUNS against the pre-change module and fails
 * on its verdicts rather than at import. A control test that imports a symbol
 * the change adds dies before it can fail for the right reason.
 *
 * The fence predicate and the CRLF normalisation are a paired rule: lore-cli
 * implements the same two predicates, and a change to either here is a
 * divergence to agree with them before landing.
 */

/** A 40-hex commit, the shape resolveTagCommit returns. */
const TAGGED = "f3305628b2e21aed7e02236cee98dfd9a7f081c7";

const ghReturning =
  (text: string, calls: string[][]) =>
  async (file: string, args: readonly string[]) => {
    calls.push([file, ...args]);
    return { stdout: text };
  };

const ghFailing = async () => {
  const error = new Error("Command failed") as Error & { stderr?: string };
  error.stderr = "gh: Not Found (HTTP 404)\ngh api repos/.../contents/...";
  throw error;
};

test("the body comes from the tagged commit, so a working-tree edit cannot reach it", async () => {
  const tagged = "# Changelog\n\n## 9.9.9\n\nThe bytes at the tagged commit.\n";
  const calls: string[][] = [];
  const notes = await releaseNotesFor("9.9.9", {
    commit: TAGGED,
    execFile: ghReturning(tagged, calls),
  });

  // This checkout has no `## 9.9.9` section, so a working-tree read cannot
  // produce these notes. Against the pre-change module this assertion is what
  // fails, which is the control the criterion asks for, and it fails for the
  // reason the module reads a file this version has no section in: `null` when
  // that CHANGELOG is present beside it, and a read failure when it is not.
  expect(notes).toEqual({
    ok: true,
    notes: "The bytes at the tagged commit.",
    title: "Quest CLI 9.9.9",
  });
  const call = calls[0].join(" ");
  expect(calls[0][0]).toBe("gh");
  expect(call).toContain(`contents/CHANGELOG.md?ref=${TAGGED}`);
  expect(call).toContain("Accept: application/vnd.github.raw");
  expect(call).toContain("--hostname github.com");
});

test("a failed read is reported against the commit, never defaulted to a working tree", async () => {
  const notes = await releaseNotesFor("9.9.9", {
    commit: TAGGED,
    execFile: ghFailing,
  });
  if (notes.ok) throw new Error("expected a read failure, got notes");
  expect(notes.detail).toContain(TAGGED);
  expect(notes.detail).toContain("Not Found");
});

test("a section missing at the tagged commit refuses, and names the honest remedy", async () => {
  const notes = await releaseNotesFor("9.9.9", {
    commit: TAGGED,
    execFile: ghReturning("# Changelog\n\n## 9.9.8\n\nolder\n", []),
  });
  if (notes.ok) throw new Error("expected a refusal, got notes");
  expect(notes.detail).toContain("## 9.9.9");
  // The tag already exists, so editing and re-running cannot reach it. The
  // refusal says so rather than leaving that remedy implied, and it names the
  // hand cut BEFORE the re-tag: by this point the version is normally already
  // on npm latest, where moving a tag is the riskier of the two (review
  // finding F4).
  expect(notes.detail).toContain("cut the release by hand, or re-tag");
});

test("a `## ` inside a fence does not end the section, indented or not (vectors i, ii)", () => {
  const unindented =
    "## 9.9.9\n\nbefore\n\n```md\n## not a heading\n```\n\nafter\n\n## 9.9.8\n\nolder\n";
  const first = changelogSection(unindented, "9.9.9");
  expect(first?.body).toContain("## not a heading");
  expect(first?.body).toContain("after");
  expect(first?.body).not.toContain("older");

  // A real shape in this repository's own CHANGELOG: a fenced block indented
  // two spaces inside a list item.
  const indented =
    "## 9.9.9\n\n- item:\n\n  ```sh\n  ## not a heading\n  ```\n\ntail\n\n## 9.9.8\n\nolder\n";
  const second = changelogSection(indented, "9.9.9");
  expect(second?.body).toContain("## not a heading");
  expect(second?.body).toContain("tail");
  expect(second?.body).not.toContain("older");
});

test("a heading after a CLOSED fence still ends the section (vector iii)", () => {
  const changelog = "## 9.9.9\n\n```\nfenced\n```\n\n## 9.9.8\n\nolder\n";
  const section = changelogSection(changelog, "9.9.9");
  expect(section?.body).toContain("fenced");
  expect(section?.body).not.toContain("older");
});

test("the existing-release refusal names WHICH side the operator has to change", async () => {
  // The comparison target moved from the checkout to the tagged commit with
  // the notes themselves, so the refusal has to say which body passes.
  // Otherwise "reconcile it by hand" reads as an invitation to edit the
  // release toward whatever the checkout happens to say (review finding F1).
  const execFile = async (_file: string, args: readonly string[]) => ({
    stdout:
      args[1] === "view"
        ? JSON.stringify({
            tagName: "v9.9.9",
            body: "Hand-edited, and newer than the tag.\n",
            isDraft: false,
            isPrerelease: false,
          })
        : "",
  });
  const out = await ensureGitHubRelease({
    version: "9.9.9",
    notes: "The bytes at the tagged commit.",
    execFile,
  });
  expect(out.ok).toBe(false);
  expect(out.detail).toContain("notes differ");
  expect(out.detail).toContain("at the commit the tag peels to");
});

test("a tilde fence opens and closes like a backtick fence", () => {
  // Both predicates carry `~~~` (a reviewer noted no test exercised it), and
  // a tilde fence is a real shape in Markdown, not a decoration.
  const changelog =
    "## 9.9.9\n\n~~~md\n## not a heading\n~~~\n\nafter\n\n## 9.9.8\n\nolder\n";
  const section = changelogSection(changelog, "9.9.9");
  expect(section?.body).toContain("## not a heading");
  expect(section?.body).toContain("after");
  expect(section?.body).not.toContain("older");
});

test("a fence closes only on its OWN character, at AT LEAST its length (vectors a, d, e)", () => {
  // All three were measured gaps in the first cut of this rule: a `~~~` inside
  // a backtick fence closed it, and a fence of four or more markers matched
  // neither predicate and could never close. Both sides fixed them together.
  const tildeInsideBackticks =
    "## 9.9.9\n\n```md\nalpha\n~~~\n## still inside the fence\nbeta\n```\n\n## 9.9.8\n\nolder\n";
  expect(changelogSection(tildeInsideBackticks, "9.9.9")?.body).toBe(
    "```md\nalpha\n~~~\n## still inside the fence\nbeta\n```",
  );

  const shorterInsideLonger =
    "## 9.9.9\n\n````\nalpha\n```\n## still inside\n````\n\n## 9.9.8\n\nolder\n";
  expect(changelogSection(shorterInsideLonger, "9.9.9")?.body).toContain(
    "## still inside",
  );

  // Longer DOES close shorter: CommonMark's rule is at-least, not equal.
  const longerClosesShorter =
    "## 9.9.9\n\n```\nalpha\n`````\n\n## 9.9.8\n\nolder\n";
  const closed = changelogSection(longerClosesShorter, "9.9.9");
  expect(closed?.body).toContain("`````");
  expect(closed?.body).not.toContain("older");
});

test("a longer fence is bounded by the next heading, not by EOF (vector b)", () => {
  const changelog = "## 9.9.9\n\n````\nalpha\n````\n\n## 9.9.8\n\nolder\n";
  const section = changelogSection(changelog, "9.9.9");
  expect(section?.body).toBe("````\nalpha\n````");
});

test("a fenced heading cannot START a section either (vector c)", () => {
  const hijack =
    "## Unreleased\n\n```\n## 9.9.9\n```\n\n## 9.9.9\n\nreal body\n\n## 9.9.8\n\nolder\n";
  // Before the fix the fenced line was taken as the section start, and the
  // body then ran to EOF from there.
  expect(changelogSection(hijack, "9.9.9")?.body).toBe("real body");
});

test("when the only matching heading is fenced, there is no section at all (vector c)", () => {
  const onlyFenced =
    "## Unreleased\n\n```\n## 9.9.9\n```\n\n## 9.9.8\n\nolder\n";
  // The honest answer is refusal: this changelog has no real 9.9.9 section, so
  // there are no notes to cut a release from.
  expect(changelogSection(onlyFenced, "9.9.9")).toBeNull();
});

test("a backtick fence's info string may not contain a backtick, so it opens nothing", () => {
  const changelog =
    "## 9.9.9\n\n```a`b\n## not a heading\n```\n\n## 9.9.8\n\nolder\n";
  // CommonMark: "```a`b" is not an opening fence, so the next heading is a
  // heading and the section ends there.
  expect(changelogSection(changelog, "9.9.9")?.body).toBe("```a`b");
});

test("an UNCLOSED fence runs to EOF, carrying the following entries (vector iv)", () => {
  const changelog = "## 9.9.9\n\n```\nunclosed\n\n## 9.9.8\n\nolder\n";
  const section = changelogSection(changelog, "9.9.9");
  expect(section?.body).toContain("unclosed");
  // CommonMark, agreed with lore-cli: the over-long body is the loud failure,
  // where stopping early would ship a short body silently.
  expect(section?.body).toContain("older");
});

test("line endings are normalised before the split, so CRLF gives the same body", () => {
  const lf = "## 9.9.9\n\nbody line\n\n## 9.9.8\n\nolder\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  const fromCrlf = changelogSection(crlf, "9.9.9");
  expect(fromCrlf).toEqual(changelogSection(lf, "9.9.9"));
  expect(fromCrlf?.body).not.toContain("\r");
});

// The two clauses a unit test of the extractor cannot see: WHICH commit the
// promotion path reads, and that the repair tool reads the same one. Read the
// source layout, as qcli398's order test does.
const promoteSource = readFileSync(
  new URL("../scripts/promote-release.mjs", import.meta.url),
  "utf8",
);
const promoteMain = promoteSource.slice(
  promoteSource.indexOf("async function main("),
);
const repairSource = readFileSync(
  new URL("../scripts/github-release.mjs", import.meta.url),
  "utf8",
);

test("promote reads the notes once, at the peeled commit unless --notes-from names a descendant (QCLI-515), before the preflight and every tag move", () => {
  // One read, reused by the cut, so the bytes the refusal is judged on are the
  // bytes that are published.
  expect(promoteMain.match(/releaseNotesFor\(/g)?.length).toBe(1);
  const read = promoteMain.indexOf(
    "releaseNotesFor(version, { commit: notesCommit })",
  );
  const peel = promoteMain.indexOf(
    "const peeled = await resolveTagCommit(version)",
  );
  expect(peel).toBeGreaterThan(-1);
  expect(read).toBeGreaterThan(peel);
  // QCLI-515: the commit read defaults to the peel, so without --notes-from the
  // read is exactly the one this test has always pinned.
  const fallback = promoteMain.indexOf("let notesCommit = peeled.commit;");
  expect(fallback).toBeGreaterThan(peel);
  expect(fallback).toBeLessThan(read);
  expect(read).toBeLessThan(promoteMain.indexOf("dryRun: true"));
  for (const later of ['flag: "wx"', "await promote({"])
    expect(read).toBeLessThan(promoteMain.indexOf(later));
});

test("the repair tool resolves the peel too, so it cuts the bytes the next preflight compares", () => {
  const main = repairSource.slice(repairSource.indexOf("async function main("));
  const peel = main.indexOf("await resolveTagCommit(version)");
  const read = main.indexOf(
    "releaseNotesFor(version, { commit: peeled.commit })",
  );
  expect(peel).toBeGreaterThan(-1);
  expect(read).toBeGreaterThan(peel);
});
