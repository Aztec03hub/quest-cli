import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// QCLI-296. The candidate-version predicate below is shared with the
// derivation test, so the gate and the test that a release build satisfies it
// cannot drift into two copies.
import { isCandidateReleaseVersion } from "./candidate-version.ts";
import { REGISTRY_PINS } from "./registry-visibility.mjs";
// QCLI-426. Its own module because this file runs its gates at import time,
// so a test cannot reach the helper through here without running a full
// candidate qualification.
import { spawnTarget } from "./spawn-target.mjs";

const execFile = promisify(execFileCallback);

// QCLI-492. Never resolve `bun` from PATH: on a host whose PATH bun is not the
// declared pin, a bare `bun` runs the gate under the wrong runtime.
// `npm_execpath` is the declaring bun Bun exports into every nested script's
// environment (QCLI-471); where it is absent -- CI runs this file directly as
// `bun scripts/qualification/prepublish.mjs`, not through `bun run` --
// `process.execPath` IS that same bun, because bun is the running interpreter.
const BUN = process.env.npm_execpath ?? process.execPath;
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const requestedTarget = process.env.QUEST_QUALIFICATION_TARGET;
const nativeTarget = `${process.platform}-${process.arch}`;
const report = [];

function record(name, status, detail) {
  report.push({ name, status, detail });
}

async function command(name, file, args, options = {}) {
  const { executable, argv, verbatim } = spawnTarget(file, args);
  try {
    const result = await execFile(executable, argv, {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
      // QCLI-371: no spawned quest may reach the machine's real claude or
      // codex; set here so it is in every child's ORIGINAL environment.
      env: { ...process.env, QUEST_AGENT_PLUGINS: "off" },
      ...(verbatim ? { windowsVerbatimArguments: true } : {}),
      ...options,
    });
    record(name, "passed", { command: [executable, ...argv].join(" ") });
    return result.stdout;
  } catch (error) {
    record(name, "failed", {
      command: [executable, ...argv].join(" "),
      exitCode: error.code ?? null,
      stderr: String(error.stderr ?? "").trim(),
      stdout: String(error.stdout ?? "").trim(),
    });
    throw error;
  }
}

async function attempt(gate) {
  try {
    await gate();
  } catch {
    // command() has already recorded the objective failure evidence.
  }
}

function packedEntry(value) {
  return Array.isArray(value) ? value[0] : Object.values(value)[0];
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function runSourceGates() {
  await attempt(() => command("typecheck", BUN, ["run", "typecheck"]));
  await attempt(() => command("biome", BUN, ["run", "lint"]));
  await attempt(() => command("format", BUN, ["run", "format:check"]));
  await attempt(() => command("layers", BUN, ["run", "layer:check"]));
  // QCLI-292: CI's frozen install cannot see a stale bun.lock pin until the
  // new version is published, so a bump PR has to be gated here instead.
  await attempt(() => command("lockfile_pins", BUN, ["run", "check:lockfile"]));
  // QCLI-328: a breaking CHANGELOG section at a patch-level bump is refused
  // on the bump PR itself, before anyone chooses the number again (0.6.2).
  await attempt(() =>
    command("breaking_bump", BUN, ["run", "check:breaking-bump"]),
  );
  await attempt(() =>
    command("package_artifact_delivery", BUN, [
      "run",
      "test:package-artifact-delivery",
    ]),
  );
  // QCLI-376: `bun run test` runs this first; nothing in CI ran it at all.
  await attempt(() =>
    command("repository_check_scope", BUN, [
      "run",
      "test:repository-check-scope",
    ]),
  );
  // QCLI-431: the Quest board's hooks module is neither typechecked by
  // `bun run typecheck` (its tsconfig covers src and test only) nor collected
  // by `bun test` (the engine's runner takes only *.test.tsx under the mod).
  // It is exercised by Claude Code's own engine, through scripts/mod-test.mjs,
  // so without a gate here the only thing that runs it is whoever remembers
  // to. The runner installs beside the pinned CLI below.
  await attempt(() => command("mod", BUN, ["run", "test:mod"]));
  const files = await testFiles();
  await attempt(() => checkTestCoverage(files));
  for (const [name, path] of TEST_GATES)
    await attempt(() => command(name, BUN, ["test", `./${path}`]));
  const topLevel = files.filter(
    (file) => !file.includes("/", "test/".length) && !gatedBy(file),
  );
  await attempt(() =>
    command("top_level", BUN, ["test", ...topLevel.map((file) => `./${file}`)]),
  );
}

// QCLI-375: source-gates is the only required context that runs tests, so a
// test file none of these gates names never runs in CI at all. Each gate is
// named so a failure says which suite broke; every test file under test/ not
// at its top level must fall under one of them, or be excluded here with a
// written reason. Top-level files not named below run as `top_level`.
const TEST_GATES = [
  ["unit", "test/domain"],
  ["contract", "test/contract"],
  ["integration", "test/integration"],
  ["black_box", "test/cli-tracker-process.test.ts"],
  ["fault_clone_worktree", "test/fault/git/local-git.test.ts"],
  ["migration", "test/e2e/migration"],
  ["release", "test/e2e/release"],
  ["scale", "test/scale"],
];
const TEST_EXCLUSIONS = {};

function gatedBy(file) {
  return TEST_GATES.find(
    ([, path]) => file === path || file.startsWith(`${path}/`),
  );
}

async function testFiles() {
  const entries = await readdir(join(root, "test"), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) =>
      relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"),
    )
    .sort();
}

