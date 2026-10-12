import { aliasKey, RecordValidationError } from "../../domain/records.ts";
import {
  defaultLifecyclePolicy,
  type LifecyclePolicy,
  resolveConfiguredStatus,
  searchTasks,
  statusKey,
  type TaskState,
  taskState,
} from "../../domain/tasks/tasks.ts";
import type { GitPort } from "../../ports/git.ts";
import type { RefDiscoveryPort } from "../../ports/ref-discovery.ts";
import { CONTINUITY_TASK_LOCATIONS } from "../checks/continuity.ts";

/**
 * QCLI-417 / DEC-40 (operator-accepted 2026-09-29), recorded as the opum-doc
 * ADR "keep lore and quest records on the branch with a read-only view across
 * open PRs" (ODOC-330). QCLI-316 gave a listing a `scope` field because
 * `quest task list --status "In Progress"` reads the CHECKED-OUT ref and
 * nothing else, so an empty answer reads as the repository being clear when it
 * only means that branch was. This is the complete form of that answer: one
 * read-only view over `origin/dev` plus the head of every OPEN PR into `dev`,
 * with per-state provenance and a coverage report, so "nothing is open" holds
 * for the repository only when every planned ref was actually read.
 *
 * THE POPULATION IS EXPLICIT AND ITS COMPLETENESS TRAVELS WITH THE ANSWER.
 * `open-prs` requires a forge-aware, base-filtered discovery; nothing Git-only
 * may claim it (see `src/ports/ref-discovery.ts` for the measurement that
 * settled that). When discovery fails, the answer is a coverage failure naming
 * what could not be read -- never a quiet narrowing of the population to
 * whatever happened to be readable.
 *
 * EVERY STATE IS LISTED AND NO WINNER IS PICKED. Two refs carrying the same id
 * with different statuses is a conflict, not a merge: the entry carries
 * `conflict: true` and both states with their own `refProvenance`. Inventing a
 * merge policy for tracker state is a much larger decision than this view, and
 * the caller is the one who can resolve it.
 *
 * THE VIEW NEVER WRITES. It reads blobs and trees at SHAs, may fetch missing
 * OBJECTS through a bare refspec with an explicit empty `--refmap=` (objects
 * and FETCH_HEAD only -- no ref, and no remote-tracking ref either; a bare
 * refspec alone still let Git's opportunistic update move
 * `refs/remotes/origin/dev`), and never touches the working tree: a record
 * that exists only uncommitted in a checkout is not in the view, which
 * `quest help task list --across-refs` says in as many words.
 *
 * `refProvenance`, not `provenance`: lore's query hits already use the latter
 * name for a different shape, and the two CLIs ship the byte-identical inner
 * object `{ref, pullRequest, sha}` (DEC-40 D2).
 */

/** The population a view answered about. `dev-only` is the --allow-partial
 * degrade and is never reported with `complete: true`. */
export type AcrossRefsPopulation = "open-prs" | "explicit" | "dev-only";

/** Where one state was read from. Compact, and null is never omitted. */
export interface AcrossRefsProvenance {
  readonly ref: string;
  /** `owner/repo#N`, or null for dev and for an explicitly named ref. */
  readonly pullRequest: string | null;
  /** The full 40-hex commit actually read. */
  readonly sha: string;
}

export interface AcrossRefsState {
  readonly status: string;
  readonly refProvenance: AcrossRefsProvenance;
}

/**
 * Whether an entry's states are one task or a genuine id collision (QCLI-432).
 *
 * `task` -- every state carries the SAME `createdAt`. A task record is created
 * once and read identically from every ref it appears on, so its `createdAt`
 * survives a ref change while a title or status edit does not move it; two
 * independent `quest task create` calls that minted the same id in two
 * checkouts (the QCLI-431 shape) do not share a creation stamp. `createdAt` is
 * chosen over the title deliberately: the same task's title can be edited on a
 * PR head, which would read as a collision under a title comparison.
 *
 * `collision` -- the states carry two or more distinct `createdAt` values, so
 * they name different records that happen to share an id.
 *
 * `unresolved` -- the group has TWO OR MORE states and at least one carries no
 * `createdAt` (it is optional on the record), so the states cannot be compared.
 * Reported as a collision the view could not resolve rather than assumed to be
 * one task. A LONE state is `task` whatever it carries: it has nothing to
 * collide with.
 */
