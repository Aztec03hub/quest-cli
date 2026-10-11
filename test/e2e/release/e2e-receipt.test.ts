import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describeOverride,
  evaluateReceipt,
  expectedTarballNames,
  fetchReceipt,
  requireQualification,
} from "../../../scripts/qualification/e2e-receipt.mjs";
import {
  qualifyBundle,
  registryHoldsTarball,
} from "../../../scripts/publish-release.mjs";

/**
 * QCLI-366: publication refuses without an opum-cli-e2e qualification receipt
 * binding the exact commit, run and tarballs. The format is opum-cli-e2e's
 * (agreed on lore-cli LCLI-578); these build receipts in that shape and
 * attack each binding separately, so a reader that silently skipped one field
 * would turn exactly one case red.
 */

const VERSION = "9.9.9";
const LAUNCHER_VERSION = "9.9.9-rc.2";
const FINAL = "opum-ai-quest-9.9.9.tgz";
const COMMIT = "a".repeat(40);
const RUN = 123456789;
const names = () => expectedTarballNames(VERSION, LAUNCHER_VERSION);

let bundleDir: string;
let digests: Record<string, string>;
let finalDigest: string;
let equivalence: { ok: boolean; problems: string[] };

beforeEach(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "qcli366-bundle-"));
  await mkdir(join(bundleDir, "tarballs"));
  await mkdir(join(bundleDir, "final"));
  await mkdir(join(bundleDir, "evidence"));
  const finalBytes = Buffer.from("the X launcher");
  await writeFile(join(bundleDir, "final", FINAL), finalBytes);
  finalDigest = createHash("sha256").update(finalBytes).digest("hex");
  equivalence = { ok: true, problems: [] };
  digests = {};
  for (const name of names()) {
    const bytes = Buffer.from(`archive ${name}`);
    await writeFile(join(bundleDir, "tarballs", name), bytes);
    digests[name] = createHash("sha256").update(bytes).digest("hex");
  }
  // Present in a real bundle and deliberately not a tarball: it must not be
  // counted as an eighth archive.
  await writeFile(join(bundleDir, "tarballs", "sha256.txt"), "ignored\n");
  await writeMetadata({});
});

afterEach(async () => {
  await rm(bundleDir, { recursive: true, force: true });
});

async function writeMetadata(overrides: Record<string, unknown>) {
  await writeFile(
    join(bundleDir, "evidence", "package-metadata.json"),
    JSON.stringify({
      sourceCommit: COMMIT,
      version: VERSION,
      artifactProvenance: "committed",
      launcher: {
        name: "@opum-ai/quest",
        stagedVersion: LAUNCHER_VERSION,
        stagedTarball: `opum-ai-quest-${LAUNCHER_VERSION}.tgz`,
        finalVersion: VERSION,
        finalTarball: `final/${FINAL}`,
      },
      ...overrides,
    }),
  );
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: "opum.qualification-receipt.v1",
    product: "quest",
    version: VERSION,
    commit: COMMIT,
    releaseRunId: RUN,
    runAttempt: 1,
    tarballs: { ...digests },
    launcherVersion: LAUNCHER_VERSION,
    launcherSubstitution: {
      verdict: "MATCH",
      finalTarball: { filename: FINAL, sha256: finalDigest },
      method: "entry-by-entry after substituting 9.9.9-rc.2 with 9.9.9",
      mismatches: [],
    },
    verdict: "QUALIFIED",
    counts: { pass: 463, fail: 0, blocked: 1 },
    ...overrides,
  };
}

const gate = (doc: unknown, extra: Record<string, unknown> = {}) =>
  requireQualification({
    bundleDir,
    version: VERSION,
    commit: COMMIT,
    releaseRunId: RUN,
    fetch: async () =>
      doc === null
        ? { doc: null, source: "test", error: "HTTP 404" }
        : { doc, source: "test" },
    checkEquivalence: async () => equivalence,
    ...extra,
  });

test("no receipt refuses", async () => {
  const result = await gate(null);
  expect(result.ok).toBe(false);
  expect(result.problems.join("\n")).toContain(
    "no opum-cli-e2e qualification receipt",
  );
});

test("a matching QUALIFIED receipt passes, and sha256.txt is not an archive", async () => {
  const result = await gate(receipt());
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  expect(Object.keys(result.bundle.tarballs)).toHaveLength(7);
});

