// Stage two of a version bump: install the six platform candidate packages
// that CI built, as one repository script rather than a set of hand steps
// (QCLI-305).
//
// Background. The runbook's "Why strings first, then bytes" splits a bump into
// two commits. Step 1 moves every version STRING. Step 2 replaces the BINARY
// bytes: a qualification run against the branch builds all six
// `npm/quest-<target>` packages on their own native runners (Bun cannot
// cross-compile `bun-windows-aarch64` at all), uploads each as the
// `quest-package-<target>` artifact, and this script installs them.
//
// What this script does, in order, and nothing else:
//   1. download the six `quest-package-<target>` artifacts for one
//      prepublication-qualification run id;
//   2. recompute sha256 over each downloaded binary and compare it to THAT
//      artifact's own `questBinarySha256` field -- BEFORE anything is
//      installed. Any mismatch, any missing artifact, any unreadable file is
//      refused with nothing written;
//   3. copy each artifact's `package.json`, `LICENSE` and binary into
//      `npm/quest-<target>/`, and chmod +x the binary;
//   4. rewrite root `package.json`'s `questPlatformPackages` map to the same
//      six recomputed digests.
//
// THE DARWIN-ARM64 SIGKILL HAZARD APPLIES, and this script is shaped by it
// (QCLI-271; see the runbook's "A locally-rebuilt darwin-arm64 binary can
// SIGKILL git on this host"). On a host that code-signs and validates Mach-O
// binaries at mmap time, once `npm/quest-darwin-arm64/bin/quest` has been
// executed, any later git operation that reads that working-tree file is
// killed outright (exit 137). Three consequences, all load-bearing here:
//
//   * This script NEVER executes a downloaded binary. It only reads bytes to
//     hash them and copies bytes to install them; it spawns exactly one
//     subprocess, `gh`, to download. Executing a candidate is a separate,
//     deliberate act that must happen before the binary is committed, not
//     here.
//   * Every file is written to a FRESH INODE: the destination is deleted
//     before it is copied. The runbook calls a fresh inode NECESSARY -- an
//     in-place copy keeps the old inode and its stale signing validation
//     state, so a later git read of that path can still be killed -- and the
//     darwin-arm64 binary in particular must not be overwritten in place.
//   * `npm/quest-darwin-arm64/bin/quest` is written LAST -- after the other
//     five targets and after the root package.json rewrite -- so the final
//     recreate the runbook prescribes is the last write before git touches the
//     tree (the wrapper stages and commits right after this runs).
//
// Usage:
//   bun run install:platform-candidates -- --run <run-id>            # verify + install
//   bun run install:platform-candidates -- --run <run-id> --dry-run  # verify only, write nothing
//   bun run install:platform-candidates -- --from <dir> --dry-run    # verify an already-downloaded set
//
// `--run` takes a `prepublication-qualification.yml` run id; its six
// `quest-package-*` artifacts are downloaded into a fresh temp directory.
// `--dry-run` downloads and verifies against a real run id and writes NOTHING
// to the repository; it exercises the download+verify path only, never the
// install writes. `--from <dir>` skips the download and verifies a
// directory already shaped like a `gh run download` output (each target under
// `quest-package-<target>/`); it is an offline re-verify escape hatch.

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = fileURLToPath(new URL("..", import.meta.url));

const REPOSITORY = "opum-ai/quest-cli";
const QUALIFICATION_WORKFLOW =
  ".github/workflows/prepublication-qualification.yml";

// darwin-arm64 is installed last: it is the one binary this class of host
// natively code-signs and validates, so its working-tree bytes are the ones a
// subsequent git operation is most likely to trip over (see the header).
const DARWIN_LAST_TARGET = "darwin-arm64";

/** The six platform targets, in the order the root checksum map declares them. */
export const TARGETS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
]);

/** `darwin-arm64` -> `@opum-ai/quest-darwin-arm64`. */
export function packageNameFor(target) {
  return `@opum-ai/quest-${target}`;
}

/** The executable name inside a platform package (`quest.exe` on win32). */
export function binaryNameFor(target) {
  return target.startsWith("win32-") ? "quest.exe" : "quest";
}

/**
 * Read the artifact set at `sourceRoot` and check each binary against the
 * `questBinarySha256` its own manifest declares. Read-only: it writes nothing
 * and executes nothing.
 *
 * Returns `{ problems, digests, verified }`. `problems` is every refusal
 * reason found; a caller installs only when it is empty. `digests` maps each
 * verified package name to its recomputed sha256.
 */