export const ACROSS_REFS_IDENTITIES = [
  "task",
  "collision",
  "unresolved",
] as const;

/**
 * The values `identity` can carry, DERIVED from that list so the type and the
 * runtime set cannot drift: a value added to the array is a value the code may
 * return. It is a runtime value because the DOCUMENTED set is held against it
 * (QCLI-493) -- the task-creation guide and the `task list --across-refs` help
 * must name exactly these, in a sentence a test can read.
 */
export type AcrossRefsIdentity = (typeof ACROSS_REFS_IDENTITIES)[number];

export interface AcrossRefsEntry {
  readonly id: string;
  readonly title: string;
  /** `owner/repo#N` when the id exists only on an open PR head; else null. */
  readonly proposedBy: string | null;
  /** True when the states carry two or more distinct statuses. */
  readonly conflict: boolean;
  /**
   * QCLI-432: whether the states are one task, a genuine collision of two
   * different records sharing the id, or a collision the discriminator could
   * not resolve (see {@link AcrossRefsIdentity}). `conflict` above still
   * reports status divergence WITHIN one task; `identity` reports whether the
   * states are one task at all.
   */
  readonly identity: AcrossRefsIdentity;
  readonly states: readonly AcrossRefsState[];
}

export interface AcrossRefsUnreadable {
  /** null only for the discovery failure, which is about no single ref. */
  readonly ref: string | null;
  readonly pullRequest: string | null;
  readonly reason: string;
}

export interface AcrossRefsCoverage {
  readonly complete: boolean;
  readonly population: AcrossRefsPopulation;
  /** When the population read was attempted, ISO-8601 UTC. */
  readonly discoveredAt: string;
  readonly refsRead: readonly AcrossRefsProvenance[];
  readonly refsUnreadable: readonly AcrossRefsUnreadable[];
}

export interface AcrossRefsFilter {
  readonly status?: string;
  readonly excludeStatuses?: readonly string[];
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
  readonly unassigned?: boolean;
  readonly milestoneId?: string;
  readonly parentId?: string;
  readonly priority?: string;
  readonly types?: readonly string[];
  readonly search?: string;
  readonly unresolvedAtCompletion?: boolean;
  readonly includeArchived?: boolean;
  /** Entry-level only: an entry with several states has no single `status`,
   * `priority` or `createdAt`, and picking one state to sort by is exactly the
   * merge policy this view refuses to invent. */
  readonly sort?: {
    readonly field: "id" | "title";
    readonly direction?: "asc" | "desc";
  };
  readonly limit?: number;
}

export interface AcrossRefsRequest {
  readonly repositoryPath: string;
  /** `--ref`, repeated. Naming either this or `pullRequests` replaces
   * discovery with an explicit population. */
  readonly refs?: readonly string[];
  /** `--pr`, repeated. Resolved through Git alone, so it needs no forge. */
  readonly pullRequests?: readonly number[];
  /** `--allow-partial`: emit the view with `complete: false` instead of
   * failing, while still naming every ref that could not be read. */
  readonly allowPartial: boolean;
  readonly filter?: AcrossRefsFilter;
}

export type AcrossRefsOutcome =
  | {
      readonly kind: "view";
      readonly entries: readonly AcrossRefsEntry[];
      readonly coverage: AcrossRefsCoverage;
    }
  | {
      /** A population input is missing outright (QCLI-417 exit 3). */
      readonly kind: "absent";
      readonly detail: "origin" | "dev";
      readonly message: string;
    };

