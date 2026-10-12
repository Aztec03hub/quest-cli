import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startBrowserServer } from "../src/application/browser/browser.ts";

/**
 * QCLI-348. `quest browser` outlived the workspace it was started against
 * with no upper bound. Harness runs left daemons alive for up to 44 hours,
 * with deleted working directories and one per qualification run. Ruled
 * 2026-09-28: it exits when the workspace root no longer exists. It has no
 * parent-death watch, because a person may detach it on purpose.
 *
 * The first test is the acceptance evidence. It uses a real process and a
 * real workspace, deletes the workspace, and watches the process exit.
 * Reading the source cannot show that nothing else holds the event loop
 * open. Only an exit can.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;

async function exitsWithin(
  child: ReturnType<typeof Bun.spawn>,
  ms: number,
): Promise<number | "still running"> {
  const timeout = new Promise<"still running">((resolve) =>
    setTimeout(() => resolve("still running"), ms),
  );
  return Promise.race([child.exited, timeout]);
}

test("a browser whose workspace is deleted exits (QCLI-348)", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli348-"));
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
  await Bun.spawn([process.execPath, MAIN, "init"], {
    cwd: root,
    stdout: "ignore",
  }).exited;
  const child = Bun.spawn(
    [process.execPath, MAIN, "browser", "--port", "0", "--json"],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    // Started and serving, before anything is deleted.
    const reader = child.stdout.getReader();
    let text = "";
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    const started = JSON.parse(text);
    expect(started.kind).toBe("browser.started");
    const response = await fetch(started.data.overview);
    expect(response.status).toBe(200);
    await response.text();

    // Still up while the workspace exists: a poll interval passes, and it
    // has not exited.
    expect(await exitsWithin(child, 3000)).toBe("still running");

    await rm(root, { recursive: true, force: true });
    // The default poll is 2s. Allow several intervals.
    expect(await exitsWithin(child, 10_000)).toBe(0);
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("the server stays up while the probe says present, and treats a probe error as present (QCLI-348)", async () => {
  let answer: boolean | Error = true;
  const started = await startBrowserServer(
    {
      tasks: {} as never,
      planning: {} as never,
    },
    {
      workspace: {
        exists: async () => {
          if (answer instanceof Error) throw answer;
          return answer;
        },
        pollIntervalMs: 20,
      },
    },
  );
  try {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await sleep(100);
    expect(started.server.listening).toBe(true);
    answer = new Error("EACCES");
    await sleep(100);
    expect(started.server.listening).toBe(true);
    answer = false;
    await sleep(100);
    expect(started.server.listening).toBe(false);
  } finally {
    if (started.server.listening) await started.close();
  }
});
