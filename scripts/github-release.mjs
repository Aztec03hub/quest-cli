// Cuts the GitHub Release for a version tag, its body taken from that
// version's CHANGELOG.md section AT THE COMMIT THE TAG PEELS TO, read
// through the GitHub API rather than from the checkout this runs in
// (QCLI-398, opum-agent OPAG-646; QCLI-407, paired with lore-cli LCLI-639).
//
// GitHub Releases stopped at v0.6.0 because nothing in the release flow ever
// created one: every later release moved npm `latest` and left GitHub saying
// v0.6.0. promote-release.mjs now calls ensureGitHubRelease once `latest` is
// verified moved, so the step cannot be skipped again. This file is also the
// backfill and the repair tool:
//
//   node scripts/github-release.mjs --version 0.11.0            # dry run
//   node scripts/github-release.mjs --version 0.11.0 --create   # cut it
//   node scripts/github-release.mjs --version 0.9.0 --create --not-latest
//
// It never creates a tag (`--verify-tag`), never edits an existing release's
// body, and pins the host (`-R github.com/...`) so GH_HOST cannot redirect it.
// An existing release counts as done only when it is published and carries
// these notes (QCLI-401, paired with lore-cli LCLI-622). A draft, a
// prerelease, or different notes is refused and left for a person to repair --
// except for the recorded legacy releases, whose stored bodies are records
// written after their tags and are reported with their reasons instead.

import { execFile as execFileCallback } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveTagCommit } from "./qualification/pair-receipt.mjs";

const execFile = promisify(execFileCallback);

export const RELEASE_REPOSITORY = "github.com/opum-ai/quest-cli";

/** The same repository as it is addressed under `gh api repos/<this>`. */
const REPOSITORY_PATH = RELEASE_REPOSITORY.replace(/^github\.com\//, "");

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * An opening fence, per CommonMark: up to three spaces of indent, then at
 * least three backticks or tildes, then the rest of the line. The character
 * and the run length are remembered, because a fence closes only on its own
 * character at at least that length (QCLI-407 / LCLI-639, agreed with
 * lore-cli -- both sides implement exactly this, so a change here is a
 * divergence to agree before landing).
 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Which lines of a document sit inside a fenced block, computed over the
 * WHOLE document before anything else is decided, so a fenced heading can
 * neither start nor end a section.
 *
 * Deliberate limit, agreed with lore-cli so neither side rediscovers it as an
 * omission: this implements the fence state and nothing else of CommonMark --
 * no indented-code-block interaction, no lazy continuation, no container or
 * list scoping. An unclosed fence runs to EOF.
 */
function fencedLines(lines) {
  const fenced = new Array(lines.length).fill(false);
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    if (open === null) {
      const opening = FENCE_OPEN.exec(lines[i]);
      // A backtick fence's info string may not itself contain a backtick, so
      // "```a`b" opens nothing; tilde fences take any info string.
      if (!opening) continue;
      if (opening[1][0] === "`" && opening[2].includes("`")) continue;
      open = { char: opening[1][0], length: opening[1].length };
      fenced[i] = true;
      continue;
    }
    fenced[i] = true;
    const closing = new RegExp(`^ {0,3}${open.char}{${open.length},}[ \\t]*$`);
    if (closing.test(lines[i])) open = null;
  }
  return fenced;
}

/**
 * The body of `## <version>` in CHANGELOG.md, up to the next `## ` heading
 * that is not inside a fence, trimmed. The heading may carry a suffix
 * (`## 0.11.0 - 2026-09-27`), but `0.1.0` never matches `0.1.01`. Returns
 * null when there is no such section, when it is empty, or when the only
 * matching heading is inside a fence: a release with no notes is refused,
 * not cut.
 *
 * Line endings are normalised to LF before anything is split, so the same
 * bytes give the same body whatever the file's line endings are, and the
 * notes this returns are the notes GitHub is asked to store.
 *
 * Fences matter here because a `## ` line inside one is content, not a
 * heading: reading it as a heading silently truncated a release body, and
 * with the fence state computed over the whole document the same is now true
 * of the section's START, so a fenced `## <version>` cannot hijack it.
 * An UNCLOSED fence runs to EOF, which is CommonMark and also the loud
 * failure -- a body that carries the following entries is visible, where
 * stopping early ships a short body silently.
 */