export async function verifyArtifactSet({ sourceRoot, targets = TARGETS }) {
  const problems = [];
  const digests = {};
  let verified = 0;
  for (const target of targets) {
    const directory = join(sourceRoot, `quest-package-${target}`);
    const manifestPath = join(directory, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      problems.push(
        `quest-package-${target}: cannot read manifest ${manifestPath} (${error.message})`,
      );
      continue;
    }
    const expectedName = packageNameFor(target);
    if (manifest.name !== expectedName) {
      problems.push(
        `quest-package-${target}: manifest names ${JSON.stringify(manifest.name)}, expected ${expectedName}`,
      );
      continue;
    }
    const binaryPath = join(directory, "bin", binaryNameFor(target));
    let bytes;
    try {
      bytes = await readFile(binaryPath);
    } catch (error) {
      problems.push(
        `quest-package-${target}: cannot read binary ${binaryPath} (${error.message})`,
      );
      continue;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const declared = manifest.questBinarySha256;
    if (typeof declared !== "string" || declared.length === 0) {
      problems.push(
        `quest-package-${target}: manifest declares no questBinarySha256`,
      );
      continue;
    }
    if (declared !== digest) {
      problems.push(
        `quest-package-${target}: sha256 mismatch -- manifest declares ${declared}, bytes hash to ${digest}`,
      );
      continue;
    }
    // LICENSE ships inside the artifact (build-platform-packages.mjs copies
    // it), so require it here, during verification, rather than discovering
    // its absence part-way through the install.
    try {
      if (!(await stat(join(directory, "LICENSE"))).isFile())
        throw new Error("not a regular file");
    } catch (error) {
      problems.push(
        `quest-package-${target}: cannot read LICENSE (${error.message})`,
      );
      continue;
    }
    digests[expectedName] = digest;
    verified += 1;
  }
  return { problems, digests, verified };
}

async function installTarget({ sourceRoot, writableRoot, target }) {
  const from = join(sourceRoot, `quest-package-${target}`);
  const to = join(writableRoot, "npm", `quest-${target}`);
  await mkdir(join(to, "bin"), { recursive: true });
  const written = [];
  // Manifest, then license, then binary: within a target the binary is always
  // the last file written, so the darwin-arm64 binary is last overall.
  for (const relative of [
    "package.json",
    "LICENSE",
    join("bin", binaryNameFor(target)),
  ]) {
    const destination = join(to, relative);
    // A FRESH INODE, never an in-place overwrite (QCLI-271; runbook "A locally-
    // rebuilt darwin-arm64 binary can SIGKILL git on this host"). The runbook
    // calls a fresh inode NECESSARY: an in-place copy keeps the old inode and
    // its stale code-signing validation state, so a later git read of that path
    // can still be killed (exit 137). Deleting first and recreating the file
    // gives it the new inode; for darwin-arm64 that recreate is the last write
    // of the whole install.
    await rm(destination, { force: true });
    await copyFile(join(from, relative), destination);
    written.push(destination);
  }
  await chmod(join(to, "bin", binaryNameFor(target)), 0o755);
  return written;
}

/**
 * Copy each verified artifact into `npm/quest-<target>/` and rewrite the root
 * `questPlatformPackages` map. Writes only; it never executes a binary.
 *
 * `sourceRoot` holds the verified artifact set, `digests` is the map returned
 * by `verifyArtifactSet`, and `writableRoot` is the package root (a directory
 * with `package.json` and `npm/`). Returns `{ written }`, the absolute paths
 * in the order they were written -- `npm/quest-darwin-arm64/bin/quest` last.
 */
export async function installArtifactSet({
  sourceRoot,
  writableRoot,
  digests,
  targets = TARGETS,
}) {
  // The root questPlatformPackages map carries all six packages, so a partial
  // set is REFUSED rather than written as a map that silently loses the
  // entries it never verified (QCLI-305 review). `targets` may not narrow the
  // map; the CLI always installs the full set anyway.
  const unverified = TARGETS.filter(
    (target) => digests[packageNameFor(target)] === undefined,
  );
  if (unverified.length)
    throw new Error(
      `refusing to install: no verified digest for ${unverified.join(", ")} (the root questPlatformPackages map carries all six packages)`,
    );
  // Read the root manifest first so an unreadable root refuses before any
  // platform file is copied.
  const rootPackagePath = join(writableRoot, "package.json");
  const rootPackage = JSON.parse(await readFile(rootPackagePath, "utf8"));
  const written = [];
  const nonDarwin = targets.filter((t) => t !== DARWIN_LAST_TARGET);
  const darwin = targets.filter((t) => t === DARWIN_LAST_TARGET);
  for (const target of nonDarwin)
    written.push(
      ...(await installTarget({ sourceRoot, writableRoot, target })),
    );
  // The root checksum map carries all six packages, so it is rewritten from
  // the verified digests between the ordinary targets and darwin-arm64 -- which
  // keeps the darwin binary the final write on disk.
  rootPackage.questPlatformPackages = Object.fromEntries(
    TARGETS.map((target) => [
      packageNameFor(target),
      digests[packageNameFor(target)],
    ]),
  );
  await writeFile(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
  written.push(rootPackagePath);
  for (const target of darwin)
    written.push(
      ...(await installTarget({ sourceRoot, writableRoot, target })),
    );
  return { written };
}

async function downloadArtifacts({ runId, into, gh = runGh }) {
  const { stdout } = await gh([
    "api",
    `repos/${REPOSITORY}/actions/runs/${runId}`,
  ]);
  const run = JSON.parse(stdout);
  if (run.path !== QUALIFICATION_WORKFLOW)
    throw new Error(
      `run ${runId} is ${JSON.stringify(run.path)}, not ${QUALIFICATION_WORKFLOW}`,
    );
  // A concluded-but-failed run's artifacts are not a candidate; an
  // in-progress run's may already be ready, so only a completed run is judged
  // on its conclusion (status `completed` implies a non-null conclusion).
  if (run.status === "completed" && run.conclusion !== "success")
    throw new Error(
      `run ${runId} concluded ${JSON.stringify(run.conclusion)}, not success`,
    );
  await gh([
    "run",
    "download",
    String(runId),
    "--repo",
    REPOSITORY,
    "--pattern",
    "quest-package-*",
    "--dir",
    into,
  ]);
}

function runGh(args) {
  return execFile("gh", args, { maxBuffer: 32 * 1024 * 1024 });
}

/** A refusal raised when verification fails; carries the per-artifact problems. */
export class ArtifactVerificationError extends Error {
  constructor(problems) {
    super(
      `refusing to install: ${problems.length} problem(s) verifying the artifact set`,
    );
    this.name = "ArtifactVerificationError";
    this.problems = problems;
  }
}

/**
 * The whole flow: acquire the six artifacts (download from `runId`, or use
 * `artifactSource` as an already-downloaded set), verify them, and install
 * unless `dryRun`. Throws `ArtifactVerificationError` on any verification
 * failure before anything is written.
 */
export async function runInstallCandidates({
  runId,
  dryRun = false,
  artifactSource,
  writableRoot = root,
  targets = TARGETS,
  log = (message) => process.stdout.write(`${message}\n`),
  download = downloadArtifacts,
} = {}) {
  if (!artifactSource && !/^[0-9]+$/.test(String(runId ?? "")))
    throw new Error(
      "--run <id> must be a numeric prepublication-qualification run id",
    );

  let sourceRoot = artifactSource;
  let temporaryDirectory;
  if (!sourceRoot) {
    temporaryDirectory = await realpath(
      await mkdtemp(join(tmpdir(), "quest-install-candidates-")),
    );
    sourceRoot = temporaryDirectory;
    log(`Downloading quest-package-* artifacts from run ${runId} ...`);
    await download({ runId: String(runId), into: sourceRoot, gh: runGh });
  }

  try {
    log(`Verifying ${targets.length} artifacts under ${sourceRoot} ...`);
    const { problems, digests, verified } = await verifyArtifactSet({
      sourceRoot,
      targets,
    });
    if (problems.length) {
      for (const problem of problems) log(`  refused: ${problem}`);
      throw new ArtifactVerificationError(problems);
    }
    log(`Verified ${verified} of ${targets.length} artifacts:`);
    for (const target of targets)
      log(
        `  ${packageNameFor(target)} sha256 ${digests[packageNameFor(target)]}`,
      );
    if (dryRun) {
      log("Dry run: verified the artifact set; nothing was written.");
      return { dryRun: true, verified, digests, written: [] };
    }
    const { written } = await installArtifactSet({
      sourceRoot,
      writableRoot,
      digests,
      targets,
    });
    log(
      `Installed ${written.length} files; wrote ${packageNameFor(DARWIN_LAST_TARGET)} last.`,
    );
    return { dryRun: false, verified, digests, written };
  } finally {
    if (temporaryDirectory)
      await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = { runId: undefined, dryRun: false, from: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--run" || arg === "--from") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      if (arg === "--run") options.runId = value;
      else options.from = value;
      index += 1;
    } else if (arg.startsWith("--run=")) {
      options.runId = arg.slice("--run=".length);
    } else if (arg.startsWith("--from=")) {
      options.from = arg.slice("--from=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.runId && !options.from)
    throw new Error(
      "Usage: --run <run-id> [--dry-run] | --from <dir> [--dry-run]",
    );
  return options;
}

async function main() {
  const { runId, dryRun, from } = parseArgs(process.argv.slice(2));
  await runInstallCandidates({ runId, dryRun, artifactSource: from });
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