/**
 * Git reports the remote it could not reach verbatim, and that text can name a
 * local path. Coverage reasons cross the JSON boundary into CI logs, so they
 * are held to one line with no absolute paths. A whitespace-delimited token
 * that starts with `/` is an absolute path; a URL token starts with its scheme
 * and is left alone.
 */
export function sanitizeReason(text: string): string {
  const line =
    text
      .split("\n")
      .map((value) => value.trim())
      .find((value) => value.length > 0) ?? "unreadable";
  return line
    .replace(
      // A `/` that starts a path token: not preceded by a word character, a
      // dot, a colon or another slash. That excludes `refs/pull/1/head` (a
      // word character precedes each slash) and leaves `https://host/x/y`
      // alone, while catching a path inside punctuation -- Git writes one as
      // "(/tmp/…/origin.git)" when it reports a failing remote.
      /(?<![A-Za-z0-9._:/-])\/[A-Za-z0-9._~+/-]*/gu,
      "<path>",
    )
    .split(/\s+/u)
    .join(" ");
}

function describe(error: unknown): string {
  return sanitizeReason(error instanceof Error ? error.message : String(error));
}

export const DEV_REF = "origin/dev";
const DEV_SOURCE_REF = "refs/heads/dev";

/** One planned ref: what to read, what to call it, and at which commit. */
interface PlannedRef {
  readonly ref: string;
  readonly pullRequest: string | null;
  readonly sha: string;
  /** The remote ref to fetch when the objects are missing. Absent for an
   * explicitly named ref, which is by definition already local. */
  readonly sourceRef?: string;
  /** The reason not to read it at all; the ref is reported unreadable. */
  readonly failure?: string;
}

interface RefRecord {
  readonly task: TaskState;
  readonly archived: boolean;
}

interface ReadRef {
  readonly provenance: AcrossRefsProvenance;
  readonly records: readonly RefRecord[];
}

interface LocatedState {
  readonly task: TaskState;
  readonly refProvenance: AcrossRefsProvenance;
}

interface LocatedEntry {
  readonly id: string;
  readonly title: string;
  readonly proposedBy: string | null;
  readonly conflict: boolean;
  readonly identity: AcrossRefsIdentity;
  readonly states: readonly LocatedState[];
}

/**
 * QCLI-432: whether a same-id group is one task, a collision of two different
 * records, or a collision the discriminator cannot resolve. `createdAt` is the
 * discriminator (see {@link AcrossRefsIdentity}); a state that carries none is
 * not comparable, so a group of TWO OR MORE such states is `unresolved` rather
 * than assumed to be one task. A LONE state has nothing to collide with, so it
 * is `task` regardless of whether its record carries a createdAt.
 */
function identityOf(states: readonly LocatedState[]): AcrossRefsIdentity {
  if (states.length < 2) return "task";
  const createdAts = new Set(states.map((state) => state.task.createdAt));
  if (createdAts.has(undefined)) return "unresolved";
  return createdAts.size > 1 ? "collision" : "task";
}

/**
 * The status vocabulary a filter is resolved against, mirroring
 * `TaskService.resolveFilterStatus` (QCLI-392, QCLI-331): the paused and
 * closed statuses are reachable as filters because the commands that assign
 * them exist, and anything else must be a configured status or the caller
 * hears about it rather than getting a silently empty list.
 */
function resolveFilterStatus(value: string, policy: LifecyclePolicy): string {
  for (const offLadder of [policy.pausedStatus, policy.closedStatus])
    if (offLadder !== undefined && statusKey(offLadder) === statusKey(value))
      return offLadder;
  return resolveConfiguredStatus(value, policy);
}

