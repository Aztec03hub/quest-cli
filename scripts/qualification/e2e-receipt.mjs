// The opum-cli-e2e qualification gate on publication (QCLI-366).
//
// Binding record: opum-doc docs/adr/harden-fleet-ci-against-a-single-runner-
// outage-and-unqualified-publication.md, ruling 3, at main 9222079. The
// publisher HARD-REFUSES without a qualification receipt from opum-cli-e2e
// unless an explicit override is written to the record it reads. A
// warning-only mode was considered there and rejected: lore 0.9.0 shipped over
// a recorded NOT QUALIFIED result.
//
// The receipt format is opum-cli-e2e's, agreed with lore-cli on LCLI-578 and
// deliberately not redesigned here. It lives at receipts/quest/<version>.json
// on opum-cli-e2e's main and binds version, commit, releaseRunId and the
// sha256 of every tarball.
//
// For quest, "the release run" is the prepublication-qualification run on the
// tag that uploaded quest-candidate-bundle, because that is the run whose
// tarballs opum-cli-e2e qualifies (--quest-candidate). release.yml builds no
// tarballs of its own. The gate only means something if those exact files are
// what npm receives, so the publishers publish the bundle's .tgz files
// byte-for-byte rather than repacking the working tree -- the repack is how
// the win32 packages came to differ from the qualified bytes (QCLI-368).
//
// This file never decides that a missing receipt is fine. A 404, a 403 (the
// repository is private, so an unprivileged token gets one), a network error
// and a malformed document all read as NO RECEIPT, and no receipt refuses.

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { checkLauncherEquivalence } from "./launcher-equivalence.mjs";
import { REQUIRED_PLATFORMS } from "./native-execution-receipt.mjs";

const execFile = promisify(execFileCallback);

export const RECEIPT_KIND = "opum.qualification-receipt.v1";
export const RECEIPT_REPOSITORY = "opum-ai/opum-cli-e2e";
export const PRODUCT = "quest";
export const LAUNCHER = "@opum-ai/quest";

const OVERRIDE_FIELDS = Object.freeze(["by", "reason", "task", "adr"]);
const COMMIT_HEX = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function receiptPath(version) {
  return `receipts/${PRODUCT}/${version}.json`;
}

/**
 * QCLI-399: is `launcherVersion` an rc of exactly `version`? opum-cli-e2e's
 * receipts/README.md ("Root launcher rc-staging") validates it against
 * ^<X>-rc\.[1-9][0-9]*$ with X taken from the release, never a bare pattern
 * that an rc of some other release would also satisfy.
 */
export function isLauncherVersionOf(version, launcherVersion) {
  const prefix = `${version}-rc.`;
  return (
    typeof launcherVersion === "string" &&
    launcherVersion.startsWith(prefix) &&
    /^[1-9][0-9]*$/.test(launcherVersion.slice(prefix.length))
  );
}

/** `@opum-ai/quest-linux-x64` -> `opum-ai-quest-linux-x64-<v>.tgz`, as npm pack names it. */
export function tarballName(pkgName, version) {
  return `${pkgName.replace("@", "").replace("/", "-")}-${version}.tgz`;
}

/**
 * The seven archives a quest release STAGES, named as `npm pack` names them:
 * the root launcher at its rc version (QCLI-399) and the six platforms at X.
 * The X launcher is not one of them; it is published only on promotion.
 */
