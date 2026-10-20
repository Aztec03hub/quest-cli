// QCLI-509 / DEC-204. The release gate's missing half.
//
// `check-package-artifacts.mjs` has always hashed each committed platform
// binary and compared the digest to two copies of a number that is
// regenerated FROM THAT SAME BINARY: the platform manifest's
// `questBinarySha256` and root `questPlatformPackages[...]`. The map can never
// disagree with the bytes it was computed from, and nothing rebuilds from the
// current `src/` and compares, so a binary stale relative to the source passes
// by construction. QCLI-438 records the measured consequence: five of the six
// committed binaries shipped the pre-fix `--source <project>` help string
// while `grep -- '--source <project>' src/` returned nothing, and 0.13.0
// shipped a darwin-arm64 binary with no `--fields` support at all.
//
// This module supplies the part a digest cannot: a behavioural probe. It
// executes the committed binary and requires it to answer commands that exist
// only in this source tree. Measured on 2026-10-19 at dev b337381d, with the
// committed darwin-arm64 binary (sha256 59d1c0dc...):
//
//   task list --fields id          exit 2 "Unrecognized flag --fields."
//   task view <id> --fields title  exit 2 "Unrecognized flag --fields."
//
// while the same two commands from `src/cli/main.ts` exit 0 and print one id
// per line / one title line. A binary built from this tree therefore passes,
// and a stale one goes red -- which is the difference the checksum map cannot
// see.
//
// WHY THE PROBE IS RELEASE-SCOPED, NOT ALWAYS ON. `check:packages` runs inside
// `source-gates`, the required PR context, and the release runbook depends on
// it passing in an intermediate state: a "strings" bump commits the new
// version strings while the binaries are still the previous bytes, so that
// `source-gates` stays green long enough for `immutable-candidates` to build
// the new ones. If the probe ran in `source-gates`, a strings-only bump whose
// binaries predate the new source would go red, `immutable-candidates` would
// never run, and the gate that asks for fresh bytes would be the gate the
// stale bytes break -- the trap the runbook's "Why strings first, then bytes"
// section exists to describe. So the probe runs only where a binary is
// actually about to ship and there is no later CI build to correct it:
//
//   - `QUEST_QUALIFICATION_TARGET` equals this host's target. That is the
//     native qualification job (`immutable-candidates`). On a tag ref that
//     job runs no rebuild, so it executes the COMMITTED artifact as-is -- the
//     last thing between these bytes and the registry; on a dispatched run it
//     runs `build:packages` first, so the binary it probes is the one that run
//     just built from this tree.
//   - or `QUEST_RELEASE_BINARY_PROBE=1`, an explicit opt-in used by the
//     both-ways proof and available to a release session running the gate by
//     hand.
//
// In `source-gates` neither is set, so the existing identity checks there are
// unchanged and the strings-first flow still works.
//
// The probe list is the pair DEC-204 names for 0.14.0. It is deliberately a
// CAPABILITY FLOOR rather than a general staleness detector: a future release
// that adds a new user-visible surface should add a probe for it here, or the
// binary may be stale in exactly that new surface and still pass. The comment
// above the constants is the maintenance instruction.

const SUPPORTED_TARGETS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
]);

/**
 * The DEC-204 probe pair, verbatim: one list projection and one view
 * projection. `task list --fields id` proves the `--fields` flag exists and
 * projects; the id it prints is then fed to `task view <id> --fields title`,
 * which proves the same flag on the other command and that a real record can
 * be read through it. A binary that predates QCLI-291/QCLI-312 rejects both
 * with exit 2 before any record is touched.
 *
 * Each command runs twice: once in the DEC-204 spelling, whose exit code is
 * what the criterion names, and once with `--json`, whose envelope is where
 * the SHAPE is asserted. The plain form is not used for shape because
 * `task list` appends a human-only scope footer (QCLI-316) describing what
 * the listing answered about -- legitimate, variable prose that a projected
 * row count must not be inferred from. The JSON envelope carries the same
 * projection without that footer.
 */
