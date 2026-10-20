import { expect, test } from "bun:test";

import { runCommand } from "./helpers/spawn.ts";

/**
 * QCLI-502. The test tree used to read every spawned child as
 * `child.exitCode ?? 0`, which folds a child that did NOT exit normally into a
 * clean exit 0. `runCommand` is the one place that now refuses to do that.
 *
 * Both directions are proved here: a spawn that cannot START and a child that
 * does not exit NORMALLY each fail loudly, while a normal exit is returned
 * unchanged -- including a normal non-zero exit, which must be a result, not a
 * throw.
 */

test("a spawn that cannot start fails loudly and names the command (QCLI-502)", () => {
  expect(() => runCommand(["/nonexistent/qcli502-not-a-real-binary"])).toThrow(
    /QCLI-502: could not spawn "\/nonexistent\/qcli502-not-a-real-binary"/,
  );
});

test("a child killed by a signal fails loudly instead of reporting exit 0 (QCLI-502)", () => {
  // This is the case `child.exitCode ?? 0` masked: a SIGKILLed child reports
  // `exitCode: null, signalCode: "SIGKILL"`, which the old fold turned into a
  // pass-shaped 0. The mutation check restores that fold and this test goes red.
  expect(() => runCommand(["/bin/sh", "-c", "kill -9 $$"])).toThrow(
    /QCLI-502: "\/bin\/sh" did not exit normally \(signal SIGKILL\)/,
  );
});

test("a normal exit is returned unchanged, zero and non-zero alike (QCLI-502)", () => {
  const clean = runCommand(["/bin/echo", "hi"]);
  expect({ exitCode: clean.exitCode, stdout: clean.stdout.trim() }).toEqual({
    exitCode: 0,
    stdout: "hi",
  });
  // A non-zero exit is a RESULT, never a throw: many tests assert one.
  const failed = runCommand(["/bin/sh", "-c", "exit 7"]);
  expect(failed.exitCode).toBe(7);
});
