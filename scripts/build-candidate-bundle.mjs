// Digest-pinned candidate bundle (QCLI-135 follow-through).
//
// A candidate bundle lets downstream qualification exercise an UNPUBLISHED
// build: opum-cli-e2e binds it with `--quest-candidate`, installs Quest from
// the exact tarballs inside it, and recomputes every executable digest live
// from those bytes. Nothing reaches a registry.
//
// It exists because the alternative for exercising unreleased changes is
// publishing them, and "publish it and see" is not a qualification strategy.
//
// What binding a candidate gains and loses, stated here so nobody has to infer
// it from a passing report (opum-cli-e2e's own design note says the same):
//   GAINED  every digest is recomputed from these tarball bytes at run time,
//           and the binary that actually runs the ~400 behavioural rows is the
//           one in this bundle.
//   LOST    execution attestation for the five platforms the running host
//           cannot execute. This bundle proves a tarball containing a binary
//           of digest X exists for win32-arm64; it proves nothing ran there.
// The native-execution receipt is what covers the second, and the two are
// complementary rather than substitutes.
//
// This must run where all six platform packages exist. Bun cannot cross-compile
// bun-windows-aarch64, so that is CI after the platform matrix, never a laptop.
// QCLI-419 enforces that rather than trusting it: off a release ref a bundle
// with NO rebuilt platform package refuses outright, because committed bytes
// are an earlier release's and cannot be stamped as this source's. A partial
// set still builds, labeled "rebuilt" with rebuiltPlatforms naming the
// difference.

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  checkLauncherEquivalence,
  launcherRcVersion,
  nextRcNumber,
} from "./qualification/launcher-equivalence.mjs";
import { REGISTRY_PINS } from "./qualification/registry-visibility.mjs";

const execFile = promisify(execFileCallback);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

export const REQUIRED_PLATFORMS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
]);

const COMMIT_HEX = /^[0-9a-f]{40}$/;

