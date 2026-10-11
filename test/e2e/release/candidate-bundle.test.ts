import { expect, test } from "bun:test";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const { stdout } = await execFile(command, [...args], { cwd });
  return stdout;
}

import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCandidateBundle,
  executableFor,
  REQUIRED_PLATFORMS,
} from "../../../scripts/build-candidate-bundle.mjs";

/**
 * QCLI-135 follow-through. The bundle is how downstream qualification
 * exercises an unpublished build, so the failures worth testing are the ones
 * that would make a run report a product defect when the real problem was a
 * build that was never finished, or bytes that do not match their own manifest.
 */

const COMMIT = "a".repeat(40);

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A minimal repository tree: a root package plus six platform packages. */
async function fixture(
  options: { readonly omit?: string; readonly version?: string } = {},
): Promise<string> {
  const version = options.version ?? "9.9.9";
  const directory = await mkdtemp(join(tmpdir(), "quest-candidate-fixture-"));
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(join(directory, "bin", "quest.cjs"), "#!/usr/bin/env node\n");
  await writeFile(join(directory, "LICENSE"), "MIT\n");
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "@opum-ai/quest",
      version,
      bin: { quest: "./bin/quest.cjs" },
      files: ["bin/quest.cjs", "LICENSE"],
      questPlatformPackages: { stale: "values" },
      optionalDependencies: Object.fromEntries(
        REQUIRED_PLATFORMS.map((platform) => [
          `@opum-ai/quest-${platform}`,
          version,
        ]),
      ),
    }),
  );
  for (const platform of REQUIRED_PLATFORMS) {
    if (platform === options.omit) continue;
    const packageDirectory = join(directory, "npm", `quest-${platform}`);
    await mkdir(join(packageDirectory, "bin"), { recursive: true });
    const bytes = `binary for ${platform}`;
    await writeFile(
      join(packageDirectory, "bin", executableFor(platform)),
      bytes,
    );
    await writeFile(join(packageDirectory, "LICENSE"), "MIT\n");
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({
        name: `@opum-ai/quest-${platform}`,
        version,
        files: [`bin/${executableFor(platform)}`],
        questBinarySha256: sha256(bytes),
      }),
    );
  }
  return directory;
}

/**
 * A fixture that is also a Git repository with everything committed, so the
 * comparison against the committed blobs (QCLI-419) has a repository to run
 * in. It needs one: outside a repository `git diff` runs in --no-index mode
 * and exits 1 for an inaccessible path, which reads as "rebuilt".
 */
async function commitFixture(directory: string): Promise<string> {
  await run("git", ["init", "-q"], directory);
  await run("git", ["config", "user.email", "t@example.com"], directory);
  await run("git", ["config", "user.name", "t"], directory);
  await run("git", ["add", "-A"], directory);
  await run("git", ["commit", "-qm", "fixture"], directory);
  return (await run("git", ["rev-parse", "HEAD"], directory)).trim();
}