export function changelogSection(changelog, version) {
  const heading = new RegExp(`^## ${escapeRegExp(version)}(?:\\s.*)?$`);
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const fenced = fencedLines(lines);
  const start = lines.findIndex((line, i) => !fenced[i] && heading.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!fenced[i] && lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  const body = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  return body === "" ? null : { heading: lines[start], body };
}

/** "Quest CLI 0.11.0", matching lore-cli's "Lore CLI <v>". */
export function releaseTitle(version, heading = "") {
  return /never published/i.test(heading)
    ? `Quest CLI ${version} (tagged, never published)`
    : `Quest CLI ${version}`;
}

/** Notes compared as GitHub may store them: CRLF line ends, outer whitespace. */
const normaliseNotes = (text) => text.replace(/\r\n/g, "\n").trim();

/**
 * Releases whose stored body is a record rather than the tag's section, kept
 * deliberately (QCLI-410, ruled 2026-09-29).
 *
 * QCLI-407 re-sourced `notes` from the checkout to the tagged commit, which
 * moved what the existing-release comparison compares: 0.6.1, 0.6.2, 0.7.0 and
 * 0.8.0 were cut or backfilled on 2026-09-27 from a working tree that differed
 * from their tag, so every one of them now differs from the section at the
 * commit its tag peels to. 0.6.0 was added afterwards (QCLI-410) and differs
 * under the old comparison too: its body is an out-of-band provenance record
 * that exists nowhere in CHANGELOG.md, and the tag's section is what still
 * matches the file.
 *
 * Every difference is text authored AFTER its tag -- additions for 0.6.2 and
 * 0.7.0, and for 0.6.0, 0.6.1 and 0.8.0 a record that rewrites or replaces
 * part of the section, 0.6.1's keeping none of it -- and rewriting a body to
 * match an earlier section would delete that text, so the bodies are kept and
 * this table records why.
 *
 * What the table does NOT do is re-check the stored bytes against the reason
 * (measured, and accepted for a closed set of frozen historical releases;
 * pinning the bodies would close it if that changes). A body edited to
 * anything other than the tagged bytes is still reported with its reason. A
 * body reconciled exactly to the tagged section deliberately stops being a
 * recorded exception and is treated as matching -- marked latest when asked
 * -- because the recorded branch sits in the mismatch path; that is the one
 * edit this table cannot report.
 *
 * A CLOSED table, deliberately: only a version named here is reported as a
 * recorded exception, every other release keeps the notes-differ refusal, and
 * adding a version is a deliberate, reviewable edit to this map. It REPORTS
 * rather than exempts silently -- the run names the version's reason, so an
 * operator sees a recorded decision instead of a clean bill of health.
 */
const RECORDED_LEGACY_NOTES = new Map([
  [
    "0.6.0",
    "a provenance record written after the tag, not the changelog entry: the body says the tag does not point at the commit that produced the published artifact (it peels to a9fbc78, the post-recreation initial commit, while npm's gitHead for 0.6.0 is ce551cf4, which does not exist here) and advises citing the npm version over the tag",
  ],
  [
    "0.6.1",
    "tagged at 1fa0fef and never published, because every publish attempt failed a registry E404 before writing anything (a CI-only defect with no content of its own). The stored body replaces the section with the note recording that, and the content it would have carried shipped as 0.6.2; the tag is not re-pointed because quest-web's CI cites this repository's tags",
  ],
  [
    "0.6.2",
    "published after its tag, and the stored body carries what was written since, purely additively: the README-in-tarball entry, the release.yml registry-verification fix (QCLI-247), four more Fixed bullets (QCLI-257, 261, 269, 270, 282), and a Known limitations section recording the missing provenance attestation",
  ],
  [
    "0.7.0",
    'published after its tag, and the stored body differs by exactly one added block: the post-release observation that opum-cli-e2e\'s qualification matrix pinned the literal "Blocked" while a live-reading suite absorbed the same release unmoved',
  ],
  [
    "0.8.0",
    "frozen, tagged and never published (its content shipped as 0.9.0), and the stored body rewrites its opening and adds two blocks: the never-published annotation with the QCLI-345 correction of the claim that nothing in lore changed, and the note on what the removal short-circuit does not cover (the LCLI-522 read-modify-write race)",
  ],
]);

/**
 * The reason a release's stored body is kept even though it differs from the
 * section at the commit its tag peels to; `undefined` for every version not in
 * the table. The table's single reader, so the recorded set can be asserted
 * from one place rather than from a second copy of the keys.
 * @param {string} version
 * @returns {string | undefined}
 */
export function recordedLegacyReason(version) {
  return RECORDED_LEGACY_NOTES.get(version);
}

/**
 * Every version in the recorded table, ascending. The closed-set property is
 * asserted from this rather than from a second, hand-kept copy of the keys,
 * so adding or removing an entry fails a test rather than slipping through.
 * @returns {string[]}
 */
export function recordedLegacyVersions() {
  return [...RECORDED_LEGACY_NOTES.keys()];
}

/**
 * Creates the release for v<version>, or confirms one exists. Never edits an
 * existing release's notes. An existing release must be published (not a
 * draft or prerelease) and carry `notes`, or the result is a failure
 * (QCLI-401) -- unless it is one of the recorded legacy releases, whose stored
 * body differs by a recorded decision and is reported with its reason rather
 * than refused or marked latest (QCLI-410). Except as above, when `latest` is
 * asked for and the release already exists, it is marked latest, because that
 * is the state a finished release must leave behind. Returns {ok, action, detail}; every failure is returned,
 * never thrown, so a caller that has already moved npm `latest` can report it
 * without a stack trace that reads like the promotion failed.
 */
export async function ensureGitHubRelease({
  version,
  notes,
  title = releaseTitle(version),
  latest = true,
  dryRun = false,
  execFile: execFileFn = execFile,
}) {
  const tag = `v${version}`;
  const repo = ["-R", RELEASE_REPOSITORY];
  let exists;
  let state;
  try {
    const { stdout } = await execFileFn("gh", [
      "release",
      "view",
      tag,
      ...repo,
      "--json",
      "tagName,body,isDraft,isPrerelease",
    ]);
    try {
      state = JSON.parse(stdout);
    } catch {
      state = undefined;
    }
    if (
      state === null ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      typeof state.body !== "string"
    )
      return {
        ok: false,
        action: "none",
        detail: `could not read release ${tag}: gh release view did not return its state`,
      };
    exists = true;
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error);
    // gh prints "release not found" for a missing repository too. The
    // repository is a constant here, so that case is an access loss, and the
    // create that follows fails closed on it rather than succeeding.
    if (!/release not found/i.test(detail))
      return {
        ok: false,
        action: "none",
        detail: `could not read release ${tag}: ${detail.trim().split("\n")[0]}`,
      };
    exists = false;
  }

  if (exists) {
    // QCLI-401: refused, never repaired. Publishing a draft or rewriting a
    // release body is a decision for a person, not for a release script.
    if (state.isDraft !== false || state.isPrerelease !== false)
      return {
        ok: false,
        action: "none",
        detail: `release ${tag} exists but is a ${state.isDraft !== false ? "draft" : "prerelease"}; publish or delete it by hand, then re-run`,
      };
    if (normaliseNotes(state.body) !== normaliseNotes(notes)) {
      // A recorded exception is reported, never exempted silently, and never
      // marked latest: the release exists, its body is the record, and moving
      // the Latest badge onto a version from another era is not a repair.
      const recorded = recordedLegacyReason(version);
      if (recorded)
        return {
          ok: true,
          action: "recorded-exception",
          detail: `release ${tag} exists and its stored notes differ from the "## ${version}" section at the commit the tag peels to (or at the --notes-from commit, when the promotion was given one) BY RECORDED EXCEPTION (QCLI-410): ${recorded}. Nothing to repair -- the stored body is the record, this tool never edits it, and it is not marked latest`,
        };
      return {
        ok: false,
        action: "none",
        // QCLI-407 re-sourced `notes` from the checkout to the tagged commit,
        // so the comparison target moved with it: a release cut or backfilled
        // from a working tree that differed from its tag (0.6.1, 0.6.2, 0.7.0
        // and 0.8.0 were, measured) no longer matches, and the bytes that pass
        // are the tag-era ones. The refusal names that object rather than
        // leaving the operator to guess which side to change.
        detail: `release ${tag} exists but its notes differ from the "## ${version}" section at the commit the tag peels to (or at the --notes-from commit, when the promotion was given one); this tool never edits an existing release, so make the release carry those bytes by hand, then re-run`,
      };
    }
    if (!latest)
      return {
        ok: true,
        action: "exists",
        detail: `release ${tag} already exists; left as is`,
      };
    if (dryRun)
      return {
        ok: true,
        action: "would-mark-latest",
        detail: `release ${tag} exists; would mark it latest`,
      };
    try {
      await execFileFn("gh", ["release", "edit", tag, ...repo, "--latest"]);
      return {
        ok: true,
        action: "marked-latest",
        detail: `release ${tag} already existed; marked latest`,
      };
    } catch (error) {
      const detail = String(error?.stderr || error?.message || error)
        .trim()
        .split("\n")[0];
      return {
        ok: false,
        action: "none",
        detail: `release ${tag} exists but could not be marked latest: ${detail}`,
      };
    }
  }

  if (dryRun)
    return {
      ok: true,
      action: "would-create",
      detail: `would create release ${tag} "${title}" (${Buffer.byteLength(notes)} bytes of notes)${latest ? ", marked latest" : ""}`,
    };

  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), "quest-release-notes-"));
    const notesFile = join(dir, "notes.md");
    await writeFile(notesFile, `${notes}\n`);
    await execFileFn("gh", [
      "release",
      "create",
      tag,
      ...repo,
      "--verify-tag",
      "--title",
      title,
      "--notes-file",
      notesFile,
      `--latest=${latest ? "true" : "false"}`,
    ]);
    return {
      ok: true,
      action: "created",
      detail: `created release ${tag} "${title}"`,
    };
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error)
      .trim()
      .split("\n")[0];
    return {
      ok: false,
      action: "none",
      detail: `could not create release ${tag}: ${detail}`,
    };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The commit a release's notes may be read from when it is not the tag's own
 * (`promote-release.mjs --notes-from`, QCLI-515, opum-doc DEC-204 (3)). 0.14.1
 * was tagged without a `## 0.14.1` section and the heading was fixed forward on
 * dev; the tag, the receipt and the rc bytes stay bound to the tag's commit, and
 * only the changelog read moves. Used once, for 0.14.1.
 *
 * Narrow on purpose, and each refusal names what failed:
 * - a full 40-hex commit, never a branch or tag name, which can be re-pointed
 *   where a commit cannot;
 * - a DESCENDANT of `tagCommit` (compare status `ahead`), so the notes cannot
 *   come from a sibling history, and a commit that is part of dev's history, so
 *   it cannot be a sha that exists only in a fork;
 * - whose net diff against `tagCommit` is CHANGELOG.md, modified in place, plus
 *   at most tracker records under .quest/ (DEC-204 (3a)); any other path, or a
 *   CHANGELOG.md that is added, renamed or removed, is refused by name. The
 *   compare list stops at 300 files, so a full list is refused, not trusted.
 * Every failure is `ok: false` with its cause; nothing is thrown or defaulted.
 */