test("each binding refuses on its own", async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["commit", { commit: "b".repeat(40) }, "receipt describes commit"],
    ["version", { version: "9.9.8" }, "receipt describes version"],
    ["run", { releaseRunId: RUN + 1 }, "receipt describes run"],
    ["kind", { kind: "opum.native-execution-receipt.v1" }, "kind must be"],
    ["product", { product: "lore" }, "not quest"],
    ["verdict", { verdict: "NOT QUALIFIED" }, "carries no override"],
  ];
  for (const [label, overrides, expected] of cases) {
    const result = await gate(receipt(overrides));
    expect({ label, ok: result.ok }).toEqual({ label, ok: false });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain(expected);
  }
});

test("tarball digests bind in both directions", async () => {
  const [first, second] = names();
  const wrong = await gate(
    receipt({ tarballs: { ...digests, [first]: "0".repeat(64) } }),
  );
  expect(wrong.ok).toBe(false);
  expect(wrong.problems[0]).toContain(`${first}: receipt says`);

  const { [second]: _omitted, ...short } = digests;
  const missing = await gate(receipt({ tarballs: short }));
  expect(missing.problems[0]).toContain(`${second}: not in the receipt`);

  const extra = await gate(
    receipt({ tarballs: { ...digests, "stray.tgz": "1".repeat(64) } }),
  );
  expect(extra.problems[0]).toContain("stray.tgz: named in the receipt");
});

test("an override in the file waives the verdict and nothing else", async () => {
  const override = {
    by: "operator",
    reason: "scale row unbound",
    task: "TASK-107",
    adr: "docs/adr/x.md@9222079",
  };
  const passed = await gate(receipt({ verdict: "NOT QUALIFIED", override }));
  expect(passed.ok).toBe(true);
  expect(passed.override).toEqual(override);
  expect(describeOverride(override, "test")).toContain(
    '"reason": "scale row unbound"',
  );

  const [first] = names();
  const stillBound = await gate(
    receipt({
      verdict: "NOT QUALIFIED",
      override,
      tarballs: { ...digests, [first]: "0".repeat(64) },
    }),
  );
  expect(stillBound.ok).toBe(false);
});

test("a bundle of rebuilt binaries, another commit, or a missing archive refuses", async () => {
  await writeMetadata({ artifactProvenance: "rebuilt" });
  expect((await gate(receipt())).problems[0]).toContain("provenance");

  await writeMetadata({ sourceCommit: "c".repeat(40) });
  expect((await gate(receipt())).problems[0]).toContain(
    "bundle was built from",
  );

  await writeMetadata({});
  const [first] = names();
  await rm(join(bundleDir, "tarballs", first));
  const { [first]: _gone, ...rest } = digests;
  expect((await gate(receipt({ tarballs: rest }))).problems).toEqual([
    `bundle is missing ${first}`,
  ]);
});

test("a malformed document is refused, not thrown", () => {
  for (const doc of [null, [], "QUALIFIED", 7])
    expect(
      evaluateReceipt(doc, {
        version: VERSION,
        commit: COMMIT,
        releaseRunId: RUN,
        tarballs: digests,
        launcherVersion: LAUNCHER_VERSION,
        finalTarball: { filename: FINAL, sha256: finalDigest },
      }).ok,
    ).toBe(false);
});

test("an unreadable receipt reads as no receipt", async () => {
  const result = await fetchReceipt(VERSION, {
    execFile: async () => {
      throw Object.assign(new Error("exit 1"), {
        stderr: "gh: Not Found (HTTP 404)\n",
      });
    },
  });
  expect(result.doc).toBeNull();
  expect(result.error).toBe("gh: Not Found (HTTP 404)");
  expect(result.source).toBe(
    "opum-ai/opum-cli-e2e@main:receipts/quest/9.9.9.json",
  );
});

// QCLI-396: the receipt read pins the host, so a GH_HOST in the environment
// cannot redirect the read that gates publication away from github.com.
test("the receipt fetch pins --hostname github.com despite a hostile GH_HOST", async () => {
  const prior = process.env.GH_HOST;
  process.env.GH_HOST = "evil.example";
  try {
    const calls: Array<{ file: string; args: string[] }> = [];
    const result = await fetchReceipt(VERSION, {
      execFile: async (file: string, args: readonly string[]) => {
        calls.push({ file, args: [...args] });
        return { stdout: JSON.stringify(receipt()), stderr: "" };
      },
    });
    expect(result.doc).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("gh");
    expect(calls[0].args.slice(0, 3)).toEqual([
      "api",
      "--hostname",
      "github.com",
    ]);
    expect(calls[0].args).toContain("github.com");
    expect(calls[0].args).not.toContain("evil.example");
  } finally {
    if (prior === undefined) delete process.env.GH_HOST;
    else process.env.GH_HOST = prior;
  }
});

