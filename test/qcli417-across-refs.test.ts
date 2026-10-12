import { beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalGitPort } from "../src/adapters/git/local-git.ts";
import {
  GhRefDiscovery,
  ghPullRequestArguments,
  OPEN_PULL_REQUEST_LIMIT,
  parseOpenPullRequests,
} from "../src/adapters/refs/gh-ref-discovery.ts";
import { commandHelp } from "../src/application/command-help.ts";
import { BOOLEAN_FLAGS } from "../src/application/command-parameters.ts";
import {
  type AcrossRefsCoverage,
  type AcrossRefsEntry,
  type AcrossRefsFilter,
  type AcrossRefsOutcome,
  AcrossRefsViewService,
} from "../src/application/refs/across-refs.ts";
import type {
  DiscoveredPullRequest,
  OriginRemote,
  RefDiscoveryPort,
} from "../src/ports/ref-discovery.ts";

/**
 * QCLI-417 / DEC-40 (operator-accepted 2026-09-29, ODOC-330): the read-only,
 * repository-true view over `origin/dev` plus the head of every open PR into
 * `dev` -- `quest task list --across-refs`.
 *
 * The fixtures are REAL Git repositories, because every claim this command
 * makes is a claim about the commit graph: `origin/dev` is read at the SHA the
 * REMOTE advertises (never the possibly stale local ref), a PR head at the SHA
 * discovery returned, and objects are fetched only when they are absent. A
 * mocked graph would not exercise the part that can be wrong. The one thing
 * that cannot be real here is the forge -- `gh pr list` is behind an
 * injectable seam, so these tests inject discovery and never touch the
 * network. The CLI-level cases use the REAL adapter on an origin that is not
 * GitHub, which is how the discovery-failure path is reached without depending
 * on whether `gh` happens to be installed on the machine running the suite.
 *
 * BOTH HALVES OF EVERY DETECTION ARE PINNED. A view that always answered
 * `complete: true` and one that always answered `conflict: true` would each
 * satisfy the happy path, so the complete case, the incomplete case, the
 * agreeing pair and the conflicting pair are all asserted -- and a run that
 * read ZERO refs fails rather than passing, which is the positive control that
 * makes the coverage report something other than a promise.
 */

const MAIN = new URL("../src/cli/main.ts", import.meta.url).pathname;
const ACTOR = ["--actor", "t", "--actor-kind", "human"] as const;

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(cwd: string, argv: readonly string[]): Run {
  const child = Bun.spawnSync([...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    // The suite's own harness runs with plugins off; doing it here keeps the
    // fixture's stderr deterministic when a single file is run directly.
    env: { ...process.env, QUEST_AGENT_PLUGINS: "off" },
  });
  return {
    exitCode: child.exitCode ?? 0,
    stdout: child.stdout ? child.stdout.toString() : "",
    stderr: child.stderr ? child.stderr.toString() : "",
  };
}

