// lore and quest publish at one version number, or not at all (QCLI-386,
// constitution Article 3 clause 6: "Each CLI's release workflow refuses to
// publish when the two version numbers differ. That check, not this
// paragraph, is what keeps the pair together.").
//
// What is compared: this repository's package.json version against
// lore-cli's package.json version on lore-cli's `main`, read through the
// GitHub contents API. Not the registry, because whichever side stages first
// would see the other still on the old number and neither could ever go
// first. Not a lore tag, because that forces a tag order across repositories.
// `main` reading the same number on both sides is a state a paired release
// already has to reach before either side tags. lore-cli runs the mirror of
// this against quest-cli.
//
// Fail closed: a read that fails, answers something that is not a
// package.json, or names another package refuses exactly like a mismatch.
// There is no override flag; changing the rule means amending Article 3.
//
//   node scripts/qualification/version-parity.mjs --require

import { execFile as execFileCallback } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const PEER = Object.freeze({
  repository: "opum-ai/lore-cli",
  ref: "main",
  packageName: "@opum-ai/lore",
});

/** The one argv this reads the peer with. Exported so a test can pin it. */
export function peerReadArgs(peer = PEER) {
  return [
    "api",
    "--hostname",
    "github.com",
    "-H",
    "Accept: application/vnd.github.raw",
    `repos/${peer.repository}/contents/package.json?ref=${peer.ref}`,
  ];
}

/**
 * The peer's package.json version on its ref. Every failure comes back as
 * `version: null` with the reason, never thrown and never defaulted.
 */
export async function readPeerVersion({
  peer = PEER,
  execFile: execFileFn = execFile,
} = {}) {
  const source = `${peer.repository}@${peer.ref}:package.json`;
  try {
    const { stdout } = await execFileFn("gh", peerReadArgs(peer), {
      maxBuffer: 4 * 1024 * 1024,
    });
    const manifest = JSON.parse(stdout);
    if (manifest?.name !== peer.packageName)
      return {
        version: null,
        source,
        error: `names package ${JSON.stringify(manifest?.name)}, not ${peer.packageName}`,
      };
    if (typeof manifest.version !== "string" || !manifest.version)
      return { version: null, source, error: "carries no version" };
    return { version: manifest.version, source };
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error)
      .trim()
      .split("\n")[0];
    return { version: null, source, error: detail };
  }
}

/** Pure verdict: both versions present and identical. */
export function checkVersionParity({ version, peerRead }) {
  if (peerRead.version === null)
    return {
      ok: false,
      problem: `lore's version could not be read from ${peerRead.source} (${peerRead.error}); Article 3.6 refuses rather than assumes`,
    };
  if (peerRead.version !== version)
    return {
      ok: false,
      problem: `quest is ${version} (this checkout's package.json) but lore is ${peerRead.version} (${peerRead.source}); Article 3.6: lore and quest publish at one version, or not at all`,
    };
  return {
    ok: true,
    problem: null,
    message: `quest ${version} and lore ${peerRead.version} (${peerRead.source}) are one version (Article 3.6).`,
  };
}

/** Reads both sides and returns the verdict. */
export async function requireVersionParity({
  version,
  read = () => readPeerVersion(),
} = {}) {
  return checkVersionParity({ version, peerRead: await read() });
}

async function main(argv) {
  if (!argv.includes("--require"))
    throw new Error("usage: version-parity.mjs --require");
  const { version } = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const verdict = await requireVersionParity({ version });
  if (!verdict.ok) {
    console.error(`Refusing to publish: ${verdict.problem}`);
    process.exit(1);
  }
  console.log(verdict.message);
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
