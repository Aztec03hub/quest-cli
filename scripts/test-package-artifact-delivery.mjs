import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const realGit = Bun.which("git");

// QCLI-492. Never resolve `bun` from PATH: on a host whose PATH bun is not the
// declared pin, a bare `bun` runs the delivery under the wrong runtime.
// `npm_execpath` is the declaring bun Bun exports into every nested script's
// environment (QCLI-471); `process.execPath` is the fallback for a direct
// `bun <file>` launch, where the running interpreter IS that bun.
const BUN = process.env.npm_execpath ?? process.execPath;

function run(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "quest-delivery-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await cp(
    join(repository, "scripts", "deliver-package-artifacts.mjs"),
    join(root, "scripts", "deliver-package-artifacts.mjs"),
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        "build:packages": "node scripts/build.mjs",
        "check:packages": "node scripts/noop.mjs",
        "test:packages": "node scripts/noop.mjs",
        "deliver:packages":
          '"$npm_execpath" run scripts/deliver-package-artifacts.mjs',
      },
    }),
  );
  await writeFile(
    join(root, "scripts", "noop.mjs"),
    'process.exit(process.env.QUEST_FIXTURE_KILL_TEST_PACKAGES === "1" ? 137 : 0);\n',
  );
  await writeFile(
    join(root, "scripts", "build.mjs"),
    `
import { mkdir, readFile, writeFile } from "node:fs/promises";
const target = process.env.QUEST_BUN_TARGET;
const executable = target.startsWith("win32-") ? "quest.exe" : "quest";
const directory = \`npm/quest-\${target}\`;
await mkdir(\`\${directory}/bin\`, { recursive: true });
await writeFile(\`\${directory}/package.json\`, "{}\\n");
await writeFile(\`\${directory}/bin/\${executable}\`, target);
await writeFile(\`\${directory}/LICENSE\`, "MIT\\n");
await writeFile("package.json", \`\${await readFile("package.json", "utf8").then((value) => value.trim())}\\n\`);
`,
  );
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "fixture@example.test"],
    ["config", "user.name", "Fixture"],
    ["add", "."],
    ["commit", "-qm", "seed"],
  ]) {
    const result = await run(realGit, args, root);
    assert(result.code === 0, `Fixture Git setup failed: ${result.stderr}`);
  }
  return root;
}

async function deliver(root, env) {
  return run(
    BUN,
    ["run", "deliver:packages", "--", "--message", "fixture delivery"],
    root,
    env,
  );
}

const workspaces = [];
try {
  const success = await fixture();
  workspaces.push(success);
  await writeFile(join(success, "unrelated.txt"), "preserve me\n");
  const delivered = await deliver(success);
  assert(
    delivered.code === 0,
    `Delivery fixture failed: ${delivered.stderr}\n${delivered.stdout}`,
  );
  assert(
    delivered.stdout.includes('"event":"stage_inspection"') &&
      delivered.stdout.includes('"missing_paths":[]') &&
      delivered.stdout.includes('"unexpected_paths":[]'),
    "Delivery did not emit complete staged-artifact inspection evidence.",
  );
  const committed = await run(
    realGit,
    ["show", "--format=", "--name-only", "HEAD"],
    success,
  );
  const paths = committed.stdout.trim().split("\n").filter(Boolean).sort();
  assert(
    paths.length === 19 &&
      paths.includes("package.json") &&
      paths.includes("npm/quest-win32-x64/bin/quest.exe"),
    "Delivery commit did not contain the exact artifact paths.",
  );
  const status = await run(realGit, ["status", "--porcelain"], success);
  assert(
    status.stdout === "?? unrelated.txt\n",
    "Delivery did not preserve unrelated unstaged work.",
  );

  const preStaged = await fixture();
  workspaces.push(preStaged);
  await writeFile(join(preStaged, "pre-staged.txt"), "x\n");
  await run(realGit, ["add", "pre-staged.txt"], preStaged);
  const rejected = await deliver(preStaged);
  assert(
    rejected.code !== 0 &&
      rejected.stdout.includes("empty pre-existing Git index"),
    "Pre-staged index was not rejected.",
  );

  const hidden = await fixture();
  workspaces.push(hidden);
  await run(
    realGit,
    ["update-index", "--assume-unchanged", "package.json"],
    hidden,
  );
  const hiddenRejected = await deliver(hidden);
  assert(
    hiddenRejected.code !== 0 &&
      hiddenRejected.stdout.includes("assume-unchanged"),
    "Hidden index flag was not rejected.",
  );

  const skipped = await fixture();
  workspaces.push(skipped);
  await run(
    realGit,
    ["update-index", "--skip-worktree", "package.json"],
    skipped,
  );
  const skipRejected = await deliver(skipped);
  assert(
    skipRejected.code !== 0 && skipRejected.stdout.includes("skip-worktree"),
    "Skip-worktree index flag was not rejected.",
  );

  const killed = await fixture();
  workspaces.push(killed);
  const killedResult = await deliver(killed, {
    QUEST_FIXTURE_KILL_TEST_PACKAGES: "1",
  });
  assert(
    killedResult.code !== 0 &&
      killedResult.stdout.includes("memory_or_staging_failure"),
    "Exit 137 was not classified.",
  );
  const noCommit = await run(realGit, ["rev-list", "--count", "HEAD"], killed);
  assert(noCommit.stdout.trim() === "1", "Staging failure created a commit.");
  const visible = await run(realGit, ["status", "--porcelain"], killed);
  assert(
    visible.stdout.includes("M  package.json") &&
      visible.stdout.includes("A  npm/quest-darwin-arm64/bin/quest"),
    "Staging failure did not leave partial ordinary staging visibly inspectable.",
  );
  process.stdout.write("package artifact delivery fixture passed\n");
} finally {
  await Promise.all(
    workspaces.map((root) => rm(root, { recursive: true, force: true })),
  );
}