test("the bundle matches the consumer's contract exactly", async () => {
  const directory = await fixture();
  const out = await mkdtemp(join(tmpdir(), "quest-candidate-out-"));
  try {
    const commit = await commitFixture(directory);
    // Committed artifacts are the release-ref shape since QCLI-419: off a
    // release ref they refuse, because nothing rebuilt them for this source.
    const built = await buildCandidateBundle({
      commit,
      out,
      directory,
      releaseRef: true,
    });

    // Every field opum-cli-e2e reads. sourceCommit is required and it throws
    // before recording a row if absent, so a wrong shape here costs a whole run.
    const metadata = JSON.parse(
      await readFile(join(out, "evidence", "package-metadata.json"), "utf8"),
    );
    expect(metadata.sourceCommit).toBe(commit);
    expect(metadata.version).toBe("9.9.9");
    expect(metadata.packages.map((row: { name: string }) => row.name)).toEqual(
      REQUIRED_PLATFORMS.map((platform) => `@opum-ai/quest-${platform}`),
    );
    for (const row of metadata.packages)
      expect(row.name).toMatch(/^@opum-ai\/quest-(.+)$/);

    // The root tarball's filename is matched by name downstream. Since
    // QCLI-399 (Article 3 clause 5, ODOC-302) the STAGED launcher is X-rc.N,
    // and the X launcher sits apart in final/: it is never staged.
    const names = built.digests.map(
      (row: { filename: string }) => row.filename,
    );
    expect(names).toContain("opum-ai-quest-9.9.9-rc.1.tgz");
    expect(names).not.toContain("opum-ai-quest-9.9.9.tgz");
    expect(built.rcVersion).toBe("9.9.9-rc.1");
    expect(metadata.launcher).toMatchObject({
      stagedVersion: "9.9.9-rc.1",
      stagedTarball: "opum-ai-quest-9.9.9-rc.1.tgz",
      finalVersion: "9.9.9",
      finalTarball: "final/opum-ai-quest-9.9.9.tgz",
    });
    const finalLines = (
      await readFile(join(out, "final", "sha256.txt"), "utf8")
    )
      .trim()
      .split("\n");
    expect(finalLines).toEqual([
      `${sha256(await readFile(join(out, "final", "opum-ai-quest-9.9.9.tgz")))}  opum-ai-quest-9.9.9.tgz`,
    ]);
    expect(metadata.launcher.finalSha256).toBe(built.final.digest);

    // sha256.txt lines are '<digest>  <filename>' and must be true of the
    // bytes on disk, not merely internally consistent.
    const lines = (await readFile(join(out, "tarballs", "sha256.txt"), "utf8"))
      .trim()
      .split("\n");
    expect(lines.length).toBe(7);
    for (const line of lines) {
      const [digest, filename] = line.split("  ");
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(
        sha256(await readFile(join(out, "tarballs", filename as string))),
      ).toBe(digest);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("a five-platform build refuses rather than producing a bundle", async () => {
  // Downstream this would surface as a coverage failure that reads like a
  // product defect. It is a build that was never finished, so it fails here.
  const directory = await fixture({ omit: "win32-arm64" });
  const out = await mkdtemp(join(tmpdir(), "quest-candidate-out-"));
  try {
    await expect(
      buildCandidateBundle({ commit: COMMIT, out, directory }),
    ).rejects.toThrow(/missing: win32-arm64/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("a binary that disagrees with its own manifest never reaches a bundle", async () => {
  const directory = await fixture();
  const out = await mkdtemp(join(tmpdir(), "quest-candidate-out-"));
  try {
    await writeFile(
      join(directory, "npm", "quest-linux-x64", "bin", "quest"),
      "swapped after the manifest was written",
    );
    await expect(
      buildCandidateBundle({ commit: COMMIT, out, directory }),
    ).rejects.toThrow(/does not match its own manifest/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("a platform package left at the previous version is refused", async () => {
  const directory = await fixture();
  const out = await mkdtemp(join(tmpdir(), "quest-candidate-out-"));
  try {
    const path = join(directory, "npm", "quest-darwin-x64", "package.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...manifest, version: "9.9.8" }));
    await expect(
      buildCandidateBundle({ commit: COMMIT, out, directory }),
    ).rejects.toThrow(/version 9\.9\.8, root is 9\.9\.9/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("the packed root carries re-derived digests, and the working tree is left untouched", async () => {
  const directory = await fixture();
  const out = await mkdtemp(join(tmpdir(), "quest-candidate-out-"));
  try {
    const before = await readFile(join(directory, "package.json"), "utf8");
    // A repository plus releaseRef for the same reasons as the contract test
    // above (QCLI-419).
    const commit = await commitFixture(directory);
    await buildCandidateBundle({
      commit,
      out,
      directory,
      releaseRef: true,
    });

    // The digests must be re-derived from the binaries actually present, or a
    // bundle assembled from separately-built artifacts advertises the previous
    // release's values.
    // Both launchers: the staged rc and the X that reaches latest.
    for (const [packed, version] of [
      [join(out, "tarballs", "opum-ai-quest-9.9.9-rc.1.tgz"), "9.9.9-rc.1"],
      [join(out, "final", "opum-ai-quest-9.9.9.tgz"), "9.9.9"],
    ] as const) {
      const extracted = join(out, `root-${version}`);
      await mkdir(extracted, { recursive: true });
      await execFile("tar", ["xzf", packed, "-C", extracted]);
      const shipped = JSON.parse(
        await readFile(join(extracted, "package", "package.json"), "utf8"),
      );
      expect(shipped.version).toBe(version);
      for (const platform of REQUIRED_PLATFORMS) {
        expect(
          shipped.questPlatformPackages[`@opum-ai/quest-${platform}`],
        ).toBe(sha256(`binary for ${platform}`));
        // The rc launcher pins the platforms at exactly X, not at the rc.
        expect(shipped.optionalDependencies[`@opum-ai/quest-${platform}`]).toBe(
          "9.9.9",
        );
      }
      expect(shipped.questPlatformPackages.stale).toBeUndefined();
    }

    // And the repository is left exactly as it was found. A build step that
    // mutates the working tree eventually has that mutation swept into an
    // unrelated commit — which happened: a red-case test's tampered digest
    // reached dev inside another change and failed CI there.
    expect(await readFile(join(directory, "package.json"), "utf8")).toBe(
      before,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("a pack failure during bundle assembly leaves the root package.json untouched", async () => {
  // QCLI-420: the mutation window (re-derived digests, then a version swap per
  // launcher) used to restore package.json only on the success path, so a throw
  // from packing left the tree rewritten with version X-rc.N and re-derived
  // digests. npm always ships a package's `bin` files, so removing the root
  // launcher makes the packed root tarball omit package/bin/quest.cjs and
  // pack() throw. That file is at the root, not under npm/quest-<platform>/, so
  // the QCLI-419 rebuilt check is unaffected and releaseRef: true reaches
  // packing (off a release ref committed platform artifacts refuse earlier).
  const directory = await fixture();
  const out = await mkdtemp(join(tmpdir(), "quest-candidate-out-"));
  try {
    const commit = await commitFixture(directory);
    await rm(join(directory, "bin", "quest.cjs"));
    // The pre-run state the function must restore to.
    const before = await readFile(join(directory, "package.json"), "utf8");
    await expect(
      buildCandidateBundle({ commit, out, directory, releaseRef: true }),
    ).rejects.toThrow(/does not contain package\/bin\/quest\.cjs/);
    expect(await readFile(join(directory, "package.json"), "utf8")).toBe(
      before,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("a tarball-name mismatch during bundle assembly leaves the root package.json untouched", async () => {
  // The other throw inside the mutation window: packLauncher writes the root
  // package.json with its packed version, then the archive npm produces must be
  // named tarballName("@opum-ai/quest", version). A different root `name` makes
  // npm name the archive after it instead, so packLauncher throws after the
  // rewrite — the failure path QCLI-420 moved into a finally.
  const directory = await fixture();
  const out = await mkdtemp(join(tmpdir(), "quest-candidate-out-"));
  try {
    const commit = await commitFixture(directory);
    const packagePath = join(directory, "package.json");
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    await writeFile(
      packagePath,
      JSON.stringify({ ...manifest, name: "@opum-ai/quest-demo" }),
    );
    // Captured after the mutation, so it is the pre-run state the function must
    // restore to.
    const before = await readFile(packagePath, "utf8");
    await expect(
      buildCandidateBundle({ commit, out, directory, releaseRef: true }),
    ).rejects.toThrow(/root archive is .*expected/);
    expect(await readFile(packagePath, "utf8")).toBe(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("a bundle without a real source commit is refused", async () => {
  const directory = await fixture();
  const out = await mkdtemp(join(tmpdir(), "quest-candidate-out-"));
  try {
    await expect(
      buildCandidateBundle({ commit: "not-a-commit", out, directory }),
    ).rejects.toThrow(/not a 40-hex commit id/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("a source commit that does not resolve refuses before any artifact is tied to it", async () => {
  // Two measured shapes, found reviewing QCLI-419. A directory with no
  // repository behind it: `git diff` switches to --no-index mode and reports
  // every path as a difference, which read as "rebuilt" and built a bundle
  // anyway. And a 40-hex commit the repository does not have: it contributed
  // nothing to `rebuilt`, so the refusal named committed artifacts rather
  // than the real cause.
  const checked = await fixture();
  const unchecked = await fixture();
  const out = await mkdtemp(join(tmpdir(), "quest-candidate-out-"));
  try {
    await commitFixture(checked);
    await expect(
      buildCandidateBundle({ commit: COMMIT, out, directory: checked }),
    ).rejects.toThrow(/does not resolve to a commit/);
    await expect(
      buildCandidateBundle({ commit: COMMIT, out, directory: unchecked }),
    ).rejects.toThrow(/does not resolve to a commit/);
  } finally {
    await rm(checked, { recursive: true, force: true });
    await rm(unchecked, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
});

test("a bundle refuses committed platform artifacts off a release ref, and refuses rebuilds on one", async () => {
  // Bun's --compile output is not byte-reproducible, so a bundle assembled
  // from fresh builds names a commit whose bytes it does not contain. That
  // happened, and was caught downstream by digest comparison rather than here.
  // The mirror image is the measured QCLI-419 defect: off a release ref
  // nothing rebuilt the platform packages, so they are bytes the tree already
  // carried — an earlier release's build — and a laptop run stamped them with
  // the current sourceCommit and called them "committed".
  const directory = await fixture();
  const out = await mkdtemp(join(tmpdir(), "quest-candidate-out-"));
  try {
    const commit = await commitFixture(directory);

    // The violating shape: committed artifacts, no release ref. It refuses
    // BEFORE packing, so nothing is written: not the metadata, and not the
    // root package.json rewrite the packing path performs below the check.
    const before = await readFile(join(directory, "package.json"), "utf8");
    await expect(
      buildCandidateBundle({ commit, out, directory }),
    ).rejects.toThrow(/committed platform artifacts/);
    await expect(
      readFile(join(out, "evidence", "package-metadata.json"), "utf8"),
    ).rejects.toThrow();
    expect(await readFile(join(directory, "package.json"), "utf8")).toBe(
      before,
    );

    // On a release ref the same committed bytes are the shape that ships.
    const committed = await buildCandidateBundle({
      commit,
      out,
      directory,
      releaseRef: true,
    });
    expect(committed.artifactProvenance).toBe("committed");
    const metadata = JSON.parse(
      await readFile(join(out, "evidence", "package-metadata.json"), "utf8"),
    );
    expect(metadata.sourceCommit).toBe(commit);
    expect(metadata.artifactProvenance).toBe("committed");
    expect(metadata.rebuiltPlatforms).toBeUndefined();

    // A real rebuild regenerates the manifest too, so the manifest check
    // cannot catch it. Only the comparison against the committed blob can.
    const bytes = "a genuinely rebuilt binary";
    await writeFile(
      join(directory, "npm", "quest-linux-arm64", "bin", "quest"),
      bytes,
    );
    const manifestPath = join(
      directory,
      "npm",
      "quest-linux-arm64",
      "package.json",
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...JSON.parse(await readFile(manifestPath, "utf8")),
        questBinarySha256: sha256(bytes),
      }),
    );

    // Off a release ref this is the accepted shape: matrix-built artifacts.
    const rebuilt = await buildCandidateBundle({ commit, out, directory });
    expect(rebuilt.artifactProvenance).toBe("rebuilt");
    expect(
      JSON.parse(
        await readFile(join(out, "evidence", "package-metadata.json"), "utf8"),
      ).rebuiltPlatforms,
    ).toEqual(["linux-arm64"]);

    // On a release ref it is fatal: a release publishes the committed bytes,
    // so a bundle of rebuilds describes something else entirely.
    await expect(
      buildCandidateBundle({ commit, out, directory, releaseRef: true }),
    ).rejects.toThrow(/rebuilt artifacts.*linux-arm64/s);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  }
  // QCLI-466: this test builds several candidate bundles, which is far slower
  // than bun's 5000ms per-test default allows for under CI load. Measured in
  // CI (prepublication-qualification run 37689693005, 2026-10-07): it hit that
  // cap and was killed at 5000.80ms, while the heaviest siblings in this same
  // file ran ~2470ms; locally it runs ~3.4s. 60_000 -- the repo's slow-test
  // convention -- gives a wide margin over that measured CI floor, so the same
  // tree cannot pass source-gates on one run and fail on another.
}, 60_000);