async function checkTestCoverage(files) {
  const nested = files.filter((file) => file.includes("/", "test/".length));
  const ungated = nested.filter(
    (file) => !gatedBy(file) && !(file in TEST_EXCLUSIONS),
  );
  // A gate path that matches nothing is a gate that tests nothing and passes.
  const empty = TEST_GATES.filter(
    ([, path]) =>
      !files.some((file) => file === path || file.startsWith(`${path}/`)),
  ).map(([name]) => name);
  const detail = {
    filesRead: files.length,
    topLevel: files.length - nested.length,
    excluded: TEST_EXCLUSIONS,
    ungated,
    emptyGates: empty,
  };
  if (files.length === 0 || ungated.length > 0 || empty.length > 0) {
    record("test_coverage", "failed", detail);
    throw new Error("test_coverage");
  }
  record("test_coverage", "passed", detail);
}

async function runCandidateSmoke() {
  const target = requestedTarget ?? nativeTarget;
  if (target !== nativeTarget) {
    record("candidate_clean_install", "environment_skipped", {
      requestedTarget: target,
      nativeTarget,
      publicationBlocking: true,
      reason: "Candidate binaries must execute on their native runner.",
    });
    return;
  }
  const directory = join(root, "npm", `quest-${target}`);
  const work = await mkdtemp(join(tmpdir(), "quest-candidate-"));
  const cache = join(work, "npm-cache");
  const install = join(work, "install");
  const tarballs = [];
  try {
    await mkdir(install, { recursive: true });
    const rootPacked = JSON.parse(
      await command("root_pack", "npm", ["pack", "--json", "--cache", cache]),
    );
    const rootTarball = join(root, packedEntry(rootPacked).filename);
    tarballs.push(rootTarball);
    const platformPacked = JSON.parse(
      await command(
        "platform_pack",
        "npm",
        ["pack", "--json", "--cache", cache],
        {
          cwd: directory,
        },
      ),
    );
    const platformTarball = join(
      directory,
      packedEntry(platformPacked).filename,
    );
    tarballs.push(platformTarball);
    record("immutable_candidate_checksums", "passed", {
      root: sha256(await readFile(rootTarball)),
      platform: sha256(await readFile(platformTarball)),
    });
    // Pinned although both tarballs are local: the root's optionalDependencies
    // name @opum-ai packages, and npm resolves their packuments even when a
    // local tarball supplies one (QCLI-400 review, measured on npm 12.1.0).
    // Unpublished platforms 404 on the public registry, tolerated as optional.
    await command(
      "candidate_clean_install",
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--cache",
        cache,
        rootTarball,
        platformTarball,
        ...REGISTRY_PINS,
      ],
      { cwd: install },
    );
    const quest = join(
      install,
      "node_modules",
      "@opum-ai",
      `quest-${target}`,
      "bin",
      process.platform === "win32" ? "quest.exe" : "quest",
    );
    const env = {
      ...process.env,
      QUEST_TASK_STORE: install,
      QUEST_AGENT_PLUGINS: "off",
    };
    const version = (
      await command("candidate_version", quest, ["--version"], {
        cwd: install,
        env,
      })
    ).trim();
    if (!isCandidateReleaseVersion(version))
      throw new Error("candidate version is not semver");
    const manifest = JSON.parse(
      await command("candidate_manifest", quest, ["manifest", "--json"], {
        cwd: install,
        env,
      }),
    );
    if (manifest.kind !== "manifest.registry")
      throw new Error("candidate manifest failed");
    await command(
      "candidate_task_create",
      quest,
      [
        "task",
        "create",
        "candidate",
        "--id",
        "T-1",
        "--actor",
        "qualification",
        "--actor-kind",
        "delegated-agent",
        "--accountable-human",
        "release-owner",
        "--json",
      ],
      { cwd: install, env },
    );
    const tasks = JSON.parse(
      await command("candidate_task", quest, ["task", "list", "--json"], {
        cwd: install,
        env,
      }),
    );
    if (tasks.data?.[0]?.id !== "T-1")
      throw new Error("candidate task smoke failed");
    const sqlite = JSON.parse(
      await command("candidate_projection", quest, ["sqlite-smoke", "--json"], {
        cwd: install,
        env,
      }),
    );
    if (sqlite.kind !== "sqlite.smoke" || sqlite.data?.value !== 1)
      throw new Error("candidate projection smoke failed");
    const migration = JSON.parse(
      await command(
        "candidate_migration",
        quest,
        ["migration-smoke", "--json"],
        {
          cwd: install,
          env,
        },
      ),
    );
    if (migration.kind !== "migration.smoke" || migration.data?.removed !== 1)
      throw new Error("candidate migration smoke failed");
  } catch (error) {
    record("candidate_smoke_validation", "failed", {
      publicationBlocking: true,
      message:
        error instanceof Error
          ? error.message
          : "Candidate smoke validation failed.",
    });
    throw error;
  } finally {
    await Promise.all(tarballs.map((file) => rm(file, { force: true })));
    await rm(work, { recursive: true, force: true });
  }
}

if (process.env.QUEST_QUALIFICATION_SOURCE === "1") await runSourceGates();
await attempt(() =>
  command("package_contents_and_provenance", BUN, ["run", "check:packages"]),
);
if (process.env.QUEST_QUALIFICATION_SKIP_CANDIDATE !== "1")
  await attempt(runCandidateSmoke);

const blocking = report.some((gate) => gate.status !== "passed");
process.stdout.write(
  `${JSON.stringify({ kind: "quest.qualification", nativeTarget, report }, null, 2)}\n`,
);
if (blocking) process.exitCode = 1;