function fold(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

/** How a PR ref is labelled when the forge's own url does not name it. */
function slugLabel(slug: string | null, number: number): string | null {
  return slug === null ? null : `${slug}#${number}`;
}

function labelFromUrl(url: string, number: number): string | null {
  const slug =
    /^https?:\/\/[^/]+\/(?<slug>[^/]+\/[^/]+)\/pull\/[0-9]+\/?$/u.exec(
      url.trim(),
    )?.groups?.slug;
  return slug === undefined ? null : `${slug.replace(/\.git$/u, "")}#${number}`;
}

export class AcrossRefsViewService {
  constructor(
    private readonly git: GitPort,
    private readonly discovery: RefDiscoveryPort,
    private readonly policy: LifecyclePolicy = defaultLifecyclePolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async view(request: AcrossRefsRequest): Promise<AcrossRefsOutcome> {
    const plan = await this.plan(request);
    if (plan.kind === "absent") return plan;

    const read: ReadRef[] = [];
    const unreadable: AcrossRefsUnreadable[] = [...plan.unreadable];
    // Sequential on purpose: `git cat-file` is one process per blob, and the
    // order of both `refsRead` and the states inside an entry is then the
    // planned order rather than a scheduler's.
    for (const planned of plan.refs) {
      if (planned.failure !== undefined) {
        unreadable.push({
          ref: planned.ref,
          pullRequest: planned.pullRequest,
          reason: sanitizeReason(planned.failure),
        });
        continue;
      }
      const opened = await this.readRef(request.repositoryPath, planned);
      if (opened.kind === "unreadable") unreadable.push(opened.ref);
      else read.push(opened.ref);
    }

    const coverage: AcrossRefsCoverage = {
      // Complete is relative to the population named in this same object (the
      // rule both CLIs agreed on), and a read of ZERO refs is never complete:
      // `[]` is what a typo, a wrong repository and an unreachable remote all
      // produce, so passing then would be the false green the QCLI-415
      // zero-read rule exists to remove.
      complete: unreadable.length === 0 && read.length > 0,
      population: plan.population,
      discoveredAt: plan.discoveredAt,
      refsRead: read.map((entry) => entry.provenance),
      refsUnreadable: unreadable,
    };

    return {
      kind: "view",
      entries: this.buildEntries(read, request.filter),
      coverage,
    };
  }

  /**
   * What to read, and what could not even be planned.
   *
   * A discovery failure is ONE unreadable entry with `ref: null` -- it is
   * about a population that could not be listed, not about a ref that failed
   * to read -- and it is what makes `complete` false for a dev-only answer.
   * Without --allow-partial the population stays `open-prs`: the caller never
   * agreed to a narrower question, so the answer does not quietly become one.
   * `dev-only` is emitted for exactly one reason, the degrade the caller asked
   * for, and it is never reported complete.
   */
  private async plan(request: AcrossRefsRequest): Promise<
    | {
        readonly kind: "planned";
        readonly population: AcrossRefsPopulation;
        readonly refs: readonly PlannedRef[];
        readonly unreadable: readonly AcrossRefsUnreadable[];
        readonly discoveredAt: string;
      }
    | Extract<AcrossRefsOutcome, { kind: "absent" }>
  > {
    const discoveredAt = this.now().toISOString();
    const explicitRefs = request.refs ?? [];
    const explicitPrs = request.pullRequests ?? [];

    if (explicitRefs.length > 0 || explicitPrs.length > 0) {
      // An explicit population needs no forge and no origin remote. The slug
      // is still read when it is there, because `--pr 7` names a pull request
      // and `owner/repo#7` is the label a consumer reads; with no GitHub origin
      // the label is null -- a local path cannot name a forge -- and the ref
      // name still identifies the pull request exactly.
      const origin = await this.discovery.origin(request.repositoryPath);
      const slug = origin.kind === "github" ? origin.slug : null;
      const refs: PlannedRef[] = [];
      for (const ref of explicitRefs) {
        const sha = await this.resolveLocal(request.repositoryPath, ref);
        refs.push(
          sha === undefined
            ? {
                ref,
                pullRequest: null,
                sha: "",
                failure: `${ref} does not resolve in this repository`,
              }
            : { ref, pullRequest: null, sha },
        );
      }
      for (const number of explicitPrs) {
        const ref = `refs/pull/${number}/head`;
        // `--pr` is the deterministic, forge-free path opum-cli-e2e can
        // qualify with, so it resolves the PR head with Git alone -- no `gh`.
        // Remote truth first, for the same reason dev uses it: the fetch
        // writes FETCH_HEAD and objects and moves nothing (that is the
        // read-only promise), so `refs/pull/<N>/head` never appears locally
        // and a local-only lookup would miss a PR that is right there on the
        // remote. A locally resolvable ref is the fallback for an origin this
        // checkout cannot reach; the objects are fetched by `readRef` only if
        // the resolved commit turns out to be absent.
        let sha: string | undefined;
        try {
          sha =
            (await this.git.remoteRevision(
              request.repositoryPath,
              "origin",
              ref,
            )) ?? undefined;
        } catch {
          sha = undefined;
        }
        sha ??= await this.resolveLocal(request.repositoryPath, ref);
        refs.push(
          sha === undefined
            ? {
                ref,
                pullRequest: slugLabel(slug, number),
                sha: "",
                failure: `${ref} does not resolve here and could not be fetched from origin; run \`git fetch origin ${ref}\` first`,
              }
            : {
                ref,
                pullRequest: slugLabel(slug, number),
                sha,
                sourceRef: ref,
              },
        );
      }
      return {
        kind: "planned",
        population: "explicit",
        refs,
        unreadable: [],
        discoveredAt,
      };
    }

    const origin = await this.discovery.origin(request.repositoryPath);
    if (origin.kind === "absent")
      return {
        kind: "absent",
        detail: "origin",
        message:
          "task list --across-refs reads origin/dev and the head of every open pull request into dev, and this repository has no `origin` remote to read.",
      };

    // Remote truth, never the possibly stale local `origin/dev`: this checkout
    // may not have fetched since the branch moved, and the view promises the
    // repository's dev.
    let devSha: string | null = null;
    let devFailure: string | undefined;
    try {
      devSha = await this.git.remoteRevision(
        request.repositoryPath,
        "origin",
        DEV_SOURCE_REF,
      );
    } catch (error) {
      devFailure = `origin/dev could not be read from the remote: ${describe(error)}`;
    }
    if (devSha === null && devFailure === undefined)
      return {
        kind: "absent",
        detail: "dev",
        message:
          "task list --across-refs reads origin/dev, and the origin remote does not advertise refs/heads/dev.",
      };

    const dev = this.planDev(devSha, devFailure);
    // Both discovery failures land in the same shape: one unreadable entry
    // with no ref of its own, because what could not be read is a POPULATION,
    // not a ref. `--allow-partial` is the only thing that decides whether the
    // population is reported as the narrowed one.
    const noDiscovery = (reason: string) => ({
      kind: "planned" as const,
      population: request.allowPartial
        ? ("dev-only" as const)
        : ("open-prs" as const),
      refs: [dev],
      unreadable: [
        {
          ref: null,
          pullRequest: null,
          reason: sanitizeReason(reason),
        },
      ],
      discoveredAt,
    });
    if (origin.kind !== "github")
      return noDiscovery(
        `the origin remote is not a GitHub remote, so open pull requests into dev cannot be listed (${origin.url})`,
      );

    let pullRequests: readonly {
      readonly number: number;
      readonly headRefOid: string;
      readonly url?: string;
    }[];
    try {
      pullRequests = await this.discovery.listOpenPullRequests(
        request.repositoryPath,
        origin.slug,
        "dev",
      );
    } catch (error) {
      // A forge that could not be asked is incomplete coverage, never an
      // uncaught error: the whole point of the coverage report is that this
      // case has a shape the caller can read.
      return noDiscovery(describe(error));
    }

    return {
      kind: "planned",
      population: "open-prs",
      refs: [
        dev,
        ...pullRequests.map((pullRequest) => {
          const ref = `refs/pull/${pullRequest.number}/head`;
          return {
            ref,
            // The forge's own url is preferred because it names the pull
            // request it just returned; the origin slug is the fallback.
            pullRequest:
              pullRequest.url === undefined
                ? slugLabel(origin.slug, pullRequest.number)
                : (labelFromUrl(pullRequest.url, pullRequest.number) ??
                  slugLabel(origin.slug, pullRequest.number)),
            sha: pullRequest.headRefOid,
            sourceRef: ref,
          };
        }),
      ],
      unreadable: [],
      discoveredAt,
    };
  }

  private planDev(
    devSha: string | null,
    failure: string | undefined,
  ): PlannedRef {
    if (failure !== undefined || devSha === null)
      return {
        ref: DEV_REF,
        pullRequest: null,
        sha: "",
        failure: failure ?? "origin/dev could not be read from the remote.",
      };
    return {
      ref: DEV_REF,
      pullRequest: null,
      sha: devSha,
      sourceRef: DEV_SOURCE_REF,
    };
  }

  /** The commit an explicitly named ref resolves to here, or undefined. */
  private async resolveLocal(
    repositoryPath: string,
    ref: string,
  ): Promise<string | undefined> {
    try {
      const sha = await this.git.readRevision(repositoryPath, ref);
      return /^[0-9a-f]{40}$/u.test(sha) ? sha : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Reads one planned ref at its discovered SHA. Objects are fetched only when
   * they are absent, and the presence probe is a real one: `listFiles` answers
   * `[]` and `readBlob` answers `null` for a missing object and for a failed
   * read alike, so neither can decide whether a fetch is needed.
   */
  private async readRef(
    repositoryPath: string,
    planned: PlannedRef,
  ): Promise<
    | { readonly kind: "read"; readonly ref: ReadRef }
    | { readonly kind: "unreadable"; readonly ref: AcrossRefsUnreadable }
  > {
    const provenance: AcrossRefsProvenance = {
      ref: planned.ref,
      pullRequest: planned.pullRequest,
      sha: planned.sha,
    };
    const unreadable = (
      reason: string,
    ): {
      readonly kind: "unreadable";
      readonly ref: AcrossRefsUnreadable;
    } => ({
      kind: "unreadable",
      ref: {
        ref: planned.ref,
        pullRequest: planned.pullRequest,
        reason: sanitizeReason(reason),
      },
    });

    if (!(await this.git.hasRevision(repositoryPath, planned.sha))) {
      if (planned.sourceRef === undefined)
        return unreadable(
          `${planned.ref} resolves to ${planned.sha}, which is not present in this repository`,
        );
      try {
        await this.git.fetchRef(repositoryPath, "origin", planned.sourceRef);
      } catch (error) {
        return unreadable(
          `${planned.ref} could not be fetched from origin: ${describe(error)}`,
        );
      }
      if (!(await this.git.hasRevision(repositoryPath, planned.sha)))
        return unreadable(
          `origin does not offer ${planned.sha} for ${planned.sourceRef}`,
        );
    }

    // The STRICT listing (QCLI-417 F1). `listFiles` answers `[]` for a listing
    // Git refused as well as for a prefix that holds nothing, and this view
    // cannot tell those apart in its output: a ref whose tree is unreadable
    // would read as a ref with no records, and the coverage report would call
    // that complete. Measured with a deleted tree object: `complete: true`,
    // `refsUnreadable: []`, `data: []`, exit 0.
    let listings: readonly (readonly string[])[];
    try {
      listings = await Promise.all(
        CONTINUITY_TASK_LOCATIONS.map((location) =>
          this.git.listFilesRequired(
            repositoryPath,
            planned.sha,
            `.quest/${location}`,
          ),
        ),
      );
    } catch (error) {
      return unreadable(
        `${planned.ref} could not be listed at ${planned.sha}: ${describe(error)}`,
      );
    }
    const records: RefRecord[] = [];
    const pathsById = new Map<string, string>();
    for (const [index, location] of CONTINUITY_TASK_LOCATIONS.entries()) {
      for (const path of listings[index] ?? []) {
        // The same filter the repository reader applies (local-task-
        // repository.ts): dot-prefixed files beside the records are
        // operational metadata (a journal), never authored records, and
        // parsing one would wedge this view on a committed journal.
        const name = path.slice(path.lastIndexOf("/") + 1);
        if (name.startsWith(".") || !name.endsWith(".json")) continue;
        const blob = await this.git.readBlob(repositoryPath, planned.sha, path);
        // One unreadable record fails the whole ref, on QCLI-415's rule: a
        // record this view cannot read is a record whose absence it also could
        // not report, and reporting the ref as merely "lighter" would be the
        // false green rather than the honest gap.
        if (blob === null)
          return unreadable(`${planned.ref} carries an unreadable ${path}`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(blob);
        } catch {
          return unreadable(`${planned.ref} carries a malformed ${path}`);
        }
        let task: TaskState;
        try {
          task = taskState(parsed as TaskState);
        } catch {
          return unreadable(`${planned.ref} carries an invalid ${path}`);
        }
        // A duplicate id inside one ref is NOT resolved by keeping the first
        // (QCLI-417 F4). Every other command fails closed on it with a
        // RecordDuplicateIdentityError -- usually a half-staged relocation
        // that left the record in tasks/ and completed/ at once -- so a view
        // that silently picked one would answer about a state the repository
        // itself refuses to read. The ref goes unreadable and names both
        // paths, which is what makes the coverage incomplete instead of
        // confidently wrong.
        const key = aliasKey(task.id);
        const previous = pathsById.get(key);
        if (previous !== undefined)
          return unreadable(
            `${planned.ref} carries ${task.id} at both ${previous} and ${path}`,
          );
        pathsById.set(key, path);
        records.push({ task, archived: location === "archive/tasks" });
      }
    }
    return { kind: "read", ref: { provenance, records } };
  }

  /**
   * One entry per task id, with every state that carries it. Archived records
   * are excluded unless `--include-archived`, matching `task list`'s shipped
   * convention for the archive location.
   */
  private buildEntries(
    read: readonly ReadRef[],
    filter: AcrossRefsFilter | undefined,
  ): readonly AcrossRefsEntry[] {
    const groups = new Map<
      string,
      { readonly id: string; readonly states: LocatedState[] }
    >();
    for (const ref of read) {
      for (const record of ref.records) {
        if (record.archived && filter?.includeArchived !== true) continue;
        const key = aliasKey(record.task.id);
        const group = groups.get(key) ?? { id: record.task.id, states: [] };
        group.states.push({
          task: record.task,
          refProvenance: ref.provenance,
        });
        groups.set(key, group);
      }
    }

    const entries: LocatedEntry[] = [...groups.values()].map((group) => {
      const statuses = new Set(
        group.states.map((state) => statusKey(state.task.status)),
      );
      const labels = new Set(
        group.states
          .map((state) => state.refProvenance.pullRequest)
          .filter((value): value is string => value !== null),
      );
      const onDev = group.states.some(
        (state) => state.refProvenance.ref === DEV_REF,
      );
      return {
        id: group.id,
        // The existence ref's title: dev when the id is there, else the first
        // ref in planned order that carries it (the single proposing ref, by
        // the same condition proposedBy uses). Title divergence across refs is
        // deliberately not modelled as a conflict -- a title edit is not a
        // status divergence. A divergence between DIFFERENT records is a
        // collision, reported by `identity` below rather than by the title.
        title: group.states[0]?.task.title ?? group.id,
        proposedBy:
          !onDev && labels.size === 1 ? ([...labels][0] ?? null) : null,
        conflict: statuses.size > 1,
        identity: identityOf(group.states),
        states: group.states,
      };
    });

    const matches = compileFilter(filter, entries, this.policy);
    const selected = entries.filter((entry) =>
      entry.states.some((state) => matches(state)),
    );
    const sort = filter?.sort;
    const ordered =
      sort === undefined
        ? [...selected].sort((a, b) => a.id.localeCompare(b.id))
        : [...selected].sort(
            (a, b) =>
              (sort.direction === "desc" ? -1 : 1) *
              (sort.field === "id"
                ? a.id.localeCompare(b.id)
                : a.title.localeCompare(b.title)),
          );
    const limited =
      filter?.limit === undefined ? ordered : ordered.slice(0, filter.limit);

    return limited.map((entry) => ({
      id: entry.id,
      title: entry.title,
      proposedBy: entry.proposedBy,
      conflict: entry.conflict,
      identity: entry.identity,
      // Every state of a matched entry is shown, including the ones that did
      // not match the filter: a conflict is only legible with all of it.
      states: entry.states.map((state) => ({
        status: state.task.status,
        refProvenance: state.refProvenance,
      })),
    }));
  }
}

/**
 * A per-state predicate: an entry matches when ANY of its states does. Fields
 * are folded the way `TaskService.listFiltered` folds them, so a filter means
 * the same thing on both listings.
 *
 * `--parent` resolves the reference against the ids and aliases this view saw
 * and matches every state whose `parentId` is one of them. A reference that
 * resolves nowhere is a not-found, exactly as it is on `task list`. Two
 * entries matching one reference is not an ambiguity error here: the view is a
 * read across refs where the same id can legitimately appear more than once,
 * and refusing the filter would be an exit-5 conflict, which this command
 * reserves for nothing.
 */
function compileFilter(
  filter: AcrossRefsFilter | undefined,
  entries: readonly LocatedEntry[],
  policy: LifecyclePolicy,
): (state: LocatedState) => boolean {
  if (filter === undefined) return () => true;
  const status =
    filter.status === undefined
      ? undefined
      : statusKey(resolveFilterStatus(filter.status, policy));
  const excluded = new Set(
    (filter.excludeStatuses ?? []).map((value) =>
      statusKey(resolveFilterStatus(value, policy)),
    ),
  );
  const assignees = filter.assignees?.length
    ? new Set(filter.assignees.map((value) => fold(value)))
    : undefined;
  const types = filter.types?.length
    ? new Set(filter.types.map((value) => fold(value)))
    : undefined;
  const priority =
    filter.priority === undefined ? undefined : fold(filter.priority);
  const milestoneId =
    filter.milestoneId === undefined ? undefined : fold(filter.milestoneId);
  const parentIds =
    filter.parentId === undefined
      ? undefined
      : resolveParentIds(entries, filter.parentId);
  const needle = filter.search;
  return (state) => {
    const task = state.task;
    if (status !== undefined && statusKey(task.status) !== status) return false;
    if (excluded.has(statusKey(task.status))) return false;
    if (
      filter.labels?.length &&
      !filter.labels.every((label) => task.labels.includes(label))
    )
      return false;
    if (
      assignees !== undefined &&
      !(task.assignees ?? []).some((assignee) => assignees.has(fold(assignee)))
    )
      return false;
    if (filter.unassigned && task.assignees?.length) return false;
    if (milestoneId !== undefined && fold(task.milestoneId) !== milestoneId)
      return false;
    if (parentIds !== undefined && !parentIds.has(fold(task.parentId)))
      return false;
    if (priority !== undefined && fold(task.priority) !== priority)
      return false;
    if (types !== undefined && !types.has(fold(task.type))) return false;
    if (
      filter.unresolvedAtCompletion &&
      task.unresolvedAtCompletion === undefined
    )
      return false;
    if (needle !== undefined && searchTasks([task], needle).length === 0)
      return false;
    return true;
  };
}

/** The folded ids of the entries a `--parent` reference names, by id or alias. */
function resolveParentIds(
  entries: readonly LocatedEntry[],
  reference: string,
): ReadonlySet<string> {
  const key = aliasKey(reference);
  const ids = new Set<string>();
  for (const entry of entries) {
    const names =
      aliasKey(entry.id) === key ||
      entry.states.some((state) =>
        state.task.aliases.some((alias) => aliasKey(alias) === key),
      );
    if (names) ids.add(fold(entry.id));
  }
  if (ids.size === 0) throw new RecordValidationError("task_not_found");
  return ids;
}
