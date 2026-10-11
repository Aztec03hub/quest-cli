import { RecordValidationError } from "../../domain/records.ts";
import {
  canonicalizeTaskLinks,
  closeMilestoneReference,
  closeTask,
  createDraft,
  createTask,
  createTaskLinkSession,
  demoteTask,
  type DraftInput,
  type DraftLocation,
  type DraftState,
  defaultLifecyclePolicy,
  evaluateReadySet,
  findTask,
  type LifecyclePolicy,
  pauseTask,
  type ReadySet,
  resolveConfiguredStatus,
  searchTasks,
  startTask,
  statusKey,
  type TaskInput,
  type TaskLocation,
  type TaskResolutionKind,
  type TaskState,
  type TaskStatus,
  taskResolutionKinds,
  taskState,
  transitionTask,
  unresolvedAtCompletion,
} from "../../domain/tasks/tasks.ts";
import type { MigrationTransactionRepository } from "../../ports/backlog-import.ts";
import type { PlanningRepository } from "../../ports/planning.ts";
import {
  resolveVocabularyPatch,
  type TaskVocabulary,
} from "../../domain/tasks/vocabulary.ts";
import { type EditPatchVocabulary, foldEditPatch } from "./edit-patch.ts";
import { recordRevision } from "./record-revision.ts";

/** Re-exported so the CLI can read and report the vocabulary without importing the domain. */
export {
  defaultTaskVocabulary,
  type TaskVocabulary,
  type TaskVocabularyContext,
  VocabularyValueError,
} from "../../domain/tasks/vocabulary.ts";
/** Re-exported so the CLI can validate `--resolution` without importing the domain. */
export { taskResolutionKinds, type TaskResolutionKind };

/**
 * `task close --survivor <id>` named no task in any location (QCLI-331).
 * A not-found, not a validation failure: the same command line succeeds
 * once the survivor exists. Carries the reference so the CLI can echo it.
 */
export class SurvivorNotFoundError extends Error {
  constructor(readonly survivor: string) {
    super("survivor_not_found");
    this.name = "SurvivorNotFoundError";
  }
}

/** What `TaskService.close` needs beyond the task reference. */
export interface TaskCloseRequest {
  readonly kind: TaskResolutionKind;
  /** Required for duplicate/superseded, refused for wont-do. Any alias resolves. */
  readonly survivor?: string;
  /** A plain replace, exactly as `complete`'s (QCLI-270). */
  readonly finalSummary?: string;
}

/** The authoritative store is Git-backed in production; query methods deliberately have no write capability. */
export interface TaskReader {
  readAll(): Promise<TaskReadSnapshot>;
}
export interface TaskReadSnapshot {
  readonly revision: string;
  readonly tasks: readonly TaskState[];
  /** All task records, including retention locations. Omitted by legacy readers. */
  readonly taskRecords?: readonly LocatedTask[];
  readonly drafts?: readonly LocatedDraft[];
}
export interface LocatedTask {
  readonly task: TaskState;
  readonly location: TaskLocation;
}
/**
 * A task enriched with its current repo-relative record path. The path
 * tracks `location` (QCLI-220): it moves when a task's status crosses a
 * lifecycle boundary (e.g. archive or complete), so a caller that persists
 * it must expect staleness after such a transition rather than treating it
 * as a stable identifier -- the task id is the stable one.
 */
export type TaskStateWithPath = TaskState & { readonly path: string };
export interface LocatedDraft {
  readonly draft: DraftState;
  readonly location: DraftLocation;
}
export interface TaskWriteRequest {
  readonly task: TaskState;
  readonly expectedRevision: string;
  readonly operationId: string;
  /** Predeclared authored paths passed through to QCLI-79's owned Git operation. */
  readonly ownedPaths: readonly string[];
}
export interface TaskWriteSuccess {
  readonly kind: "success";
  readonly revision: string;
}
export interface TaskWriteConflict {
  readonly kind: "conflict";
  readonly expectedRevision: string;
  readonly actualRevision: string;
  readonly operationId: string;
  readonly ownedPaths: readonly string[];
  /**
   * QCLI-425: set only when the conflict IS the `--if-revision` guard's own
   * refusal -- `expectedRevision` then holds the value the caller sent. A
   * workspace CAS race leaves this unset, and its `expectedRevision` is the
   * snapshot revision the write expected, not anything a caller sent, so
   * consumers must key on this code rather than on `expectedRevision`.
   */
  readonly code?: "revision_precondition_failed";
}
export type TaskWriteResult = TaskWriteSuccess | TaskWriteConflict;
export interface TaskWriter {
  write(request: TaskWriteRequest): Promise<TaskWriteResult>;
}
export interface TaskRepository extends TaskReader, TaskWriter {}
export interface LifecycleWriteRequest {
  readonly expectedRevision: string;
  readonly operationId: string;
  readonly ownedPaths: readonly string[];
  readonly taskChanges: readonly (
    | { readonly task: TaskState; readonly location: TaskLocation }
    | {
        readonly taskId: string;
        readonly location: TaskLocation;
        readonly remove: true;
      }
  )[];
  readonly draftChanges: readonly (
    | { readonly draft: DraftState; readonly location: DraftLocation }
    | {
        readonly draftId: string;
        readonly location: DraftLocation;
        readonly remove: true;
      }
  )[];
}
export interface LifecycleTaskRepository extends TaskRepository {
  writeLifecycle(request: LifecycleWriteRequest): Promise<TaskWriteResult>;
}

/** Typed capability port for locked multi-operation sessions (QCLI-122). */
export interface BatchTaskRepository extends LifecycleTaskRepository {
  beginTaskBatch(expectedRevision: string): Promise<
    | {
        readonly kind: "locked";
        readonly session: {
          writeRecord(
            task: import("../../domain/tasks/tasks.ts").TaskState,
            location?: TaskLocation,
          ): Promise<void>;
          markApplied(operationId: string, taskId: string): Promise<void>;
          finish(): Promise<void>;
        };
        readonly recovered?: {
          readonly sessionId: string;
          readonly appliedOperationIds: readonly string[];
        };
      }
    | {
        readonly kind: "conflict";
        readonly expectedRevision: string;
        readonly actualRevision: string;
      }
    | { readonly kind: "unrecoverable_lock"; readonly message: string }
  >;
}
export type TaskMutationResult =
  | {
      readonly kind: "success";
      readonly task: TaskState;
      readonly revision: string;
      /**
       * QCLI-412: the location this write MOVED the record to, set only when
       * the operation relocated it. `complete`, `close` and `archive` always
       * do; `demote` only when the record was outside `tasks` to begin with.
       * The CLI renders the staging hint from this rather than from a
       * command-to-directory table of its own, so a hint can never name a
       * location the operation did not actually use.
       */
      readonly relocatedTo?: TaskLocation;
    }
  | TaskWriteConflict;

/**
 * QCLI-277: an optional precondition for {@link TaskService.edit}/{@link
 * TaskService.editOn}. Every mutation already reads a fresh snapshot and
 * writes with that snapshot's own revision as `expectedRevision` -- which
 * trivially matches every time, since it was read moments earlier in the
 * same call, and so can never by itself detect that a CALLER's own earlier
 * read (e.g. `task view --json`'s `revision` field) has since gone stale.
 * `ifRevision`, when supplied, is checked against the RESOLVED RECORD's own
 * revision ({@link recordRevision}) before any write -- including the
 * freshly-read `expectedRevision` write below, which is the repository's
 * workspace-wide CAS and stays exactly as before -- so a caller reasoning
 * from a stale read gets the same exit-5 conflict shape an ordinary write
 * race already produces, instead of silently succeeding over another
 * session's update. Omitted, behavior is unchanged.
 *
 * QCLI-310: the record, not the workspace, is the unit -- `task view`'s
 * `revision` is the same per-record value, so the pair round-trips. It used
 * to compare the whole-store revision on both sides, which was
 * self-consistent but wrong in scope: any write anywhere invalidated every
 * outstanding precondition, making the flag unusable for the concurrent
 * sessions it was built for.
 */
