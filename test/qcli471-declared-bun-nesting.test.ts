import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * QCLI-471. `bun run check` must run every nested command under the bun that
 * started the run, not under whatever `bun` resolves to on PATH.
 *
 * The defect: launched by an absolute-path bun -- the declared packageManager,
 * e.g. /opt/homebrew/Cellar/bun/1.4.2/bin/bun -- `bun run check` still ran its
 * nested `bun test` under PATH's bun, 1.3.14 on the workstation this was found
 * on. test/qcli411-bun-declare-binding.test.ts then failed and a clean tree
 * exited 1: a command meant to assert the declared runtime reddened because of
 * an undeclared ambient one.
 *
 * The fix names the runner as "$npm_execpath" rather than a bare `bun`. Bun
 * sets that variable to the executing binary's absolute path and re-exports it
 * to every nested script, so the whole chain stays on the declaring bun. These
 * tests hold that rule, so the nested runner cannot silently fall back to
 * PATH's bun again.
 */

const REPO = new URL("..", import.meta.url).pathname;

// A bare `bun` token: not preceded by a path or word character (`/`, `.`,
// letters, digits) and not followed by a word character or `-` (so `bunx` and
// a hyphenated word are not offenders). That shape is a PATH lookup wherever
// it appears -- at the start of a script, after `&&`, `;`, `|` or `(`, inside
// backtick or `$(` command substitution, behind a `VAR=` prefix, or as a
// `${npm_execpath:-bun}` fallback. `"$npm_execpath"` carries no `bun` token,
// which is the whole point.
const BARE_BUN = /(?:^|[^\w/.])bun(?![-\w])/;

const readScripts = async (): Promise<Record<string, string>> => {
  const pkg = (await Bun.file(join(REPO, "package.json")).json()) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
};

test("no package script invokes a bare `bun` (QCLI-471)", async () => {
  const scripts = await readScripts();
  const names = Object.keys(scripts).sort();
  // A check that read nothing must not pass.
  expect(names.length).toBeGreaterThan(0);

  const offenders = names.filter((name) => BARE_BUN.test(scripts[name] ?? ""));
  expect(offenders).toEqual([]);
});

test("the nested test runner in `bun run check` uses the declared bun (QCLI-471)", async () => {
  const scripts = await readScripts();
  const check = scripts.check ?? "";
  const runTest = scripts.test ?? "";

  // The chain that carried the defect: `check` -> `test` -> the runner.
  expect(check).toContain("run test");
  expect(check).toContain("$npm_execpath");
  expect(BARE_BUN.test(check)).toBe(false);

  // The final command of `test` is the runner that reddened under PATH's bun.
  expect(runTest).toMatch(/npm_execpath"?\s+test\s/);
  expect(runTest).toContain("--path-ignore-patterns='tests/**'");
  expect(BARE_BUN.test(runTest)).toBe(false);
});

// The guard above is only as good as the shell forms it can see. QCLI-471's
// review round 1 measured that the first version of BARE_BUN, whose separators
// were `[\s&|;(]`, missed a bare `bun` inside backtick command substitution --
// a gap no current script exercises but a future one could. These cases pin the
// guard's reach so it cannot silently narrow again.
test("the bare-bun guard matches every shell position (QCLI-471)", () => {
  // Positive: a bare `bun` token in any shell position is a PATH lookup.
  for (const script of [
    "bun test",
    "x && bun test",
    "x;bun test",
    "x|bun test",
    "(bun test)",
    "FOO=1 bun test",
    "`bun --version`",
    "echo `bun test`",
    "$(bun test)",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal script text, not a placeholder
    "${npm_execpath:-bun} test",
    "... && bun",
  ])
    expect([script, BARE_BUN.test(script)]).toEqual([script, true]);

  // Negative: naming the declaring runtime, or a token that is not `bun`.
  for (const script of [
    '"$npm_execpath" test',
    '"$npm_execpath" run check',
    "node scripts/check-layers.mjs",
    "./node_modules/.bin/bun test",
    "/opt/homebrew/bin/bun test",
    "bunx tsc",
  ])
    expect([script, BARE_BUN.test(script)]).toEqual([script, false]);
});
