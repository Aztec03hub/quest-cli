import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * QCLI-492. Nothing `bun run check` reaches may resolve a `bun` from PATH.
 *
 * QCLI-471 pinned package.json's scripts to "$npm_execpath", which covers the
 * shell strings. Two pieces of the SAME bare-PATH-lookup class were left open,
 * because they are not in package.json:
 *
 * 1. the nested bun spawns inside the scripts the check chain runs, and inside
 *    the test files it runs -- both layers build their own argv;
 * 2. `bunx`, which QCLI-471's guard deliberately exempted even though it is a
 *    PATH-resolved executable like any other.
 *
 * The offender is a QUOTED executable name: spawn called with the literal bun
 * as an argv element. A file that names the declaring runtime carries no such
 * literal, so the two assertions below are complements -- no quoted literal,
 * and the declaring runtime is named.
 */

const REPO = new URL("..", import.meta.url).pathname;

// A quoted executable name is the PATH lookup this task removes. The QUOTE
// characters are load-bearing: they are what make it an argv element rather
// than prose, so a comment that names the literal in backticks is not a false
// positive.
const QUOTED_BUN = /(["'])bunx?\1/;

const declaresRuntime = (source: string): boolean =>
  /npm_execpath|execPath/.test(source);

// The scripts under `scripts/` that `bun run check` reaches and that spawn a
// nested bun. `check` reaches two of them directly through `test`
// (test:repository-check-scope and test:package-artifact-delivery); prepublish
// and deliver are the qualification and delivery entry points of the same
// class, both named by QCLI-492.
const CHECK_CHAIN_SCRIPTS = [
  "scripts/test-repository-check-scope.mjs",
  "scripts/test-package-artifact-delivery.mjs",
  "scripts/qualification/prepublish.mjs",
  "scripts/deliver-package-artifacts.mjs",
] as const;

test("no check-chain script spawns a bare `bun`/`bunx` (QCLI-492)", async () => {
  // A check that read nothing must not pass.
  expect(CHECK_CHAIN_SCRIPTS.length).toBeGreaterThan(0);

  for (const file of CHECK_CHAIN_SCRIPTS) {
    const source = await Bun.file(join(REPO, file)).text();
    expect(
      {
        file,
        barePathLookup: QUOTED_BUN.test(source),
        namesDeclaringRuntime: declaresRuntime(source),
      },
      `${file}: must spawn the declaring runtime, never a quoted executable name`,
    ).toEqual({
      file,
      barePathLookup: false,
      namesDeclaringRuntime: true,
    });
  }
});

// The other half of the same class: the test files the `"$npm_execpath" test
// ...` step runs build their own argv, so they spawn whichever bun PATH holds
// unless they name the runtime too. The runner IS the declaring bun here, so
// `process.execPath` is that runtime. This file is one of them and is scanned
// like the rest.
test("no test file spawns a bare `bun`/`bunx` (QCLI-492)", async () => {
  const files = [
    ...new Bun.Glob("test/**/*.test.ts").scanSync({ cwd: REPO }),
    ...new Bun.Glob("test/**/*.test.tsx").scanSync({ cwd: REPO }),
  ].sort();
  // A check that read nothing must not pass.
  expect(files.length).toBeGreaterThan(0);

  const offenders: string[] = [];
  for (const file of files) {
    const source = await Bun.file(join(REPO, file)).text();
    if (QUOTED_BUN.test(source)) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