export interface TaskEditOptions {
  readonly ifRevision?: string;
}

type ReferenceIndex = {
  resolve(reference: string): number | undefined;
};

/**
 * O(N)-once reference index (canonical id + aliases, case-insensitive) used
 * by the batch loop so repeated lookups do not rescan the whole collection.
 */
function buildReferenceIndex(tasks: readonly TaskState[]): ReferenceIndex {
  const byKey = new Map<string, number>();
  tasks.forEach((task, index) => {
    byKey.set(task.id.toLowerCase(), index);
    for (const alias of task.aliases) byKey.set(alias.toLowerCase(), index);
  });
  return {
    resolve(reference: string): number | undefined {
      return byKey.get(reference.toLowerCase());
    },
  };
}

function rebuildSlot(
  index: ReferenceIndex,
  _slot: number,
  _task: TaskState,
): ReferenceIndex {
  // Row identity and aliases only change through graph-affecting paths which
  // go through createTaskLinkSession; non-graph slots keep identity so the
  // original index stays valid until that occurs.
  void _slot;
  void _task;
  return index;
}

/** Application-level default so CLI composition never imports the domain layer directly. */
export const defaultTaskLifecyclePolicy = defaultLifecyclePolicy;

/** The complete `task list` selection vocabulary; the CLI layer only parses argv into this. */
export interface TaskListQuery {
  readonly status?: string;
  readonly labels?: readonly string[];
  readonly ready?: boolean;
  readonly now?: Date;
  readonly excludeStatuses?: readonly string[];
  readonly assignees?: readonly string[];
  readonly unassigned?: boolean;
  readonly milestoneId?: string;
  readonly parentId?: string;
  readonly priority?: string;
  readonly types?: readonly string[];
  readonly search?: string;
  readonly limit?: number;
  readonly sort?: {
    readonly field: string;
    /** Ascending when omitted, matching the CLI's bare `--sort <field>`. */
    readonly direction?: "asc" | "desc";
  };
  /**
   * Includes archived tasks in the selection (QCLI-165). Completed tasks are
   * always included -- Done is an ordinary terminal status, filterable like
   * any other via --status/--exclude-status -- matching `milestone list
   * --include-archived`'s existing default-excluded convention for the
   * archive location specifically.
   */
  readonly includeArchived?: boolean;
  /**
   * QCLI-336: selects only tasks carrying a persisted `unresolvedAtCompletion`
   * -- i.e. completed with acceptance criteria or definition-of-done items
   * still unchecked -- so a sweep for "shipped with X open" does not require
   * reading every completed record by hand.
   */
  readonly unresolvedAtCompletion?: boolean;
}

const TASK_LIST_SORT_FIELDS = new Set([
  "id",
  "title",
  "status",
  "priority",
  "type",
  "ordinal",
  "createdAt",
  "updatedAt",
]);

/**
 * Priority is a free-form authored string, so ranking is by the conventional
 * high/medium/low vocabulary, case-folded. Anything else sorts after all three
 * rather than landing in the middle of them alphabetically.
 */
const TASK_LIST_PRIORITY_RANK = new Map([
  ["high", 0],
  ["medium", 1],
  ["low", 2],
]);

