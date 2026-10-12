import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveBuildVersion } from "./derive-build-version.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const rootPackagePath = join(root, "package.json");
const rootPackage = JSON.parse(await readFile(rootPackagePath, "utf8"));
const version = rootPackage.version;

// QCLI-492. Never resolve `bun` from PATH: `Bun.which("bun")` returned whatever
// PATH held, so on a host whose PATH bun is not the declared pin the compile
// ran under the wrong runtime. `npm_execpath` is the declaring bun Bun exports
// into every nested script's environment (QCLI-471 -- and this file is reached
// as `"$npm_execpath" run scripts/build-platform-packages.mjs`); the
// `process.execPath` fallback covers a direct `bun <file>` launch.
const BUN = process.env.npm_execpath ?? process.execPath;

// The reported version is derived once, here, from the checkout's git state
// (QCLI-296). It is injected as a build-time define so a dev binary reports a
// version distinguishable from the last published one without introducing a
// hand-edited version site. A RELEASE build -- one whose environment sets
// QUEST_RELEASE_BUILD=1, which CI does only for the candidate build -- embeds
// the bare package.json version instead of a -dev suffix. `deriveBuildVersion`
// is pure; the git call below is the only side effect.
const releaseBuild = process.env.QUEST_RELEASE_BUILD === "1";
const describeLong = Bun.spawnSync(["git", "describe", "--tags", "--long"], {
  cwd: root,
  stdout: "pipe",
  stderr: "pipe",
});
const buildVersion = deriveBuildVersion({
  baseVersion: version,
  describeLong:
    describeLong.exitCode === 0 ? describeLong.stdout.toString().trim() : null,
  releaseBuild,
});
const checksums = { ...(rootPackage.questPlatformPackages ?? {}) };
const targetDirectory = process.env.QUEST_BUN_TARGETS_DIR;
const requestedTarget = process.env.QUEST_BUN_TARGET;
const platforms = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "arm64"],
  ["linux", "x64"],
  ["win32", "arm64"],
  ["win32", "x64"],
];

const selectedPlatforms = requestedTarget
  ? platforms.filter(([os, cpu]) => `${os}-${cpu}` === requestedTarget)
  : platforms;
if (selectedPlatforms.length === 0)
  throw new Error(`Unsupported Quest platform target: ${requestedTarget}.`);

for (const [os, cpu] of selectedPlatforms) {
  const directory = join(root, "npm", `quest-${os}-${cpu}`);
  const executable = os === "win32" ? "quest.exe" : "quest";
  const binary = join(directory, "bin", executable);
  await rm(directory, { recursive: true, force: true });
  await mkdir(dirname(binary), { recursive: true });
  const targetArchitecture = cpu === "arm64" ? "aarch64" : cpu;
  const targetExecutable =
    targetDirectory && !(os === process.platform && cpu === process.arch)
      ? join(
          targetDirectory,
          `bun-${os === "win32" ? "windows" : os}-${targetArchitecture}`,
          os === "win32" ? "bun.exe" : "bun",
        )
      : undefined;
  const result = Bun.spawnSync(
    [
      BUN,
      "build",
      "--compile",
      `--target=bun-${os}-${cpu}`,
      ...(targetExecutable
        ? [`--compile-executable-path=${targetExecutable}`]
        : []),
      `--define=__QUEST_BUILD_VERSION__=${JSON.stringify(buildVersion)}`,
      "src/cli/main.ts",
      `--outfile=${binary}`,
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode);
  if (os !== "win32") await chmod(binary, 0o755);
  const sha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  const name = `@opum-ai/quest-${os}-${cpu}`;
  checksums[name] = sha256;
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(
      {
        name,
        version,
        description: `Quest CLI binary for ${os}-${cpu}.`,
        license: "MIT",
        author: "Opum AI",
        repository: {
          type: "git",
          url: "git+https://github.com/opum-ai/quest-cli.git",
        },
        os: [os],
        cpu: [cpu],
        files: [`bin/${executable}`],
        questBinarySha256: sha256,
      },
      null,
      2,
    )}\n`,
  );
  await copyFile(join(root, "LICENSE"), join(directory, "LICENSE"));
}

rootPackage.questPlatformPackages = checksums;
await writeFile(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);