function git(cwd: string, ...args: readonly string[]): string {
  const result = run(cwd, ["git", ...args]);
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Points a fixture's `origin` at `url` by writing `.git/config` directly.
 *
 * Deliberately NOT `git remote add`: changing a remote is a tier-3 action
 * everywhere in this fleet, and a fixture does not need one to be a fixture.
 * `git remote add` writes exactly this stanza (a url plus the default fetch
 * refspec), so the config a test writes and the config Git writes are the same
 * bytes, and the fetch machinery under test cannot tell them apart. Passing
 * null removes the remote again.
 */
async function setOriginUrl(
  repository: string,
  url: string | null,
): Promise<void> {
  const path = join(repository, ".git", "config");
  const original = await readFile(path, "utf8");
  const withoutOrigin = original.replace(
    /\[remote "origin"\]\n(?:\t[^\n]*\n)*/u,
    "",
  );
  await writeFile(
    path,
    url === null
      ? withoutOrigin
      : `${withoutOrigin.trimEnd()}\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
}

const quest = (cwd: string, args: readonly string[]): Run =>
  run(cwd, ["bun", MAIN, ...args]);

/** Runs a command that must succeed, so a broken fixture says so where it
 *  broke rather than three assertions later. */
function questOk(cwd: string, args: readonly string[]): Run {
  const result = quest(cwd, [...args, "--json"]);
  expect({ args, exitCode: result.exitCode, stderr: result.stderr }).toEqual({
    args,
    exitCode: 0,
    stderr: "",
  });
  return result;
}

interface Fixture {
  /** The working checkout: `dev` plus an unmerged `feature` branch. */
  readonly work: string;
  /** The bare repository `origin` points at. */
  readonly origin: string;
  readonly devSha: string;
  readonly prSha: string;
  readonly devT1Blob: string;
  readonly prT1Blob: string;
  /** A PR head whose objects exist only in the bare origin (N4). */
  readonly prTwoSha: string;
  /** QCLI-432: a ref carrying T-1 as a DIFFERENT record (a genuine collision). */
  readonly collisionSha: string;
  /** QCLI-432: a ref carrying T-1 with NO createdAt (an unresolvable pair). */
  readonly unresolvedSha: string;
}

/**
 * `dev` carries T-1 (To Do) and T-2 (To Do). The unmerged `feature` branch
 * carries T-1 as In Progress and adds T-3, which exists nowhere else. So the
 * same view holds one conflicting id (T-1), one agreeing id (T-2, carried
 * identically by both refs) and one PR-only id (T-3).
 */
async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "qcli417-"));
  const work = join(root, "work");
  git(root, "init", "-q", "-b", "dev", work);
  git(work, "config", "user.email", "t@example.invalid");
  git(work, "config", "user.name", "T");
  questOk(work, ["init", "--name", "Probe", "--task-id-prefix", "T"]);
  questOk(work, ["task", "create", "on dev", "--label", "tracker", ...ACTOR]);
  questOk(work, ["task", "create", "agreeing across refs", ...ACTOR]);
  git(work, "add", "-A");
  git(work, "commit", "-qm", "T-1 and T-2 on dev");
  const devSha = git(work, "rev-parse", "dev");
  const devT1Blob = git(work, "rev-parse", "dev:.quest/tasks/T-1.json");

  git(work, "checkout", "-q", "-b", "feature");
  questOk(work, ["task", "create", "only on the pr head", ...ACTOR]);
  questOk(work, ["task", "edit", "T-1", "--status", "In Progress", ...ACTOR]);
  git(work, "add", "-A");
  git(work, "commit", "-qm", "T-3, and T-1 In Progress");
  const prSha = git(work, "rev-parse", "feature");
  const prT1Blob = git(work, "rev-parse", "feature:.quest/tasks/T-1.json");
  git(work, "checkout", "-q", "dev");

  // `origin` is a real remote (a local bare repository), so `git remote
  // get-url`, `git ls-remote` and a fetch of a missing object are all
  // exercised for real and offline. The PR ref is deliberately NOT created
  // locally: that is what forces the view through "objects are fetched only
  // when absent".
  const origin = join(root, "origin.git");
  git(root, "clone", "-q", "--bare", work, origin);
  git(origin, "update-ref", "refs/heads/dev", devSha);
  git(origin, "update-ref", "refs/pull/1/head", prSha);
  await setOriginUrl(work, origin);
  expect(
    run(work, ["git", "rev-parse", "--verify", "refs/pull/1/head"]).exitCode,
  ).not.toBe(0);

  // A SECOND pull request whose commit exists ONLY in the bare origin: this
  // clone has neither the ref nor its objects, so a read of it must go through
  // the fetch. The first PR could not cover that -- its objects came along
  // with the feature branch this fixture created.
  const outsider = join(root, "outsider");
  git(root, "clone", "-q", origin, outsider);
  git(outsider, "config", "user.email", "t@example.invalid");
  git(outsider, "config", "user.name", "T");
  git(outsider, "checkout", "-q", "-b", "pr-two");
  questOk(outsider, ["task", "create", "only on the second pr head", ...ACTOR]);
  git(outsider, "add", "-A");
  git(outsider, "commit", "-qm", "T-4 on pr-two");
  const prTwoSha = git(outsider, "rev-parse", "pr-two");
  // Copy the commit into the bare and name it as a PR ref -- `update-ref` on
  // the bare, never a push to a branch and never a remote change.
  git(origin, "fetch", "-q", outsider, "refs/heads/pr-two");
  git(origin, "update-ref", "refs/pull/2/head", prTwoSha);
  expect(
    run(work, ["git", "cat-file", "-e", `${prTwoSha}^{commit}`]).exitCode,
  ).not.toBe(0);

  // QCLI-432: a GENUINE id collision -- the same id "T-1" naming a DIFFERENT
  // record (a different creation stamp and title), the shape two uncommitted
  // `create` calls in two checkouts produce (QCLI-431). The record is rewritten
  // on a branch off dev, which is what a second `create` would have committed.
  const t1Path = join(work, ".quest/tasks/T-1.json");
  const t1Record = JSON.parse(await readFile(t1Path, "utf8")) as Record<
    string,
    unknown
  >;
  git(work, "checkout", "-q", "-b", "collision", "dev");
  await writeFile(
    t1Path,
    JSON.stringify({
      ...t1Record,
      title: "a different T-1",
      createdAt: "2031-01-01T00:00:00.000Z",
    }),
  );
  git(work, "add", "-A");
  git(work, "commit", "-qm", "a different T-1 (id collision)");
  const collisionSha = git(work, "rev-parse", "collision");

  // QCLI-432 AC2: a record carrying NO createdAt cannot be compared, so the
  // pair is an UNRESOLVED collision rather than assumed to be one task.
  git(work, "checkout", "-q", "-b", "unresolved", "dev");
  const withoutCreatedAt = { ...t1Record };
  delete withoutCreatedAt.createdAt;
  await writeFile(t1Path, JSON.stringify(withoutCreatedAt));
  // A LONE record with no createdAt, on this ref only: id T-9 exists nowhere
  // else, so the view sees a single state and must call it `task`, not
  // `unresolved`. This is what pins the `states.length < 2` guard -- without
  // it a lone record lacking createdAt would read as an unresolved collision.
  const t2Record = JSON.parse(
    await readFile(join(work, ".quest/tasks/T-2.json"), "utf8"),
  ) as Record<string, unknown>;
  const loneNoCreatedAt: Record<string, unknown> = { ...t2Record, id: "T-9" };
  delete loneNoCreatedAt.createdAt;
  await writeFile(
    join(work, ".quest/tasks/T-9.json"),
    JSON.stringify(loneNoCreatedAt),
  );
  git(work, "add", "-A");
  git(work, "commit", "-qm", "a T-1 with no createdAt, and a lone T-9");
  const unresolvedSha = git(work, "rev-parse", "unresolved");
  git(work, "checkout", "-q", "dev");

  git(
    origin,
    "fetch",
    "-q",
    work,
    "refs/heads/collision",
    "refs/heads/unresolved",
  );
  git(origin, "update-ref", "refs/pull/3/head", collisionSha);
  git(origin, "update-ref", "refs/pull/4/head", unresolvedSha);
  return {
    work,
    origin,
    devSha,
    prSha,
    devT1Blob,
    prT1Blob,
    prTwoSha,
    collisionSha,
    unresolvedSha,
  };
}

let fixture: Fixture;

beforeAll(async () => {
  fixture = await createFixture();
}, 120_000);

/** The forge seam: production shells out to `gh`; these tests inject. */
function discovery(options: {
  readonly origin?: OriginRemote;
  readonly pullRequests?: readonly DiscoveredPullRequest[];
  readonly failure?: string;
}): RefDiscoveryPort {
  return {
    async origin(): Promise<OriginRemote> {
      return options.origin ?? { kind: "github", slug: "opum-ai/quest-cli" };
    },
    async listOpenPullRequests() {
      if (options.failure !== undefined) throw new Error(options.failure);
      return options.pullRequests ?? [];
    },
  };
}

function prOne(f: Fixture): DiscoveredPullRequest {
  return {
    number: 1,
    headRefName: "feature",
    headRefOid: f.prSha,
    url: "https://github.com/opum-ai/quest-cli/pull/1",
  };
}

/** QCLI-432: the PR head that carries T-1 as a different record. */
function prThree(f: Fixture): DiscoveredPullRequest {
  return {
    number: 3,
    headRefName: "collision",
    headRefOid: f.collisionSha,
    url: "https://github.com/opum-ai/quest-cli/pull/3",
  };
}

/** QCLI-432: the PR head carrying T-1 with no createdAt. */
function prFour(f: Fixture): DiscoveredPullRequest {
  return {
    number: 4,
    headRefName: "unresolved",
    headRefOid: f.unresolvedSha,
    url: "https://github.com/opum-ai/quest-cli/pull/4",
  };
}

/** The production wiring, minus the forge: the same real Git port the CLI
 *  composes, with discovery replaced by an injected seam. */
function service(f: Fixture, port: RefDiscoveryPort): AcrossRefsViewService {
  void f;
  return new AcrossRefsViewService(new LocalGitPort(), port);
}

async function viewAt(
  repositoryPath: string,
  port: RefDiscoveryPort,
  request: {
    readonly allowPartial?: boolean;
    readonly refs?: readonly string[];
    readonly pullRequests?: readonly number[];
    readonly filter?: AcrossRefsFilter;
  } = {},
): Promise<{
  entries: readonly AcrossRefsEntry[];
  coverage: AcrossRefsCoverage;
}> {
  const outcome: AcrossRefsOutcome = await new AcrossRefsViewService(
    new LocalGitPort(),
    port,
  ).view({
    repositoryPath,
    allowPartial: request.allowPartial ?? false,
    ...(request.refs === undefined ? {} : { refs: request.refs }),
    ...(request.pullRequests === undefined
      ? {}
      : { pullRequests: request.pullRequests }),
    ...(request.filter === undefined ? {} : { filter: request.filter }),
  });
  if (outcome.kind !== "view")
    throw new Error(`expected a view, got absent(${outcome.detail})`);
  return { entries: outcome.entries, coverage: outcome.coverage };
}

const view = (
  f: Fixture,
  port: RefDiscoveryPort,
  request: Parameters<typeof viewAt>[2] = {},
) => viewAt(f.work, port, request);

function entry(
  entries: readonly AcrossRefsEntry[],
  id: string,
): AcrossRefsEntry {
  const found = entries.find((candidate) => candidate.id === id);
  if (found === undefined)
    throw new Error(`no entry for ${id} in [${entries.map((e) => e.id)}]`);
  return found;
}

const openPr = (f: Fixture) => discovery({ pullRequests: [prOne(f)] });
/** QCLI-432: dev plus the PR head carrying T-1 as a different record. */
const collisionPr = (f: Fixture) => discovery({ pullRequests: [prThree(f)] });
/** QCLI-432: dev plus the PR head carrying T-1 with no createdAt. */
const unresolvedPr = (f: Fixture) => discovery({ pullRequests: [prFour(f)] });

test("a complete view reads origin/dev and every open PR head, and a dev state carries pullRequest null (QCLI-417 AC2)", async () => {
  const result = await view(fixture, openPr(fixture));
  expect({
    complete: result.coverage.complete,
    population: result.coverage.population,
  }).toEqual({ complete: true, population: "open-prs" });
  // discoveredAt is the instant the population read was attempted.
  expect(result.coverage.discoveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u);
  expect(result.coverage.refsUnreadable).toEqual([]);
  // refsRead is the refProvenance inner object verbatim, in planned order.
  expect(result.coverage.refsRead).toEqual([
    { ref: "origin/dev", pullRequest: null, sha: fixture.devSha },
    {
      ref: "refs/pull/1/head",
      pullRequest: "opum-ai/quest-cli#1",
      sha: fixture.prSha,
    },
  ]);

  // The dev half of a conflicting id: pullRequest is PRESENT and null, never
  // omitted, and the sha is the one the remote advertised.
  const conflict = entry(result.entries, "T-1");
  expect(conflict.states).toEqual([
    {
      status: "To Do",
      refProvenance: {
        ref: "origin/dev",
        pullRequest: null,
        sha: fixture.devSha,
      },
    },
    {
      status: "In Progress",
      refProvenance: {
        ref: "refs/pull/1/head",
        pullRequest: "opum-ai/quest-cli#1",
        sha: fixture.prSha,
      },
    },
  ]);
  // The two states really were read from two different commits' bytes; the
  // status difference is not this view inventing one.
  expect(fixture.devT1Blob).not.toBe(fixture.prT1Blob);
  // The title comes from the existence ref, dev.
  expect(conflict.title).toBe("on dev");
}, 60_000);

test("a record that exists only on a PR head is proposed by that PR (QCLI-417 AC2)", async () => {
  const result = await view(fixture, openPr(fixture));
  const proposed = entry(result.entries, "T-3");
  expect(proposed.proposedBy).toBe("opum-ai/quest-cli#1");
  expect(proposed.title).toBe("only on the pr head");
  // QCLI-432: a lone state has nothing to collide with, so it is one task
  // whatever its record carries.
  expect(proposed.identity).toBe("task");
  expect(proposed.states).toEqual([
    {
      status: "To Do",
      refProvenance: {
        ref: "refs/pull/1/head",
        pullRequest: "opum-ai/quest-cli#1",
        sha: fixture.prSha,
      },
    },
  ]);
  // The negative half: an id dev carries as well is never attributed to a PR.
  expect(entry(result.entries, "T-1").proposedBy).toBeNull();
}, 60_000);

test("two refs disagreeing about a status list every state with its provenance and pick no winner (QCLI-417 AC3)", async () => {
  const result = await view(fixture, openPr(fixture));
  const conflict = entry(result.entries, "T-1");
  expect(conflict.conflict).toBe(true);
  // QCLI-432: the SAME record on both refs -- one createdAt -- is one task
  // whose states disagree, NOT a collision. `identity` distinguishes them.
  expect(conflict.identity).toBe("task");
  expect(conflict.states.map((state) => state.status)).toEqual([
    "To Do",
    "In Progress",
  ]);
  // No winner: the entry carries no resolved `status` field at all.
  expect(Object.keys(conflict).sort()).toEqual([
    "conflict",
    "id",
    "identity",
    "proposedBy",
    "states",
    "title",
  ]);
}, 60_000);

test("a genuine id collision -- two different records sharing an id -- is reported, not folded into one task (QCLI-432 AC1)", async () => {
  const result = await view(fixture, collisionPr(fixture));
  const collision = entry(result.entries, "T-1");
  // The same id on two refs, but two records: not one task with disagreeing
  // states.
  expect(collision.identity).toBe("collision");
  // The two states really are different records' bytes, read from dev and the
  // colliding PR head -- the view is not inventing the distinction.
  expect(fixture.devT1Blob).not.toBe(
    git(fixture.work, "rev-parse", "collision:.quest/tasks/T-1.json"),
  );
  // Both states are still listed, one per ref, with their own provenance.
  expect(collision.states.map((state) => state.refProvenance.ref)).toEqual([
    "origin/dev",
    "refs/pull/3/head",
  ]);
}, 60_000);

test("a pair the discriminator cannot compare is an unresolved collision, never assumed one task (QCLI-432 AC2)", async () => {
  const result = await view(fixture, unresolvedPr(fixture));
  const unresolved = entry(result.entries, "T-1");
  expect(unresolved.identity).toBe("unresolved");
  expect(unresolved.states.map((state) => state.refProvenance.ref)).toEqual([
    "origin/dev",
    "refs/pull/4/head",
  ]);
}, 60_000);

test("a LONE record with no createdAt is one task, not an unresolved collision (QCLI-432 AC2)", async () => {
  const result = await view(fixture, unresolvedPr(fixture));
  const lone = entry(result.entries, "T-9");
  // One state cannot collide with anything, so the missing createdAt does not
  // make it unresolved. This is the case that fails if the `states.length < 2`
  // guard is removed -- unlike a lone state that carries a createdAt.
  expect(lone.identity).toBe("task");
  expect(lone.states).toHaveLength(1);
}, 60_000);

test("an id both refs carry identically is NOT marked as a conflict (negative control for AC3)", async () => {
  const result = await view(fixture, openPr(fixture));
  const agreeing = entry(result.entries, "T-2");
  // Two states, one status: a `conflict` that fired on "more than one state"
  // would be true here, and this is the case that says it does not.
  expect(agreeing.states).toHaveLength(2);
  expect(new Set(agreeing.states.map((state) => state.status)).size).toBe(1);
  expect(agreeing.conflict).toBe(false);
}, 60_000);

test("a status conflict is DATA: the CLI exits 0, never 5 (QCLI-417 exit codes)", async () => {
  const result = quest(fixture.work, [
    "task",
    "list",
    "--across-refs",
    "--ref",
    "refs/heads/dev",
    "--pr",
    "1",
    "--json",
  ]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const envelope = JSON.parse(result.stdout) as {
    data: readonly AcrossRefsEntry[];
    coverage: AcrossRefsCoverage;
  };
  expect(entry(envelope.data, "T-1").conflict).toBe(true);
  expect(envelope.coverage.complete).toBe(true);
}, 60_000);

test("an injected discovery failure is one unreadable ref and never an uncaught error (QCLI-417)", async () => {
  const result = await view(
    fixture,
    discovery({ failure: "gh was not found on PATH" }),
  );
  expect(result.coverage.complete).toBe(false);
  // Without --allow-partial the population stays the one that was planned:
  // the caller never agreed to a narrower question.
  expect(result.coverage.population).toBe("open-prs");
  expect(result.coverage.refsUnreadable).toEqual([
    { ref: null, pullRequest: null, reason: "gh was not found on PATH" },
  ]);
  // The dev ref was still read, and is still reported.
  expect(result.coverage.refsRead).toEqual([
    { ref: "origin/dev", pullRequest: null, sha: fixture.devSha },
  ]);
}, 60_000);

test("--allow-partial degrades to dev-only with complete false, and never complete true (QCLI-417 AC5)", async () => {
  const result = await view(
    fixture,
    discovery({ failure: "gh was not found on PATH" }),
    { allowPartial: true },
  );
  expect(result.coverage.complete).toBe(false);
  expect(result.coverage.population).toBe("dev-only");
  expect(result.coverage.refsUnreadable).toHaveLength(1);
  // The dev half is a real read, at remote truth.
  expect(entry(result.entries, "T-1").states[0]?.refProvenance.sha).toBe(
    fixture.devSha,
  );
}, 60_000);

test("a run that read zero refs is not complete even with --allow-partial (QCLI-417 AC4, positive control)", async () => {
  const outcome = await service(
    fixture,
    discovery({ failure: "gh was not found on PATH" }),
  ).view({
    repositoryPath: fixture.work,
    allowPartial: true,
    // An explicit ref that resolves nowhere reads zero refs.
    refs: ["refs/heads/no-such-branch"],
  });
  if (outcome.kind !== "view") throw new Error("expected a view");
  expect(outcome.coverage.refsRead).toEqual([]);
  expect(outcome.coverage.complete).toBe(false);
}, 60_000);

test("zero refs is a CLI failure, not a pass, with and without --allow-partial (QCLI-417 AC4)", async () => {
  for (const allowPartial of [false, true]) {
    const result = quest(fixture.work, [
      "task",
      "list",
      "--across-refs",
      "--pr",
      "99",
      ...(allowPartial ? ["--allow-partial"] : []),
      "--json",
    ]);
    expect(result.exitCode).toBe(6);
    expect(result.stdout).toBe("");
    const diagnostic = JSON.parse(result.stderr) as {
      error_type: string;
      message: string;
      input: { coverage: AcrossRefsCoverage };
      principal: null;
    };
    expect(diagnostic.error_type).toBe("drift");
    expect(diagnostic.message).toContain("read 0 refs");
    expect(diagnostic.input.coverage.refsRead).toEqual([]);
    expect(diagnostic.input.coverage.complete).toBe(false);
    // The error envelope is the only output, on stderr, and still well formed.
    expect(Object.keys(diagnostic)).toEqual([
      "error_type",
      "message",
      "input",
      "hint",
      "principal",
    ]);
  }
}, 60_000);

test("an unreadable ref exits 6 with the ref named in the message and in input, 0 bytes on stdout (QCLI-417 AC4)", async () => {
  const result = quest(fixture.work, [
    "task",
    "list",
    "--across-refs",
    "--ref",
    "refs/heads/dev",
    "--ref",
    "refs/heads/no-such-branch",
    "--json",
  ]);
  expect(result.exitCode).toBe(6);
  expect(result.stdout).toBe("");
  const diagnostic = JSON.parse(result.stderr) as {
    error_type: string;
    message: string;
    input: { coverage: AcrossRefsCoverage };
  };
  expect(diagnostic.error_type).toBe("drift");
  expect(diagnostic.message).toContain("refs/heads/no-such-branch");
  expect(diagnostic.input.coverage.refsUnreadable).toEqual([
    {
      ref: "refs/heads/no-such-branch",
      pullRequest: null,
      reason: expect.stringContaining("does not resolve"),
    },
  ]);
  // The ref that WAS read is reported too, so a reader can see how far the
  // answer got before it stopped.
  expect(diagnostic.input.coverage.refsRead.map((read) => read.ref)).toEqual([
    "refs/heads/dev",
  ]);
}, 60_000);

test("--allow-partial turns incomplete coverage into exit 0 with the refs still named (QCLI-417 AC5)", async () => {
  const result = quest(fixture.work, [
    "task",
    "list",
    "--across-refs",
    "--allow-partial",
    "--ref",
    "refs/heads/dev",
    "--ref",
    "refs/heads/no-such-branch",
    "--json",
  ]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const envelope = JSON.parse(result.stdout) as {
    coverage: AcrossRefsCoverage;
  };
  expect(envelope.coverage.complete).toBe(false);
  expect(envelope.coverage.refsUnreadable).toHaveLength(1);
  expect(envelope.coverage.refsUnreadable[0]?.ref).toBe(
    "refs/heads/no-such-branch",
  );
}, 60_000);

test("an empty answer with complete coverage exits 0 (QCLI-417 AC4)", async () => {
  // The other half of the coverage contract: an EMPTY list is a legitimate
  // answer when every planned ref was read, and the exit code has to say so --
  // otherwise "nothing matched" and "nothing could be read" are the same
  // signal, which is the failure this command exists to remove.
  const result = questOk(fixture.work, [
    "task",
    "list",
    "--across-refs",
    "--ref",
    "refs/heads/dev",
    "--status",
    "Done",
  ]);
  const envelope = JSON.parse(result.stdout) as {
    data: readonly AcrossRefsEntry[];
    coverage: AcrossRefsCoverage;
  };
  expect(envelope.data).toEqual([]);
  expect(envelope.coverage.complete).toBe(true);
  expect(envelope.coverage.refsRead).toHaveLength(1);
}, 60_000);

test("the plain output says a nothing-open answer does not hold when coverage is incomplete (QCLI-417 AC5)", async () => {
  const result = quest(fixture.work, [
    "task",
    "list",
    "--across-refs",
    "--allow-partial",
    "--ref",
    "refs/heads/dev",
    "--ref",
    "refs/heads/no-such-branch",
    "--plain",
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("INCOMPLETE");
  expect(result.stdout).toContain("does NOT hold for the repository");
  expect(result.stdout).toContain("refs/heads/no-such-branch");

  const complete = quest(fixture.work, [
    "task",
    "list",
    "--across-refs",
    "--ref",
    "refs/heads/dev",
    "--plain",
  ]);
  expect(complete.exitCode).toBe(0);
  expect(complete.stdout).toContain("holds for the repository");
  expect(complete.stdout).not.toContain("INCOMPLETE");
}, 60_000);

test("the envelope keeps contractVersion at index 1, coverage after data, and principal last (QCLI-417)", async () => {
  const result = questOk(fixture.work, [
    "task",
    "list",
    "--across-refs",
    "--pr",
    "1",
  ]);
  const envelope = JSON.parse(result.stdout) as {
    kind: string;
    data: readonly AcrossRefsEntry[];
    coverage: AcrossRefsCoverage;
  };
  expect(Object.keys(envelope)).toEqual([
    "schemaVersion",
    "contractVersion",
    "kind",
    "data",
    "coverage",
    "principal",
  ]);
  expect(Object.keys(envelope).indexOf("contractVersion")).toBe(1);
  expect(envelope.kind).toBe("task.list-across-refs");
  // `scope` is superseded, not also emitted.
  expect(Object.keys(envelope)).not.toContain("scope");
}, 60_000);

test("every key `task list --across-refs` emits is manifest-declared, and every declared field is emitted (QCLI-475)", async () => {
  // The manifest entry is the contract a consumer reads, and nothing tied it to
  // the payload this command actually emits: QCLI-432's round-1 review found
  // the new `identity` key emitted but undeclared, and only a reviewer noticed.
  // The key-set assertion further down this file is hardcoded, so it pins the
  // keys without ever reading the manifest and cannot catch that drift. This is
  // the across-refs half of the QCLI-137 / QCLI-461 test for task view/list.
  const manifest = JSON.parse(questOk(fixture.work, ["manifest"]).stdout).data
    .commands as { name: string; fields?: readonly string[] }[];
  const declared = manifest.find(
    (command) => command.name === "task list --across-refs",
  )?.fields;
  expect(declared).toBeDefined();
  const declaredSorted = [...(declared ?? [])].sort();
  expect(declaredSorted.length).toBeGreaterThan(0);

  const envelope = JSON.parse(
    questOk(fixture.work, [
      "task",
      "list",
      "--across-refs",
      "--ref",
      "refs/heads/dev",
      "--pr",
      "1",
    ]).stdout,
  ) as { data: readonly AcrossRefsEntry[] };
  // A read that saw nothing must not pass: the loop below is vacuous over [].
  expect(envelope.data.length).toBeGreaterThan(0);

  for (const row of envelope.data) {
    const keys = Object.keys(row).sort();
    // (a) every emitted key is declared -- the direction QCLI-432 broke, where
    // an undeclared `identity` rode out unnoticed.
    expect(keys.filter((key) => !declaredSorted.includes(key))).toEqual([]);
    // (b) and every declared field is emitted, so a declaration nothing writes
    // (the QCLI-137 class) goes red here too.
    expect(keys).toEqual(declaredSorted);
  }
  // Exercised by the emitted `identity` key: it is on every entry, and the
  // fixture's T-1 is a real conflict, so this is not a stand-in value.
  expect(envelope.data.every((row) => "identity" in row)).toBe(true);
  expect(entry(envelope.data, "T-1").identity).toBeDefined();
}, 60_000);

test("--ref and --pr replace discovery with an explicit population, and --pr resolves by Git alone (QCLI-417)", async () => {
  const result = questOk(fixture.work, [
    "task",
    "list",
    "--across-refs",
    "--ref",
    "refs/heads/dev",
    "--pr",
    "1",
  ]);
  const envelope = JSON.parse(result.stdout) as {
    data: readonly AcrossRefsEntry[];
    coverage: AcrossRefsCoverage;
  };
  expect(envelope.coverage.population).toBe("explicit");
  expect(envelope.coverage.complete).toBe(true);
  // refs/pull/1/head exists only in the bare origin, so this is also the
  // fetch-when-absent path -- and the fetch must NOT have created the ref.
  expect(envelope.coverage.refsRead.map((read) => read.ref)).toEqual([
    "refs/heads/dev",
    "refs/pull/1/head",
  ]);
  expect(
    run(fixture.work, ["git", "rev-parse", "--verify", "refs/pull/1/head"])
      .exitCode,
  ).not.toBe(0);
  // The explicit population needs no forge: neither entry claims a PR.
  expect(entry(envelope.data, "T-1").states[1]?.refProvenance.pullRequest).toBe(
    null,
  );
}, 60_000);

test("filters compose: an entry matches when any state matches, and keeps all its states (QCLI-417)", async () => {
  // T-1 is In Progress on the PR head only; T-2 is To Do everywhere; T-3 is
  // To Do on the PR head only.
  const byStatus = await view(fixture, openPr(fixture), {
    filter: { status: "In Progress" },
  });
  expect(byStatus.entries.map((row) => row.id)).toEqual(["T-1"]);
  expect(entry(byStatus.entries, "T-1").states).toHaveLength(2);

  const none = await view(fixture, openPr(fixture), {
    filter: { status: "Done" },
  });
  expect(none.entries).toEqual([]);

  const byLabel = await view(fixture, openPr(fixture), {
    filter: { labels: ["tracker"] },
  });
  expect(byLabel.entries.map((row) => row.id)).toEqual(["T-1"]);

  const bySearch = await view(fixture, openPr(fixture), {
    filter: { search: "PR HEAD" },
  });
  expect(bySearch.entries.map((row) => row.id)).toEqual(["T-3"]);

  const limited = await view(fixture, openPr(fixture), {
    filter: { sort: { field: "id", direction: "desc" }, limit: 1 },
  });
  expect(limited.entries.map((row) => row.id)).toEqual(["T-3"]);

  // Two filters over the same entry compose rather than replacing each other.
  const composed = await view(fixture, openPr(fixture), {
    filter: { search: "only on the pr head", excludeStatuses: ["Done"] },
  });
  expect(composed.entries.map((row) => row.id)).toEqual(["T-3"]);

  // --exclude-status matches on the same ANY-state rule, which for a
  // conflicting entry means it is selected by its surviving state: T-1 is In
  // Progress on the PR head and To Do on dev, so it is NOT excluded. That is
  // the semantics the accepted shape states, and it is the safe direction --
  // the alternative would let one ref's status hide an id another ref carries.
  const excluded = await view(fixture, openPr(fixture), {
    filter: { excludeStatuses: ["In Progress"] },
  });
  expect(excluded.entries.map((row) => row.id)).toEqual(["T-1", "T-2", "T-3"]);
}, 60_000);

test("an unknown --status is refused rather than answering an empty list (QCLI-417)", async () => {
  const result = quest(fixture.work, [
    "task",
    "list",
    "--across-refs",
    "--ref",
    "refs/heads/dev",
    "--status",
    "No Such Status",
    "--json",
  ]);
  expect(result.exitCode).toBe(6);
  expect(JSON.parse(result.stderr).message).toContain(
    "Task status is not configured",
  );
}, 60_000);

test("--ready is refused rather than approximated (QCLI-417)", async () => {
  const result = quest(fixture.work, [
    "task",
    "list",
    "--across-refs",
    "--ready",
    "--json",
  ]);
  expect(result.exitCode).toBe(2);
  expect(JSON.parse(result.stderr).message).toContain("--ready");
}, 60_000);

test("the view is read-only: no record, ref or branch is written (QCLI-417 AC6)", async () => {
  const before = {
    refs: git(
      fixture.work,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ),
    head: git(fixture.work, "rev-parse", "HEAD"),
    status: git(fixture.work, "status", "--porcelain"),
    record: await readFile(join(fixture.work, ".quest/tasks/T-1.json"), "utf8"),
    tracked: git(fixture.work, "ls-files", ".quest/"),
  };
  questOk(fixture.work, ["task", "list", "--across-refs", "--pr", "1"]);
  expect(
    git(fixture.work, "for-each-ref", "--format=%(refname) %(objectname)"),
  ).toBe(before.refs);
  expect(git(fixture.work, "rev-parse", "HEAD")).toBe(before.head);
  expect(git(fixture.work, "status", "--porcelain")).toBe(before.status);
  expect(
    await readFile(join(fixture.work, ".quest/tasks/T-1.json"), "utf8"),
  ).toBe(before.record);
  expect(git(fixture.work, "ls-files", ".quest/")).toBe(before.tracked);
}, 60_000);

test("the working tree is not the view: a record that exists only uncommitted is absent (QCLI-417)", async () => {
  const created = questOk(fixture.work, [
    "task",
    "create",
    "only uncommitted",
    ...ACTOR,
  ]);
  const id = (JSON.parse(created.stdout) as { data: { id: string } }).data.id;
  const local = JSON.parse(
    quest(fixture.work, ["task", "list", "--json"]).stdout,
  ) as { data: readonly { id: string }[] };
  expect(local.data.map((row) => row.id)).toContain(id);
  const across = questOk(fixture.work, [
    "task",
    "list",
    "--across-refs",
    "--ref",
    "refs/heads/dev",
  ]);
  const envelope = JSON.parse(across.stdout) as {
    data: readonly { id: string }[];
  };
  const acrossIds = envelope.data.map((row) => row.id);
  // QCLI-472: the absence below is a claim about THIS list, so it is paired
  // with a positive over the same list and the same source. Without it an empty
  // across-refs view satisfies the row vacuously -- the only other positive is
  // over `local.data`, a plain `task list`, which is a different source and
  // establishes nothing about whether the across-refs view is populated at all.
  // `dev` carries T-1 and T-2 (see createFixture), so the view must carry T-1.
  expect(acrossIds).toContain("T-1");
  expect(acrossIds).not.toContain(id);
  // Leave the shared fixture as it was found.
  await rm(join(fixture.work, `.quest/tasks/${id}.json`), { force: true });
}, 60_000);

test("an origin that is not GitHub is a named coverage failure through the REAL adapter (QCLI-417)", async () => {
  // No injection here: this is the production path, and a local-path origin is
  // exactly what a caller in a fixture, a mirror or a sandbox hits. The failure
  // must be a coverage entry -- never an uncaught error, never a silent empty
  // list -- and its reason must survive the JSON boundary without naming a
  // local path.
  const failing = quest(fixture.work, [
    "task",
    "list",
    "--across-refs",
    "--json",
  ]);
  expect(failing.exitCode).toBe(6);
  expect(failing.stdout).toBe("");
  const diagnostic = JSON.parse(failing.stderr) as {
    error_type: string;
    message: string;
    input: { coverage: AcrossRefsCoverage };
  };
  expect(diagnostic.error_type).toBe("drift");
  expect(diagnostic.message).toContain("the open-pull-request list");
  const [unreadable] = diagnostic.input.coverage.refsUnreadable;
  expect(unreadable?.ref).toBeNull();
  expect(unreadable?.pullRequest).toBeNull();
  expect(unreadable?.reason).toContain("not a GitHub remote");
  expect(unreadable?.reason).not.toContain(fixture.origin);
  expect(unreadable?.reason.split("\n")).toHaveLength(1);

  // ...and --allow-partial keeps it usable as a dev-only answer.
  const partial = questOk(fixture.work, [
    "task",
    "list",
    "--across-refs",
    "--allow-partial",
  ]);
  const envelope = JSON.parse(partial.stdout) as {
    coverage: AcrossRefsCoverage;
    data: readonly AcrossRefsEntry[];
  };
  expect(envelope.coverage.population).toBe("dev-only");
  expect(envelope.coverage.complete).toBe(false);
  expect(envelope.coverage.refsUnreadable).toHaveLength(1);
  // A dev-only answer still answers about dev: T-1 and T-2 are here, and the
  // PR-only record is honestly absent rather than guessed at.
  expect(envelope.data.map((row) => row.id)).toEqual(["T-1", "T-2"]);
}, 60_000);

test("a repository with no origin is a not-found, not a coverage failure (QCLI-417 exit 3)", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli417-noorigin-"));
  try {
    git(root, "init", "-q", "-b", "dev", ".");
    git(root, "config", "user.email", "t@example.invalid");
    git(root, "config", "user.name", "T");
    questOk(root, ["init", "--name", "NoOrigin", "--task-id-prefix", "T"]);
    const result = quest(root, ["task", "list", "--across-refs", "--json"]);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error_type).toBe("not_found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("an origin with no dev branch is a not-found (QCLI-417 exit 3)", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli417-nodev-"));
  try {
    git(root, "init", "-q", "-b", "trunk", ".");
    git(root, "config", "user.email", "t@example.invalid");
    git(root, "config", "user.name", "T");
    questOk(root, ["init", "--name", "NoDev", "--task-id-prefix", "T"]);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    const origin = join(root, "origin.git");
    git(root, "clone", "-q", "--bare", ".", origin);
    await setOriginUrl(root, origin);
    const result = quest(root, ["task", "list", "--across-refs", "--json"]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stderr).error_type).toBe("not_found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("the real discovery adapter classifies GitHub and non-GitHub remotes (QCLI-417)", async () => {
  const port = new GhRefDiscovery(new LocalGitPort());
  expect(await port.origin(fixture.work)).toEqual({
    kind: "unsupported",
    url: fixture.origin,
  });
  const root = await mkdtemp(join(tmpdir(), "qcli417-remotes-"));
  try {
    git(root, "init", "-q", "-b", "dev", ".");
    for (const [url, expected] of [
      [
        "git@github.com:opum-ai/quest-cli.git",
        { kind: "github", slug: "opum-ai/quest-cli" },
      ],
      [
        "https://github.com/opum-ai/quest-cli.git",
        { kind: "github", slug: "opum-ai/quest-cli" },
      ],
      [
        "ssh://git@github.com/opum-ai/quest-cli.git",
        { kind: "github", slug: "opum-ai/quest-cli" },
      ],
      [
        "/tmp/somewhere/else.git",
        { kind: "unsupported", url: "/tmp/somewhere/else.git" },
      ],
    ] as const) {
      await setOriginUrl(root, url);
      expect({ url, origin: await port.origin(root) }).toEqual({
        url,
        origin: expected,
      });
      await setOriginUrl(root, null);
    }
    expect(await port.origin(root)).toEqual({ kind: "absent" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

/**
 * FIX ROUND (independent review, 2026-09-29). Seven conformance failures
 * against the accepted shape and one documentation gap. Each test below
 * reaches the property that was wrong rather than the code path that was
 * changed: the listing failure is a REAL missing tree object, the fetch test
 * uses a REAL stale remote-tracking ref in a REAL clone, the duplicate is a
 * REAL second copy of a record, and the gh cases exercise the parse and argv
 * layers the production path actually uses.
 */

test("a ref whose TREE cannot be listed is unreadable, not empty (F1)", async () => {
  // The false green: `listFiles` answers [] for a refused listing, so a ref
  // whose tree object is gone read as "no records" and the view said
  // complete:true, exit 0. Measured before the fix: exit 0, data [], exit 6
  // never reached.
  const root = await mkdtemp(join(tmpdir(), "qcli417-f1-"));
  try {
    git(root, "init", "-q", "-b", "dev", ".");
    git(root, "config", "user.email", "t@example.invalid");
    git(root, "config", "user.name", "T");
    questOk(root, ["init", "--name", "F1", "--task-id-prefix", "T"]);
    questOk(root, ["task", "create", "on dev", ...ACTOR]);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "T-1 on dev");
    // A second branch with a tree of its own, so deleting that tree leaves
    // dev readable.
    git(root, "checkout", "-q", "-b", "broken");
    questOk(root, ["task", "create", "on the branch", ...ACTOR]);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "T-2 on broken");
    const tree = git(root, "rev-parse", "broken^{tree}");
    const objectPath = join(
      root,
      ".git",
      "objects",
      tree.slice(0, 2),
      tree.slice(2),
    );
    // Loose objects only: assert the object is where this test thinks it is,
    // so a packed fixture fails loudly instead of passing vacuously.
    expect(existsSync(objectPath)).toBe(true);
    await rm(objectPath);
    expect(run(root, ["git", "ls-tree", "-r", "broken"]).exitCode).not.toBe(0);

    const result = quest(root, [
      "task",
      "list",
      "--across-refs",
      "--ref",
      "refs/heads/dev",
      "--ref",
      "refs/heads/broken",
      "--json",
    ]);
    expect(result.exitCode).toBe(6);
    expect(result.stdout).toBe("");
    const diagnostic = JSON.parse(result.stderr) as {
      error_type: string;
      input: { coverage: AcrossRefsCoverage };
    };
    expect(diagnostic.error_type).toBe("drift");
    expect(diagnostic.input.coverage.complete).toBe(false);
    expect(diagnostic.input.coverage.refsRead.map((read) => read.ref)).toEqual([
      "refs/heads/dev",
    ]);
    expect(diagnostic.input.coverage.refsUnreadable[0]?.ref).toBe(
      "refs/heads/broken",
    );

    // --allow-partial is unchanged by this: the readable half is still served.
    const partial = questOk(root, [
      "task",
      "list",
      "--across-refs",
      "--allow-partial",
      "--ref",
      "refs/heads/dev",
      "--ref",
      "refs/heads/broken",
    ]);
    const envelope = JSON.parse(partial.stdout) as {
      data: readonly AcrossRefsEntry[];
      coverage: AcrossRefsCoverage;
    };
    expect(envelope.coverage.complete).toBe(false);
    expect(envelope.data.map((row) => row.id)).toEqual(["T-1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a duplicate id inside one ref makes that ref unreadable, naming both paths (F4)", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli417-f4-"));
  try {
    git(root, "init", "-q", "-b", "dev", ".");
    git(root, "config", "user.email", "t@example.invalid");
    git(root, "config", "user.name", "T");
    questOk(root, ["init", "--name", "F4", "--task-id-prefix", "T"]);
    questOk(root, ["task", "create", "on dev", ...ACTOR]);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "T-1 on dev");
    // The half-staged relocation shape: the record exists in tasks/ and
    // completed/ at once. Written directly because every quest write refuses
    // this state -- which is the point: the view must not read a record set
    // the repository itself calls corrupt.
    const task = await readFile(join(root, ".quest/tasks/T-1.json"), "utf8");
    await mkdir(join(root, ".quest/completed"), { recursive: true });
    await writeFile(join(root, ".quest/completed/T-1.json"), task);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "duplicate T-1");

    const result = quest(root, [
      "task",
      "list",
      "--across-refs",
      "--ref",
      "refs/heads/dev",
      "--json",
    ]);
    expect(result.exitCode).toBe(6);
    expect(result.stdout).toBe("");
    const diagnostic = JSON.parse(result.stderr) as {
      error_type: string;
      input: { coverage: AcrossRefsCoverage };
    };
    expect(diagnostic.error_type).toBe("drift");
    expect(diagnostic.input.coverage.complete).toBe(false);
    const [unreadable] = diagnostic.input.coverage.refsUnreadable;
    expect(unreadable?.ref).toBe("refs/heads/dev");
    // Both paths, so a reader can act on it without a second command.
    expect(unreadable?.reason).toContain(".quest/tasks/T-1.json");
    expect(unreadable?.reason).toContain(".quest/completed/T-1.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a fetch moves no ref: a stale origin/dev stays put (F3)", async () => {
  // The claim the port docblock, the service header and the help text all
  // make. Measured before the fix: `git fetch --no-tags origin refs/heads/dev`
  // moved refs/remotes/origin/dev (and what origin/HEAD resolves to) from the
  // stale tip to the remote's, which also changes a later QCLI-316 scope
  // answer.
  const root = await mkdtemp(join(tmpdir(), "qcli417-f3-"));
  try {
    const work = join(root, "work");
    git(root, "init", "-q", "-b", "dev", work);
    git(work, "config", "user.email", "t@example.invalid");
    git(work, "config", "user.name", "T");
    questOk(work, ["init", "--name", "F3", "--task-id-prefix", "T"]);
    questOk(work, ["task", "create", "first on dev", ...ACTOR]);
    git(work, "add", "-A");
    git(work, "commit", "-qm", "T-1 on dev");
    const origin = join(root, "origin.git");
    git(root, "clone", "-q", "--bare", work, origin);
    // A clone taken BEFORE dev moves on: it has the old tip only.
    const stale = join(root, "stale");
    git(root, "clone", "-q", origin, stale);
    questOk(work, ["task", "create", "second on dev", ...ACTOR]);
    git(work, "add", "-A");
    git(work, "commit", "-qm", "T-2 on dev");
    const moved = git(work, "rev-parse", "dev");
    // Move the bare's dev without a push, so the fixture never has to write a
    // branch through the delivery path this repository guards.
    git(origin, "fetch", "-q", work, "refs/heads/dev");
    git(origin, "update-ref", "refs/heads/dev", moved);
    // The stale clone genuinely lacks the new tip's objects, which is what
    // forces the fetch.
    expect(
      run(stale, ["git", "cat-file", "-e", `${moved}^{commit}`]).exitCode,
    ).not.toBe(0);

    const refsBefore = git(
      stale,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/remotes",
    );
    const result = await viewAt(
      stale,
      discovery({ failure: "no forge here" }),
      {
        allowPartial: true,
      },
    );
    // The run really did read the remote's tip, so the fetch happened.
    expect(result.coverage.refsRead).toEqual([
      { ref: "origin/dev", pullRequest: null, sha: moved },
    ]);
    expect(result.entries.map((row) => row.id)).toEqual(["T-1", "T-2"]);
    expect(
      git(
        stale,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
        "refs/remotes",
      ),
    ).toBe(refsBefore);
    expect(
      run(stale, ["git", "cat-file", "-e", `${moved}^{commit}`]).exitCode,
    ).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a committed dot-prefixed journal beside the records is not read as one (F7)", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli417-f7-"));
  try {
    git(root, "init", "-q", "-b", "dev", ".");
    git(root, "config", "user.email", "t@example.invalid");
    git(root, "config", "user.name", "T");
    questOk(root, ["init", "--name", "F7", "--task-id-prefix", "T"]);
    questOk(root, ["task", "create", "on dev", ...ACTOR]);
    // Operational metadata that will never parse as a record. The repository
    // reader skips dot-prefixed files for exactly this reason.
    await writeFile(
      join(root, ".quest/tasks/.lifecycle.journal.json"),
      '{"journal": true}\n',
    );
    git(root, "add", "-A");
    git(root, "commit", "-qm", "T-1 and a journal");
    const result = questOk(root, [
      "task",
      "list",
      "--across-refs",
      "--ref",
      "refs/heads/dev",
    ]);
    const envelope = JSON.parse(result.stdout) as {
      data: readonly AcrossRefsEntry[];
      coverage: AcrossRefsCoverage;
    };
    // Before the fix this was exit 6: the journal failed the whole ref.
    expect(envelope.coverage.complete).toBe(true);
    expect(envelope.data.map((row) => row.id)).toEqual(["T-1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("gh is asked for an explicit --limit and an explicit --repo (F2, F8)", () => {
  const argv = ghPullRequestArguments("opum-ai/quest-cli", "dev");
  // gh's own default is 30 and it says nothing when it stops there, so the
  // limit has to be named by us -- and reaching it is reported as incomplete
  // rather than trusted.
  expect(argv).toContain("--limit");
  expect(argv[argv.indexOf("--limit") + 1]).toBe(
    String(OPEN_PULL_REQUEST_LIMIT),
  );
  expect(OPEN_PULL_REQUEST_LIMIT).toBeGreaterThan(30);
  // GH_REPO would otherwise redirect the query away from the origin the slug
  // names, which is how "the slug and the forge cannot drift apart" was false.
  expect(argv).toContain("--repo");
  expect(argv[argv.indexOf("--repo") + 1]).toBe("opum-ai/quest-cli");
  expect(argv).toContain("--base");
  expect(argv[argv.indexOf("--base") + 1]).toBe("dev");
  expect(argv).toContain("--state");
  expect(argv[argv.indexOf("--state") + 1]).toBe("open");
}, 60_000);

test("a truncated listing is incomplete coverage, not a confident answer (F2)", () => {
  const row = (number: number) => ({
    number,
    headRefName: `pr-${number}`,
    headRefOid: "a".repeat(40),
    url: `https://github.com/opum-ai/quest-cli/pull/${number}`,
  });
  // Below the ceiling: usable.
  expect(
    parseOpenPullRequests(JSON.stringify([row(1), row(2)]), 3),
  ).toHaveLength(2);
  // At the ceiling: gh may have stopped there, so the population is unknown.
  expect(() =>
    parseOpenPullRequests(JSON.stringify([row(1), row(2)]), 2),
  ).toThrow(/truncated/);
  // And the rows that were returned are still reported through the error,
  // not silently dropped.
  try {
    parseOpenPullRequests(JSON.stringify([row(1), row(2), row(3)]), 3);
    throw new Error("expected a throw");
  } catch (error) {
    const message = (error as Error).message;
    expect(message).toContain("3 rows");
    expect(message).toContain("--limit 3");
    // N1: the reason is a one-line remedy, like every other reason this
    // command reports -- a reader who hits the ceiling learns both what to do
    // instead and that the ceiling is a code constant, not a forge setting.
    expect(message).toContain("--ref <ref>");
    expect(message).toContain("--pr <N>");
    expect(message).toContain("OPEN_PULL_REQUEST_LIMIT");
    // QCLI-418: the source-level remedy must name no repository path. The
    // reason is read by installed-CLI users, who have no checkout to open, so
    // a path there is a remedy they cannot follow.
    expect(message).toContain("source checkout");
    expect(message).not.toMatch(/\.ts\b/);
    expect(message).not.toContain("src/");
    expect(message.split("\n")).toHaveLength(1);
  }
}, 60_000);

test("rows this view cannot use make the population incomplete (F6)", () => {
  const good = {
    number: 7,
    headRefName: "feature",
    headRefOid: "b".repeat(40),
    url: "https://github.com/opum-ai/quest-cli/pull/7",
  };
  const parsed = parseOpenPullRequests(JSON.stringify([good]));
  expect(parsed).toEqual([good]);

  for (const [row, expected] of [
    [{ ...good, number: "7" }, "number is not an integer"],
    [{ ...good, headRefOid: "not-a-sha" }, "headRefOid is not a 40-hex commit"],
    [{ ...good, headRefName: 7 }, "headRefName is not a string"],
    ["not-an-object", "not a JSON object"],
  ] as const) {
    expect(() => parseOpenPullRequests(JSON.stringify([good, row]))).toThrow(
      new RegExp(expected),
    );
  }
  // The row index is named, so a caller knows which row the forge got wrong.
  expect(() =>
    parseOpenPullRequests(JSON.stringify([good, { ...good, headRefOid: "x" }])),
  ).toThrow(/row 2/);
  // A row with no url is usable: url only refines the label.
  expect(
    parseOpenPullRequests(
      JSON.stringify([
        { number: 2, headRefName: "f", headRefOid: "c".repeat(40) },
      ]),
    ),
  ).toEqual([{ number: 2, headRefName: "f", headRefOid: "c".repeat(40) }]);
  expect(() => parseOpenPullRequests("not json")).toThrow(
    /did not return JSON/,
  );
  expect(() => parseOpenPullRequests("{}")).toThrow(/JSON array/);
}, 60_000);

test("every flag documented for an invocation is a flag that invocation accepts (F5)", () => {
  // The reviewer's defect: `quest help task list` advertised --across-refs,
  // --allow-partial, --ref and --pr, and plain `task list` rejects all four
  // with exit 2. Documentation that outruns the parser is worse than silence,
  // because the reader believes it.
  const booleanFlags = new Set<string>(BOOLEAN_FLAGS);
  // Plausible values, so a flag that IS accepted runs rather than tripping a
  // value check -- which is a different refusal and must not be read as
  // acceptance or as rejection.
  const values: Record<string, string> = {
    "--status": "To Do",
    "--exclude-status": "Done",
    "--label": "tracker",
    "--assignee": "t",
    "--milestone": "M-1",
    "--parent": "T-1",
    "--priority": "high",
    "--type": "feature",
    "--search": "dev",
    "--sort": "id",
    "--limit": "5",
    "--ref": "refs/heads/dev",
    "--pr": "1",
  };
  const recipe: Record<string, readonly string[]> = {
    "task list": ["task", "list"],
    "task list --across-refs": [
      "task",
      "list",
      "--across-refs",
      "--ref",
      "refs/heads/dev",
    ],
  };
  for (const [name, base] of Object.entries(recipe)) {
    for (const flag of commandHelp[name as keyof typeof commandHelp]?.flags ??
      []) {
      const result = quest(fixture.work, [
        ...base,
        booleanFlags.has(flag) ? flag : `${flag}=${values[flag] ?? "1"}`,
        "--json",
      ]);
      // "Unrecognized flag" is the defect: `only()` refused the flag, so the
      // command never ran. Any other outcome -- success, not-found, a
      // validation refusal about the value -- means the parser accepted it.
      expect({
        name,
        flag,
        unrecognized: result.stderr.includes("Unrecognized flag"),
        stderr: result.stderr.includes("Unrecognized flag")
          ? result.stderr
          : "",
      }).toEqual({ name, flag, unrecognized: false, stderr: "" });
    }
  }
  // The manifest half of the same defect: `quest manifest` derives each
  // entry's parameters from that entry's own help, so a plain `task list`
  // that advertised them would hand a machine consumer a flag its own
  // invocation rejects.
  const manifest = JSON.parse(
    quest(fixture.work, ["manifest", "--json"]).stdout,
  ) as {
    data: {
      commands: readonly {
        name: string;
        parameters: { flags: Record<string, unknown> };
      }[];
    };
  };
  const flagsOf = (name: string): readonly string[] =>
    Object.keys(
      manifest.data.commands.find((command) => command.name === name)
        ?.parameters.flags ?? {},
    );
  for (const flag of ["--across-refs", "--allow-partial", "--ref", "--pr"])
    expect({
      flag,
      onPlainTaskList: flagsOf("task list").includes(flag),
    }).toEqual({ flag, onPlainTaskList: false });
  expect(flagsOf("task list --across-refs")).toContain("--ref");
  expect(flagsOf("task list --across-refs")).toContain("--across-refs");
}, 60_000);

test("the help states the zero-ref exemption from --allow-partial (D-a)", () => {
  // --allow-partial downgrades incomplete coverage to exit 0. A read of ZERO
  // refs is not incomplete coverage, it is no coverage, and the help has to
  // say so: the two read identically otherwise.
  const summary = commandHelp["task list --across-refs"]?.summary ?? "";
  expect(summary).toContain("ZERO refs");
  expect(summary).toContain("still exits 6 even with --allow-partial");
}, 60_000);

/**
 * ROUND 3. Two constructions the reviewer could not verify, built entirely
 * from test code: no `git remote` command runs anywhere in this suite
 * (setOriginUrl writes .git/config), no push writes a branch, and no network
 * is touched. Each is deterministic rather than best-effort, and each is
 * proven non-vacuous in the established way.
 */

test("an unreachable origin fails the dev read closed, never as an uncaught error", async () => {
  const root = await mkdtemp(join(tmpdir(), "qcli417-unreachable-"));
  try {
    git(root, "init", "-q", "-b", "dev", ".");
    git(root, "config", "user.email", "t@example.invalid");
    git(root, "config", "user.name", "T");
    questOk(root, ["init", "--name", "Unreachable", "--task-id-prefix", "T"]);
    questOk(root, ["task", "create", "on dev", ...ACTOR]);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "T-1 on dev");
    // An origin that is configured and cannot be reached: the path is simply
    // not there. `git ls-remote` fails, so the dev SHA cannot be discovered --
    // and the view must not fall back to a stale local `origin/dev`, which is
    // the whole point of reading remote truth.
    await setOriginUrl(root, join(root, "gone.git"));
    expect(
      run(root, ["git", "ls-remote", "origin", "refs/heads/dev"]).exitCode,
    ).not.toBe(0);

    for (const allowPartial of [false, true]) {
      const result = quest(root, [
        "task",
        "list",
        "--across-refs",
        ...(allowPartial ? ["--allow-partial"] : []),
        "--json",
      ]);
      // Fail closed, and identically: a run that read ZERO refs is the one
      // case --allow-partial does not downgrade, because no-coverage cannot be
      // told apart from a wrong repository. The partial VIEW is still reported
      // (population dev-only, complete false) inside the error's input.
      expect({ allowPartial, exitCode: result.exitCode }).toEqual({
        allowPartial,
        exitCode: 6,
      });
      expect(result.stdout).toBe("");
      const diagnostic = JSON.parse(result.stderr) as {
        error_type: string;
        message: string;
        input: { coverage: AcrossRefsCoverage };
      };
      expect(diagnostic.error_type).toBe("drift");
      // The failing ref is named in the message a CI reader sees...
      expect(diagnostic.message).toContain("origin/dev");
      expect(diagnostic.message).toContain("read 0 refs");
      // ...and the failure itself is in refsUnreadable, with the dev ref named.
      const dev = diagnostic.input.coverage.refsUnreadable.find(
        (entry) => entry.ref === "origin/dev",
      );
      expect(dev?.reason).toContain(
        "origin/dev could not be read from the remote",
      );
      expect(diagnostic.input.coverage.refsRead).toEqual([]);
      expect(diagnostic.input.coverage.complete).toBe(false);
      expect(diagnostic.input.coverage.population).toBe(
        allowPartial ? "dev-only" : "open-prs",
      );
      // Never an uncaught error: no stack, no exit 1, a well-formed envelope.
      expect(diagnostic).toHaveProperty("principal", null);
      expect(result.stderr).not.toContain("    at ");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a fetch that the origin rejects fails the ref closed, naming the fetch", async () => {
  // Reachable remote, advertised ref, objects that the remote cannot actually
  // serve: the bare's dev points at a commit whose object is deleted, so
  // `ls-remote` still advertises the SHA (dev is planned normally) and the
  // FETCH is what fails. Measured: `fatal: remote error: upload-pack: not our
  // ref <sha>`. This is the fetchRef rejection branch the reviewer noted as
  // untested.
  const root = await mkdtemp(join(tmpdir(), "qcli417-badfetch-"));
  try {
    const seed = join(root, "seed");
    git(root, "init", "-q", "-b", "dev", seed);
    git(seed, "config", "user.email", "t@example.invalid");
    git(seed, "config", "user.name", "T");
    questOk(seed, ["init", "--name", "BadFetch", "--task-id-prefix", "T"]);
    questOk(seed, ["task", "create", "on dev", ...ACTOR]);
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "T-1 on dev");
    const devSha = git(seed, "rev-parse", "dev");
    const origin = join(root, "origin.git");
    git(root, "clone", "-q", "--bare", seed, origin);
    // The consumer clone predates nothing: it simply has no objects for the
    // advertised commit because the object is gone from the bare.
    const work = join(root, "work");
    git(root, "init", "-q", "-b", "dev", work);
    git(work, "config", "user.email", "t@example.invalid");
    git(work, "config", "user.name", "T");
    // A workspace, so the CLI can resolve a root -- but no objects: the
    // records the view must read live at the advertised SHA, which this clone
    // has never seen. `.quest/` stays uncommitted and is irrelevant to a view
    // that reads refs.
    questOk(work, ["init", "--name", "BadFetch", "--task-id-prefix", "T"]);
    await setOriginUrl(work, origin);
    const object = join(origin, "objects", devSha.slice(0, 2), devSha.slice(2));
    expect(existsSync(object)).toBe(true);
    await rm(object);
    expect(
      run(work, ["git", "ls-remote", "origin", "refs/heads/dev"]).stdout.trim(),
    ).toContain(devSha);

    const result = quest(work, ["task", "list", "--across-refs", "--json"]);
    expect(result.exitCode).toBe(6);
    expect(result.stdout).toBe("");
    const diagnostic = JSON.parse(result.stderr) as {
      error_type: string;
      input: { coverage: AcrossRefsCoverage };
    };
    expect(diagnostic.error_type).toBe("drift");
    const dev = diagnostic.input.coverage.refsUnreadable.find(
      (entry) => entry.ref === "origin/dev",
    );
    expect(dev?.reason).toContain("could not be fetched from origin");
    expect(diagnostic.input.coverage.refsRead).toEqual([]);
    expect(diagnostic.input.coverage.complete).toBe(false);
    expect(result.stderr).not.toContain("    at ");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("a PR head whose objects are not local IS fetched, and no ref moves (N4)", async () => {
  // The first PR's objects came along with the branch that created it, so the
  // pull-shaped fetch was never exercised. PR 2's commit exists only in the
  // bare origin, so this run must fetch it -- and the read-only promise has to
  // hold for that fetch too.
  expect(
    run(fixture.work, ["git", "cat-file", "-e", `${fixture.prTwoSha}^{commit}`])
      .exitCode,
  ).not.toBe(0);
  const before = git(
    fixture.work,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/heads",
    "refs/remotes",
  );
  const result = questOk(fixture.work, [
    "task",
    "list",
    "--across-refs",
    "--pr",
    "2",
  ]);
  // The objects arrived, and the records they carry are in the view.
  expect(
    run(fixture.work, ["git", "cat-file", "-e", `${fixture.prTwoSha}^{commit}`])
      .exitCode,
  ).toBe(0);
  const envelope = JSON.parse(result.stdout) as {
    data: readonly AcrossRefsEntry[];
    coverage: AcrossRefsCoverage;
  };
  expect(envelope.coverage.complete).toBe(true);
  expect(envelope.coverage.refsRead).toEqual([
    { ref: "refs/pull/2/head", pullRequest: null, sha: fixture.prTwoSha },
  ]);
  const proposed = entry(envelope.data, "T-4");
  expect(proposed.states[0]?.refProvenance.sha).toBe(fixture.prTwoSha);
  // Byte-identical refs: the fetch wrote objects and FETCH_HEAD and nothing
  // else, which is what --refmap= buys (F3) and what a pull-shaped refspec
  // has to honour too.
  expect(
    git(
      fixture.work,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/remotes",
    ),
  ).toBe(before);
}, 60_000);