export function expectedTarballNames(version, launcherVersion) {
  if (!isLauncherVersionOf(version, launcherVersion))
    throw new Error(
      `the launcher version must be ${version}-rc.<N>, got ${JSON.stringify(launcherVersion)}`,
    );
  return [
    tarballName(LAUNCHER, launcherVersion),
    ...REQUIRED_PLATFORMS.map((platform) =>
      tarballName(`${LAUNCHER}-${platform}`, version),
    ),
  ];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function digestTgz(directory) {
  const digests = {};
  for (const name of (await readdir(directory)).sort())
    if (name.endsWith(".tgz"))
      digests[name] = sha256(await readFile(join(directory, name)));
  return digests;
}

/**
 * Reads a downloaded quest-candidate-bundle and re-derives every tarball
 * digest from the bytes on disk, the never-staged X launcher in final/
 * included. The bundle's own sha256.txt files are not consulted: a document
 * agreeing with itself proves nothing about the files beside it.
 */
export async function readBundle(bundleDir) {
  const metadata = JSON.parse(
    await readFile(
      join(bundleDir, "evidence", "package-metadata.json"),
      "utf8",
    ),
  );
  const directory = join(bundleDir, "tarballs");
  const finalDirectory = join(bundleDir, "final");
  return {
    metadata,
    directory,
    tarballs: await digestTgz(directory),
    finalDirectory,
    final: await digestTgz(finalDirectory).catch(() => ({})),
  };
}

/**
 * QCLI-399: the bundle's launcher block, checked against the release rather
 * than trusted. Returns the staged rc version and the final X launcher's
 * file, or the problems that make them unusable.
 */
export function bundleLauncher(bundle, version) {
  const launcher = bundle.metadata?.launcher;
  if (!launcher || typeof launcher !== "object" || Array.isArray(launcher))
    return {
      ok: false,
      problems: [
        "bundle metadata has no launcher block; it predates root-launcher rc-staging (QCLI-399) and cannot be published",
      ],
    };
  const problems = [];
  const stagedVersion = launcher.stagedVersion;
  if (launcher.name !== LAUNCHER)
    problems.push(
      `bundle launcher is ${JSON.stringify(launcher.name)}, not ${LAUNCHER}`,
    );
  if (!isLauncherVersionOf(version, stagedVersion))
    problems.push(
      `bundle launcher stages as ${JSON.stringify(stagedVersion)}, not ${version}-rc.<N>`,
    );
  if (launcher.finalVersion !== version)
    problems.push(
      `bundle launcher's final version is ${JSON.stringify(launcher.finalVersion)}, the release is ${version}`,
    );
  const finalName = tarballName(LAUNCHER, version);
  const finalFiles = Object.keys(bundle.final ?? {});
  if (finalFiles.length !== 1 || finalFiles[0] !== finalName)
    problems.push(
      `bundle final/ must hold exactly ${finalName}, holds ${JSON.stringify(finalFiles)}`,
    );
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    problems,
    stagedVersion,
    stagedTarball: join(bundle.directory, tarballName(LAUNCHER, stagedVersion)),
    final: {
      filename: finalName,
      path: join(bundle.finalDirectory, finalName),
      sha256: bundle.final[finalName],
    },
  };
}

/**
 * Pure verdict over a receipt and the facts of the release about to happen.
 *
 * The override waives the VERDICT and nothing else. A receipt still has to be
 * about these bytes: an override written for a different commit or a
 * different tarball set is not an override for this one.
 */
export function evaluateReceipt(
  doc,
  { version, commit, releaseRunId, tarballs, launcherVersion, finalTarball },
) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    return {
      ok: false,
      problems: ["receipt is not a JSON object"],
      override: null,
    };
  const problems = [];
  if (doc.schemaVersion !== 1)
    problems.push(
      `schemaVersion must be 1, got ${JSON.stringify(doc.schemaVersion)}`,
    );
  if (doc.kind !== RECEIPT_KIND)
    problems.push(
      `kind must be ${RECEIPT_KIND}, got ${JSON.stringify(doc.kind)}`,
    );
  if (doc.product !== PRODUCT)
    problems.push(
      `receipt is for product ${JSON.stringify(doc.product)}, not ${PRODUCT}`,
    );
  if (doc.version !== version)
    problems.push(
      `receipt describes version ${JSON.stringify(doc.version)}, the release is ${version}`,
    );
  if (!COMMIT_HEX.test(String(doc.commit ?? "")) || doc.commit !== commit)
    problems.push(
      `receipt describes commit ${JSON.stringify(doc.commit)}, the release is ${commit}`,
    );
  if (
    doc.releaseRunId === undefined ||
    doc.releaseRunId === null ||
    String(doc.releaseRunId) !== String(releaseRunId)
  )
    problems.push(
      `receipt describes run ${JSON.stringify(doc.releaseRunId)}, the tarballs come from run ${releaseRunId}`,
    );

  // Set equality, in both directions. A receipt that omits a tarball did not
  // qualify it; one that names an extra describes a different release.
  const recorded =
    doc.tarballs &&
    typeof doc.tarballs === "object" &&
    !Array.isArray(doc.tarballs)
      ? doc.tarballs
      : {};
  if (recorded !== doc.tarballs)
    problems.push("receipt has no tarballs object");
  // Object.hasOwn, never `in`: `in` also finds inherited properties, so a
  // receipt naming `constructor` or `__proto__` would pass as a known archive.
  for (const [name, digest] of Object.entries(tarballs)) {
    if (!Object.hasOwn(recorded, name))
      problems.push(`${name}: not in the receipt, so it was never qualified`);
    else if (!SHA256_HEX.test(String(recorded[name])))
      problems.push(`${name}: receipt digest is not a sha256 hex digest`);
    else if (recorded[name] !== digest)
      problems.push(
        `${name}: receipt says ${recorded[name]}, the file being published is ${digest}`,
      );
  }
  for (const name of Object.keys(recorded))
    if (!Object.hasOwn(tarballs, name))
      problems.push(
        `${name}: named in the receipt but not part of this release`,
      );

  problems.push(
    ...evaluateLauncher(doc, { version, launcherVersion, finalTarball }),
  );

  const verdict = evaluateVerdict(doc);
  problems.push(...verdict.problems);
  return {
    ok: problems.length === 0,
    problems,
    override: verdict.override,
  };
}