test("the publisher checks the run before downloading anything from it", async () => {
  const calls: string[][] = [];
  const run = {
    path: ".github/workflows/prepublication-qualification.yml",
    head_sha: COMMIT,
    conclusion: "success",
  };
  const gh = (answer: object) => async (args: string[]) => {
    calls.push(args);
    return { stdout: JSON.stringify(answer), stderr: "" };
  };

  for (const wrong of [
    { ...run, head_sha: "d".repeat(40) },
    { ...run, path: ".github/workflows/release.yml" },
    { ...run, conclusion: "failure" },
  ]) {
    calls.length = 0;
    const result = await qualifyBundle({
      runId: RUN,
      commit: COMMIT,
      version: VERSION,
      into: bundleDir,
      gh: gh(wrong),
      gate: async () => {
        throw new Error("gate must not run");
      },
    });
    expect(result.ok).toBe(false);
    expect(calls.some((args) => args[0] === "run")).toBe(false);
  }

  calls.length = 0;
  const seen: unknown[] = [];
  const result = await qualifyBundle({
    runId: RUN,
    commit: COMMIT,
    version: VERSION,
    into: bundleDir,
    gh: gh(run),
    gate: async (input: unknown) => {
      seen.push(input);
      return { ok: true, problems: [] };
    },
  });
  expect(result.ok).toBe(true);
  expect(calls[1]).toContain("quest-candidate-bundle");
  expect(seen).toEqual([
    { bundleDir, version: VERSION, commit: COMMIT, releaseRunId: RUN },
  ]);
});

test("neither publisher offers an override outside the receipt", async () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const sources = await Promise.all(
    [
      "scripts/publish-release.mjs",
      "scripts/qualification/e2e-receipt.mjs",
      ".github/workflows/release.yml",
    ].map((path) => readFile(join(root, path), "utf8")),
  );
  for (const source of sources)
    expect(source).not.toMatch(
      /--(skip|no|allow|force)[-a-z]*(qualif|receipt|e2e)/i,
    );
});

// QCLI-366 review findings, each proven against the real 0.10.0 bundle by the
// reviewer before it was fixed here.

test("a receipt naming an inherited property as an extra tarball refuses", async () => {
  for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
    const result = await gate(
      receipt({ tarballs: { ...digests, [key]: "1".repeat(64) } }),
    );
    expect({ key, ok: result.ok }).toEqual({ key, ok: false });
    expect(result.problems[0]).toContain(`${key}: named in the receipt`);
  }
  const proto = JSON.parse(
    JSON.stringify(receipt()).replace(
      '"tarballs":{',
      `"tarballs":{"__proto__":"${"1".repeat(64)}",`,
    ),
  );
  expect((await gate(proto)).ok).toBe(false);
});

test("an override without its four named fields waives nothing", async () => {
  const full = { by: "a", reason: "b", task: "c", adr: "d" };
  for (const override of [
    {},
    [],
    "yes",
    { ...full, reason: "  " },
    { by: "a", reason: "b", task: "c" },
  ]) {
    const result = await gate(receipt({ verdict: "NOT QUALIFIED", override }));
    expect(result.ok).toBe(false);
    expect(result.override).toBeNull();
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("override must name");
  }
});

test("an already-published package is skipped only when the registry holds the qualified bytes", async () => {
  const [name] = names();
  const tarball = join(bundleDir, "tarballs", name);
  const integrity = `sha512-${createHash("sha512")
    .update(await readFile(tarball))
    .digest("base64")}`;
  const answering = (stdout: string) => async () => ({ stdout, stderr: "" });

  const held = await registryHoldsTarball("@opum-ai/quest", VERSION, tarball, {
    execFile: answering(`${integrity}\n`),
  });
  expect(held.ok).toBe(true);

  const repacked = await registryHoldsTarball(
    "@opum-ai/quest",
    VERSION,
    tarball,
    { execFile: answering("sha512-somethingelse==\n") },
  );
  expect(repacked.ok).toBe(false);
  expect(repacked.expected).toBe(integrity);
});

// QCLI-399, opum-cli-e2e TASK-126 (receipts/README.md blob 241ac885, "Root
// launcher rc-staging"): the launcher stages as X-rc.N, and the receipt
// carries opum-cli-e2e's own substitution verdict naming the X launcher.

