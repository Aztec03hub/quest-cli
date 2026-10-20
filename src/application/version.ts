/**
 * The Quest CLI's reported version.
 *
 * The bare semver literal below is the release version, hand-edited on a bump
 * alongside `package.json`. A RELEASE build -- `scripts/build-platform-packages.mjs`
 * run with `QUEST_RELEASE_BUILD=1`, which CI sets only for the candidate build
 * -- embeds that same bare version and nothing else. Every other platform build
 * injects `__QUEST_BUILD_VERSION__` as `<package.json version>-dev.<N>.g<sha>`,
 * where N is the commit distance `git describe` reports since the last reachable
 * tag, so a dev checkout reports a version distinguishable from the last
 * published one. Where the injected global is absent -- `bun test`, `bun run
 * src/cli/main.ts` -- the bare literal is reported, so the dev-runtime and
 * in-process value stays exactly the version this file names.
 */
declare const __QUEST_BUILD_VERSION__: string;
export const QUEST_VERSION: string =
  typeof __QUEST_BUILD_VERSION__ === "string"
    ? __QUEST_BUILD_VERSION__
    : "0.14.1";
