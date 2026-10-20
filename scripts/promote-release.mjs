// Moves `latest` to a staged release, as a separate, recorded, reversible
// step (QCLI-385, constitution Article 3 clause 5).
//
// scripts/publish-release.mjs STAGES a release under the release-candidate
// dist-tag and leaves `latest` where it was. opum-cli-e2e then qualifies the
// staged lore/quest pair from clean registry installs, and only after that
// does `latest` move -- Quest first, then Lore. This script is that move.
//
// Registry publication is irreversible, so a failed promotion is never
// repaired by unpublishing. What rolls back is the dist-tags: every prior
// `latest` is written to a record file BEFORE any tag moves, a failure part
// way through restores the tags this run already moved, and `--rollback
// <record>` restores all of them later (for instance when the Lore side's
// promotion fails after Quest's succeeded). The record is written once and
// reused on a rerun, never re-read from the registry: after a partial move
// the registry's current `latest` is the NEW version, and recording that as
// the prior value would make the rollback a no-op.
//
// Promotion also refuses without opum-cli-e2e's pair receipt for this
// version (QCLI-388, scripts/qualification/pair-receipt.mjs): the verdict on
// the staged pair is read from the record, never taken from a message.
// --rollback is deliberately not gated on it.
//
// QCLI-399 (constitution Article 3 clause 5 as amended by ODOC-302, read at
// opum-doc f322cff): the six platform packages still reach `latest` by a
// dist-tag move, but the root launcher does not. It stages as X-rc.N and
// reaches `latest` by a FRESH PUBLISH of X, because only a publish onto
// `latest` makes npm derive the packument readme. The X published is the
// never-staged launcher in the qualified candidate bundle's final/, fetched
// here from --qualification-run and gated on the pass-1 receipt again. The
// order, agreed with lore-cli (LCLI-621) and opum-cli-e2e (TASK-126):
//   1. the pair receipt, the launcher entry read at launcherVersion
//   2. the rc npm serves is the bundle's rc, and X is that rc with only its
//      version substituted -- checked against the registry's bytes
//   3. the platforms move `latest` by dist-tag
//   4. the same check again, immediately before the publish
//   5. `npm publish final/<X>.tgz --tag latest`, the one publish in this
//      pipeline that does not stage (test/qcli385 holds it to exactly one)
//   6. `latest` reads X on all seven, and npm serves X as the bundle's bytes
// A failure restores every `latest` this run moved by dist-tag, the
// launcher's included. Nothing is unpublished; retry at the same version.
//
// Once `latest` is verified moved, the same run cuts the GitHub Release for
// v<version> from CHANGELOG.md AT THE COMMIT THE TAG PEELS TO (QCLI-398,
// scripts/github-release.mjs; QCLI-407, paired with lore-cli LCLI-639): GitHub
// had stopped at v0.6.0 because no step did. A missing section at that commit
// refuses before any tag moves, dry runs included. --rollback leaves
// releases alone.
//
// Usage:
//   node scripts/promote-release.mjs --record <path> --qualification-run <id>             # dry run
//   node scripts/promote-release.mjs --record <path> --qualification-run <id> --promote   # move latest
//   ... --notes-from <40-hex sha>   # QCLI-515: read the release notes from a descendant of the
//                                   # tag's commit whose range is CHANGELOG.md plus .quest/ only (DEC-204 (3a)); used once, for 0.14.1
//   node scripts/promote-release.mjs --rollback <path>                                    # restore it
//
// Auth is the publisher's: a stored granular token (Keychain, then
// NPM_TOKEN) in a temp npmrc, else the interactive login with --otp.

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ensureGitHubRelease,
  notesCommitFrom,
  releaseNotesFor,
} from "./github-release.mjs";
import {
  describeKeychainState,
  isPublished,
  isValidGranularTokenShape,
  qualifyBundle,
  registryHoldsTarball,
  resolveToken,
  STAGE_TAG,
  tokenShape,
} from "./publish-release.mjs";
import { describeOverride, LAUNCHER } from "./qualification/e2e-receipt.mjs";
import { checkLauncherEquivalence } from "./qualification/launcher-equivalence.mjs";
import { REQUIRED_PLATFORMS } from "./qualification/native-execution-receipt.mjs";
import {
  requirePairQualification,
  resolveTagCommit,
} from "./qualification/pair-receipt.mjs";
import { REGISTRY_PINS } from "./qualification/registry-visibility.mjs";

const execFile = promisify(execFileCallback);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

export const PROMOTE_TAG = "latest";
export const RECORD_KIND = "quest.promotion-record.v1";

/** Platforms first, wrapper last: the same order the publisher writes in. */
export const RELEASE_PACKAGES = Object.freeze([
  ...REQUIRED_PLATFORMS.map((platform) => `@opum-ai/quest-${platform}`),
  LAUNCHER,
]);

/**
 * The one `npm publish` in this pipeline that does not stage (QCLI-399): the
 * bundle's final X launcher, straight onto `latest`. Every other publish goes
 * through publish-release.mjs's publishArgs and stages under release-candidate.
 */
export function launcherPublishArgs(tarball, { otp } = {}) {
  return [
    "publish",
    tarball,
    "--access",
    "public",
    "--tag",
    PROMOTE_TAG,
    ...REGISTRY_PINS,
    ...(otp ? ["--otp", otp] : []),
  ];
}

/**
 * An anonymous read of one package's dist-tags. Throws on anything but a
 * 200 with an object body: an unreadable tag set is not an empty one.
 */
