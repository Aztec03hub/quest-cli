import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ArtifactVerificationError,
  binaryNameFor,
  packageNameFor,
  runInstallCandidates,
  TARGETS,
  verifyArtifactSet,
} from "../scripts/install-platform-candidates.mjs";

/**
 * QCLI-305. Stage two of a bump installs the six platform candidate packages
 * that a qualification run built. The install's whole integrity value is that
 * it recomputes each binary's sha256 and compares it to that artifact's own
 * manifest BEFORE anything is written, so a tampered or truncated artifact
 * stops the run with nothing on disk. These tests prove that refusal path,
 * the clean path, and that a downloaded binary is never executed.
 */

interface FixtureOptions {
  /** A target whose binary is corrupted after its manifest is written. */
  readonly tamperTarget?: string;
  /** A target whose manifest is written under the wrong package name. */
  readonly mislabelTarget?: string;
  /** Override the bytes written as every binary. */
  readonly binaryBody?: (target: string) => Buffer;
}

async function makeSourceRoot(options: FixtureOptions = {}): Promise<string> {
  const sourceRoot = await mkdtemp(join(tmpdir(), "qcli305-source-"));
  for (const target of TARGETS) {
    const directory = join(sourceRoot, `quest-package-${target}`);
    await mkdir(join(directory, "bin"), { recursive: true });
    const body =
      options.binaryBody?.(target) ?? Buffer.from(`binary for ${target}\n`);
    await writeFile(join(directory, "bin", binaryNameFor(target)), body);
    await writeFile(join(directory, "LICENSE"), "MIT\n");
    const digest = createHash("sha256").update(body).digest("hex");
    const name =
      options.mislabelTarget === target
        ? "@opum-ai/quest-something-else"
        : packageNameFor(target);
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({ name, version: "0.13.0", license: "MIT", questBinarySha256: digest }, null, 2)}\n`,
    );
  }
  if (options.tamperTarget) {
    // Corrupt the binary AFTER its manifest was written, so the declared
    // digest no longer describes the bytes on disk.
    const target = options.tamperTarget;
    await writeFile(
      join(sourceRoot, `quest-package-${target}`, "bin", binaryNameFor(target)),
      Buffer.from("tampered\n"),
    );
  }
  return sourceRoot;
}

async function makeWritableRoot(): Promise<{
  writableRoot: string;
  before: string;
}> {
  const writableRoot = await mkdtemp(join(tmpdir(), "qcli305-writable-"));
  const before = `${JSON.stringify(
    {
      name: "@opum-ai/quest",
      version: "0.13.0",
      questPlatformPackages: {},
    },
    null,
    2,
  )}\n`;
  await writeFile(join(writableRoot, "package.json"), before);
  return { writableRoot, before };
}

async function refuseInstall(options: {
  sourceRoot: string;
  writableRoot: string;
}): Promise<unknown> {
  try {
    await runInstallCandidates({
      artifactSource: options.sourceRoot,
      writableRoot: options.writableRoot,
      log: () => {},
    });
    return undefined;
  } catch (error) {
    return error;
  }
}

test("a clean artifact set verifies all six binaries against their own manifests", async () => {
  const sourceRoot = await makeSourceRoot();
  const { problems, digests, verified } = await verifyArtifactSet({
    sourceRoot,
  });
  expect(problems).toEqual([]);
  expect(verified).toBe(6);
  expect(Object.keys(digests)).toHaveLength(6);
});

test("a tampered binary is refused, naming the target and both digests", async () => {
  const sourceRoot = await makeSourceRoot({ tamperTarget: "linux-x64" });
  const { problems, verified } = await verifyArtifactSet({ sourceRoot });
  expect(verified).toBe(5);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("quest-package-linux-x64");
  expect(problems[0]).toContain("sha256 mismatch");
});

test("an artifact whose manifest names the wrong package is refused", async () => {
  const sourceRoot = await makeSourceRoot({ mislabelTarget: "darwin-arm64" });
  const { problems, verified } = await verifyArtifactSet({ sourceRoot });
  expect(verified).toBe(5);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("quest-package-darwin-arm64");
  expect(problems[0]).toContain("expected @opum-ai/quest-darwin-arm64");
});

test("a tampered artifact stops the install with nothing written", async () => {
  const sourceRoot = await makeSourceRoot({ tamperTarget: "darwin-x64" });
  const { writableRoot, before } = await makeWritableRoot();
  const error = await refuseInstall({ sourceRoot, writableRoot });
  expect(error).toBeInstanceOf(ArtifactVerificationError);
  expect((error as ArtifactVerificationError).problems).toHaveLength(1);
  // Nothing written: the root manifest is byte-identical and no npm/ dir exists.
  expect(await readFile(join(writableRoot, "package.json"), "utf8")).toBe(
    before,
  );
  await expect(stat(join(writableRoot, "npm"))).rejects.toThrow();
});

test("a clean set installs every platform package and rewrites the root checksum map", async () => {
  const sourceRoot = await makeSourceRoot();
  const { writableRoot } = await makeWritableRoot();
  const { digests, written } = await runInstallCandidates({
    artifactSource: sourceRoot,
    writableRoot,
    log: () => {},
  });
  for (const target of TARGETS) {
    const directory = join(writableRoot, "npm", `quest-${target}`);
    const manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    const binary = await readFile(
      join(directory, "bin", binaryNameFor(target)),
    );
    const digest = createHash("sha256").update(binary).digest("hex");
    expect(manifest.questBinarySha256).toBe(digest);
    expect(digest).toBe(digests[packageNameFor(target)]);
    expect((await stat(join(directory, "LICENSE"))).isFile()).toBe(true);
  }
  const rootPackage = JSON.parse(
    await readFile(join(writableRoot, "package.json"), "utf8"),
  );
  expect(rootPackage.questPlatformPackages).toEqual(digests);
  // darwin-arm64's binary is the last thing written.
  expect(
    written[written.length - 1].endsWith(
      join("npm", "quest-darwin-arm64", "bin", "quest"),
    ),
  ).toBe(true);
});

test("the install recreates the destination as a fresh file, never in place (QCLI-271)", async () => {
  const sourceRoot = await makeSourceRoot();
  const { writableRoot } = await makeWritableRoot();
  // A stale file at the darwin-arm64 destination, standing in for the inode
  // whose code-signing validation state the runbook warns about. An in-place
  // copy would keep this inode; the runbook calls a fresh inode NECESSARY, so
  // the install must delete-then-recreate.
  //
  // The proof holds an OPEN HANDLE on the old file across the whole install, so
  // its inode cannot be freed and reused (DEC-172 (4ay)): inode-number
  // inequality ALONE is unsound, because a filesystem may legally hand a freed
  // number to the next create -- the GitHub runner's does, which made an
  // inode-only assertion fail there while passing on a host that does not
  // reuse. With the handle open, the destination's (dev, ino) differing from
  // the handle's AND the handle still reading the OLD bytes together prove a
  // different file took the path.
  const stale = join(writableRoot, "npm", "quest-darwin-arm64", "bin", "quest");
  await mkdir(join(writableRoot, "npm", "quest-darwin-arm64", "bin"), {
    recursive: true,
  });
  await writeFile(stale, "stale\n");
  const held = await open(stale, "r");
  try {
    const heldIdentity = await held.stat();
    await runInstallCandidates({
      artifactSource: sourceRoot,
      writableRoot,
      log: () => {},
    });
    const destination = await stat(stale);
    expect([destination.dev, destination.ino]).not.toEqual([
      heldIdentity.dev,
      heldIdentity.ino,
    ]);
    // The held handle still reads the old bytes, so the old inode was never
    // handed to the destination.
    expect((await held.readFile()).toString()).toBe("stale\n");
  } finally {
    await held.close();
  }
});

test("--dry-run verifies a real artifact set and writes nothing", async () => {
  const sourceRoot = await makeSourceRoot();
  const { writableRoot, before } = await makeWritableRoot();
  const { dryRun, verified, written } = await runInstallCandidates({
    artifactSource: sourceRoot,
    writableRoot,
    dryRun: true,
    log: () => {},
  });
  expect(dryRun).toBe(true);
  expect(verified).toBe(6);
  expect(written).toEqual([]);
  expect(await readFile(join(writableRoot, "package.json"), "utf8")).toBe(
    before,
  );
  await expect(stat(join(writableRoot, "npm"))).rejects.toThrow();
});

test("the install never executes a downloaded binary", async () => {
  // Every "binary" is a shell script that would leave a sentinel file if it
  // were ever run. The install only reads and copies bytes, so the sentinel
  // must not exist afterwards.
  const sentinelDirectory = await mkdtemp(join(tmpdir(), "qcli305-sentinel-"));
  const sentinel = join(sentinelDirectory, "executed");
  const sourceRoot = await makeSourceRoot({
    binaryBody: () => Buffer.from(`#!/bin/sh\n: > "${sentinel}"\n`),
  });
  const { writableRoot } = await makeWritableRoot();
  await runInstallCandidates({
    artifactSource: sourceRoot,
    writableRoot,
    log: () => {},
  });
  await expect(stat(sentinel)).rejects.toThrow();
});