export async function notesCommitFrom(
  sha,
  tagCommit,
  { execFile: execFileFn = execFile } = {},
) {
  if (!/^[0-9a-f]{40}$/.test(String(sha)))
    return {
      ok: false,
      detail: `--notes-from needs a full 40-hex commit sha, got ${JSON.stringify(sha)}; a branch or tag name can move, a commit cannot.`,
    };
  if (sha === tagCommit)
    return {
      ok: false,
      detail: `--notes-from ${sha} is the tag's own commit; omit the flag to read the notes there.`,
    };
  let compare;
  try {
    const { stdout } = await execFileFn("gh", [
      "api",
      "--hostname",
      "github.com",
      `repos/${REPOSITORY_PATH}/compare/${tagCommit}...${sha}`,
    ]);
    compare = JSON.parse(stdout);
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error)
      .trim()
      .split("\n")[0];
    return {
      ok: false,
      detail: `${sha} could not be compared with the tag commit ${tagCommit} (${detail || "the read failed"}).`,
    };
  }
  if (compare?.status !== "ahead")
    return {
      ok: false,
      detail: `${sha} does not descend from the tag commit ${tagCommit} (compare status ${JSON.stringify(compare?.status ?? null)}); the notes may only be read from a descendant.`,
    };
  // quest-cli is public, so a sha can exist only in a fork's object network and
  // still resolve through this repository's compare and contents endpoints. The
  // notes must come from a commit that is part of dev's history: dev...sha is
  // `behind` or `identical` exactly when sha is an ancestor of (or is) dev.
  let onDev;
  try {
    const { stdout } = await execFileFn("gh", [
      "api",
      "--hostname",
      "github.com",
      `repos/${REPOSITORY_PATH}/compare/dev...${sha}`,
    ]);
    onDev = JSON.parse(stdout);
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error)
      .trim()
      .split("\n")[0];
    return {
      ok: false,
      detail: `${sha} could not be compared with dev (${detail || "the read failed"}), so it is not shown to be part of dev's history.`,
    };
  }
  if (onDev?.status !== "behind" && onDev?.status !== "identical")
    return {
      ok: false,
      detail: `${sha} is not part of dev's history (compare dev...sha status ${JSON.stringify(onDev?.status ?? null)}); the notes may only be read from a commit that landed on dev.`,
    };
  const files = Array.isArray(compare.files) ? compare.files : null;
  if (!files || files.length === 0 || files.length >= 300)
    return {
      ok: false,
      detail: `${sha} against ${tagCommit}: the changed-file list is ${files ? (files.length === 0 ? "empty" : "at the API's 300-file limit, so it may be truncated") : "missing"}; refusing rather than trusting it.`,
    };
  // DEC-204 (3a): the NET range may touch CHANGELOG.md and the tracker under
  // .quest/ and nothing else. Tracker records are written on dev between the
  // tag and any changelog fix (0.14.1: #630 and #631 before #632), so a
  // CHANGELOG-only range would refuse the one commit this flag exists for. The
  // notes are still read from CHANGELOG.md alone, and CHANGELOG.md itself must
  // be a plain modification, not an add, rename or removal.
  const underTracker = (path) =>
    typeof path === "string" && path.startsWith(".quest/");
  const changelog = files.filter((file) => file?.filename === "CHANGELOG.md");
  const others = files.filter(
    (file) =>
      file?.filename !== "CHANGELOG.md" &&
      !(
        underTracker(file?.filename) &&
        (file?.previous_filename === undefined ||
          underTracker(file.previous_filename))
      ),
  );
  if (others.length)
    return {
      ok: false,
      detail: `${sha} touches more than CHANGELOG.md and .quest/ against the tag commit ${tagCommit}: ${others.map((file) => file?.filename ?? "(unnamed)").join(", ")}; --notes-from accepts a descendant whose net range is CHANGELOG.md plus tracker records under .quest/.`,
    };
  if (
    changelog.length !== 1 ||
    changelog[0].status !== "modified" ||
    changelog[0].previous_filename !== undefined
  )
    return {
      ok: false,
      detail: `${sha} against the tag commit ${tagCommit}: CHANGELOG.md must be modified in the net range (status ${JSON.stringify(changelog[0]?.status ?? "absent")}); the notes are read from it.`,
    };
  return { ok: true, commit: sha, tagCommit };
}

