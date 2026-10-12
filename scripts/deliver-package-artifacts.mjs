import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const targets = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
];
const scopes = [
  "package.json",
  ...targets.map((target) => `npm/quest-${target}`),
];
const required = [
  "package.json",
  ...targets.flatMap((target) => {
    const executable = target.startsWith("win32-") ? "quest.exe" : "quest";
    return [
      `npm/quest-${target}/package.json`,
      `npm/quest-${target}/bin/${executable}`,
    ];
  }),
].sort();
const optional = targets.map((target) => `npm/quest-${target}/LICENSE`);

const messageIndex = process.argv.indexOf("--message");
const message = messageIndex >= 0 ? process.argv[messageIndex + 1] : undefined;
if (!message || messageIndex !== process.argv.length - 2)
  throw new Error("Usage: bun run deliver:packages -- --message <message>");

function emit(event, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({ event, at: new Date().toISOString(), ...fields })}\n`,
  );
}

// QCLI-492. Never resolve `bun` from PATH: on a host whose PATH bun is not the
// declared pin, a bare `bun` runs the nested script under the wrong runtime.
// `npm_execpath` is the declaring bun Bun exports into every nested script's
// environment (QCLI-471); `process.execPath` is the fallback for a direct
// `bun <file>` launch, where the running interpreter IS that bun.
const BUN = process.env.npm_execpath ?? process.execPath;

function run(command, args, { allowFailure = false, env } = {}) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const result = {
        command: [command, ...args].join(" "),
        exit: code,
        signal,
        elapsed_ms: Math.round(performance.now() - started),
      };
      if (!allowFailure && (code !== 0 || signal)) {
        const error = new Error(`Command failed: ${result.command}`);
        Object.assign(error, result);
        reject(error);
      } else resolve(result);
    });
  });
}

async function git(args, options) {
  return run("git", args, options);
}

async function output(command, args) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) =>
      code === 0 && !signal
        ? resolve(stdout)
        : reject(
            Object.assign(new Error(stderr || `${command} failed`), {
              command: [command, ...args].join(" "),
              exit: code,
              signal,
            }),
          ),
    );
  });
}

async function stagedPaths() {
  return (await output("git", ["diff", "--cached", "--name-only", "-z"]))
    .split("\0")
    .filter(Boolean)
    .sort();
}

async function hiddenPaths() {
  const lines = (await output("git", ["ls-files", "-v", "--", ...scopes]))
    .split("\n")
    .filter(Boolean);
  return lines
    .filter((line) => /^[a-zS]/.test(line))
    .map((line) => line.slice(2));
}

async function evidence(error) {
  let staged = [];
  try {
    staged = await stagedPaths();
  } catch {}
  const missing = required.filter((path) => !staged.includes(path));
  const killed = error.exit === 137 || error.signal === "SIGKILL";
  emit("failure", {
    classification: killed ? "memory_or_staging_failure" : "command_failure",
    step: error.step ?? "unknown",
    command: error.command,
    exit: error.exit ?? null,
    signal: error.signal ?? null,
    elapsed_ms: error.elapsed_ms ?? null,
    staged_paths: staged,
    missing_paths: missing,
    message: error.message,
  });
}

async function step(name, action) {
  const started = performance.now();
  emit("step_start", { step: name });
  try {
    const result = await action();
    emit("step_success", {
      step: name,
      elapsed_ms: Math.round(performance.now() - started),
    });
    return result;
  } catch (error) {
    error.step ??= name;
    error.elapsed_ms ??= Math.round(performance.now() - started);
    throw error;
  }
}

try {
  await step("preflight", async () => {
    if ((await stagedPaths()).length)
      throw new Error("Delivery requires an empty pre-existing Git index.");
    if (
      (await output("git", ["diff", "--name-only", "--diff-filter=U"])).trim()
    )
      throw new Error("Delivery cannot run with merge conflicts.");
    const hidden = await hiddenPaths();
    if (hidden.length)
      throw new Error(
        `Delivery scope has assume-unchanged or skip-worktree flags: ${hidden.join(", ")}`,
      );
  });
  for (const target of targets)
    await step(`build:${target}`, () =>
      run(BUN, ["run", "build:packages"], {
        env: { QUEST_BUN_TARGET: target },
      }),
    );
  await step("stage:package-json", () => git(["add", "--", "package.json"]));
  for (const target of targets)
    await step(`stage:${target}`, () =>
      git(["add", "--", `npm/quest-${target}`]),
    );
  await step("validate-staged", async () => {
    const staged = await stagedPaths();
    const allowed = [...required, ...optional].sort();
    const missing = required.filter((path) => !staged.includes(path));
    const unexpected = staged.filter((path) => !allowed.includes(path));
    emit("stage_inspection", {
      staged_paths: staged,
      missing_paths: missing,
      unexpected_paths: unexpected,
    });
    await git(["diff", "--cached", "--check"]);
    if (missing.length || unexpected.length)
      throw new Error(
        `Invalid staged artifact set. staged=${staged.join(",")}`,
      );
  });
  await step("check:packages", () => run(BUN, ["run", "check:packages"]));
  await step("test:packages", () => run(BUN, ["run", "test:packages"]));
  await step("commit", () =>
    git([
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "-c",
      "pack.threads=1",
      "-c",
      "pack.windowMemory=64m",
      "commit",
      "-m",
      message,
    ]),
  );
  await step("postflight", async () => {
    const committed = (
      await output("git", ["show", "--format=", "--name-only", "HEAD"])
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    const allowed = [...required, ...optional].sort();
    if (
      !required.every((path) => committed.includes(path)) ||
      !committed.every((path) => allowed.includes(path))
    )
      throw new Error("Committed path set is not the artifact set.");
    if ((await stagedPaths()).length)
      throw new Error("Index is not empty after delivery commit.");
    if (
      (await output("git", ["status", "--porcelain", "--", ...scopes])).trim()
    )
      throw new Error("Delivery scope is not clean after commit.");
    const hidden = await hiddenPaths();
    if (hidden.length)
      throw new Error(`Delivery left hidden index flags: ${hidden.join(", ")}`);
  });
  emit("success", { targets, message });
} catch (error) {
  await evidence(error);
  process.exitCode = 1;
}
