import { expect, test } from "claude-code/testing";

import { repoNameFromGitCommonDir } from "../hooks/quest";

/**
 * QCLI-490, DEC-172 (4bg) item 1 (a): fleet mode and its discovery are gone, so
 * the only repository the board keys is the session's own. What survives the
 * removal here is the one function that gives that repository its NAME -- a
 * worktree session still keys its row, and its writes, to the repository the
 * operator knows rather than to the worktree directory.
 */
test("git's common dir names the repository a worktree belongs to", async () => {
  expect(
    repoNameFromGitCommonDir(
      "/repos/quest-cli/.claude/worktrees/QCLI-404",
      "/repos/quest-cli/.git",
    ),
  ).toBe("quest-cli");
  expect(repoNameFromGitCommonDir("/repos/quest-cli", ".git")).toBe(
    "quest-cli",
  );
  expect(repoNameFromGitCommonDir("/repos/quest-cli", null)).toBe("quest-cli");
  expect(repoNameFromGitCommonDir("/repos/quest-cli/", "")).toBe("quest-cli");
});