export async function readDistTags(name, { fetchFn = fetch } = {}) {
  const url = `https://registry.npmjs.org/-/package/${name.replace("/", "%2f")}/dist-tags`;
  const response = await fetchFn(url, { cache: "no-store" });
  if (!response.ok)
    throw new Error(`${url} answered ${response.status}, not 200`);
  const tags = await response.json();
  if (!tags || typeof tags !== "object" || Array.isArray(tags))
    throw new Error(`${url} did not return a dist-tag object`);
  return tags;
}

/**
 * Reads every package's tags and builds the record, or says why not. Refuses
 * unless the version is staged under release-candidate on ALL of them: moving
 * `latest` on a subset would pair a qualified wrapper with a platform package
 * nobody staged. A fresh run also refuses a record validateRecord would
 * refuse; a RESUMED run refuses when any package's CURRENT `latest` LEADS
 * WITH a release strictly newer than `version` (QCLI-405, paired with
 * lore-cli LCLI-638): the reused record says what the prior values were, and
 * a registry that moved ahead since would make the resume move `latest`
 * backwards.
 */
export async function planPromotion({
  version,
  // QCLI-399: the launcher is staged at its rc version, not at X.
  launcherVersion,
  packages = RELEASE_PACKAGES,
  readTags = readDistTags,
  now = () => new Date(),
  // A rerun that reuses the first run's record: some packages may already
  // read the new version, which is exactly what the record is for.
  resuming = false,
}) {
  const problems = [];
  const entries = [];
  for (const name of packages) {
    let tags;
    try {
      tags = await readTags(name);
    } catch (error) {
      problems.push(`${name}: dist-tags unreadable (${error.message})`);
      continue;
    }
    const staged = name === LAUNCHER ? launcherVersion : version;
    if (!staged || tags[STAGE_TAG] !== staged)
      problems.push(
        `${name}: ${STAGE_TAG} is ${JSON.stringify(tags[STAGE_TAG] ?? null)}, not ${staged ?? `${version}-rc.<N>`}; stage it with scripts/publish-release.mjs first`,
      );
    const current = tags[PROMOTE_TAG];
    const currentMain = leadingReleaseVersion(current);
    if (typeof current !== "string")
      problems.push(
        `${name}: has no ${PROMOTE_TAG} to record as the prior value`,
      );
    else if (current === version && !resuming)
      // Only a lost record reaches here: a fresh record would name the new
      // version as the prior one, and a rollback from it would restore nothing.
      problems.push(
        `${name}: ${PROMOTE_TAG} already reads ${version}; a new record would store that as the prior value -- pass the record written by the first run`,
      );
    // QCLI-405 (paired with lore-cli LCLI-638): the QCLI-402 gate below is
    // fresh-only, because a fresh record is what it validates. A RESUME keeps
    // the record the first run wrote, so nothing there compares the registry
    // NOW with `version` -- and on a registry that moved ahead between the two
    // runs, the resume would move `latest` BACKWARDS, the move the QCLI-402
    // refusal exists to prevent. Equal-to-`version` is the partial state a
    // resume exists for and stays accepted; only strictly newer refuses.
    // `current` is the live value, not the record's, so the record's
    // `priorLatest` is deliberately not used here. The comparison is against
    // the release the live value LEADS WITH (leadingReleaseVersion) so that a
    // prerelease is measured by semver precedence rather than skipped:
    // 5.7.0-rc.1 is newer than 5.6.7 and refuses; 5.6.7-rc.1 and 5.6.7+build.7
    // are not newer than 5.6.7 and still resume. A live value that leads with
    // no release at all (null) is unorderable and not this rule's question.
    else if (
      resuming &&
      currentMain !== null &&
      typeof version === "string" &&
      STRICT_SEMVER.test(version) &&
      compareReleaseVersions(currentMain, version) > 0
    )
      problems.push(
        `${name}: ${version} is older than the current ${PROMOTE_TAG} ${current}, so resuming would move ${PROMOTE_TAG} backwards. ${PROMOTE_TAG} has moved on since the record was written, so this record is stale: re-run against the newer release's checkout. Moving ${PROMOTE_TAG} back is a deliberate, manual decision -- --rollback refuses here, because ${current} is neither this record's release nor its recorded prior`,
      );
    entries.push({ name, priorLatest: current ?? null });
  }
  if (problems.length) return { ok: false, problems };
  const record = {
    schemaVersion: 1,
    kind: RECORD_KIND,
    version,
    recordedAt: now().toISOString(),
    packages: entries,
  };
  // QCLI-402 (twin of lore-cli LCLI-631; opum-doc ADR
  // refuse-a-lore-quest-promotion-that-would-move-npm-latest-backwards and its
  // Amendment 1): a fresh record must be one resume and rollback would accept,
  // or `latest` could move onto a record that can be neither resumed nor
  // rolled back. validateRecord is the one gate: it refuses a version that is
  // not plain X.Y.Z and a prior newer than the version. The headlines below
  // only explain its refusal; they never refuse on their own. A RESUMED run
  // keeps the record the first run wrote, so this block never runs: the resume
  // refusal in the loop above closes that hole (QCLI-405, paired with
  // lore-cli LCLI-638) by comparing the release every package's CURRENT
  // `latest` leads with against `version` and refusing a strictly newer one.
  if (!resuming) {
    const valid = validateRecord(record, { version, packages });
    if (!valid.ok) {
      const plain = typeof version === "string" && STRICT_SEMVER.test(version);
      const headlines = plain
        ? [
            ...entries
              .filter(
                (entry) =>
                  STRICT_SEMVER.test(entry.priorLatest) &&
                  compareReleaseVersions(entry.priorLatest, version) > 0,
              )
              .map(
                (entry) =>
                  `${entry.name}: ${version} is older than the current ${PROMOTE_TAG} ${entry.priorLatest}, so promoting it would move ${PROMOTE_TAG} backwards. Backports are not a promote use case: an older version belongs on a non-${PROMOTE_TAG} dist-tag through a separate path that is not built`,
              ),
            // QCLI-405, mirrored from lore-cli LCLI-638: on a fresh run
            // nothing has been RECORDED yet, so validateRecord's own "recorded
            // prior latest ..." wording names an artifact that does not exist
            // and carries no remedy. The refusal is right -- a record's prior
            // is what --rollback restores from, so it must be a release -- so
            // explain it in the registry's own terms instead. The verdict is
            // unchanged; only the message is.
            ...entries
              .filter(
                (entry) =>
                  typeof entry.priorLatest === "string" &&
                  !STRICT_SEMVER.test(entry.priorLatest),
              )
              .map(
                (entry) =>
                  `${entry.name}: its current ${PROMOTE_TAG} is ${JSON.stringify(entry.priorLatest)}, not a plain X.Y.Z release. A promotion records the current ${PROMOTE_TAG} as the value --rollback would restore, so ${PROMOTE_TAG} must read a release: move ${entry.name}'s ${PROMOTE_TAG} onto the release it should return to, then re-run`,
              ),
          ]
        : [
            `${version} is not a plain X.Y.Z release, and ${PROMOTE_TAG} only ever takes a release. A prerelease, like a backport, belongs on a non-${PROMOTE_TAG} dist-tag through a separate path that is not built`,
          ];
      return { ok: false, problems: [...headlines, ...valid.problems] };
    }
  }
  return { ok: true, record };
}