/**
 * CHANGELOG.md's bytes at `commit`, through the GitHub API (QCLI-407, paired
 * with lore-cli LCLI-639). The tag is created remotely by release.yml and
 * this flow holds no local-git invocation, so the commit addressed here is
 * the one resolveTagCommit already resolved -- never a working tree, and
 * never a tag name, which can be re-pointed where a commit cannot.
 *
 * Every failure comes back as `text: null` with its cause, never thrown and
 * never defaulted -- the same failure shape check-breaking-bump.mjs reads a
 * peer's changelog with, though that one reports `ref`/`sha` where this
 * reports `commit`.
 */
export async function changelogAt(
  commit,
  { execFile: execFileFn = execFile } = {},
) {
  try {
    const { stdout } = await execFileFn(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        "-H",
        "Accept: application/vnd.github.raw",
        `repos/${REPOSITORY_PATH}/contents/CHANGELOG.md?ref=${commit}`,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return { text: stdout, commit, error: null };
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error)
      .trim()
      .split("\n")[0];
    return { text: null, commit, error: detail || "the read failed" };
  }
}

/**
 * The notes and title for a version, read at the commit v<version> peels to
 * (QCLI-407). A working-tree read used to stand here, which made an
 * uncommitted edit -- or work landed after the tag -- the body of a new
 * release. The tag is immutable once cut, so a missing section is not
 * repairable by editing and re-running, and the refusal says so rather than
 * leaving that remedy implied.
 */
