/**
 * QCLI-502. The test tree spawns the CLI and `git` hundreds of times, and every
 * one of those helpers used to read the result as `child.exitCode ?? 0`.
 *
 * `child.exitCode` is null when the child did NOT exit normally -- a
 * signal-terminated child (SIGKILL under memory pressure, an AMFI kill, a
 * `kill -9`) reports `exitCode: null` with `signalCode` set. Folding that null
 * into 0 made a broken child indistinguishable from a clean exit: a test that
 * asserted a command FAILED saw a pass-shaped 0, and a test that asserted
 * success would have read a dead child as success. (A command that cannot be
 * STARTED is a different path: `Bun.spawnSync` throws ENOENT, which these
 * helpers let propagate.)
 *
 * So there is exactly ONE place that turns a child into an exit code, and it
 * fails loudly instead. Every test helper delegates here rather than repeating
 * the fold.
 */
export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  /** Bun's stdio option for the child's stdin; "ignore" by default behaviour. */
  readonly stdin?: "ignore" | "pipe";
}

export function runCommand(
  argv: readonly string[],
  options: CommandOptions = {},
): CommandResult {
  let child: ReturnType<typeof Bun.spawnSync>;
  try {
    child = Bun.spawnSync([...argv], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined
        ? {}
        : { env: options.env as Record<string, string> }),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new Error(
      `QCLI-502: could not spawn ${JSON.stringify(argv[0])}: ${
        error instanceof Error ? error.message : String(error)
      }. Full command: ${JSON.stringify(argv)}`,
    );
  }
  if (child.exitCode === null) {
    throw new Error(
      `QCLI-502: ${JSON.stringify(argv[0])} did not exit normally (signal ${String(
        child.signalCode,
      )}). Refusing to report a null exit code as 0. Full command: ${JSON.stringify(
        argv,
      )}`,
    );
  }
  return {
    exitCode: child.exitCode,
    stdout: child.stdout ? child.stdout.toString() : "",
    stderr: child.stderr ? child.stderr.toString() : "",
  };
}