/**
 * QCLI-399, opum-cli-e2e TASK-126 (receipts/README.md blob 241ac885, "Root
 * launcher rc-staging"): the pass-1 receipt names the staged rc launcher and
 * carries opum-cli-e2e's OWN substitution verdict over the bundle's rc and X
 * launchers, with the X launcher's digest. An override waives the verdict
 * field only; it does not waive this, because Article 3 clause 5 is what
 * makes publishing X to `latest` legitimate at all.
 */
function evaluateLauncher(doc, { version, launcherVersion, finalTarball }) {
  const problems = [];
  // Against the release's X, which the receipt's own version must equal (a
  // difference there is already its own problem, and is not reported twice).
  if (!isLauncherVersionOf(version, doc.launcherVersion))
    problems.push(
      `launcherVersion must be ${version}-rc.<N>, got ${JSON.stringify(doc.launcherVersion)}`,
    );
  else if (doc.launcherVersion !== launcherVersion)
    problems.push(
      `receipt qualified launcher ${doc.launcherVersion}, the bundle stages ${launcherVersion}`,
    );
  const substitution = doc.launcherSubstitution;
  if (
    !substitution ||
    typeof substitution !== "object" ||
    Array.isArray(substitution)
  ) {
    problems.push(
      `receipt has no launcherSubstitution, so nothing re-derived that the ${version} launcher is the qualified rc with only its version changed`,
    );
    return problems;
  }
  if (
    substitution.verdict === "MATCH" &&
    Array.isArray(substitution.mismatches) &&
    substitution.mismatches.length
  )
    problems.push(
      `launcherSubstitution.verdict is "MATCH" but lists ${substitution.mismatches.length} mismatch(es); a MATCH has none`,
    );
  if (substitution.verdict !== "MATCH")
    problems.push(
      `launcherSubstitution.verdict is ${JSON.stringify(substitution.verdict)}, not "MATCH"${Array.isArray(substitution.mismatches) && substitution.mismatches.length ? `: ${substitution.mismatches.map((entry) => JSON.stringify(entry)).join("; ")}` : ""}`,
    );
  const recordedFinal = substitution.finalTarball;
  if (recordedFinal?.filename !== finalTarball?.filename)
    problems.push(
      `launcherSubstitution.finalTarball.filename is ${JSON.stringify(recordedFinal?.filename)}, the bundle's is ${JSON.stringify(finalTarball?.filename)}`,
    );
  if (
    !SHA256_HEX.test(String(recordedFinal?.sha256 ?? "")) ||
    recordedFinal.sha256 !== finalTarball?.sha256
  )
    problems.push(
      `launcherSubstitution.finalTarball.sha256 is ${JSON.stringify(recordedFinal?.sha256)}, the bundle's ${finalTarball?.filename} is ${finalTarball?.sha256}`,
    );
  return problems;
}

/**
 * The verdict half every opum-cli-e2e receipt shares, the per-product and
 * the pair receipt (QCLI-388) alike: QUALIFIED, or a well-formed override.
 */
export function evaluateVerdict(doc) {
  const problems = [];
  // An override is a signed waiver, not a truthy value: it must carry the four
  // fields the agreed format names, each a non-empty string, or it waives
  // nothing and its banner would print an empty object.
  let override = null;
  if (doc.override !== undefined) {
    const candidate = doc.override;
    const shaped =
      candidate && typeof candidate === "object" && !Array.isArray(candidate);
    const missing = OVERRIDE_FIELDS.filter(
      (field) =>
        !shaped ||
        typeof candidate[field] !== "string" ||
        !candidate[field].trim(),
    );
    if (missing.length)
      problems.push(
        `override must name ${OVERRIDE_FIELDS.join(", ")} as non-empty strings; missing or empty: ${missing.join(", ")}`,
      );
    else override = candidate;
  }
  // The key is verdict alone. The harness summary line can read NOT QUALIFIED
  // for reasons the verdict field already accounts for (opum-cli-e2e TASK-107).
  if (doc.verdict !== "QUALIFIED" && !override && doc.override === undefined)
    problems.push(
      `verdict is ${JSON.stringify(doc.verdict)}, not "QUALIFIED", and the receipt carries no override`,
    );
  return { problems, override };
}

/**
 * Reads the receipt from opum-cli-e2e's main. Every failure is returned as
 * `doc: null` with the reason, never thrown and never retried into a pass.
 */