export async function releaseNotesFor(
  version,
  { commit, execFile: execFileFn = execFile } = {},
) {
  const read = await changelogAt(commit, { execFile: execFileFn });
  if (read.error)
    return {
      ok: false,
      detail: `CHANGELOG.md at ${commit} could not be read (${read.error}).`,
    };
  const section = changelogSection(read.text, version);
  if (!section)
    return {
      ok: false,
      // The remedies are ordered deliberately: by this point the version is
      // normally already on npm `latest`, where a hand cut is safe and moving
      // the tag is not -- see the release runbook's tag-stability note.
      detail: `CHANGELOG.md at ${commit} has no non-empty "## ${version}" section for its GitHub Release. v${version} is already tagged, so adding a section and re-running cannot reach it: cut the release by hand, or re-tag.`,
    };
  return {
    ok: true,
    notes: section.body,
    title: releaseTitle(version, section.heading),
  };
}

async function main(argv) {
  const index = argv.indexOf("--version");
  const version = index === -1 ? undefined : argv[index + 1];
  if (!version || version.startsWith("--"))
    throw new Error(
      "usage: github-release.mjs --version <x.y.z> [--create] [--not-latest]",
    );
  // QCLI-407: the notes are read at the tagged commit, so this tool resolves
  // the peel too -- it must cut the same bytes the next promote's preflight
  // will compare against, and neither of them reads a working tree.
  const peeled = await resolveTagCommit(version);
  if (!peeled.commit) {
    console.error(
      `Refusing to cut v${version}: ${peeled.error}. The notes are read at the tagged commit, so the tag has to resolve before there is anything to read.`,
    );
    process.exit(1);
  }
  const release = await releaseNotesFor(version, { commit: peeled.commit });
  if (!release.ok) {
    console.error(`Refusing to cut a release without notes: ${release.detail}`);
    process.exit(1);
  }
  const outcome = await ensureGitHubRelease({
    version,
    notes: release.notes,
    title: release.title,
    latest: !argv.includes("--not-latest"),
    dryRun: !argv.includes("--create"),
  });
  (outcome.ok ? console.log : console.error)(outcome.detail);
  if (!outcome.ok) process.exit(1);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