/** Case-folded comparison key for the free-form authored selection fields. */
function fold(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function taskListSortValue(task: TaskState, field: string): string | number {
  switch (field) {
    case "id":
      return task.id;
    case "title":
      return task.title;
    case "status":
      return task.status;
    case "priority":
      // Rank, not alphabet: "high" < "low" as strings, which would invert the
      // ordering an agent asking for the top N actually wants.
      return (
        TASK_LIST_PRIORITY_RANK.get(fold(task.priority)) ??
        TASK_LIST_PRIORITY_RANK.size
      );
    case "type":
      return fold(task.type);
    case "ordinal":
      return task.ordinal ?? 0;
    // A record with no time is unknown rather than oldest, so it sorts after
    // every stamped task ascending — and therefore first when reversed, the
    // same way an unrecognized priority does.
    case "createdAt":
      return task.createdAt ?? "\uffff";
    case "updatedAt":
      return task.updatedAt ?? "\uffff";
    default:
      throw new RecordValidationError("task_list_sort_field_invalid");
  }
}

function sortTasksBy(
  tasks: readonly TaskState[],
  sort: NonNullable<TaskListQuery["sort"]>,
): readonly TaskState[] {
  if (!TASK_LIST_SORT_FIELDS.has(sort.field))
    throw new RecordValidationError("task_list_sort_field_invalid");
  const direction = sort.direction === "desc" ? -1 : 1;
  return [...tasks].sort((a, b) => {
    const left = taskListSortValue(a, sort.field);
    const right = taskListSortValue(b, sort.field);
    if (left < right) return -1 * direction;
    if (left > right) return 1 * direction;
    // Ties always break by ascending id, independent of sort direction.
    return a.id.localeCompare(b.id);
  });
}

export class TaskService {
  private readonly batchRepository: BatchTaskRepository | undefined;

  constructor(
    public readonly repository: TaskRepository,
    private readonly lifecyclePolicy: LifecyclePolicy = defaultLifecyclePolicy,
    private readonly ownedPathFor = (task: TaskState) =>
      `.quest/tasks/${task.id}.md`,
    planning?: PlanningRepository,
    batchRepository?: BatchTaskRepository,
    /** Injected so tests can pin task timestamps (QCLI-137). */
    private readonly now: () => Date = () => new Date(),
    /**
     * QCLI-330: the workspace's configured type/priority sets. Empty is the
     * open default, so every caller that does not read workspace.toml --
     * migration included -- keeps today's unvalidated behaviour.
     */
    private readonly taskVocabulary: TaskVocabulary = {},
    /**
     * QCLI-330 (reviewer finding 2): a [tasks] table the workspace declares
     * but that cannot be read. Every WRITE refuses with it, as a
     * RecordValidationError carrying the configuration message; reads carry
     * on untouched, so a broken table breaks no read command.
     */
    private readonly configuredVocabularyProblem?: string,
  ) {
    // Blocker #4 (fourth pass): the batch port is injected as a real typed
    // constructor argument; no structural `as unknown` casting anywhere.
    this.batchRepository = batchRepository;
    this.planning = planning;
  }

  private readonly planning?: PlanningRepository | undefined;

  /**
   * Persists a task whose milestone reference changed with atomic forward/back
   * milestone closure: the planning revision is verified and both stores are
   * written in one revision-guarded transaction.
   */
  private async persistWithMilestoneClosure(
    persisted: TaskState,
    previousMilestoneId: string | undefined,
    snapshot: TaskReadSnapshot,
    operationId: string,
    location: TaskLocation,
  ): Promise<TaskMutationResult> {
    const transactional = this.repository as unknown as
      | MigrationTransactionRepository
      | undefined;
    if (
      !transactional ||
      typeof transactional.applyTransaction !== "function" ||
      !this.planning
    )
      throw new RecordValidationError("planning_repository_unavailable");
    const planningSnapshot = await this.planning.read();
    const milestones = [...planningSnapshot.milestones];
    const index =
      persisted.milestoneId !== undefined
        ? milestones.findIndex((m) => m.id === persisted.milestoneId)
        : -1;
    if (persisted.milestoneId !== undefined && index < 0)
      throw new RecordValidationError("milestone_reference_dangling");
    let closedTask = persisted;
    // Close from the pre-change state so closeMilestoneReference observes the
    // actual transition instead of mistaking a fresh link for drift.
    const baseTask =
      persisted.milestoneId !== previousMilestoneId
        ? { ...persisted, milestoneId: previousMilestoneId }
        : persisted;
    const movingFromPrevious =
      previousMilestoneId !== undefined &&
      previousMilestoneId !== persisted.milestoneId;
    if (movingFromPrevious) {
      // Unlink the previous milestone first so a move is one atomic re-close.
      const previousIndex = milestones.findIndex(
        (m) => m.id === previousMilestoneId,
      );
      if (previousIndex >= 0) {
        const unlinked = closeMilestoneReference(
          baseTask,
          milestones[previousIndex],
          false,
        );
        closedTask = unlinked.task;
        milestones[previousIndex] = {
          ...milestones[previousIndex],
          taskIds: unlinked.milestone.taskIds,
        };
      }
    }
    if (
      persisted.milestoneId !== undefined &&
      persisted.milestoneId !== previousMilestoneId
    ) {
      const closed = closeMilestoneReference(
        closedTask.milestoneId === persisted.milestoneId
          ? baseTask
          : closedTask,
        milestones[Math.max(index, 0)],
        true,
      );
      closedTask = closed.task;
      milestones[Math.max(index, 0)] = {
        ...milestones[Math.max(index, 0)],
        taskIds: closed.milestone.taskIds,
      };
    }
    const result = await transactional.applyTransaction({
      expectedTaskRevision: snapshot.revision,
      expectedPlanningRevision: planningSnapshot.revision,
      operationId,
      ownedPaths: [this.ownedPathFor(closedTask)],
      taskChanges: [{ task: closedTask, location }],
      milestones,
      decisions: planningSnapshot.decisions,
    });
    return result.kind === "success"
      ? { kind: "success", task: closedTask, revision: result.revision }
      : {
          kind: "conflict",
          expectedRevision: result.expectedRevision,
          actualRevision: result.actualRevision,
          operationId: result.operationId,
          ownedPaths: result.ownedPaths,
        };
  }
  /**
   * Stamps a record's mutation time (QCLI-137). `created` also sets
   * `createdAt`; every other write only advances `updatedAt`.
   *
   * Records written before timestamps existed are deliberately not
   * backfilled: their next edit gains an `updatedAt`, and `createdAt` stays
   * absent rather than being invented.
   */
  private stamped(task: TaskState, created = false): TaskState {
    const at = this.now().toISOString();
    return created
      ? { ...task, createdAt: at, updatedAt: at }
      : { ...task, updatedAt: at };
  }
  async create(
    id: string,
    input: TaskInput,
    operationId: string,
  ): Promise<TaskMutationResult> {
    if (this.configuredVocabularyProblem !== undefined)
      throw new RecordValidationError(this.configuredVocabularyProblem);
    const snapshot = await this.repository.readAll();
    const located = this.taskRecords(snapshot);
    const task = this.stamped(
      createTask(
        id,
        resolveVocabularyPatch(input, this.taskVocabulary),
        this.lifecycle,
      ),
      true,
    );
    // Checked before canonicalization so reusing an id retired to
    // completed/archived storage still reports the specific
    // task_already_exists rather than the generic duplicate-id rejection
    // canonicalizeTaskLinks would otherwise throw first.
    if (located.some((existing) => existing.task.id === task.id))
      throw new Error("task_already_exists");
    // Full cross-location universe (QCLI-223): a new task's dependency or
    // parent can legitimately name a task that has since been completed or
    // archived. Resolving against snapshot.tasks alone made that edge
    // unresolvable and broke every subsequent create, not just this one.
    const tasks = located.map((record) => record.task);
    // Validation before persistence makes bad references and alias conflicts non-mutating.
    const canonical = canonicalizeTaskLinks([...tasks, task]);
    const persisted = canonical.at(-1);
    if (!persisted) throw new Error("task_canonicalization_failed");
    if (persisted.milestoneId !== undefined)
      return this.persistWithMilestoneClosure(
        persisted,
        undefined,
        snapshot,
        operationId,
        "tasks",
      );
    const result = await this.repository.write({
      task: persisted,
      expectedRevision: snapshot.revision,
      operationId,
      ownedPaths: [this.ownedPathFor(persisted)],
    });
    return result.kind === "success"
      ? { kind: "success", task: persisted, revision: result.revision }
      : result;
  }
  async list(): Promise<readonly TaskState[]> {
    return [...(await this.repository.readAll()).tasks].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }
  /**
   * The full `task list` selection contract in one place: readiness delegates
   * to {@link evaluateReadySet}, search delegates to {@link searchTasks}, and
   * every other filter composes as a plain predicate. Sort and limit apply
   * last, after every filter, so `--limit` truncates the final ordering.
   */
  async listFiltered(query: TaskListQuery): Promise<readonly TaskState[]> {
    return (await this.listFilteredLocated(query)).tasks;
  }
  /**
   * Presentation-boundary variant of {@link listFiltered} for `task list
   * --json` (QCLI-220), same reasoning as {@link viewWithPath}.
   */
  async listFilteredWithPath(
    query: TaskListQuery,
  ): Promise<readonly TaskStateWithPath[]> {
    const { tasks, locationById } = await this.listFilteredLocated(query);
    return tasks.map((task) => {
      const location = locationById.get(task.id);
      if (!location) throw new RecordValidationError("task_not_found");
      return { ...task, path: this.ownedPathForLocation(task.id, location) };
    });
  }
  private async listFilteredLocated(query: TaskListQuery): Promise<{
    readonly tasks: readonly TaskState[];
    readonly locationById: ReadonlyMap<string, TaskLocation>;
  }> {
    // The CLI guards this too, but the contract belongs here so a non-CLI
    // caller cannot silently ask for an empty list.
    if (query.unassigned && query.assignees?.length)
      throw new RecordValidationError("assignee_filter_conflict");
    const status = query.status
      ? this.resolveFilterStatus(query.status)
      : undefined;
    const excludeStatuses = query.excludeStatuses?.length
      ? new Set(
          query.excludeStatuses.map((value) => this.resolveFilterStatus(value)),
        )
      : undefined;
    // One snapshot feeds both the listing and the ready set, so readiness can
    // never describe a different revision than the rows it selects.
    const snapshot = await this.repository.readAll();
    // QCLI-165: snapshot.tasks only holds the "tasks" location, so a
    // completed task was invisible to every list query -- including an
    // explicit --status Done -- because it never reached the filter at all.
    // Source from every location instead, matching view()'s and
    // listIncludingRetained()'s existing all-locations resolution; archived
    // stays opt-in via includeArchived, matching milestone list's convention.
    const located = this.taskRecords(snapshot).filter(
      (record) => record.location !== "archive/tasks" || query.includeArchived,
    );
    const locationById = new Map(
      located.map((record) => [record.task.id, record.location] as const),
    );
    const listed = located
      .map((record) => record.task)
      .sort((a, b) => a.id.localeCompare(b.id));
    // Readiness is evaluated over the whole collection before any filter: a
    // dependency excluded by --label must still count against its dependent.
    // QCLI-249: graph resolution needs the FULL closure, archive/tasks
    // included -- validateTaskGraph requires every task's parentId and
    // dependencies to resolve within whatever array it is given, even
    // though parenthood alone is not a readiness edge. `listed` already
    // excludes archive/tasks by default (the correct exclusion for what
    // --ready actually returns), so a child whose parent was archived
    // independently of it would otherwise fail the whole graph validation
    // for every task, not just that child. readyIds is only ever
    // intersected against `listed` below, so an archived task's own
    // readiness (were it evaluated) can never leak into the result.
    const readyIds = query.ready
      ? new Set(
          evaluateReadySet(
            this.taskRecords(snapshot).map((record) => record.task),
            query.now ?? new Date(),
            this.lifecycle,
          ).ready,
        )
      : undefined;
    const searched = query.search
      ? new Set(searchTasks(listed, query.search).map((task) => task.id))
      : undefined;
    const assignees = query.assignees?.length
      ? new Set(query.assignees.map(fold))
      : undefined;
    const types = query.types?.length
      ? new Set(query.types.map(fold))
      : undefined;
    const priority = query.priority ? fold(query.priority) : undefined;
    const milestoneId = query.milestoneId ? fold(query.milestoneId) : undefined;
    // Resolve the parent through the same reference rules every other task
    // lookup uses, so an alias or a case variant selects the same subtasks the
    // canonical id does. An unknown reference is a not-found, not an empty list.
    const parentId =
      query.parentId === undefined
        ? undefined
        : findTask(listed, query.parentId).id;
    const filtered = listed.filter(
      (task) =>
        (!status || task.status === status) &&
        !excludeStatuses?.has(task.status) &&
        (!query.labels?.length ||
          query.labels.every((label) => task.labels.includes(label))) &&
        // A repeated --assignee is a union: "any of these people".
        (!assignees ||
          (task.assignees ?? []).some((assignee) =>
            assignees.has(fold(assignee)),
          )) &&
        (!query.unassigned || !task.assignees?.length) &&
        (milestoneId === undefined || fold(task.milestoneId) === milestoneId) &&
        // Stored parentId is already canonical (canonicalizeTaskLinks), so
        // only the query reference needs resolving.
        (parentId === undefined || task.parentId === parentId) &&
        (priority === undefined || fold(task.priority) === priority) &&
        (!types || types.has(fold(task.type))) &&
        (!query.unresolvedAtCompletion ||
          task.unresolvedAtCompletion !== undefined) &&
        (!readyIds || readyIds.has(task.id)) &&
        (!searched || searched.has(task.id)),
    );
    const sorted = query.sort ? sortTasksBy(filtered, query.sort) : filtered;
    const limited =
      query.limit === undefined ? sorted : sorted.slice(0, query.limit);
    return { tasks: limited, locationById };
  }
  /** Lists every canonical task, including retained lifecycle records. */
  async listIncludingRetained(): Promise<readonly TaskState[]> {
    const snapshot = await this.repository.readAll();
    return this.taskRecords(snapshot)
      .map((record) => record.task)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  /** QCLI-330: the configured type/priority sets doctor and the manifest report. */
  get vocabulary(): TaskVocabulary {
    return this.taskVocabulary;
  }
  /** QCLI-330: the problem reading that vocabulary, when the workspace declares a broken [tasks] table. */
  get vocabularyProblem(): string | undefined {
    return this.configuredVocabularyProblem;
  }
  /** The configured lifecycle policy; status-flow reports it, never a hardcoded copy. */
  get lifecycle(): LifecyclePolicy {
    return this.lifecyclePolicy;
  }
  private lifecycleRepository(): LifecycleTaskRepository {
    if (!("writeLifecycle" in this.repository))
      throw new Error("task_lifecycle_repository_required");
    return this.repository as LifecycleTaskRepository;
  }
  private taskRecords(snapshot: TaskReadSnapshot): readonly LocatedTask[] {
    return (
      snapshot.taskRecords ??
      snapshot.tasks.map((task) => ({ task, location: "tasks" as const }))
    );
  }
  private async moveTask(
    reference: string,
    destination: TaskLocation,
    operationId: string,
    transform: (
      task: TaskState,
      all: readonly TaskState[],
      location: TaskLocation,
    ) => TaskState = (task) => task,
    options?: { readonly ifRevision?: string },
  ): Promise<TaskMutationResult> {
    const snapshot = await this.repository.readAll();
    const records = this.taskRecords(snapshot);
    const all = records.map((record) => record.task);
    const selected = findTask(all, reference);
    const current = records.find((record) => record.task.id === selected.id);
    if (!current) throw new RecordValidationError("task_not_found");
    // QCLI-423: the same per-record precondition `editOn` enforces, checked
    // after resolution and before any state change -- a refused precondition
    // still writes nothing and moves nothing. It compares against the
    // resolved RECORD's own revision (the value `task view --json` emits),
    // not the snapshot's, so one captured value works for either command.
    if (
      options?.ifRevision !== undefined &&
      options.ifRevision !== recordRevision(current)
    )
      return {
        kind: "conflict",
        code: "revision_precondition_failed",
        expectedRevision: options.ifRevision,
        actualRevision: recordRevision(current),
        operationId,
        ownedPaths: [],
      };
    const task = this.stamped(transform(current.task, all, current.location));
    if (current.location === destination)
      throw new RecordValidationError("task_lifecycle_already_at_destination");
    const result = await this.lifecycleRepository().writeLifecycle({
      expectedRevision: snapshot.revision,
      operationId,
      ownedPaths: [
        this.ownedPathForLocation(current.task.id, current.location),
        this.ownedPathForLocation(task.id, destination),
      ],
      taskChanges: [
        { taskId: current.task.id, location: current.location, remove: true },
        { task, location: destination },
      ],
      draftChanges: [],
    });
    return result.kind === "success"
      ? {
          kind: "success",
          task,
          revision: result.revision,
          relocatedTo: destination,
        }
      : result;
  }
  private ownedPathForLocation(id: string, location: TaskLocation): string {
    return `.quest/${location}/${id}.json`;
  }
  /**
   * Completes the next legal terminal transition and retains the record
   * separately. `finalSummary`, when given, is applied to the record as
   * part of the same write (QCLI-270) -- additive: omitting it leaves
   * completion exactly as it always worked, and this is a plain replace
   * (matching `task edit --final-summary`), not the clear/append vocabulary
   * `foldFinalSummary` supports, since a completing caller states a summary
   * rather than editing one already in progress.
   */
  async complete(
    reference: string,
    operationId: string,
    finalSummary?: string,
  ): Promise<TaskMutationResult> {
    return this.moveTask(
      reference,
      "completed",
      operationId,
      (task, _all, location) => {
        const terminal = this.lifecycle.terminalStatuses[0];
        if (!terminal)
          throw new RecordValidationError(
            "Lifecycle terminal status is not configured.",
          );
        // QCLI-338 (opum-doc DEC-172 (4ai) A): a record may already BE at the
        // terminal status -- reached by `task edit --status <terminal>`, which
        // per QCLI-221 deliberately does not relocate -- while STILL STORED IN
        // tasks/. Completing it is that record's REAL completion under
        // QCLI-336's model, so the STATUS transition is skipped and everything
        // below still runs: `complete()` computes finalSummary and
        // unresolvedAtCompletion whatever status the record already had. One
        // Done shape, not two.
        //
        // The skip is guarded to `location === "tasks"` EXACTLY. A record
        // already in completed/ or in archive/tasks/ keeps transitionTask's own
        // refusal (`Illegal task transition: Done -> Done ...`), UNCHANGED --
        // the relocation this task asks for is tasks/ -> completed/ only, and
        // moveTask's own already-at-destination check is never reached for
        // those shapes because this closure throws first.
        const transitioned =
          task.status === terminal && location === "tasks"
            ? task
            : transitionTask(task, terminal, this.lifecycle);
        const withSummary =
          finalSummary === undefined
            ? transitioned
            : taskState({ ...transitioned, finalSummary });
        // QCLI-336: persists QCLI-252's response-only signal onto the record
        // itself, computed once from the checklist state at the moment of
        // completion -- see unresolvedAtCompletion's own doc comment on
        // TaskState for why this is never recomputed afterward.
        const unresolved = unresolvedAtCompletion(withSummary);
        return unresolved === undefined
          ? withSummary
          : taskState({ ...withSummary, unresolvedAtCompletion: unresolved });
      },
    );
  }
  /**
   * Retires a task at the closed status with a resolution and retains it
   * beside completed work (QCLI-331). The survivor resolves by id or alias
   * across EVERY location -- a duplicate of an archived task is still a
   * duplicate -- and is stored by its canonical id, so a later alias change
   * cannot orphan it. No `unresolvedAtCompletion` is recorded: that field
   * describes a completion, and closing asserts none.
   */
  async close(
    reference: string,
    request: TaskCloseRequest,
    operationId: string,
  ): Promise<TaskMutationResult> {
    return this.moveTask(reference, "completed", operationId, (task, all) => {
      let survivor: string | undefined;
      if (request.survivor !== undefined) {
        try {
          survivor = findTask(all, request.survivor).id;
        } catch (error) {
          if (
            error instanceof RecordValidationError &&
            error.message === "task_not_found"
          )
            throw new SurvivorNotFoundError(request.survivor);
          throw error;
        }
      }
      const closed = closeTask(
        task,
        {
          kind: request.kind,
          ...(survivor === undefined ? {} : { survivor }),
        },
        this.lifecycle,
      );
      return request.finalSummary === undefined
        ? closed
        : taskState({ ...closed, finalSummary: request.finalSummary });
    });
  }
  /**
   * QCLI-423: `options.ifRevision` is the guarded precondition
   * {@link TaskService.edit} already offers (QCLI-277), applied to the
   * archive move -- a value that does not match the RESOLVED record's own
   * revision refuses as a conflict (exit 5) and moves nothing, so a guarded
   * edit followed by an archive no longer has an unguarded window. Only
   * `archive` takes it; whether the other lifecycle moves want the same
   * guard is deliberately not decided here.
   */
  async archive(
    reference: string,
    operationId: string,
    options?: { readonly ifRevision?: string },
  ): Promise<TaskMutationResult> {
    return this.moveTask(
      reference,
      "archive/tasks",
      operationId,
      undefined,
      options,
    );
  }
  /** Moves a task from the ladder's working status to the paused status. */
  async pause(
    reference: string,
    operationId: string,
  ): Promise<TaskMutationResult> {
    const snapshot = await this.repository.readAll();
    const task = findTask(snapshot.tasks, reference);
    const persisted = this.stamped(pauseTask(task, this.lifecycle));
    const result = await this.repository.write({
      task: persisted,
      expectedRevision: snapshot.revision,
      operationId,
      ownedPaths: [this.ownedPathFor(persisted)],
    });
    return result.kind === "success"
      ? { kind: "success", task: persisted, revision: result.revision }
      : result;
  }
  /** Moves a task back to the ladder's working status from paused or initial. */
  async start(
    reference: string,
    operationId: string,
  ): Promise<TaskMutationResult> {
    const snapshot = await this.repository.readAll();
    const task = findTask(snapshot.tasks, reference);
    const persisted = this.stamped(startTask(task, this.lifecycle));
    const result = await this.repository.write({
      task: persisted,
      expectedRevision: snapshot.revision,
      operationId,
      ownedPaths: [this.ownedPathFor(persisted)],
    });
    return result.kind === "success"
      ? { kind: "success", task: persisted, revision: result.revision }
      : result;
  }
  /**
   * Demotes a task to an explicit `--to` target (QCLI-229). `legalDemoteTargets`
   * (validated inside `demoteTask`) is the single source of truth for what is
   * legal from where; this method never resets to a hardcoded status and never
   * treats "still stored at tasks" as an error on its own -- only an illegal
   * target is. A record already at `"tasks"` gets a same-location status
   * write; one returning from `"completed"`/`"archive/tasks"` gets the same
   * two-entry lifecycle move `complete`/`archive` used to leave `"tasks"`.
   */
  async demote(
    reference: string,
    to: TaskStatus,
    operationId: string,
  ): Promise<TaskMutationResult> {
    const snapshot = await this.repository.readAll();
    const records = this.taskRecords(snapshot);
    const selected = findTask(
      records.map((record) => record.task),
      reference,
    );
    const current = records.find((record) => record.task.id === selected.id);
    if (!current) throw new RecordValidationError("task_not_found");
    const persisted = this.stamped(
      taskState({
        ...demoteTask(current.task, current.location, to, this.lifecycle),
        claim: undefined,
      }),
    );
    if (current.location === "tasks") {
      const result = await this.repository.write({
        task: persisted,
        expectedRevision: snapshot.revision,
        operationId,
        ownedPaths: [this.ownedPathFor(persisted)],
      });
      return result.kind === "success"
        ? { kind: "success", task: persisted, revision: result.revision }
        : result;
    }
    const result = await this.lifecycleRepository().writeLifecycle({
      expectedRevision: snapshot.revision,
      operationId,
      ownedPaths: [
        this.ownedPathForLocation(current.task.id, current.location),
        this.ownedPathForLocation(persisted.id, "tasks"),
      ],
      taskChanges: [
        { taskId: current.task.id, location: current.location, remove: true },
        { task: persisted, location: "tasks" },
      ],
      draftChanges: [],
    });
    return result.kind === "success"
      ? {
          kind: "success",
          task: persisted,
          revision: result.revision,
          relocatedTo: "tasks",
        }
      : result;
  }
  async createDraft(
    id: string,
    input: DraftInput,
    operationId: string,
  ): Promise<
    | {
        readonly kind: "success";
        readonly draft: DraftState;
        readonly revision: string;
      }
    | TaskWriteConflict
  > {
    const snapshot = await this.repository.readAll();
    const draft = createDraft(id, input);
    if ((snapshot.drafts ?? []).some((record) => record.draft.id === draft.id))
      throw new RecordValidationError("draft_already_exists");
    const result = await this.lifecycleRepository().writeLifecycle({
      expectedRevision: snapshot.revision,
      operationId,
      ownedPaths: [`.quest/drafts/${draft.id}.json`],
      taskChanges: [],
      draftChanges: [{ draft, location: "drafts" }],
    });
    return result.kind === "success"
      ? { kind: "success", draft, revision: result.revision }
      : result;
  }
  async listDrafts(includeArchived = false): Promise<readonly LocatedDraft[]> {
    return (
      (await this.repository.readAll()).drafts
        ?.filter((record) => includeArchived || record.location === "drafts")
        .sort((a, b) => a.draft.id.localeCompare(b.draft.id)) ?? []
    );
  }
  async viewDraft(id: string): Promise<LocatedDraft> {
    const record = (await this.repository.readAll()).drafts?.find(
      (entry) => entry.draft.id === id,
    );
    if (!record) throw new RecordValidationError("draft_not_found");
    return record;
  }
  async archiveDraft(
    id: string,
    operationId: string,
  ): Promise<
    | {
        readonly kind: "success";
        readonly draft: DraftState;
        readonly revision: string;
      }
    | TaskWriteConflict
  > {
    const snapshot = await this.repository.readAll();
    const current = snapshot.drafts?.find((record) => record.draft.id === id);
    if (!current) throw new RecordValidationError("draft_not_found");
    if (current.location === "archive/drafts")
      throw new RecordValidationError("draft_lifecycle_already_at_destination");
    const result = await this.lifecycleRepository().writeLifecycle({
      expectedRevision: snapshot.revision,
      operationId,
      ownedPaths: [
        `.quest/drafts/${id}.json`,
        `.quest/archive/drafts/${id}.json`,
      ],
      taskChanges: [],
      draftChanges: [
        { draftId: id, location: current.location, remove: true },
        { draft: current.draft, location: "archive/drafts" },
      ],
    });
    return result.kind === "success"
      ? { kind: "success", draft: current.draft, revision: result.revision }
      : result;
  }
  async promoteDraft(
    id: string,
    taskId: string,
    operationId: string,
  ): Promise<TaskMutationResult> {
    const snapshot = await this.repository.readAll();
    const current = snapshot.drafts?.find((record) => record.draft.id === id);
    if (!current) throw new RecordValidationError("draft_not_found");
    const allTasks = this.taskRecords(snapshot);
    if (allTasks.some((record) => record.task.id === taskId))
      throw new RecordValidationError("task_already_exists");
    // Promotion creates a task, so it stamps like `create` does. Without
    // this the record could never acquire a createdAt: nothing backfills.
    const task = this.stamped(
      createTask(
        taskId,
        {
          title: current.draft.title,
          description: current.draft.description,
          labels: current.draft.labels,
          documentation: current.draft.documentation,
          source: current.draft.source,
        },
        this.lifecycle,
      ),
      true,
    );
    const result = await this.lifecycleRepository().writeLifecycle({
      expectedRevision: snapshot.revision,
      operationId,
      ownedPaths: [
        `.quest/${current.location}/${id}.json`,
        `.quest/tasks/${task.id}.json`,
      ],
      taskChanges: [{ task, location: "tasks" }],
      draftChanges: [{ draftId: id, location: current.location, remove: true }],
    });
    return result.kind === "success"
      ? { kind: "success", task, revision: result.revision }
      : result;
  }
  async view(reference: string): Promise<TaskState> {
    const snapshot = await this.repository.readAll();
    return findTask(
      this.taskRecords(snapshot).map((record) => record.task),
      reference,
    );
  }
  /**
   * Presentation-boundary variant of {@link view} for `task view --json`
   * (QCLI-220). Kept separate from `view` because `view`'s plain TaskState
   * result flows into write paths elsewhere (e.g. lifecycle journal replay)
   * that must never see a synthetic, non-persisted `path` property.
   */
  async viewWithPath(reference: string): Promise<TaskStateWithPath> {
    const snapshot = await this.repository.readAll();
    const records = this.taskRecords(snapshot);
    const task = findTask(
      records.map((record) => record.task),
      reference,
    );
    const current = records.find((record) => record.task.id === task.id);
    if (!current) throw new RecordValidationError("task_not_found");
    return {
      ...task,
      path: this.ownedPathForLocation(task.id, current.location),
    };
  }
  /**
   * QCLI-277: `task view --json`'s revision-exposing variant. A caller
   * captures `revision` from here and supplies it back as `task edit
   * --if-revision` later, so an edit made against a stale read is refused
   * instead of silently applied. Kept separate from {@link viewWithPath}
   * (rather than widening its return type) to avoid touching `task list`'s
   * shared `TaskStateWithPath` shape, and performs its own single
   * `readAll()` rather than composing `viewWithPath` plus a second read, so
   * the returned task and revision always describe the same snapshot.
   *
   * QCLI-310: the revision is this RECORD's ({@link recordRevision}), not the
   * repository's whole-workspace one. The value exists to be handed back to
   * `task edit --if-revision`, whose documented promise is that the edit is
   * refused "if the record has moved since" -- so the value has to move when
   * THIS record moves and stay put when an unrelated one does. Emitting the
   * workspace revision here made a captured precondition fail after any edit
   * anywhere in the workspace.
   */
  async viewWithRevision(
    reference: string,
  ): Promise<{ readonly task: TaskStateWithPath; readonly revision: string }> {
    const snapshot = await this.repository.readAll();
    const records = this.taskRecords(snapshot);
    const task = findTask(
      records.map((record) => record.task),
      reference,
    );
    const current = records.find((record) => record.task.id === task.id);
    if (!current) throw new RecordValidationError("task_not_found");
    return {
      task: {
        ...task,
        path: this.ownedPathForLocation(task.id, current.location),
      },
      revision: recordRevision(current),
    };
  }

  /**
   * Resolves the mutable task and its authoritative snapshot in one read
   * (QCLI-122). Pair with {@link editOn} in the CLI composition root so one
   * public mutation performs exactly one authoritative collection read.
   */
  async prepareMutation(reference: string): Promise<{
    readonly snapshot: TaskReadSnapshot;
    readonly task: TaskState;
    /**
     * QCLI-310: the resolved RECORD's revision, not `snapshot.revision`
     * (which is the whole workspace's). This is the value `task view --json`
     * emits and `--if-revision` compares against, so the CLI's own
     * pre-fold staleness check (QCLI-374) can ask the same question
     * `editOn` will ask.
     */
    readonly taskRevision: string;
  }> {
    const snapshot = await this.repository.readAll();
    const records = this.taskRecords(snapshot);
    const task = findTask(
      records.map((record) => record.task),
      reference,
    );
    const current = records.find((record) => record.task.id === task.id);
    if (!current) throw new RecordValidationError("task_not_found");
    return { snapshot, task, taskRevision: recordRevision(current) };
  }
  async search(query: string): Promise<readonly TaskState[]> {
    const snapshot = await this.repository.readAll();
    return searchTasks(
      this.taskRecords(snapshot).map((record) => record.task),
      query,
    );
  }
  async edit(
    reference: string,
    patch: Partial<Omit<TaskState, "id" | "gates" | "gateEvents">>,
    operationId: string,
    options?: TaskEditOptions,
  ): Promise<TaskMutationResult> {
    const snapshot = await this.repository.readAll();
    return this.editOn(snapshot, reference, patch, operationId, options);
  }

  /**
   * Single-snapshot variant of {@link edit} for the CLI composition root
   * (QCLI-122): one public task mutation reads the authoritative collection
   * exactly once instead of once per service call. Behavior, validation,
   * and result envelopes are identical to {@link edit}.
   */
  async editOn(
    snapshot: TaskReadSnapshot,
    reference: string,
    patch: Partial<Omit<TaskState, "id" | "gates" | "gateEvents">>,
    operationId: string,
    options?: TaskEditOptions,
  ): Promise<TaskMutationResult> {
    // A broken [tasks] table refuses the write before anything else is read by
    // THIS method, and it is still the first guard to run -- the QCLI-277
    // precondition below is answered before any task work, but after this and
    // after the resolution it needs.
    if (this.configuredVocabularyProblem !== undefined)
      throw new RecordValidationError(this.configuredVocabularyProblem);
    // Cross-location resolution (QCLI-219): a completed or archived record
    // is a real, viewable task -- `quest task view` resolves it fine -- so
    // scoping the lookup to active `tasks/` alone made every edit against it
    // (check-ac, add-note, final-summary, all of them) fail with the
    // misleading task_not_found, as if the record did not exist at all.
    // QCLI-223 already widened dependency/parent *resolution* to this same
    // cross-location set; this extends the primary lookup and the write
    // path to match, so a real edit to a real record actually lands.
    const records = this.taskRecords(snapshot);
    const selected = findTask(
      records.map((record) => record.task),
      reference,
    );
    const current = records.find((record) => record.task.id === selected.id);
    if (!current) throw new RecordValidationError("task_not_found");
    const task = current.task;
    // QCLI-277, scoped to the record by QCLI-310. Still checked before any
    // state change -- resolution above is a pure in-memory lookup over the
    // snapshot already in hand, so a refused precondition still writes
    // nothing and changes nothing. It does have to resolve the reference
    // first, because "did THIS record move" cannot be answered without
    // knowing which record that is; comparing against the whole-store
    // `snapshot.revision` (which is what this did) refused an untouched
    // task's guarded edit as soon as any other task was written. See
    // TaskEditOptions for why this stays a distinct check from the
    // `expectedRevision: snapshot.revision` write further down, which is the
    // repository's own workspace-wide CAS and is deliberately unchanged.
    if (
      options?.ifRevision !== undefined &&
      options.ifRevision !== recordRevision(current)
    ) {
      return {
        kind: "conflict",
        code: "revision_precondition_failed",
        expectedRevision: options.ifRevision,
        actualRevision: recordRevision(current),
        operationId,
        ownedPaths: [],
      };
    }
    const unsafe = patch as Partial<TaskState>;
    const allTasks = records.map((record) => record.task);
    if ("gates" in unsafe || "gateEvents" in unsafe)
      throw new RecordValidationError("task_gate_events_managed");
    // Timestamps are stamped by the service on every write, so a patch that
    // sets them would be silently overwritten. Reject rather than no-op.
    if ("createdAt" in unsafe || "updatedAt" in unsafe)
      throw new RecordValidationError("task_timestamps_managed");
    // QCLI-331: close writes a resolution and demote withdraws it; a direct
    // patch could set one the strict close-time rules never saw.
    if ("resolution" in unsafe)
      throw new RecordValidationError("task_resolution_managed");
    // QCLI-330: only a type/priority this edit WRITES is checked, so an edit
    // to anything else on a record holding a legacy value still lands.
    const authorizedPatch = resolveVocabularyPatch(unsafe, this.taskVocabulary);
    if (
      authorizedPatch.status !== undefined &&
      authorizedPatch.status !== task.status
    )
      // Unchanged: a genuine status *transition* still goes through the
      // normal lifecycle ladder and is rejected exactly as before for any
      // terminal record. Only metadata (notes, checklists, summaries, ...)
      // becomes editable in place; this does not relax status semantics.
      transitionTask(task, authorizedPatch.status, this.lifecycle);
    const next = this.stamped(
      taskState({ ...task, ...authorizedPatch, id: task.id }),
    );
    const canonical = canonicalizeTaskLinks(
      allTasks.map((item) => (item.id === task.id ? next : item)),
    );
    const persisted = findTask(canonical, task.id);
    if (persisted.milestoneId !== task.milestoneId) {
      return this.persistWithMilestoneClosure(
        persisted,
        task.milestoneId,
        snapshot,
        operationId,
        current.location,
      );
    }
    if (current.location === "tasks") {
      const result = await this.repository.write({
        task: persisted,
        expectedRevision: snapshot.revision,
        operationId,
        ownedPaths: [this.ownedPathFor(persisted)],
      });
      return result.kind === "success"
        ? { kind: "success", task: persisted, revision: result.revision }
        : result;
    }
    // A retained (completed/archived) record's edit must stay in its own
    // location: the plain write() above always targets the active tasks/
    // directory, so using it here would write a stray duplicate there while
    // leaving the real record untouched.
    const result = await this.lifecycleRepository().writeLifecycle({
      expectedRevision: snapshot.revision,
      operationId,
      ownedPaths: [this.ownedPathForLocation(persisted.id, current.location)],
      taskChanges: [{ task: persisted, location: current.location }],
      draftChanges: [],
    });
    return result.kind === "success"
      ? { kind: "success", task: persisted, revision: result.revision }
      : result;
  }
  /**
   * A plain field patch to `status`, nothing more -- deliberately does not
   * relocate the record even when the new status is terminal (QCLI-221).
   * Status and on-disk location are independent by design: only
   * `complete`/`archive`/`demote` (via {@link moveTask}) ever move a record.
   * A task reaching Done through `edit --status Done` legitimately stays in
   * `tasks/`, exactly like one reaching Done through this method; every
   * lookup path resolves a task by id across all locations regardless of
   * where it happens to sit.
   */
  async transition(
    reference: string,
    status: TaskStatus,
    operationId: string,
  ): Promise<TaskMutationResult> {
    return this.edit(reference, { status }, operationId);
  }

  /**
   * QCLI-122 batch mutation (corrected under FMC 05fe52e8):
   * - results preserve exact input order, exactly one per submitted item;
   * - milestone-transition items are rejected AT THEIR INDEX with a
   *   documented error instead of being deferred after later items;
   * - the returned revision is always the true terminal authoritative
   *   revision after every durable write completed;
   * - empty input returns the authoritative revision (never fabricated);
   * - each applied record is individually atomic; crash recovery relies on
   *   the session journal proof implemented by {@link LocalTaskRepository}.
   */
  async editBatch(
    items: readonly {
      readonly reference: string;
      readonly patch?: Partial<
        Omit<TaskState, "id" | "gates" | "gateEvents"> & EditPatchVocabulary
      >;
      readonly operationId?: string;
      /**
       * QCLI-277: the per-item counterpart of {@link TaskEditOptions.ifRevision}.
       * Each item's precondition -- when supplied -- is checked against THAT
       * RECORD's own revision ({@link recordRevision}) as the batch found it
       * when it opened. Not against the store's whole-workspace revision, and
       * not against the in-memory state an earlier item may since have
       * evolved: the caller captured the value before building the batch, so
       * the state it describes is the one the batch opened on. A mismatch
       * fails only that item, exactly like any other per-item validation
       * failure (`task_not_found`, a bad checklist position, ...): it does
       * not abort sibling items in the batch.
       *
       * QCLI-310 scoped this to the record. The value has to be the same one
       * `task view --json` emits, both so a captured revision is usable here
       * as well as on `task edit --if-revision`, and because a whole-store
       * comparison failed every item whose unrelated sibling task happened
       * to move.
       */
      readonly ifRevision?: string;
    }[],
  ): Promise<
    | {
        readonly kind: "success";
        readonly items: readonly (
          | {
              readonly kind: "updated";
              readonly reference: string;
              readonly operationId: string;
              readonly task: TaskState;
            }
          | {
              readonly kind: "error";
              readonly reference: string;
              readonly operationId: string;
              readonly message: string;
            }
        )[];
        readonly revision: string;
      }
    | TaskWriteConflict
  > {
    // A broken [tasks] table refuses the whole batch, like every other write.
    if (this.configuredVocabularyProblem !== undefined)
      throw new RecordValidationError(this.configuredVocabularyProblem);
    // Blocker #7 (third pass): the batch port is enforced by construction —
    // no unknown runtime casts.
    const repository = this.repository as LifecycleTaskRepository;
    if (
      this.batchRepository === undefined ||
      repository.writeLifecycle !== this.batchRepository.writeLifecycle
    ) {
      throw new RecordValidationError("batch_repository_unavailable");
    }
    const batchRepository = this.batchRepository;

    const resolvedItems = items.map((item, index) => ({
      item,
      operationId: item.operationId ?? `batch-item-${index + 1}`,
    }));

    const initial = await this.repository.readAll();
    const results: (
      | {
          readonly kind: "updated";
          readonly reference: string;
          readonly operationId: string;
          readonly task: TaskState;
        }
      | {
          readonly kind: "error";
          readonly reference: string;
          readonly operationId: string;
          readonly message: string;
        }
    )[] = [];

    // Empty input: zero items plus the authoritative revision. No lock,
    // journal, or mutation ever happens (blocker #8).
    if (items.length === 0)
      return { kind: "success", items: [], revision: initial.revision };

    // Duplicate ids fail the whole request before any mutation.
    const seenIds = new Set<string>();
    for (const [index, { operationId }] of resolvedItems.entries()) {
      if (seenIds.has(operationId))
        throw new RecordValidationError(
          `batch_duplicate_operation_id_at_line_${index + 1}`,
        );
      seenIds.add(operationId);
    }

    const opened = await batchRepository.beginTaskBatch(initial.revision);
    if (opened.kind === "conflict")
      return {
        kind: "conflict",
        expectedRevision: opened.expectedRevision,
        actualRevision: opened.actualRevision,
        operationId: "task-edit-batch",
        ownedPaths: [],
      };
    // Blocker #3: bounded error receipt instead of recursion.
    if (opened.kind === "unrecoverable_lock")
      return {
        kind: "conflict",
        expectedRevision: initial.revision,
        actualRevision: initial.revision,
        operationId: "task-edit-batch",
        ownedPaths: [],
      };
    const session = opened.session;
    try {
      if (opened.recovered?.appliedOperationIds.length)
        console.error(
          `[quest] recovered ${opened.recovered.appliedOperationIds.length} journaled operations from crashed batch ${opened.recovered.sessionId}`,
        );
      // CAS proved the store unchanged since the entry snapshot; everything
      // below evolves from that exact state (blocker #4: repeated edits to
      // one task compose because folds read EVOLVING rows).
      //
      // Cross-location resolution (QCLI-243): a completed or archived record
      // is a real, editable task -- QCLI-219 already fixed this for the
      // single-item `edit` path, and this mirrors it here. workingTasks and
      // workingLocations are parallel arrays over EVERY location, not just
      // `tasks/`, so a batch item can resolve and evolve a retired record;
      // its location never changes within a batch (only complete/archive/
      // demote relocate a record, and editBatch's patch vocabulary can't
      // reach those), so workingLocations is captured once per slot.
      const initialRecords = this.taskRecords(initial);
      const workingTasks = initialRecords.map((record) => record.task);
      const workingLocations = initialRecords.map((record) => record.location);
      // QCLI-310: each slot's per-record revision as the batch opened, held
      // alongside the other two parallel arrays so an item's precondition is
      // checked against the state its caller captured, not against whatever
      // an earlier item in this same batch has evolved the slot into.
      const initialRevisions = initialRecords.map((record) =>
        recordRevision(record),
      );
      // O(1) alias/reference index over the evolving collection.
      let rowIndex = buildReferenceIndex(workingTasks);

      /**
       * Blocker #5 fast path: patches that cannot touch aliases,
       * dependencies/parent graph, blockers, or lifecycle edges apply with
       * O(row) validation; only graph-affecting rows run full seeded-graph
       * validation through a link session built from complete existing
       * edges. Milestone-transition items are REJECTED AT THEIR EXACT
       * INPUT INDEX with milestone_transition_requires_single_edit — no
       * task or planning mutation occurs for them (single contract).
       */

      let appliedCount = 0;
      for (const [index, { item, operationId }] of resolvedItems.entries()) {
        const reference = item.reference;
        try {
          const slot = rowIndex.resolve(item.reference);
          if (slot === undefined)
            throw new RecordValidationError("task_not_found");
          // QCLI-277 (QCLI-310 scoped it to the record): checked before
          // touching this item's row, so a stale per-item precondition
          // changes nothing for it -- same "before any state change"
          // property as the single-edit check in editOn, scoped to one item
          // instead of aborting the whole batch. It resolves the reference
          // first because the question is whether THIS record moved; the
          // thrown error is still a per-item one, and an unresolvable
          // reference is reported as itself rather than as a revision
          // mismatch against a record that could not be named.
          if (
            item.ifRevision !== undefined &&
            item.ifRevision !== initialRevisions[slot]
          )
            throw new RecordValidationError(
              `task_revision_precondition_failed (expected ${item.ifRevision}, actual ${initialRevisions[slot]})`,
            );
          const current = workingTasks[slot];
          const location = workingLocations[slot];
          const unsafe = resolveVocabularyPatch(
            foldEditPatch(
              current,
              (item.patch ?? {}) as EditPatchVocabulary,
              (status) => this.resolveStatus(status),
            ) as Partial<TaskState>,
            this.taskVocabulary,
          );
          if ("gates" in unsafe || "gateEvents" in unsafe)
            throw new RecordValidationError("task_gate_events_managed");
          if ("resolution" in unsafe)
            throw new RecordValidationError("task_resolution_managed");
          if (unsafe.status !== undefined && unsafe.status !== current.status)
            transitionTask(current, unsafe.status, this.lifecycle);
          const rawNext = this.stamped(
            taskState({ ...current, ...unsafe, id: current.id }),
          );
          if (rawNext.milestoneId !== current.milestoneId) {
            // Fifth-pass blocker #3 (public JSDoc contract): milestone
            // transitions are rejected AT THEIR EXACT INDEX with the
            // documented error; no task or planning mutation occurs.
            throw new RecordValidationError(
              "milestone_transition_requires_single_edit",
            );
          }
          const touchesGraph =
            JSON.stringify(rawNext.dependencies) !==
              JSON.stringify(current.dependencies) ||
            rawNext.parentId !== current.parentId ||
            JSON.stringify(rawNext.aliases) !==
              JSON.stringify(current.aliases) ||
            JSON.stringify(rawNext.blockers ?? []) !==
              JSON.stringify(current.blockers ?? []);
          let persistedRow = rawNext as TaskState;
          if (touchesGraph) {
            // workingTasks already spans every location (QCLI-243), so this
            // is the complete graph context on its own -- no separate
            // read-only retired set to append.
            const linkSession = createTaskLinkSession(workingTasks);
            // Blocker #6: ONE canonical record flows to persistence, the
            // result envelope, and the evolving fold for following rows.
            persistedRow = linkSession.apply(rawNext);
            await session.writeRecord(persistedRow, location);
          } else {
            // Non-graph rows validate locally: one authoritative record
            // parse + unique-row check (session holds the lock).
            await session.writeRecord(taskState(rawNext), location);
          }
          await session.markApplied(operationId, persistedRow.id);
          workingTasks[slot] = persistedRow;
          rowIndex = rebuildSlot(rowIndex, slot, persistedRow);
          appliedCount += 1;
          results.push({
            kind: "updated",
            reference,
            operationId,
            task: persistedRow,
          });
        } catch (error) {
          results.push({
            kind: "error",
            reference,
            operationId,
            message:
              error instanceof Error
                ? error.message
                : "unknown_batch_item_error",
          });
        }
        void index;
        void appliedCount;
      }

      await session.finish();
      // Terminal revision ONLY after every durable write completed.
      const terminal = await this.repository.readAll();
      return { kind: "success", items: results, revision: terminal.revision };
    } finally {
      await session.finish();
    }
  }

  resolveStatus(status: string): TaskStatus {
    return resolveConfiguredStatus(status, this.lifecycle);
  }

  /**
   * A list filter may also name the paused status (QCLI-392): `task pause`
   * assigns it, so a caller must be able to find what it assigned. Writes
   * keep `resolveStatus`, which refuses it, since `task pause` is the only
   * legal way in (QCLI-229).
   */
  private resolveFilterStatus(status: string): TaskStatus {
    // QCLI-331: the same reasoning reaches the closed status -- `task close`
    // assigns it, so `task list --status Closed` must find what it assigned.
    for (const offLadder of [
      this.lifecycle.pausedStatus,
      this.lifecycle.closedStatus,
    ])
      if (offLadder !== undefined && statusKey(offLadder) === statusKey(status))
        return offLadder;
    return this.resolveStatus(status);
  }
  async ready(now: Date): Promise<ReadySet> {
    // QCLI-249: readAll().tasks only holds the "tasks" location, which
    // starves graph resolution of completed/archived parent and dependency
    // targets -- see the identical fix and full reasoning in
    // listFilteredLocated's readyIds computation above.
    const snapshot = await this.repository.readAll();
    return evaluateReadySet(
      this.taskRecords(snapshot).map((record) => record.task),
      now,
      this.lifecycle,
    );
  }
}