export async function fetchReceipt(
  version,
  { execFile: execFileFn = execFile, path = receiptPath(version) } = {},
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
        `repos/${RECEIPT_REPOSITORY}/contents/${path}?ref=main`,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    return {
      doc: JSON.parse(stdout),
      source: `${RECEIPT_REPOSITORY}@main:${path}`,
    };
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error)
      .trim()
      .split("\n")[0];
    return {
      doc: null,
      source: `${RECEIPT_REPOSITORY}@main:${path}`,
      error: detail,
    };
  }
}

/**
 * The whole gate: the bundle must be a release bundle of this commit and
 * version, carry exactly the seven archives to stage plus the X launcher,
 * pass the launcher substitution check here as well as at build, and match a
 * receipt.
 */
export async function requireQualification({
  bundleDir,
  version,
  commit,
  releaseRunId,
  fetch = (v) => fetchReceipt(v),
  checkEquivalence = checkLauncherEquivalence,
}) {
  const problems = [];
  const bundle = await readBundle(bundleDir);
  if (bundle.metadata.sourceCommit !== commit)
    problems.push(
      `bundle was built from ${bundle.metadata.sourceCommit}, the release is ${commit}`,
    );
  if (bundle.metadata.version !== version)
    problems.push(
      `bundle is version ${bundle.metadata.version}, the release is ${version}`,
    );
  if (bundle.metadata.artifactProvenance !== "committed")
    problems.push(
      `bundle provenance is ${JSON.stringify(bundle.metadata.artifactProvenance)}; only a bundle of the committed binaries can be published`,
    );
  const launcher = bundleLauncher(bundle, version);
  if (!launcher.ok) {
    problems.push(...launcher.problems);
    return { ok: false, problems, override: null, bundle, source: null };
  }
  const expected = expectedTarballNames(version, launcher.stagedVersion);
  const present = Object.keys(bundle.tarballs);
  for (const name of expected)
    if (!present.includes(name)) problems.push(`bundle is missing ${name}`);
  for (const name of present)
    if (!expected.includes(name))
      problems.push(`bundle carries an unexpected archive ${name}`);
  // Article 3 clause 5, checked mechanically on the exact files that publish,
  // not only when the bundle was built.
  if (present.includes(expected[0])) {
    const equivalence = await checkEquivalence({
      rcTarball: launcher.stagedTarball,
      finalTarball: launcher.final.path,
      rcVersion: launcher.stagedVersion,
      version,
    });
    for (const problem of equivalence.problems)
      problems.push(`launcher substitution: ${problem}`);
  }

  const fetched = await fetch(version);
  if (!fetched.doc) {
    problems.push(
      `no opum-cli-e2e qualification receipt at ${fetched.source} (${fetched.error ?? "unreadable"})`,
    );
    return {
      ok: false,
      problems,
      override: null,
      bundle,
      launcher,
      source: fetched.source,
    };
  }
  const verdict = evaluateReceipt(fetched.doc, {
    version,
    commit,
    releaseRunId,
    tarballs: bundle.tarballs,
    launcherVersion: launcher.stagedVersion,
    finalTarball: launcher.final,
  });
  problems.push(...verdict.problems);
  return {
    ok: problems.length === 0,
    problems,
    override: verdict.override,
    bundle,
    launcher,
    source: fetched.source,
  };
}

/** Printed verbatim whenever an override is what let a publish proceed. */
export function describeOverride(override, source) {
  return [
    "",
    "!!! QUALIFICATION OVERRIDE IN USE !!!",
    `The receipt at ${source} does not record QUALIFIED. It carries this override, printed verbatim:`,
    JSON.stringify(override, null, 2),
    "",
  ].join("\n");
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
  if (!argv.includes("--require"))
    throw new Error(
      "usage: e2e-receipt.mjs --require --bundle <dir> --run-id <id> --commit <sha> --version <v>",
    );
  const bundleDir = flag("--bundle");
  const releaseRunId = flag("--run-id");
  const commit = flag("--commit");
  const version = flag("--version");
  if (!bundleDir || !releaseRunId || !commit || !version)
    throw new Error(
      "--bundle, --run-id, --commit and --version are all required",
    );
  const gate = await requireQualification({
    bundleDir,
    version,
    commit,
    releaseRunId,
  });
  if (!gate.ok) {
    console.error(
      `Refusing to publish ${version} at ${commit.slice(0, 7)}: no opum-cli-e2e qualification receipt binds these bytes.`,
    );
    for (const problem of gate.problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  if (gate.override) console.log(describeOverride(gate.override, gate.source));
  console.log(
    `opum-cli-e2e receipt ${gate.source} binds ${version} at ${commit.slice(0, 7)}, run ${releaseRunId}, all ${Object.keys(gate.bundle.tarballs).length} staged tarballs (launcher ${gate.launcher.stagedVersion}), and the ${version} launcher.`,
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