export const PROBE_LIST_ARGS = Object.freeze([
  "task",
  "list",
  "--fields",
  "id",
]);

export const PROBE_LIST_SHAPE_ARGS = Object.freeze([
  "task",
  "list",
  "--fields",
  "id",
  "--json",
]);

/** @param {string} id */
export const PROBE_VIEW_ARGS = (id) =>
  Object.freeze(["task", "view", id, "--fields", "title"]);

/** @param {string} id */
export const PROBE_VIEW_SHAPE_ARGS = (id) =>
  Object.freeze(["task", "view", id, "--fields", "title", "--json"]);

/**
 * The platform-package suffix for this host, or `null` when the host is not
 * one of the six supported targets. Both the qualification matrix and the
 * package directory names use `process.platform`-`process.arch` spellings
 * (`darwin-arm64`, `win32-x64`, ...), so this is a direct match and not a
 * translation table.
 */
export function hostPlatformTarget(
  platform = process.platform,
  arch = process.arch,
) {
  const target = `${platform}-${arch}`;
  return SUPPORTED_TARGETS.includes(target) ? target : null;
}

/**
 * Whether this invocation is a release-context run that may execute the
 * committed binary. Returns a reason so a skipped probe can be explained in a
 * log rather than being indistinguishable from a probe that passed.
 */
export function releaseProbeEnablement({ env = process.env, target } = {}) {
  if (!target)
    return {
      enabled: false,
      reason: "this host is not one of the six supported platform targets",
    };
  if (env.QUEST_RELEASE_BINARY_PROBE === "1")
    return { enabled: true, reason: "QUEST_RELEASE_BINARY_PROBE=1" };
  if (env.QUEST_QUALIFICATION_TARGET === target)
    return {
      enabled: true,
      reason: `native qualification job for ${target}`,
    };
  return {
    enabled: false,
    reason: `not the native qualification job for ${target} (QUEST_QUALIFICATION_TARGET=${env.QUEST_QUALIFICATION_TARGET ?? "unset"})`,
  };
}

function display(args) {
  return args.join(" ");
}

function oneLine(value) {
  const text = value.trim().split("\n")[0] ?? "";
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** Parse a success envelope and return `data`, recording why when it cannot. */
function envelopeData(stdout, args, problems) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    problems.push(
      `\`${display(args)}\` did not print a JSON envelope: ${oneLine(stdout)}`,
    );
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") {
    problems.push(
      `\`${display(args)}\` printed JSON that is not an envelope: ${oneLine(stdout)}`,
    );
    return undefined;
  }
  return parsed.data;
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  return Object.keys(value).sort().join(",") === expected.join(",");
}

/**
 * Run the probe pair against one binary.
 *
 * `run` is injected so the both-ways proof can exercise a stale result and a
 * fresh result in one run without needing two 60 MB binaries, and so the
 * decision logic is tested rather than trusted. The default runner is
 * {@link spawnRunner}.
 *
 * Never passes on nothing read: a failed command, an empty listing, a row or
 * record carrying keys the projection should not have emitted, and a missing
 * id to feed the view half are all failures. A probe that cannot tell "the
 * flag is supported" from "the flag was accepted but ignored" would let a
 * half-implemented projection through, which is the same class of defect as
 * the checksum comparison this replaces.
 */