/** Rejects a record that is not one this script wrote for this release. */
export function validateRecord(
  record,
  { version, packages = RELEASE_PACKAGES } = {},
) {
  const problems = [];
  if (record?.kind !== RECORD_KIND)
    problems.push(
      `record kind is ${JSON.stringify(record?.kind)}, not ${RECORD_KIND}`,
    );
  if (version !== undefined && record?.version !== version)
    problems.push(
      `record is for ${JSON.stringify(record?.version)}, the release is ${version}`,
    );
  const names = (record?.packages ?? []).map((entry) => entry?.name);
  if (JSON.stringify(names) !== JSON.stringify(packages))
    problems.push(
      `record names ${JSON.stringify(names)}, expected ${JSON.stringify(packages)}`,
    );
  // QCLI-391 (paired with lore-cli LCLI-617): the less-than rule below
  // compares against record.version, and --rollback validates without
  // {version}, so its shape is checked here rather than assumed. The typeof
  // comes first because RegExp.test coerces: ["9.9.9"] would pass and then
  // throw in compareReleaseVersions (lore-cli's check, adopted verbatim).
  const comparable =
    typeof record?.version === "string" && STRICT_SEMVER.test(record.version);
  if (!comparable)
    problems.push(
      `record's version is ${JSON.stringify(record?.version)}, not a plain X.Y.Z release`,
    );
  // QCLI-390 (S1, from lore-cli's review of its mirror): a rollback sets
  // `latest` to exactly these values with no receipt, so each must be a
  // real version that is not the one being rolled back -- never a tag name
  // or an arbitrary number written into the file by hand.
  for (const entry of record?.packages ?? [])
    if (typeof entry?.priorLatest !== "string")
      problems.push(`record has no prior ${PROMOTE_TAG} for ${entry?.name}`);
    else if (!STRICT_SEMVER.test(entry.priorLatest))
      problems.push(
        `record's prior ${PROMOTE_TAG} for ${entry.name} is ${JSON.stringify(entry.priorLatest)}, not a version`,
      );
    else if (entry.priorLatest === record.version)
      problems.push(
        `record's prior ${PROMOTE_TAG} for ${entry.name} is the release version itself`,
      );
    // QCLI-391: promotion never moves `latest` backwards, so a genuine
    // record's prior is always older. A newer one ("5.7.0" in a 5.6.7
    // record) passes every check above and checkRollbackState, and would
    // move `latest` onto a version no receipt qualified.
    else if (
      comparable &&
      compareReleaseVersions(entry.priorLatest, record.version) > 0
    )
      problems.push(
        `record's prior ${PROMOTE_TAG} for ${entry.name} is ${entry.priorLatest}, newer than the release ${record.version}; a rollback may only move ${PROMOTE_TAG} backwards`,
      );
  return { ok: problems.length === 0, problems };
}

const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A semver-shaped value: the release it leads with, then `-prerelease` and/or `+build`. */
const SEMVER_SHAPED = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?=$|[-+])/;

/**
 * The MAJOR.MINOR.PATCH a semver-shaped `latest` leads with, or null when the
 * value is not one. QCLI-405, from the reviewer finding on lore-cli LCLI-638:
 * a registry `latest` may hold a prerelease or a build-metadata version, and
 * semver precedence decides those by the release they lead with -- 5.7.0-rc.1
 * is NEWER than 5.6.7, while 5.6.7-rc.1 is older than 5.6.7 and 5.6.7+build.7
 * equals it. Comparing this key against a release therefore answers "is the
 * live value strictly newer" exactly, without a precedence comparator; only a
 * value that leads with no release at all returns null.
 * @param {unknown} value
 */
export function leadingReleaseVersion(value) {
  if (typeof value !== "string") return null;
  return SEMVER_SHAPED.exec(value)?.[0] ?? null;
}

/**
 * Orders two STRICT_SEMVER versions: negative, zero or positive. Each
 * component compares by length, then lexically -- exact numeric order at any
 * size, since the grammar forbids leading zeros; Number() would not be past
 * 2^53. The same comparison as lore-cli's LCLI-617, so the pair's verdicts
 * cannot diverge on a large component.
 */