export function executableFor(platform) {
  return platform.startsWith("win32-") ? "quest.exe" : "quest";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** `npm pack` names the archive after the scoped package plus its version. */
function tarballName(packageName, version) {
  return `${packageName.replace("@", "").replace("/", "-")}-${version}.tgz`;
}

/**
 * Packs one package directory into the bundle and returns its recorded row.
 * The member check is not ceremony: the consumer installs from these bytes and
 * extracts that exact path, so a tarball missing it fails at qualification time
 * with a confusing error instead of here with an obvious one.
 */
async function pack(directory, into, expectedMember) {
  const { stdout } = await execFile(
    "npm",
    ["pack", "--pack-destination", into, "--json"],
    { cwd: directory, maxBuffer: 32 * 1024 * 1024 },
  );
  // `npm pack --json` returns an array on some npm versions and an object
  // keyed by package name on others. Accept both rather than pinning npm.
  const parsed = JSON.parse(stdout);
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  const filename = entry?.filename;
  if (!filename)
    throw new Error(
      `npm pack produced no archive in ${directory}: ${stdout.slice(0, 200)}`,
    );
  const archive = join(into, filename);
  const { stdout: members } = await execFile("tar", ["tzf", archive], {
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!members.split("\n").includes(expectedMember))
    throw new Error(`${filename} does not contain ${expectedMember}`);
  return { filename, digest: sha256(await readFile(archive)) };
}

export async function buildCandidateBundle({
  commit,
  out,
  releaseRef = false,
  directory = root,
  rcNumber = 1,
} = {}) {
  if (!COMMIT_HEX.test(String(commit ?? "")))
    throw new Error(`source commit is not a 40-hex commit id: ${commit}`);

  const version = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  ).version;
  // QCLI-399 (Article 3 clause 5, ODOC-302): the root launcher stages as
  // X-rc.N and reaches `latest` by a fresh publish of X, so the bundle packs it
  // twice. package.json on the branch stays at X; the rc version exists only in
  // the staged launcher.
  const rcVersion = launcherRcVersion(version, rcNumber);

  // Every platform, or none. A five-platform bundle would produce a coverage
  // failure downstream that reads like a product defect rather than a build
  // that was never finished.
  const present = await readdir(join(directory, "npm"));
  const missing = REQUIRED_PLATFORMS.filter(
    (platform) => !present.includes(`quest-${platform}`),
  );
  if (missing.length)
    throw new Error(
      `cannot build a candidate bundle without every platform package; missing: ${missing.join(", ")}`,
    );

  // The root package.json advertises every platform digest. In a bundle
  // assembled from artifacts each platform job built separately, the committed
  // values describe the PREVIOUS release, so they are re-derived here from the
  // binaries actually present. Same rule as everywhere else in this pipeline:
  // re-derive, never copy — two documents agreeing prove nothing about bytes.
  const rootPackagePath = join(directory, "package.json");
  const rootPackage = JSON.parse(await readFile(rootPackagePath, "utf8"));
  const platformDigests = {};
  for (const platform of REQUIRED_PLATFORMS) {
    const packageDirectory = join(directory, "npm", `quest-${platform}`);
    const manifest = JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8"),
    );
    const digest = sha256(
      await readFile(join(packageDirectory, "bin", executableFor(platform))),
    );
    if (manifest.questBinarySha256 !== digest)
      throw new Error(
        `${platform}: the binary does not match its own manifest — manifest ${manifest.questBinarySha256}, binary ${digest}`,
      );
    if (manifest.version !== version)
      throw new Error(
        `${platform}: package is version ${manifest.version}, root is ${version}`,
      );
    platformDigests[manifest.name] = digest;
  }
  // The comparisons below resolve <commit> in THIS repository, so it has to
  // exist here first. Two measured shapes otherwise slip past the rebuild
  // check (found reviewing QCLI-419): a directory with no repository behind
  // it, where `git diff` switches to --no-index mode and reports every path as
  // a difference (reading as all-rebuilt), and a 40-hex commit the repository
  // does not have (which contributes nothing to `rebuilt`, so the refusal
  // below would name committed artifacts rather than the real cause). In both
  // shapes nothing can be tied to the commit, so both refuse here.
  try {
    await execFile(
      "git",
      ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`],
      { cwd: directory },
    );
  } catch {
    throw new Error(
      `refusing to build a candidate bundle for ${commit.slice(0, 7)}: it does not resolve to a commit in ${directory} (no repository there, or this commit is not present), so no artifact can be tied to it.`,
    );
  }
  // A bundle names a sourceCommit. Whether it actually CARRIES that commit's
  // bytes is a separate question, and nothing here used to ask it.
  //
  // It matters because Bun's --compile output is not byte-reproducible: a
  // rebuilt binary can never equal the committed one, so a bundle assembled
  // from fresh builds names a commit whose bytes it does not contain. A
  // consumer then qualifies an artifact nobody will ship — which happened, and
  // was caught downstream by digest comparison rather than here.
  //
  // This runs BEFORE the root package.json is mutated below, so neither
  // refusal can leave that mutation behind.
  const rebuilt = [];
  for (const platform of REQUIRED_PLATFORMS) {
    const relative = `npm/quest-${platform}/bin/${executableFor(platform)}`;
    try {
      // `git diff --quiet` rather than hashing: these binaries are 60-95MB and
      // `git hash-object` on them gets SIGKILLed under the memory this runs in.
      // The comparison is the same one, done by git without materialising the
      // content anywhere.
      await execFile("git", ["diff", "--quiet", commit, "--", relative], {
        cwd: directory,
      });
    } catch (error) {
      // Exit 1 is "differs". Anything else — an unknown commit, a path that
      // does not exist at it — is not evidence of a rebuild, so it is ignored
      // rather than reported as one. One measured caveat (QCLI-419): OUTSIDE a
      // repository `git diff` runs in --no-index mode and exits 1 for an
      // inaccessible path, so a directory with no Git behind it reads as
      // all-rebuilt; the test fixtures that assert provenance therefore
      // initialize a real repository.
      if (error.code === 1) rebuilt.push(platform);
    }
  }
  // On a release ref this is fatal: the artifacts published are the committed
  // ones, so a bundle of rebuilds describes something else entirely.
  if (rebuilt.length && releaseRef)
    throw new Error(
      `refusing to build a release bundle from rebuilt artifacts; these are not the bytes committed at ${commit.slice(0, 7)}: ${rebuilt.join(", ")}`,
    );
  // The mirror image, and it took a measured defect to see it (QCLI-419). Off
  // a release ref, zero rebuilds means nothing here built these packages for
  // this source: they are the bytes the tree already carried — an earlier
  // release's build — and the bundle would stamp sourceCommit over them and
  // call them "committed". Measured 2026-09-29 on dev d034a239: a laptop run
  // packed the committed 0.11.0 binaries (which reject --across-refs) and
  // stamped them sourceCommit d034a239 with artifactProvenance "committed", so
  // a qualifier trusting the metadata would have exercised the wrong bytes and
  // reported PASS. A dispatch build takes its platform packages from the
  // platform matrix, which is what makes them "rebuilt"; the bytes that
  // publish are bundled on the release tag.
  if (!rebuilt.length && !releaseRef)
    throw new Error(
      `refusing to build a candidate bundle off a release ref from committed platform artifacts: nothing was rebuilt, so these are bytes the tree already carried and nothing here ties them to ${commit.slice(0, 7)}. A dispatch build takes its platform packages from the platform matrix (labeled "rebuilt"); run on the release tag to bundle the bytes that publish.`,
    );
  const artifactProvenance = rebuilt.length ? "rebuilt" : "committed";

  // `npm pack` reads package.json from disk, so the corrected digests have to
  // be written there. The ORIGINAL is kept and restored in the `finally` below,
  // so the restore runs whether packing succeeds or throws (QCLI-420): a build
  // step that leaves the working tree mutated will eventually have that
  // mutation swept into an unrelated commit, which is exactly what happened —
  // a red-case test's tampered digest reached dev inside another change.
  const originalRootPackage = await readFile(rootPackagePath, "utf8");

  // tarballs/ holds exactly what stages under release-candidate: the rc
  // launcher and the six platforms. final/ holds the X launcher, which is never
  // staged and is published to `latest` only by promote-release.mjs.
  const tarballs = join(out, "tarballs");
  const final = join(out, "final");
  const digests = [];
  const packages = [];
  let rcRow;
  let finalRow;
  try {
    rootPackage.questPlatformPackages = platformDigests;
    await writeFile(
      rootPackagePath,
      `${JSON.stringify(rootPackage, null, 2)}\n`,
    );

    await rm(out, { recursive: true, force: true });
    await mkdir(tarballs, { recursive: true });
    await mkdir(final, { recursive: true });
    await mkdir(join(out, "evidence"), { recursive: true });

    const packLauncher = async (asVersion, into) => {
      await writeFile(
        rootPackagePath,
        `${JSON.stringify({ ...rootPackage, version: asVersion }, null, 2)}\n`,
      );
      const row = await pack(directory, into, "package/bin/quest.cjs");
      if (row.filename !== tarballName("@opum-ai/quest", asVersion))
        throw new Error(
          `root archive is ${row.filename}, expected ${tarballName("@opum-ai/quest", asVersion)}`,
        );
      return row;
    };
    rcRow = await packLauncher(rcVersion, tarballs);
    finalRow = await packLauncher(version, final);
  } finally {
    // Restore in the finally so a pack failure restores too, not only the
    // success path (QCLI-420). Nothing after this block mutates the root.
    await writeFile(rootPackagePath, originalRootPackage);
  }
  const equivalence = await checkLauncherEquivalence({
    rcTarball: join(tarballs, rcRow.filename),
    finalTarball: join(final, finalRow.filename),
    rcVersion,
    version,
  });
  if (!equivalence.ok)
    throw new Error(
      `the ${version} launcher is not the ${rcVersion} launcher with only its version substituted (Article 3 clause 5):\n  ${equivalence.problems.join("\n  ")}`,
    );
  digests.push(rcRow);

  for (const platform of REQUIRED_PLATFORMS) {
    const name = `@opum-ai/quest-${platform}`;
    const row = await pack(
      join(directory, "npm", `quest-${platform}`),
      tarballs,
      `package/bin/${executableFor(platform)}`,
    );
    digests.push(row);
    packages.push({ name, tarball: row.filename });
  }

  await writeFile(
    join(tarballs, "sha256.txt"),
    `${digests.map((row) => `${row.digest}  ${row.filename}`).join("\n")}\n`,
  );
  await writeFile(
    join(final, "sha256.txt"),
    `${finalRow.digest}  ${finalRow.filename}\n`,
  );
  await writeFile(
    join(out, "evidence", "package-metadata.json"),
    `${JSON.stringify(
      {
        sourceCommit: commit,
        version,
        // "committed" means every binary here is byte-identical to the blob at
        // sourceCommit — the bytes that publish. "rebuilt" means they are not,
        // and a consumer must not present the run as qualifying that commit.
        artifactProvenance,
        ...(rebuilt.length ? { rebuiltPlatforms: rebuilt } : {}),
        packages,
        // QCLI-399: which launcher stages and which one reaches latest.
        launcher: {
          name: "@opum-ai/quest",
          stagedVersion: rcVersion,
          stagedTarball: rcRow.filename,
          finalVersion: version,
          finalTarball: `final/${finalRow.filename}`,
          finalSha256: finalRow.digest,
          equivalence:
            "identical after substituting the staged version for the final one",
        },
      },
      null,
      2,
    )}\n`,
  );
  return {
    version,
    rcVersion,
    commit,
    out,
    packages,
    digests,
    final: finalRow,
    artifactProvenance,
  };
}

/**
 * The rc number this bundle's launcher stages as (QCLI-399). An explicit
 * --launcher-rc wins. Otherwise it is one past the highest X-rc.N the registry
 * already carries, because a published rc is immutable. On a release ref an
 * unreadable registry refuses: guessing 1 could collide with a staged rc. Off
 * a release ref nothing publishes, so 1 is safe.
 */
export async function resolveRcNumber({
  version,
  explicit,
  releaseRef,
  readVersions = async () =>
    JSON.parse(
      (
        await execFile("npm", [
          "view",
          "@opum-ai/quest",
          "versions",
          "--json",
          "--prefer-online",
          ...REGISTRY_PINS,
        ])
      ).stdout,
    ),
}) {
  if (explicit !== undefined) {
    if (!/^[1-9]\d*$/.test(explicit))
      throw new Error(`--launcher-rc must be an integer >= 1, got ${explicit}`);
    return Number(explicit);
  }
  try {
    const versions = await readVersions();
    return nextRcNumber(
      version,
      Array.isArray(versions) ? versions : [versions],
    );
  } catch (error) {
    if (releaseRef)
      throw new Error(
        `cannot read @opum-ai/quest's published versions to pick the launcher rc number; pass --launcher-rc <n>: ${String(error?.message ?? error).split("\n")[0]}`,
      );
    return 1;
  }
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
  const commit =
    flag("--commit") ??
    process.env.GITHUB_SHA ??
    (await execFile("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const out = resolve(flag("--out") ?? join(root, "candidate"));
  const releaseRef = (process.env.GITHUB_REF ?? "").startsWith("refs/tags/v");
  const version = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ).version;
  const rcNumber = await resolveRcNumber({
    version,
    explicit: flag("--launcher-rc"),
    releaseRef,
  });
  const built = await buildCandidateBundle({
    commit,
    out,
    releaseRef,
    rcNumber,
  });
  console.log(
    `Candidate bundle for ${built.version} at ${commit.slice(0, 7)}: ${built.digests.length} staged archives (launcher ${built.rcVersion}) and the ${built.version} launcher in ${out}`,
  );
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