export async function probeReleaseBinary({ run }) {
  const problems = [];
  let probesRun = 0;

  const listPlain = await run(PROBE_LIST_ARGS);
  probesRun += 1;
  if (listPlain.status !== 0) {
    problems.push(
      `\`${display(PROBE_LIST_ARGS)}\` exited ${listPlain.status}: ${oneLine(listPlain.stderr || listPlain.stdout)}`,
    );
    return { ok: false, problems, probesRun, id: null };
  }

  const listShape = await run(PROBE_LIST_SHAPE_ARGS);
  probesRun += 1;
  if (listShape.status !== 0) {
    problems.push(
      `\`${display(PROBE_LIST_SHAPE_ARGS)}\` exited ${listShape.status}: ${oneLine(listShape.stderr || listShape.stdout)}`,
    );
    return { ok: false, problems, probesRun, id: null };
  }
  const rows = envelopeData(listShape.stdout, PROBE_LIST_SHAPE_ARGS, problems);
  if (!Array.isArray(rows)) {
    if (problems.length === 0)
      problems.push(
        `\`${display(PROBE_LIST_SHAPE_ARGS)}\` carried no task array, so the view half never ran. The gate refuses to pass on a probe that read nothing.`,
      );
    return { ok: false, problems, probesRun, id: null };
  }
  if (rows.length === 0) {
    problems.push(
      `\`${display(PROBE_LIST_SHAPE_ARGS)}\` returned no tasks, so the view half never ran. The gate refuses to pass on a probe that read nothing.`,
    );
    return { ok: false, problems, probesRun, id: null };
  }
  const badRow = rows.findIndex((row) => !exactKeys(row, ["id"]));
  if (badRow !== -1) {
    problems.push(
      `\`${display(PROBE_LIST_SHAPE_ARGS)}\` row ${badRow} carries keys ${JSON.stringify(Object.keys(rows[badRow] ?? {}))}; a --fields id projection carries exactly ["id"]. The flag was accepted but the projection was not applied.`,
    );
  }
  const id = typeof rows[0]?.id === "string" ? rows[0].id : null;
  if (id === null) {
    problems.push(
      `\`${display(PROBE_LIST_SHAPE_ARGS)}\` did not yield a task id to read. The gate refuses to pass on a probe that could not run its view half.`,
    );
    return { ok: false, problems, probesRun, id: null };
  }

  const viewPlain = await run(PROBE_VIEW_ARGS(id));
  probesRun += 1;
  if (viewPlain.status !== 0) {
    problems.push(
      `\`${display(PROBE_VIEW_ARGS(id))}\` exited ${viewPlain.status}: ${oneLine(viewPlain.stderr || viewPlain.stdout)}`,
    );
  }

  const viewShape = await run(PROBE_VIEW_SHAPE_ARGS(id));
  probesRun += 1;
  if (viewShape.status !== 0) {
    problems.push(
      `\`${display(PROBE_VIEW_SHAPE_ARGS(id))}\` exited ${viewShape.status}: ${oneLine(viewShape.stderr || viewShape.stdout)}`,
    );
  } else {
    const record = envelopeData(
      viewShape.stdout,
      PROBE_VIEW_SHAPE_ARGS(id),
      problems,
    );
    if (record === undefined || record === null) {
      if (problems.length === 0)
        problems.push(
          `\`${display(PROBE_VIEW_SHAPE_ARGS(id))}\` carried no data to project, so the view half proved nothing. The gate refuses to pass on a probe that read nothing.`,
        );
    } else if (!exactKeys(record, ["title"])) {
      problems.push(
        `\`${display(PROBE_VIEW_SHAPE_ARGS(id))}\` projected keys ${JSON.stringify(Object.keys(record))}; a --fields title projection carries exactly ["title"].`,
      );
    } else if (typeof record.title !== "string" || record.title.length === 0) {
      problems.push(
        `\`${display(PROBE_VIEW_SHAPE_ARGS(id))}\` projected an empty title, so the record was not read through the projection.`,
      );
    }
  }

  return { ok: problems.length === 0, problems, probesRun, id };
}

/**
 * The default runner: execute `binary` with the probe arguments and return its
 * exit status and streams. Never throws for a failed spawn -- a binary that
 * cannot be executed is a problem the gate must report, not an exception that
 * skips the report.
 */
export function spawnRunner(binary, cwd) {
  return (args) => {
    try {
      const result = Bun.spawnSync([binary, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        status: typeof result.exitCode === "number" ? result.exitCode : 1,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    } catch (error) {
      return {
        status: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