test("QCLI-399: the staged set is the rc launcher plus six platforms at X", () => {
  expect(names()[0]).toBe("opum-ai-quest-9.9.9-rc.2.tgz");
  expect(
    names()
      .slice(1)
      .every((name) => name.endsWith("-9.9.9.tgz")),
  ).toBe(true);
  for (const bad of [
    undefined,
    "9.9.9",
    "9.9.9-rc.0",
    "9.9.8-rc.1",
    "9.9.9-rc.1x",
  ])
    expect(() => expectedTarballNames(VERSION, bad as string)).toThrow();
});

test("QCLI-399: each launcher binding refuses on its own", async () => {
  const substitution = receipt().launcherSubstitution;
  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      "no launcherVersion",
      { launcherVersion: undefined },
      "launcherVersion must be",
    ],
    [
      "another release's rc",
      { launcherVersion: "9.9.8-rc.2" },
      "launcherVersion must be",
    ],
    [
      "another rc",
      { launcherVersion: "9.9.9-rc.1" },
      "the bundle stages 9.9.9-rc.2",
    ],
    [
      "no substitution",
      { launcherSubstitution: undefined },
      "no launcherSubstitution",
    ],
    [
      "MISMATCH",
      {
        launcherSubstitution: {
          ...substitution,
          verdict: "MISMATCH",
          mismatches: ["package/README.md"],
        },
      },
      'not "MATCH": "package/README.md"',
    ],
    [
      "final filename",
      {
        launcherSubstitution: {
          ...substitution,
          finalTarball: { ...substitution.finalTarball, filename: "x.tgz" },
        },
      },
      "finalTarball.filename",
    ],
    [
      "final digest",
      {
        launcherSubstitution: {
          ...substitution,
          finalTarball: {
            ...substitution.finalTarball,
            sha256: "0".repeat(64),
          },
        },
      },
      "finalTarball.sha256",
    ],
  ];
  for (const [label, overrides, expected] of cases) {
    const result = await gate(receipt(overrides));
    expect({ label, ok: result.ok }).toEqual({ label, ok: false });
    expect({ label, problems: result.problems.length }).toEqual({
      label,
      problems: 1,
    });
    expect(result.problems[0]).toContain(expected);
  }
});

test("QCLI-399: an override waives the verdict, never the launcher substitution", async () => {
  const override = { by: "a", reason: "b", task: "c", adr: "d" };
  const result = await gate(
    receipt({
      verdict: "NOT QUALIFIED",
      override,
      launcherSubstitution: {
        ...receipt().launcherSubstitution,
        verdict: "MISMATCH",
      },
    }),
  );
  expect(result.ok).toBe(false);
  expect(result.problems).toHaveLength(1);
  expect(result.problems[0]).toContain("launcherSubstitution.verdict");
});

test("QCLI-399: the final digest is re-derived from the bundle's bytes, not its metadata", async () => {
  await writeFile(join(bundleDir, "final", FINAL), "different bytes");
  const result = await gate(receipt());
  expect(result.ok).toBe(false);
  expect(result.problems[0]).toContain("finalTarball.sha256");
});

test("QCLI-399: the substitution check re-runs on the bundle being published", async () => {
  equivalence = { ok: false, problems: ["package/bin/quest.cjs: differs"] };
  const result = await gate(receipt());
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual([
    "launcher substitution: package/bin/quest.cjs: differs",
  ]);
});

test("QCLI-399: a bundle without a launcher block, or with a wrong one, refuses", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ launcher: undefined }, "no launcher block"],
    [
      {
        launcher: {
          name: "@opum-ai/quest",
          stagedVersion: "9.9.9",
          finalVersion: VERSION,
        },
      },
      'stages as "9.9.9"',
    ],
    [
      {
        launcher: {
          name: "@opum-ai/quest",
          stagedVersion: LAUNCHER_VERSION,
          finalVersion: "9.9.8",
        },
      },
      'final version is "9.9.8"',
    ],
  ];
  for (const [overrides, expected] of cases) {
    await writeMetadata(overrides);
    const result = await gate(receipt());
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain(expected);
  }
  await writeMetadata({});
  await writeFile(join(bundleDir, "final", "stray.tgz"), "x");
  expect((await gate(receipt())).problems[0]).toContain(
    "final/ must hold exactly",
  );
});

test("QCLI-399: a MATCH that still lists mismatches is refused", async () => {
  const result = await gate(
    receipt({
      launcherSubstitution: {
        ...receipt().launcherSubstitution,
        mismatches: ["package/README.md"],
      },
    }),
  );
  expect(result.ok).toBe(false);
  expect(result.problems).toEqual([
    'launcherSubstitution.verdict is "MATCH" but lists 1 mismatch(es); a MATCH has none',
  ]);
});