export function compareReleaseVersions(a, b) {
  const [left, right] = [a.split("."), b.split(".")];
  for (let i = 0; i < 3; i++) {
    if (left[i].length !== right[i].length)
      return left[i].length - right[i].length;
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/**
 * QCLI-390 (S1): a rollback may only UNDO this record's promotion. Every
 * package's current `latest` must be the record's version (moved) or its
 * recorded prior value (never moved, or already restored). Anything else
 * means `latest` has moved on since -- rolling an old record back would
 * silently downgrade it. An unreadable tag set refuses.
 */
export async function checkRollbackState({ record, readTags = readDistTags }) {
  const problems = [];
  for (const { name, priorLatest } of record.packages) {
    let tags;
    try {
      tags = await readTags(name);
    } catch (error) {
      problems.push(`${name}: dist-tags unreadable (${error.message})`);
      continue;
    }
    const current = tags[PROMOTE_TAG];
    if (current !== record.version && current !== priorLatest)
      problems.push(
        `${name}: ${PROMOTE_TAG} is ${JSON.stringify(current ?? null)}, neither ${record.version} nor the recorded prior ${priorLatest}; this record no longer describes the registry`,
      );
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Moves `latest` to the version, in record order. On the first failure it
 * restores every tag it already moved to the recorded prior value and stops,
 * so a half-promoted release is not left behind by this run.
 *
 * QCLI-399: the launcher, last in the record, is not tag-moved but handed to
 * `publishLauncher`, which publishes X onto `latest`. Its failure rolls back
 * exactly like a tag failure, the launcher's own `latest` included.
 */
export async function promote({
  record,
  setTag,
  publishLauncher,
  log = () => {},
}) {
  const moved = [];
  for (const { name } of record.packages) {
    try {
      if (name === LAUNCHER) {
        if (!publishLauncher)
          throw new Error(
            "the launcher reaches latest by a publish of X, and no publisher was given",
          );
        const how = await publishLauncher();
        moved.push(name);
        log(`${name}: ${PROMOTE_TAG} -> ${record.version} (${how})`);
        continue;
      }
      await setTag(name, record.version, PROMOTE_TAG);
      moved.push(name);
      log(`${name}: ${PROMOTE_TAG} -> ${record.version}`);
    } catch (error) {
      log(`${name}: FAILED to move ${PROMOTE_TAG} (${error.message})`);
      const restored = await rollback({
        record: {
          ...record,
          // The failed package too (QCLI-390, S2): a write that errored
          // may still have been applied (a timeout after the registry
          // accepted it), and restoring a tag that never moved is a no-op.
          packages: record.packages.filter(
            (entry) => moved.includes(entry.name) || entry.name === name,
          ),
        },
        setTag,
        log,
      });
      return { ok: false, moved, failed: name, restored };
    }
  }
  return { ok: true, moved };
}

/**
 * Restores every package's `latest` to its recorded prior value. Keeps going
 * past a failure so one stuck package does not strand the rest, and reports
 * each one.
 */
export async function rollback({ record, setTag, log = () => {} }) {
  const failed = [];
  for (const { name, priorLatest } of record.packages) {
    try {
      await setTag(name, priorLatest, PROMOTE_TAG);
      log(`${name}: ${PROMOTE_TAG} restored to ${priorLatest}`);
    } catch (error) {
      failed.push(name);
      log(
        `${name}: FAILED to restore ${PROMOTE_TAG} to ${priorLatest} (${error.message})`,
      );
    }
  }
  return { ok: failed.length === 0, failed };
}

function sha256File(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Downloads exactly what the registry serves for one package version, into
 * `into`, and returns the file's path. `npm pack <spec>` fetches the
 * published tarball and checks it against npm's own integrity.
 */
export async function downloadServedTarball(
  spec,
  into,
  { execFile: execFileFn = execFile } = {},
) {
  const { stdout } = await execFileFn(
    "npm",
    [
      "pack",
      spec,
      "--pack-destination",
      into,
      "--json",
      "--prefer-online",
      ...REGISTRY_PINS,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  if (!entry?.filename) throw new Error(`npm pack ${spec} produced no archive`);
  return join(into, entry.filename);
}

/**
 * Pair-reader step 6 (opum-cli-e2e receipts/README.md blob 241ac885): what the
 * registry serves at launcherVersion right now must be the rc the bundle
 * qualified, and the X about to be published must be that rc with only its
 * version substituted. Re-derived from the registry's bytes each time it is
 * called, never from a recorded verdict. Every failure is returned.
 */
export async function checkServedLauncher({
  version,
  launcherVersion,
  qualifiedRc,
  finalTarball,
  download = (spec, into) => downloadServedTarball(spec, into),
  checkEquivalence = checkLauncherEquivalence,
}) {
  const scratch = await mkdtemp(join(tmpdir(), "quest-served-launcher-"));
  try {
    let served;
    try {
      served = await download(`${LAUNCHER}@${launcherVersion}`, scratch);
    } catch (error) {
      return {
        ok: false,
        problems: [
          `${LAUNCHER}@${launcherVersion} could not be downloaded from the registry (${String(error?.message ?? error).split("\n")[0]})`,
        ],
      };
    }
    const problems = [];
    const [servedDigest, qualifiedDigest] = [
      sha256File(await readFile(served)),
      sha256File(await readFile(qualifiedRc)),
    ];
    if (servedDigest !== qualifiedDigest)
      problems.push(
        `npm serves ${LAUNCHER}@${launcherVersion} as sha256 ${servedDigest}; the qualified bundle's rc is ${qualifiedDigest}`,
      );
    const equivalence = await checkEquivalence({
      rcTarball: served,
      finalTarball,
      rcVersion: launcherVersion,
      version,
    });
    problems.push(...equivalence.problems);
    return { ok: problems.length === 0, problems };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Whether X is already on npm, and if so whether as the qualified final
 * launcher. Throws on a foreign X, on an X whose integrity cannot be read,
 * and on a registry that cannot say whether X exists at all. Run before any
 * tag moves, so a foreign X refuses with nothing written (as lore-cli's
 * LCLI-621 does), and again at the publish, which a concurrent write could
 * still race.
 */
export async function checkFinalLauncherSlot({
  version,
  finalTarball,
  alreadyPublished = (name, v) => isPublished(name, v),
  holds = (name, v, tarball) => registryHoldsTarball(name, v, tarball),
}) {
  if (!(await alreadyPublished(LAUNCHER, version))) return "absent";
  const held = await holds(LAUNCHER, version, finalTarball);
  // An unreadable integrity is lag or a failed read, not a mismatch: the
  // remedy is a rerun at the same version (Article 3 clause 5).
  if (!held.ok && held.actual == null)
    throw new Error(
      `${LAUNCHER}@${version} is on the registry but its dist.integrity could not be read; re-run the promotion at the same version`,
    );
  if (!held.ok)
    throw new Error(
      `${LAUNCHER}@${version} is already on the registry as ${held.actual}, not the qualified ${held.expected}; this needs a new version, not a rerun`,
    );
  return "qualified";
}

/**
 * Publishes the final X launcher onto `latest`, or -- on a rerun after it
 * already landed -- confirms npm holds exactly those bytes and moves the tag.
 * Step 6 runs first, every time, so nothing irreversible happens on a
 * re-derivation that no longer holds.
 */
export async function publishFinalLauncher({
  version,
  finalTarball,
  recheck,
  publish,
  setTag,
  alreadyPublished = (name, v) => isPublished(name, v),
  holds = (name, v, tarball) => registryHoldsTarball(name, v, tarball),
}) {
  const again = await recheck();
  if (!again.ok)
    throw new Error(
      `the launcher substitution check no longer holds against the registry: ${again.problems.join("; ")}`,
    );
  const slot = await checkFinalLauncherSlot({
    version,
    finalTarball,
    alreadyPublished,
    holds,
  });
  if (slot === "qualified") {
    await setTag(LAUNCHER, version, PROMOTE_TAG);
    return "already published as the qualified bytes; tag moved";
  }
  await publish(finalTarball);
  return "published";
}

/**
 * Pair-reader step 7's integrity half: npm serves X as the bundle's final
 * tarball. The tag half is verifyTags. An unreadable integrity is retried,
 * because the registry's read lags a publish; a different one is not.
 */
export async function verifyFinalLauncher({
  version,
  finalTarball,
  holds = (name, v, tarball) => registryHoldsTarball(name, v, tarball),
  attempts = 10,
  delayMs = 15_000,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
}) {
  let held;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    held = await holds(LAUNCHER, version, finalTarball);
    if (held.ok || held.actual != null) break;
    if (attempt < attempts) await sleep(delayMs);
  }
  return held.ok
    ? { ok: true, problems: [] }
    : {
        ok: false,
        problems: [
          held.actual == null
            ? `${LAUNCHER}@${version}: npm returned no dist.integrity`
            : `${LAUNCHER}@${version}: npm serves ${held.actual}, the qualified final launcher is ${held.expected}`,
        ],
      };
}

/**
 * QCLI-400, for QCLI-399 AC3 / OPAG-474 AC3: the byte count of npm's
 * PACKAGE-LEVEL readme for the launcher, the field a dist-tag move never
 * re-derived and only a publish onto `latest` does. Measured 2026-09-28 on
 * 0.11.0: the packument carries `readme` as a present, EMPTY string, and
 * `npm view @opum-ai/quest readme` prints nothing with exit 0 -- so 0 bytes
 * is that failure, and an error is not. Re-read until non-empty or the
 * attempts run out, because the field lags a publish (lore-cli LCLI-460
 * measured ~25 minutes). An unreadable read reports null, never 0.
 */
/** The manual re-measure the WARNING prints: this same pinned read, once. */
export const README_RECHECK = `node --input-type=module -e "const m = await import('./scripts/promote-release.mjs'); console.log(JSON.stringify(await m.readBackReadme({ attempts: 1 })))"`;

export async function readBackReadme({
  execFile: execFileFn = execFile,
  attempts = 10,
  delayMs = 15_000,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
} = {}) {
  let bytes = null;
  let error;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { stdout } = await execFileFn("npm", [
        "view",
        LAUNCHER,
        "readme",
        "--prefer-online",
        ...REGISTRY_PINS,
      ]);
      // npm view prints the field TRIMMED plus one newline, and nothing
      // for an empty one, so this is the trimmed length: exactly 0 for the
      // empty-field case this exists to catch.
      bytes = Buffer.byteLength(String(stdout).replace(/\r?\n$/, ""), "utf8");
      error = undefined;
      if (bytes > 0) return { bytes, attempts: attempt };
    } catch (failure) {
      error = String(failure?.stderr || failure?.message || failure)
        .trim()
        .split("\n")[0];
    }
    if (attempt < attempts) await sleep(delayMs);
  }
  return { bytes, attempts, ...(error ? { error } : {}) };
}

/**
 * Confirms the registry now serves the expected `latest` for every package.
 * A tag write returning success is not the registry serving it, so this
 * re-reads, with a bounded wait for the read to catch up.
 */
export async function verifyTags({
  expected,
  readTags = readDistTags,
  attempts = 10,
  delayMs = 15_000,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
}) {
  let wrong = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    wrong = [];
    for (const [name, value] of Object.entries(expected)) {
      const tags = await readTags(name).catch(() => ({}));
      if (tags[PROMOTE_TAG] !== value)
        wrong.push(
          `${name}: ${PROMOTE_TAG} reads ${JSON.stringify(tags[PROMOTE_TAG] ?? null)}, expected ${value}`,
        );
    }
    if (!wrong.length) return { ok: true, attempts: attempt, wrong };
    if (attempt < attempts) await sleep(delayMs);
  }
  return { ok: false, attempts, wrong };
}

/**
 * What to tell the operator when the GitHub Release did not cut after `latest`
 * moved. The repair tool reads the notes at the commit the tag peels to, so for
 * a promotion that took its notes from --notes-from (QCLI-515) it would refuse
 * for the same reason the tag has no section: name the hand-cut route instead
 * of a command that cannot succeed.
 */
export function repairHint(version, notesFrom) {
  if (notesFrom === undefined)
    return `Repair with: node scripts/github-release.mjs --version ${version} --create`;
  return `Do NOT use github-release.mjs --create: it reads the notes at the tag's commit, which has no "## ${version}" section (this promotion read them from ${notesFrom} by --notes-from). Cut the release by hand from the "## ${version}" section at ${notesFrom}: gh release create v${version} -R github.com/opum-ai/quest-cli --verify-tag --title "Quest CLI ${version}" --notes-file <the section body, without its ## heading> --latest`;
}

async function main(argv) {
  const flag = (name) => {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${name} requires a value`);
    return value;
  };
  const rollbackPath = flag("--rollback");
  const recordPath = flag("--record");
  const otp = flag("--otp");
  const qualificationRun = flag("--qualification-run");
  const notesFrom = flag("--notes-from");
  if (notesFrom !== undefined && rollbackPath !== undefined)
    throw new Error("--notes-from applies to a promotion, not to --rollback");
  const act = argv.includes("--promote") || rollbackPath !== undefined;
  if (!rollbackPath && !recordPath)
    throw new Error(
      "--record <path> is required: it is where every prior latest is written before any tag moves, and what --rollback reads",
    );

  const version = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ).version;

  let record;
  let release;
  let qualified;
  let bundleDir;
  let launcherVersion;
  if (rollbackPath) {
    record = JSON.parse(await readFile(rollbackPath, "utf8"));
    const valid = validateRecord(record);
    const state = valid.ok
      ? await checkRollbackState({ record })
      : { ok: true, problems: [] };
    if (!valid.ok || !state.ok) {
      console.error(`Refusing to roll back from ${rollbackPath}:`);
      for (const problem of [...valid.problems, ...state.problems])
        console.error(`  - ${problem}`);
      process.exit(1);
    }
  } else {
    // QCLI-399: the X launcher that reaches latest is the qualified bundle's
    // final/ tarball, so the bundle is fetched from the run and gated on the
    // pass-1 receipt again -- against the commit the v<version> tag peels to.
    if (!qualificationRun)
      throw new Error(
        "--qualification-run <id> is required: the prepublication-qualification run whose quest-candidate-bundle was staged, and whose final/ launcher is what publishes to latest",
      );
    const peeled = await resolveTagCommit(version);
    if (!peeled.commit) {
      console.error(`Refusing to promote ${version}: ${peeled.error}`);
      process.exit(1);
    }
    bundleDir = await mkdtemp(join(tmpdir(), "quest-promote-bundle-"));
    // On every exit, the refusals' process.exit included, which skips finally.
    process.once("exit", () =>
      rmSync(bundleDir, { recursive: true, force: true }),
    );
    qualified = await qualifyBundle({
      runId: qualificationRun,
      commit: peeled.commit,
      version,
      into: bundleDir,
    });
    if (!qualified.ok) {
      console.error(
        `Refusing to promote ${version}: the bundle from run ${qualificationRun} is not the qualified release of ${peeled.commit.slice(0, 7)}.`,
      );
      for (const problem of qualified.problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    launcherVersion = qualified.launcher.stagedVersion;
    console.log(
      `Bundle from run ${qualificationRun} is the qualified ${version} at ${peeled.commit.slice(0, 7)} (${qualified.source}); launcher staged as ${launcherVersion}, ${qualified.launcher.final.filename} sha256 ${qualified.launcher.final.sha256}.`,
    );

    // QCLI-388, promote only: opum-cli-e2e's verdict on the STAGED pair,
    // installed from the registry, read here rather than relayed. Dry runs
    // too, so a dry run answers "would this promote". --rollback never
    // reaches this branch: restoring prior tags must always be possible.
    const pair = await requirePairQualification({
      version,
      packages: RELEASE_PACKAGES,
    });
    if (pair.ok && pair.launcherVersion !== launcherVersion)
      pair.problems.push(
        `the pair receipt qualified launcher ${pair.launcherVersion}, the bundle staged ${launcherVersion}`,
      );
    if (!pair.ok || pair.problems.length) {
      console.error(
        `Refusing to promote ${version}: no opum-cli-e2e pair receipt qualifies the staged pair as npm serves it now.`,
      );
      for (const problem of pair.problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    if (pair.override)
      console.log(describeOverride(pair.override, pair.source));
    console.log(
      `Pair receipt ${pair.source} qualifies quest ${version} with lore ${version}, and all ${RELEASE_PACKAGES.length} staged tarballs npm serves match it (launcher at ${launcherVersion}).`,
    );

    const existing = await readFile(recordPath, "utf8").catch(() => null);
    if (existing) {
      record = JSON.parse(existing);
      const valid = validateRecord(record, { version });
      if (!valid.ok) {
        console.error(`Refusing to reuse ${recordPath}:`);
        for (const problem of valid.problems) console.error(`  - ${problem}`);
        process.exit(1);
      }
      console.log(
        `Reusing the record at ${recordPath} (written ${record.recordedAt}); prior values are NOT re-read.`,
      );
    }
    // The staging precondition is checked on every run, a reused record
    // included: it is a fact about the registry now, not about the record.
    const plan = await planPromotion({
      version,
      launcherVersion,
      resuming: Boolean(existing),
    });
    if (!plan.ok) {
      console.error(`Refusing to promote ${version}:`);
      for (const problem of plan.problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    record ??= plan.record;
    console.log(
      `${version} is staged under ${STAGE_TAG} on all ${record.packages.length} packages (the launcher as ${launcherVersion}). Prior ${PROMOTE_TAG}:`,
    );
    for (const entry of record.packages)
      console.log(`  ${entry.name}  ${entry.priorLatest}`);

    // Step 6, before any tag moves; it runs again just before the publish.
    const served = await checkServedLauncher({
      version,
      launcherVersion,
      qualifiedRc: qualified.launcher.stagedTarball,
      finalTarball: qualified.launcher.final.path,
    });
    if (!served.ok) {
      console.error(
        `Refusing to promote ${version}: the ${version} launcher is not the rc npm serves with only its version substituted (Article 3 clause 5).`,
      );
      for (const problem of served.problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    console.log(
      `npm serves ${LAUNCHER}@${launcherVersion} as the qualified rc, and ${qualified.launcher.final.filename} differs from it only by the version string.`,
    );
    // Before any tag moves: an X already on npm must be the qualified final
    // launcher, or the platforms' `latest` would move and then roll back.
    try {
      const slot = await checkFinalLauncherSlot({
        version,
        finalTarball: qualified.launcher.final.path,
      });
      console.log(
        slot === "absent"
          ? `${LAUNCHER}@${version} is not on npm yet; promotion publishes it.`
          : `${LAUNCHER}@${version} is already on npm as the qualified final launcher; promotion moves its tag.`,
      );
    } catch (error) {
      console.error(`Refusing to promote ${version}: ${error.message}.`);
      process.exit(1);
    }

    // QCLI-398: the GitHub Release is cut after `latest` moves, so its notes
    // must exist BEFORE anything moves; finding no section afterwards would
    // leave a promoted version with no release.
    // QCLI-407: read at the commit v<version> peels to -- the same commit the
    // bundle above was gated against -- so an uncommitted edit, or work that
    // landed after the tag, cannot become the body of this release.
    // QCLI-515 (DEC-204 (3)): --notes-from moves ONLY this read, to a
    // descendant of the tag's commit (CHANGELOG.md plus .quest/ only, DEC-204 (3a)). The bundle above, the
    // receipt and the rc bytes stay bound to the tag peel. Used once, for 0.14.1,
    // whose tag carries no `## 0.14.1` section.
    let notesCommit = peeled.commit;
    if (notesFrom !== undefined) {
      const from = await notesCommitFrom(notesFrom, peeled.commit);
      if (!from.ok) {
        console.error(`Refusing to promote ${version}: ${from.detail}`);
        process.exit(1);
      }
      notesCommit = from.commit;
      console.log(
        `Release notes are read from ${notesCommit.slice(0, 7)}, a descendant (CHANGELOG.md plus .quest/ only) of the tag commit ${peeled.commit.slice(0, 7)} (--notes-from); the bundle and receipt stay bound to ${peeled.commit.slice(0, 7)}.`,
      );
    }
    const notes = await releaseNotesFor(version, { commit: notesCommit });
    if (!notes.ok) {
      console.error(`Refusing to promote ${version}: ${notes.detail}`);
      process.exit(1);
    }
    release = { notes: notes.notes, title: notes.title };
    // A read of the release, on --promote as well as the dry run: a gh that
    // is missing, logged out or offline refuses here, before any tag moves,
    // instead of being found after `latest` has already moved.
    const planned = await ensureGitHubRelease({
      version,
      ...release,
      dryRun: true,
    });
    console.log(`GitHub Release: ${planned.detail}.`);
    if (!planned.ok) {
      console.error(
        `Refusing to promote ${version}: the GitHub Release step could not be checked, so it would fail after ${PROMOTE_TAG} moves.`,
      );
      process.exit(1);
    }
    if (!act) {
      console.log(
        `\nDry run only. Re-run with --promote to write ${recordPath} and move ${PROMOTE_TAG}.`,
      );
      return;
    }
    if (!existing) {
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, {
        flag: "wx",
      });
      console.log(`Recorded to ${recordPath} before moving anything.`);
    }
  }

  const { token, source, keychain } = await resolveToken();
  let npmrcDir;
  const env = { ...process.env };
  if (token) {
    if (!isValidGranularTokenShape(tokenShape(token)))
      throw new Error(
        `Refusing: the credential from ${source} does not look like an npm granular access token.`,
      );
    npmrcDir = await mkdtemp(join(tmpdir(), "quest-promote-npmrc-"));
    await writeFile(
      join(npmrcDir, ".npmrc"),
      `//registry.npmjs.org/:_authToken=${token}\n`,
    );
    env.npm_config_userconfig = join(npmrcDir, ".npmrc");
    // The token file must not outlive a process.exit inside the try below.
    process.once("exit", () =>
      rmSync(npmrcDir, { recursive: true, force: true }),
    );
    console.log(`Auth: using a token from ${source}.`);
  } else {
    console.log(`Auth: no token -- ${describeKeychainState(keychain)}.`);
    if (!otp)
      throw new Error(
        "--otp <code> is required when no token is configured; the account has 2FA",
      );
  }
  const setTag = (name, target, tag) =>
    execFile(
      "npm",
      [
        "dist-tag",
        "add",
        `${name}@${target}`,
        tag,
        ...REGISTRY_PINS,
        ...(!token && otp ? ["--otp", otp] : []),
      ],
      { env },
    );

  try {
    const log = (line) => console.log(`  ${line}`);
    if (rollbackPath) {
      console.log(
        `Restoring ${PROMOTE_TAG} from ${rollbackPath} (release ${record.version}):`,
      );
      const outcome = await rollback({ record, setTag, log });
      if (!outcome.ok) {
        console.error(
          `NOT restored: ${outcome.failed.join(", ")}. Re-run --rollback; it is idempotent.`,
        );
        process.exit(1);
      }
      const expected = Object.fromEntries(
        record.packages.map((entry) => [entry.name, entry.priorLatest]),
      );
      const check = await verifyTags({ expected });
      for (const line of check.wrong) console.error(`  ${line}`);
      if (!check.ok) process.exit(1);
      console.log(
        `Rolled back: every ${PROMOTE_TAG} reads its recorded prior value.`,
      );
      return;
    }

    const final = qualified.launcher.final;
    const publishLauncher = () =>
      publishFinalLauncher({
        version: record.version,
        finalTarball: final.path,
        // Step 6 again, immediately before the one irreversible write.
        recheck: () =>
          checkServedLauncher({
            version: record.version,
            launcherVersion,
            qualifiedRc: qualified.launcher.stagedTarball,
            finalTarball: final.path,
          }),
        publish: (tarball) =>
          execFile(
            "npm",
            launcherPublishArgs(tarball, { otp: !token ? otp : undefined }),
            { env, maxBuffer: 32 * 1024 * 1024 },
          ),
        setTag,
      });
    console.log(
      `\nMoving ${PROMOTE_TAG} to ${record.version}: the platforms by dist-tag, then ${LAUNCHER}@${record.version} published onto ${PROMOTE_TAG} from ${final.filename}:`,
    );
    const outcome = await promote({ record, setTag, publishLauncher, log });
    if (!outcome.ok) {
      console.error(
        `\nPROMOTION FAILED at ${outcome.failed}. The ${outcome.moved.length} tag(s) this run moved were ` +
          (outcome.restored.ok
            ? "restored to their recorded prior values."
            : `NOT all restored (${outcome.restored.failed.join(", ")}); run --rollback ${recordPath}.`) +
          " Retry at the same version; never skip to a different number (Article 3 clause 5).",
      );
      process.exit(1);
    }
    const expected = Object.fromEntries(
      record.packages.map((entry) => [entry.name, record.version]),
    );
    const check = await verifyTags({ expected });
    for (const line of check.wrong) console.error(`  ${line}`);
    if (!check.ok) {
      console.error(
        `The writes returned success but the registry does not serve ${PROMOTE_TAG} = ${record.version} everywhere after ${check.attempts} reads.`,
      );
      process.exit(1);
    }
    // Step 7: latest reads X (above), and X is the qualified final launcher.
    const bytes = await verifyFinalLauncher({
      version: record.version,
      finalTarball: final.path,
    });
    if (!bytes.ok) {
      for (const problem of bytes.problems) console.error(`  ${problem}`);
      console.error(
        `${PROMOTE_TAG} reads ${record.version} everywhere, but npm does not serve the qualified ${final.filename} as ${LAUNCHER}@${record.version}. Do NOT run npm unpublish.`,
      );
      process.exit(1);
    }
    console.log(
      `\nPromoted: ${PROMOTE_TAG} reads ${record.version} on all ${record.packages.length} packages (anonymous registry read, ${check.attempts} check${check.attempts === 1 ? "" : "s"}), and npm serves ${LAUNCHER}@${record.version} as the qualified ${final.filename}. Rollback: --rollback ${recordPath}`,
    );
  } finally {
    if (npmrcDir) await rm(npmrcDir, { recursive: true, force: true });
  }

  // QCLI-398: reached only after a verified promotion (every other path in
  // the try returns or exits). The release is cut after the finally, so the
  // npm token file is already gone: gh does not need it, and process.exit
  // below would skip a finally.
  const cut = await ensureGitHubRelease({
    version: record.version,
    ...release,
  });
  if (cut.ok) console.log(`GitHub Release: ${cut.detail}.`);
  else
    console.error(
      `\nGitHub Release NOT cut: ${cut.detail}. npm ${PROMOTE_TAG} moved and is verified -- do NOT roll back for this. ${repairHint(record.version, notesFrom)}`,
    );

  // QCLI-400: report only, AFTER the release cut so its retries cannot
  // delay it, and before a failed cut exits so it cannot be skipped. The
  // promotion is complete and verified, and the field lags a publish, so a
  // non-zero exit would invite a rollback for what is usually lag -- the
  // same call lore-cli made (LCLI-621).
  const readme = await readBackReadme();
  if (readme.bytes > 0)
    console.log(
      `README read-back (QCLI-399 AC3): npm's package-level readme for ${LAUNCHER} is ${readme.bytes} bytes (read ${readme.attempts} time(s)).`,
    );
  else
    console.warn(
      [
        "",
        `WARNING: npm serves NO package-level readme for ${LAUNCHER} yet (QCLI-399 AC3): ${readme.bytes === null ? "unreadable" : "0 bytes"}${readme.error ? ` (last read failed: ${readme.error})` : ""} after ${readme.attempts} read(s).`,
        "The promotion is complete and verified; do NOT roll back or unpublish for this. The field lags a",
        "publish (~25 minutes measured by lore-cli). Re-measure, from the repository root, with the same",
        "pinned read and record the count on QCLI-399:",
        `    ${README_RECHECK}`,
        `Still 0 after that window means the publish of ${record.version} did not populate the packument readme.`,
      ].join("\n"),
    );

  if (!cut.ok) process.exit(1);
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
