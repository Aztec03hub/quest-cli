import { z } from "zod";

import {
  blockingGatesSatisfied,
  type GateEvent,
  replayGateHistory,
} from "../gates/gates.ts";
import {
  aliasKey,
  type CanonicalId,
  canonicalId,
  canonicalIdSchema,
  RecordConflictError,
  RecordValidationError,
} from "../records.ts";

export const taskStatuses = ["To Do", "In Progress", "Done"] as const;
export type TaskStatus = string;
/** Storage location is lifecycle metadata, never part of the task identifier. */
export type TaskLocation = "tasks" | "completed" | "archive/tasks";
/**
 * The same vocabulary at runtime, in the order a reader should see it:
 * active first, then the retention locations in the order a record reaches
 * them. Seeding a per-location count from this is what lets a zero be
 * reported as a zero rather than as an absent key (QCLI-339, following
 * DEC-6's "empty is a result, not an omission").
 */
export const TASK_LOCATIONS: readonly TaskLocation[] = [
  "tasks",
  "completed",
  "archive/tasks",
];
export type DraftLocation = "drafts" | "archive/drafts";
export type DraftId = `D-${number}`;
export interface LifecyclePolicy {
  readonly statuses: readonly TaskStatus[];
  readonly terminalStatuses: readonly TaskStatus[];
  /**
   * A non-terminal parking status reached only through `quest task pause`
   * and left only through `quest task start` (QCLI-229) -- never the
   * generic `--status` edit, and never part of the forward `statuses`
   * ladder `transitionTask` walks. Absent disables pause/start for the
   * workspace; a workspace may also rename it to any other configured-
   * distinct value. Default-on so the fix applies without configuration.
   */
  readonly pausedStatus?: TaskStatus;
  /**
   * A second terminal status, OFF the ladder, reached only through
   * `quest task close` and always paired with a {@link TaskResolution}
   * (QCLI-331, opum-doc ADR "Add a second terminal task status for
   * duplicate, superseded and wont-do outcomes"). It says the task is
   * finished with, never that its outcome happened -- that stays the one
   * meaning of `terminalStatuses`. `terminalStatuses` keeps naming the
   * LADDER's terminal statuses (so `complete` still walks to Done); a
   * consumer asking "is this task finished" reads
   * {@link allTerminalStatuses}, never a `"Done"` literal. Absent disables
   * `task close` for the workspace.
   */
  readonly closedStatus?: TaskStatus;
}
export const defaultLifecyclePolicy: LifecyclePolicy = {
  statuses: taskStatuses,
  terminalStatuses: ["Done"],
  pausedStatus: "Paused",
  closedStatus: "Closed",
};

/**
 * Why a task reached the closed status (QCLI-331). `duplicate` and
 * `superseded` name the surviving task that carries the work forward;
 * `wont-do` names none, because nothing does.
 */
export const taskResolutionKinds = [
  "duplicate",
  "superseded",
  "wont-do",
] as const;
export type TaskResolutionKind = (typeof taskResolutionKinds)[number];
/** The kinds that must name a survivor; `wont-do` must not. */
const survivorRequiredKinds: readonly string[] = ["duplicate", "superseded"];

/**
 * A resolution as STORED. Read leniently on purpose -- any non-empty `kind`,
 * any non-empty `survivor` -- so a hand-edited record with a bad resolution
 * stays readable and `quest doctor` can name it ({@link resolutionProblem})
 * instead of every command refusing the whole workspace, which is what a
 * strict read-time schema would do. The strict shape is enforced where a
 * resolution is WRITTEN: {@link closeTask} is its only producer, and
 * `task edit` refuses the field as managed.
 */
export interface TaskResolution {
  readonly kind: string;
  readonly survivor?: string;
}

/**
 * Every status meaning "this task is finished with": the ladder's terminal
 * statuses plus the closed status (QCLI-331). Readiness, and any other
 * "is it finished" question, reads this -- never a `"Done"` literal.
 */
export function allTerminalStatuses(
  policy: LifecyclePolicy = defaultLifecyclePolicy,
): readonly TaskStatus[] {
  return policy.closedStatus === undefined
    ? policy.terminalStatuses
    : [...policy.terminalStatuses, policy.closedStatus];
}

/**
 * Paused-status literals an earlier release parked records at by default.
 * QCLI-287 renamed the default from `"Blocked"` to `"Paused"` without
 * migrating records already parked, so a workspace upgraded to 0.7.0 held
 * records at a status on neither the ladder nor the paused slot, which no
 * command could leave (QCLI-302). `startTask` accepts a retired literal as
 * the paused status when, and only when, the workspace does not configure
 * that literal itself -- a workspace naming `"Blocked"` on its ladder or as
 * its paused status keeps exactly the behaviour it configured. Nothing is
 * migrated silently: the exit is an explicit, attributed `task start`.
 */
export const retiredPausedStatuses: readonly TaskStatus[] = ["Blocked"];

/**
 * True when `status` is a retired paused literal the policy does not itself
 * configure, i.e. a record that only an older default could have parked
 * there (QCLI-302).
 */
export function isRetiredPausedStatus(
  status: TaskStatus,
  policy: LifecyclePolicy = defaultLifecyclePolicy,
): boolean {
  return (
    retiredPausedStatuses.includes(status) &&
    !policy.statuses.includes(status) &&
    status !== policy.pausedStatus &&
    status !== policy.closedStatus
  );
}

/**
 * True when a record's status is on neither the ladder, the paused slot,
 * nor the closed slot, so `transitionTask`, `pauseTask` and (unless it is a
 * retired paused literal) `startTask` all refuse to move it (QCLI-302).
 * `doctor` reports such records; nothing else in the lifecycle can see
 * them. The closed status is on-flow: `task demote` leaves it (QCLI-331).
 */
export function isOffFlowStatus(
  status: TaskStatus,
  policy: LifecyclePolicy = defaultLifecyclePolicy,
): boolean {
  return (
    !policy.statuses.includes(status) &&
    status !== policy.pausedStatus &&
    status !== policy.closedStatus
  );
}

function lifecyclePolicy(policy: LifecyclePolicy): LifecyclePolicy {
  if (
    !policy.statuses.length ||
    new Set(policy.statuses).size !== policy.statuses.length
  )
    throw new RecordValidationError(
      "Lifecycle statuses must be a non-empty unique order.",
    );
  if (
    policy.terminalStatuses.some((status) => !policy.statuses.includes(status))
  )
    throw new RecordValidationError(
      "Lifecycle terminal status is not configured.",
    );
  if (policy.pausedStatus !== undefined) {
    if (!policy.pausedStatus.trim())
      throw new RecordValidationError(
        "Lifecycle paused status cannot be blank.",
      );
    if (policy.statuses.includes(policy.pausedStatus))
      throw new RecordValidationError(
        "Lifecycle paused status must not collide with a ladder status.",
      );
  }
  if (policy.closedStatus !== undefined) {
    if (!policy.closedStatus.trim())
      throw new RecordValidationError(
        "Lifecycle closed status cannot be blank.",
      );
    if (policy.statuses.includes(policy.closedStatus))
      throw new RecordValidationError(
        "Lifecycle closed status must not collide with a ladder status.",
      );
    if (policy.closedStatus === policy.pausedStatus)
      throw new RecordValidationError(
        "Lifecycle closed status must not collide with the paused status.",
      );
  }
  return policy;
}

export interface TaskComment {
  readonly id: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface SourceProvenance {
  readonly system: string;
  readonly reference: string;
  readonly importedAt?: string;
}

export interface BlockerEvent {
  readonly kind: "opened" | "cleared";
  readonly blockId: string;
  readonly actorId: string;
  readonly at: string;
  readonly reason?: string;
  readonly evidence?: readonly string[];
}

export interface TaskClaim {
  readonly holderId: string;
  readonly leaseGeneration: string;
  readonly expiresAt: string;
}

export interface TaskCheckItem {
  readonly index: number;
  readonly text: string;
  readonly checked: boolean;
}

/** Legacy records store bare strings; taskState() always normalizes to items. */
export type TaskCheckList = readonly (string | TaskCheckItem)[];

export interface UnresolvedChecklistItem {
  readonly index: number;
  readonly text: string;
}

export interface UnresolvedAtCompletion {
  readonly acceptanceCriteria: readonly UnresolvedChecklistItem[];
  readonly definitionOfDone: readonly UnresolvedChecklistItem[];
}

/** Structural side of a milestone; domain/planning's Milestone is assignable. */
export interface MilestoneTaskSide {
  readonly id: string;
  readonly taskIds: readonly string[];
}

const milestoneIdPattern = /^M-[1-9][0-9]*$/;

export interface TaskGate {
  readonly id: string;
  readonly title: string;
  readonly blocking?: boolean;
  readonly state: "pending" | "satisfied";
  readonly evidence: readonly string[];
  readonly satisfiedBy?: string;
}

export interface TaskState {
  readonly id: CanonicalId;
  readonly aliases: readonly string[];
  readonly title: string;
  readonly status: TaskStatus;
  readonly summary?: string;
  readonly description?: string;
  readonly priority?: string;
  readonly type?: string;
  readonly ordinal?: number;
  readonly acceptanceCriteria: TaskCheckList;
  readonly definitionOfDone: TaskCheckList;
  readonly plan: readonly string[];
  readonly implementationNotes: readonly string[];
  readonly comments: readonly TaskComment[];
  readonly labels: readonly string[];
  readonly documentation: readonly string[];
  readonly parentId?: string;
  readonly dependencies: readonly string[];
  readonly assignees?: readonly string[];
  readonly references?: readonly string[];
  readonly modifiedFiles?: readonly string[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly finalSummary?: string;
  readonly milestoneId?: string;
  readonly blockers: readonly BlockerEvent[];
  readonly gates: readonly TaskGate[];
  /** Append-only authored gate history; `gates` is its materialized projection. */
  readonly gateEvents: readonly GateEvent[];
  readonly claim?: TaskClaim;
  readonly source?: SourceProvenance;
  /**
   * QCLI-336: the persisted counterpart of QCLI-252's response-only signal.
   * Written by `complete()` from the checklist state at the moment a task
   * reaches its terminal status. QCLI-479 (opum-doc DEC-172 (4ae)): a
   * COMPLETION REFRESHES it rather than setting it once -- a task demoted back
   * to an active status, amended, and completed again carries the unresolved
   * set of THAT completion, and the field is CLEARED when nothing is
   * unresolved then, so the earlier snapshot does not survive that
   * re-completion. The field is written ONLY by a completion, so an amendment
   * with no demote and no re-completion -- editing a completed task's
   * checklist, or `task edit --status <terminal>`, which reaches the terminal
   * status without a completion -- leaves the snapshot as the completion
   * before it wrote it. Nothing else on the record carries an earlier one;
   * each completion replaces it. Absent means either nothing was unresolved at
   * the completion that wrote it, or the task predates this field (QCLI-336 does
   * not backfill historical records) -- the two are indistinguishable from
   * this field alone, by design.
   */
  readonly unresolvedAtCompletion?: UnresolvedAtCompletion;
  /**
   * QCLI-331: why a task at the closed status was retired. Written only by
   * `closeTask`, cleared by `demoteTask` out of the closed status. Absent on
   * every record that predates it -- prospective only, nothing is migrated.
   */
  readonly resolution?: TaskResolution;
}

export interface TaskInput
  extends Omit<
    TaskState,
    | "id"
    | "status"
    | "aliases"
    | "acceptanceCriteria"
    | "definitionOfDone"
    | "plan"
    | "implementationNotes"
    | "comments"
    | "labels"
    | "documentation"
    | "dependencies"
    | "blockers"
    | "gates"
    | "gateEvents"
    | "unresolvedAtCompletion"
    | "resolution"
  > {
  readonly status?: TaskStatus;
  readonly aliases?: readonly string[];
  readonly acceptanceCriteria?: TaskCheckList;
  readonly definitionOfDone?: TaskCheckList;
  readonly plan?: readonly string[];
  readonly implementationNotes?: readonly string[];
  readonly comments?: readonly TaskComment[];
  readonly labels?: readonly string[];
  readonly documentation?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly blockers?: readonly BlockerEvent[];
}

export interface DraftState {
  readonly id: DraftId;
  readonly title: string;
  readonly description?: string;
  readonly labels: readonly string[];
  readonly documentation: readonly string[];
  readonly createdAt?: string;
  readonly source?: SourceProvenance;
}

export interface DraftInput
  extends Omit<DraftState, "id" | "labels" | "documentation"> {
  readonly labels?: readonly string[];
  readonly documentation?: readonly string[];
}

const statusSchema = z.string().min(1);
const checkItemSchema = z.object({
  index: z.number().int().min(0),
  text: z.string(),
  checked: z.boolean(),
});
const checkListSchema = z.array(z.union([z.string(), checkItemSchema]));
const draftIdSchema = z.string().regex(/^D-[1-9][0-9]*$/) as z.ZodType<DraftId>;
const draftSchema = z.object({
  id: draftIdSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  labels: z.array(z.string()),
  documentation: z.array(z.string()),
  createdAt: z.string().optional(),
  source: z
    .object({
      system: z.string().min(1),
      reference: z.string().min(1),
      importedAt: z.string().optional(),
    })
    .optional(),
});
const taskSchema = z.object({
  id: canonicalIdSchema,
  aliases: z.array(z.string().min(1)),
  title: z.string().min(1),
  status: statusSchema,
  summary: z.string().optional(),
  description: z.string().optional(),
  priority: z.string().optional(),
  type: z.string().optional(),
  ordinal: z.number().finite().optional(),
  acceptanceCriteria: checkListSchema,
  definitionOfDone: checkListSchema,
  plan: z.array(z.string()),
  implementationNotes: z.array(z.string()),
  comments: z.array(
    z.object({
      id: z.string().min(1),
      authorId: z.string().min(1),
      body: z.string(),
      createdAt: z.string().min(1),
    }),
  ),
  labels: z.array(z.string()),
  documentation: z.array(z.string()),
  parentId: z.string().optional(),
  dependencies: z.array(z.string()),
  assignees: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
  modifiedFiles: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  finalSummary: z.string().optional(),
  milestoneId: z.string().regex(milestoneIdPattern).optional(),
  blockers: z.array(
    z.object({
      kind: z.enum(["opened", "cleared"]),
      blockId: z.string().min(1),
      actorId: z.string().min(1),
      at: z.string().min(1),
      reason: z.string().optional(),
      evidence: z.array(z.string()).optional(),
    }),
  ),
  gates: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      blocking: z.boolean().optional(),
      state: z.enum(["pending", "satisfied"]),
      evidence: z.array(z.string()),
      satisfiedBy: z.string().min(1).optional(),
    }),
  ),
  gateEvents: z.array(z.unknown()),
  claim: z
    .object({
      holderId: z.string().min(1),
      leaseGeneration: z.string().min(1),
      expiresAt: z.string().min(1),
    })
    .optional(),
  source: z
    .object({
      system: z.string().min(1),
      reference: z.string().min(1),
      importedAt: z.string().optional(),
    })
    .optional(),
  unresolvedAtCompletion: z
    .object({
      acceptanceCriteria: z.array(
        z.object({ index: z.number().int().min(0), text: z.string() }),
      ),
      definitionOfDone: z.array(
        z.object({ index: z.number().int().min(0), text: z.string() }),
      ),
    })
    .optional(),
  // Lenient on read by design; see TaskResolution for why.
  resolution: z
    .object({
      kind: z.string().min(1),
      survivor: z.string().min(1).optional(),
    })
    .optional(),
});

function unique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length)
    throw new RecordValidationError(`${name} cannot contain duplicates.`);
}

/** Locale-invariant casefold for configured-status matching; storage keeps the canonical spelling. */
export function statusKey(status: string): string {
  return status.trim().toLowerCase();
}

export function resolveConfiguredStatus(
  requested: string,
  policy = defaultLifecyclePolicy,
): TaskStatus {
  const configured = lifecyclePolicy(policy);
  const match = configured.statuses.find(
    (status) => statusKey(status) === statusKey(requested),
  );
  // QCLI-331: the closed status IS configured, just off the ladder, so name
  // the one command that reaches it rather than calling it unconfigured.
  if (
    !match &&
    configured.closedStatus !== undefined &&
    statusKey(configured.closedStatus) === statusKey(requested)
  )
    throw new RecordValidationError(
      `"${configured.closedStatus}" is reached only through \`quest task close <id> --resolution <${taskResolutionKinds.join("|")}>\`, never a status edit.`,
    );
  if (!match) throw new RecordValidationError("Task status is not configured.");
  return match;
}

/**
 * The first rule a resolution breaks, as a sentence, or undefined when it
 * breaks none (QCLI-331). One predicate for both `closeTask` (which refuses
 * with it) and `doctor` (which reports it), so the two can never disagree on
 * what a valid resolution is. `survivor` is compared to the task's own id by
 * alias key, so a different spelling of the same id is still "itself".
 */
export function resolutionShapeProblem(
  taskId: string,
  resolution: TaskResolution,
): string | undefined {
  if (!(taskResolutionKinds as readonly string[]).includes(resolution.kind))
    return `resolution kind "${resolution.kind}" is not one of ${taskResolutionKinds.join(", ")}`;
  const needsSurvivor = survivorRequiredKinds.includes(resolution.kind);
  if (needsSurvivor && resolution.survivor === undefined)
    return `resolution "${resolution.kind}" requires a survivor: the id of the task that carries the work forward`;
  if (!needsSurvivor && resolution.survivor !== undefined)
    return `resolution "${resolution.kind}" takes no survivor: nothing carries the work forward`;
  if (
    resolution.survivor !== undefined &&
    aliasKey(resolution.survivor) === aliasKey(taskId)
  )
    return `a task cannot be its own survivor (${taskId})`;
  return undefined;
}

function normalizeCheckList(list: TaskCheckList): readonly TaskCheckItem[] {
  const items = list.map((entry, index) => {
    if (typeof entry === "string")
      return { index, text: entry, checked: false };
    if (entry.index !== index)
      throw new RecordValidationError("check_item_index_mismatch");
    return entry;
  });
  // Legacy string migration is positional by construction; authored item lists
  // must carry a complete, duplicate-free, positionally ordered index set.
  if (list.some((entry) => typeof entry !== "string"))
    unique(
      items.map((item) => String(item.index)),
      "Check item indexes",
    );
  return items;
}

/**
 * QCLI-252 / QCLI-336: the unchecked items in a checklist, by the same rule
 * `normalizeCheckList` already uses to decide "unchecked" for a legacy bare
 * string (unchecked by construction).
 */
function uncheckedItems(
  list: TaskCheckList,
): readonly UnresolvedChecklistItem[] {
  return normalizeCheckList(list)
    .filter((item) => !item.checked)
    .map((item) => ({ index: item.index, text: item.text }));
}

/**
 * The single computation behind both QCLI-252 (the one-shot response field)
 * and QCLI-336 (`complete()`'s persisted counterpart) -- kept here rather
 * than duplicated at each call site, so the two can never silently drift
 * apart on what "unresolved" means. Returns undefined (omit, never an empty
 * object) when nothing is unresolved.
 */
export function unresolvedAtCompletion(task: {
  readonly acceptanceCriteria: TaskCheckList;
  readonly definitionOfDone: TaskCheckList;
}): UnresolvedAtCompletion | undefined {
  const acceptanceCriteria = uncheckedItems(task.acceptanceCriteria);
  const definitionOfDone = uncheckedItems(task.definitionOfDone);
  return acceptanceCriteria.length === 0 && definitionOfDone.length === 0
    ? undefined
    : { acceptanceCriteria, definitionOfDone };
}

/** Normalizes defaults and rejects malformed authored task state. */
export function taskState(value: TaskState): TaskState {
  const parsed = taskSchema.safeParse(value);
  if (!parsed.success) throw new RecordValidationError("Invalid task state.");
  let state = parsed.data as TaskState;
  state = {
    ...state,
    acceptanceCriteria: normalizeCheckList(state.acceptanceCriteria),
    definitionOfDone: normalizeCheckList(state.definitionOfDone),
  };
  unique(state.labels, "Labels");
  unique(state.assignees ?? [], "Assignees");
  unique(state.references ?? [], "References");
  unique(state.modifiedFiles ?? [], "Modified files");
  unique(state.documentation, "Documentation links");
  unique(
    state.comments.map((comment) => comment.id),
    "Comment ids",
  );
  unique(state.aliases.map(aliasKey), "Aliases");
  unique(
    state.gates.map((gate) => gate.id),
    "Gate ids",
  );
  if (!state.gateEvents.length) {
    if (state.gates.length)
      throw new RecordValidationError("gate_materialization_drift");
  } else {
    const replayed = replayGateHistory(state.gateEvents);
    if (replayed.taskId !== state.id)
      throw new RecordValidationError("gate_task_mismatch");
    const gates: readonly TaskGate[] = replayed.gates.map((gate) => ({
      id: gate.id,
      title: gate.title,
      blocking: gate.blocking,
      state: gate.state,
      evidence: gate.evidence.map((item) => item.reference),
      ...(gate.satisfiedBy ? { satisfiedBy: gate.satisfiedBy } : {}),
    }));
    // A projection is never separately authored when a gate event stream exists.
    if (JSON.stringify(state.gates) !== JSON.stringify(gates))
      throw new RecordValidationError("gate_materialization_drift");
    state = { ...state, gates };
  }
  return state;
}

export function createTask(
  id: string,
  input: TaskInput,
  policy = defaultLifecyclePolicy,
): TaskState {
  const configured = lifecyclePolicy(policy);
  const status =
    input.status === undefined
      ? configured.statuses[0]
      : resolveConfiguredStatus(input.status, policy);
  return taskState({
    ...input,
    id: canonicalId(id),
    status,
    aliases: input.aliases ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    definitionOfDone: input.definitionOfDone ?? [],
    plan: input.plan ?? [],
    implementationNotes: input.implementationNotes ?? [],
    comments: input.comments ?? [],
    labels: input.labels ?? [],
    documentation: input.documentation ?? [],
    dependencies: input.dependencies ?? [],
    blockers: input.blockers ?? [],
    gates: [],
    gateEvents: [],
  });
}

export function draftId(value: string): DraftId {
  if (!/^D-[1-9][0-9]*$/.test(value))
    throw new RecordValidationError(`Invalid draft id: ${value}`);
  return value as DraftId;
}

export function draftState(value: DraftState): DraftState {
  const parsed = draftSchema.safeParse(value);
  if (!parsed.success) throw new RecordValidationError("Invalid draft state.");
  const state = parsed.data as DraftState;
  unique(state.labels, "Draft labels");
  unique(state.documentation, "Draft documentation links");
  return state;
}

export function createDraft(id: string, input: DraftInput): DraftState {
  return draftState({
    ...input,
    id: draftId(id),
    labels: input.labels ?? [],
    documentation: input.documentation ?? [],
  });
}

export function transitionTask(
  task: TaskState,
  next: TaskStatus,
  policy = defaultLifecyclePolicy,
): TaskState {
  const configured = lifecyclePolicy(policy);
  const position = configured.statuses.indexOf(task.status);
  // QCLI-397: a paused task is off the ladder by design, not unconfigured,
  // so name its status and the one legal way back instead.
  if (
    position < 0 &&
    (task.status === configured.pausedStatus ||
      isRetiredPausedStatus(task.status, configured))
  )
    throw new RecordValidationError(
      `Task ${task.id} is "${task.status}", ${task.status === configured.pausedStatus ? "the paused status" : "a retired paused status"}, which is off the status ladder. Bring it back with \`quest task start ${task.id}\`, then retry.`,
    );
  // QCLI-331: the closed status is terminal and off the ladder; demote is
  // its one exit, exactly as start is the paused status's.
  if (position < 0 && task.status === configured.closedStatus)
    throw new RecordValidationError(
      `Task ${task.id} is "${task.status}", a terminal status reached by \`quest task close\`, which is off the status ladder. Reopen it with \`quest task demote ${task.id} --to "${configured.statuses[0]}"\`, then retry.`,
    );
  if (position < 0)
    throw new RecordValidationError(
      "Task transition uses an unconfigured status.",
    );
  const resolved = resolveConfiguredStatus(next, policy);
  if (configured.statuses.indexOf(resolved) !== position + 1)
    throw new RecordValidationError(
      `Illegal task transition: ${task.status} -> ${resolved}.` +
        // QCLI-331: a refused walk to a terminal status is exactly where a
        // session retiring never-worked work used to reach for the
        // In-Progress-then-Done workaround, so name the real way out here.
        (configured.terminalStatuses.includes(resolved) &&
        configured.closedStatus !== undefined
          ? ` To retire a task that was never worked (a duplicate, superseded, or won't-do), use \`quest task close ${task.id} --resolution <${taskResolutionKinds.join("|")}>\`.`
          : ""),
    );
  if (
    configured.terminalStatuses.includes(resolved) &&
    !blockingGatesSatisfied(
      task.gateEvents.length
        ? replayGateHistory(task.gateEvents).gates
        : task.gates.map((gate) => ({
            id: gate.id,
            title: gate.title,
            blocking: gate.blocking ?? true,
            state: gate.state,
            evidence: [],
            ...(gate.satisfiedBy ? { satisfiedBy: gate.satisfiedBy } : {}),
          })),
    )
  )
    throw new RecordValidationError("task_terminal_transition_gate_blocked");
  return taskState({ ...task, status: resolved });
}

/**
 * Moves a task from the ladder's working status (`statuses[1]`) to the
 * configured paused status (QCLI-229). The only legal entry into
 * `pausedStatus`; the generic `--status` edit cannot reach it because
 * `transitionTask` walks `statuses` alone, which never includes it.
 */
export function pauseTask(
  task: TaskState,
  policy = defaultLifecyclePolicy,
): TaskState {
  const configured = lifecyclePolicy(policy);
  const paused = configured.pausedStatus;
  if (!paused) throw new RecordValidationError("paused_status_not_configured");
  const working = configured.statuses[1];
  if (!working || task.status !== working)
    throw new RecordValidationError(
      `Illegal task transition: ${task.status} -> ${paused}.`,
    );
  return taskState({ ...task, status: paused });
}

/**
 * Moves a task back to the ladder's working status (`statuses[1]`) from
 * either the paused status or the ladder's initial status (QCLI-229), or
 * from a retired paused literal the workspace does not configure
 * (QCLI-302) -- the one sanctioned exit for a record an older default
 * parked at `"Blocked"`.
 */
export function startTask(
  task: TaskState,
  policy = defaultLifecyclePolicy,
): TaskState {
  const configured = lifecyclePolicy(policy);
  const working = configured.statuses[1];
  if (!working)
    throw new RecordValidationError(
      "Lifecycle has no working status configured.",
    );
  const initial = configured.statuses[0];
  const paused = configured.pausedStatus;
  if (
    task.status !== initial &&
    (!paused || task.status !== paused) &&
    !isRetiredPausedStatus(task.status, configured)
  )
    throw new RecordValidationError(
      `Illegal task transition: ${task.status} -> ${working}.`,
    );
  return taskState({ ...task, status: working });
}

/**
 * Retires a task at the closed status with a required resolution
 * (QCLI-331). Legal from every NON-terminal status a task can hold -- any
 * non-terminal ladder status, the paused status, a retired paused literal
 * -- so a never-worked duplicate goes straight from To Do without the
 * In Progress step that would claim someone started it. Refused from a
 * terminal status (Done, or already closed): Done asserts the outcome
 * happened, and closing it would contradict that rather than retire it.
 *
 * Blocking gates do NOT block this. A gate gates completion EVIDENCE, and
 * closing asserts no completion, so there is nothing for a gate to hold.
 *
 * Callers own survivor existence (it needs the whole collection) and the
 * storage move; this validates the resolution's own shape and returns the
 * status-updated record.
 */
export function closeTask(
  task: TaskState,
  resolution: TaskResolution,
  policy = defaultLifecyclePolicy,
): TaskState {
  const configured = lifecyclePolicy(policy);
  const closed = configured.closedStatus;
  if (!closed) throw new RecordValidationError("closed_status_not_configured");
  if (allTerminalStatuses(configured).includes(task.status))
    throw new RecordValidationError(
      task.status === closed
        ? `Task ${task.id} is already "${closed}". To change its resolution, reopen it with \`quest task demote ${task.id} --to "${configured.statuses[0]}"\`, then close it again.`
        : `Task ${task.id} is "${task.status}", a terminal status that asserts its outcome happened; \`quest task close\` retires only a task that has not finished. If it should not have been completed, reopen it with \`quest task demote ${task.id} --to "<status>"\` first.`,
    );
  const onLadder =
    configured.statuses.includes(task.status) ||
    task.status === configured.pausedStatus ||
    isRetiredPausedStatus(task.status, configured);
  if (!onLadder)
    throw new RecordValidationError(
      "Task transition uses an unconfigured status.",
    );
  const problem = resolutionShapeProblem(task.id, resolution);
  if (problem)
    throw new RecordValidationError(`Cannot close ${task.id}: ${problem}.`);
  return taskState({
    ...task,
    status: closed,
    resolution: {
      kind: resolution.kind,
      ...(resolution.survivor === undefined
        ? {}
        : { survivor: resolution.survivor }),
    },
  });
}

/**
 * What is wrong with a record's resolution, relative to its status, or
 * undefined when nothing is (QCLI-331). `quest doctor` reports it; nothing
 * rewrites it. Survivor EXISTENCE is not checked here -- it needs the whole
 * collection -- so doctor checks that separately.
 */
export function resolutionProblem(
  task: TaskState,
  policy = defaultLifecyclePolicy,
): string | undefined {
  const closed = policy.closedStatus;
  const isClosed = closed !== undefined && task.status === closed;
  if (!isClosed)
    return task.resolution === undefined
      ? undefined
      : `carries a resolution while at "${task.status}", not the closed status`;
  if (task.resolution === undefined) return `is "${closed}" with no resolution`;
  const shape = resolutionShapeProblem(task.id, task.resolution);
  return shape === undefined ? undefined : `is "${closed}" but its ${shape}`;
}

/**
 * The non-terminal statuses `demoteTask` may legally target from a given
 * current status and storage location (QCLI-229). A task already stored at
 * `"tasks"` may only move strictly earlier on the ladder (walking back to a
 * status it has already left); a task returning from a retention location
 * (`"completed"` / `"archive/tasks"`) may also target its own current ladder
 * position, since simply un-terminating or un-archiving it is legitimate.
 * `pausedStatus` is deliberately excluded on both sides: `quest task start`
 * is its only legal exit, keeping demote's and start's responsibilities from
 * overlapping.
 */
export function legalDemoteTargets(
  status: TaskStatus,
  location: TaskLocation,
  policy = defaultLifecyclePolicy,
): readonly TaskStatus[] {
  const configured = lifecyclePolicy(policy);
  if (configured.pausedStatus && status === configured.pausedStatus) return [];
  // QCLI-331: a closed task was never done, so reopening it to ANY
  // non-terminal ladder status is legitimate, wherever it is stored.
  if (configured.closedStatus && status === configured.closedStatus)
    return configured.statuses.filter(
      (candidate) => !configured.terminalStatuses.includes(candidate),
    );
  const position = configured.statuses.indexOf(status);
  if (position < 0) return [];
  const ceiling = location === "tasks" ? position : position + 1;
  return configured.statuses
    .slice(0, ceiling)
    .filter((candidate) => !configured.terminalStatuses.includes(candidate));
}

/**
 * Validates and applies an explicit demote target (QCLI-229). Never resets
 * to a hardcoded "earliest" status and never treats "already in `tasks`" as
 * an error on its own -- only an illegal target is. Callers own the storage
 * location move; this returns the status-updated record.
 */
export function demoteTask(
  task: TaskState,
  location: TaskLocation,
  to: TaskStatus,
  policy = defaultLifecyclePolicy,
): TaskState {
  const resolved = resolveConfiguredStatus(to, policy);
  const legal = legalDemoteTargets(task.status, location, policy);
  if (!legal.includes(resolved))
    throw new RecordValidationError(
      legal.length
        ? `Illegal task demotion: ${task.status} -> ${resolved}. Legal targets from ${task.status}: ${legal.join(", ")}.`
        : `Illegal task demotion: ${task.status} has no earlier status to demote to.`,
    );
  // QCLI-331: reopening a closed task withdraws its resolution with it; a
  // resolution never survives off the closed status, and a demote from any
  // other status leaves the record's fields exactly as they were.
  if (task.status === policy.closedStatus) {
    const { resolution: _withdrawn, ...reopened } = task;
    return taskState({ ...reopened, status: resolved });
  }
  return taskState({ ...task, status: resolved });
}

export function activeBlockers(
  events: readonly BlockerEvent[],
): readonly BlockerEvent[] {
  const open = new Map<string, BlockerEvent>();
  for (const event of events) {
    if (event.kind === "opened") {
      if (!event.reason)
        throw new RecordValidationError("blocker_duplicate_open");
      if (open.has(event.blockId))
        throw new RecordValidationError("blocker_duplicate_open");
      open.set(event.blockId, event);
    } else {
      if (!open.has(event.blockId))
        throw new RecordValidationError("blocker_unknown_or_repeat_clear");
      if (!event.reason && !event.evidence?.length)
        throw new RecordValidationError("blocker_clear_requires_evidence");
      open.delete(event.blockId);
    }
  }
  return [...open.values()];
}

export type ClaimState = "unclaimed" | "live" | "reclaimable";
export function claimState(task: TaskState, now: Date): ClaimState {
  if (!task.claim) return "unclaimed";
  const expiry = Date.parse(task.claim.expiresAt);
  if (Number.isNaN(expiry)) throw new RecordValidationError("lease_invalid");
  return expiry > now.getTime() ? "live" : "reclaimable";
}

export interface ReadinessReason {
  readonly taskId: CanonicalId;
  readonly reason: string;
}
export interface ReadySet {
  readonly ready: readonly CanonicalId[];
  readonly excluded: readonly ReadinessReason[];
}

function resolver(tasks: readonly TaskState[]): Map<string, CanonicalId> {
  const resolved = new Map<string, CanonicalId>();
  for (const task of tasks) {
    for (const value of [task.id, ...task.aliases]) {
      const key = aliasKey(value);
      // Only a DIFFERENT task already claiming this key is ambiguous; a
      // task's own id legitimately reappearing among its own aliases (e.g.
      // a migrated task's bare source-id alias equaling its own newly
      // minted canonical id) is redundant, not a collision. This mirrors
      // createTaskLinkSession's indexIdentity below, which already gets
      // this right (QCLI-157).
      const claimedBy = resolved.get(key);
      if (claimedBy !== undefined && claimedBy !== task.id)
        throw new RecordValidationError("dependency_target_ambiguous");
      resolved.set(key, task.id);
    }
  }
  return resolved;
}

/** Validates all dependency and parent links as one authoritative workspace graph. */
export function validateTaskGraph(
  tasks: readonly TaskState[],
): Map<CanonicalId, readonly CanonicalId[]> {
  const byId = new Map<CanonicalId, TaskState>();
  for (const task of tasks) {
    taskState(task);
    activeBlockers(task.blockers);
    if (byId.has(task.id))
      throw new RecordValidationError("dependency_target_ambiguous");
    byId.set(task.id, task);
  }
  const aliases = resolver(tasks);
  const resolve = (raw: string): CanonicalId => {
    const id = aliases.get(aliasKey(raw));
    if (!id) throw new RecordValidationError("dependency_target_not_found");
    return id;
  };
  const links = new Map<CanonicalId, readonly CanonicalId[]>();
  for (const task of tasks) {
    const dependencies = task.dependencies.map(resolve);
    if (dependencies.some((id) => id === task.id))
      throw new RecordValidationError("dependency_self_edge");
    if (new Set(dependencies).size !== dependencies.length)
      throw new RecordValidationError("dependency_duplicate_edge");
    if (task.parentId) {
      const parent = resolve(task.parentId);
      if (parent === task.id)
        throw new RecordValidationError("parent_self_edge");
    }
    links.set(task.id, dependencies);
  }
  // A parent cycle is also invalid even though parenthood is not a readiness edge.
  const parentOf = new Map<CanonicalId, CanonicalId>();
  for (const task of tasks)
    if (task.parentId) parentOf.set(task.id, resolve(task.parentId));
  for (const task of tasks) {
    const seen = new Set<CanonicalId>();
    let current: CanonicalId | undefined = task.id;
    while (current && parentOf.has(current)) {
      if (seen.has(current)) throw new RecordValidationError("parent_cycle");
      seen.add(current);
      current = parentOf.get(current);
    }
  }
  const visited = new Set<CanonicalId>();
  const visiting = new Set<CanonicalId>();
  const walk = (id: CanonicalId): void => {
    if (visiting.has(id)) throw new RecordValidationError("dependency_cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of links.get(id) ?? []) walk(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...byId.keys()].sort()) walk(id);
  return links;
}

/** Canonicalizes aliases before an authored record is persisted. */
export function canonicalizeTaskLinks(
  tasks: readonly TaskState[],
): readonly TaskState[] {
  for (const task of tasks) taskState(task);
  const aliases = resolver(tasks);
  const resolve = (raw: string): CanonicalId => {
    const id = aliases.get(aliasKey(raw));
    if (!id) throw new RecordValidationError("dependency_target_not_found");
    return id;
  };
  const canonical = tasks.map((task) =>
    taskState({
      ...task,
      dependencies: task.dependencies.map(resolve),
      parentId: task.parentId ? resolve(task.parentId) : undefined,
    }),
  );
  validateTaskGraph(canonical);
  return canonical;
}

/**
 * QCLI-122 batch link validator. Inside one locked batch session rows are
 * immutable except through {@link TaskLinkSession.apply}, so a graph edge
 * violation introduced by a mutation must involve the mutated row: local
 * checks from that row are then sound, provided the initial collection was
 * fully validated (snapshot() does this at session entry). Structural maps
 * rebuild per apply without re-running zod across all rows, which keeps
 * authoritative semantics while making per-operation cost linear in the
 * changed record rather than the store.
 */
export function createTaskLinkSession(initial: readonly TaskState[]) {
  const byId = new Map<string, TaskState>();
  const aliases = new Map<string, CanonicalId>();
  const dependenciesMap = new Map<CanonicalId, readonly CanonicalId[]>();
  const parentOf = new Map<CanonicalId, CanonicalId>();
  const resolveFromAliases = (raw: string): CanonicalId => {
    const id = aliases.get(aliasKey(raw));
    if (!id) throw new RecordValidationError("dependency_target_not_found");
    return id;
  };
  // Phase one seeds identities only; phase two resolves every pre-existing
  // edge once the alias map is complete so nothing is silently dropped.
  const indexIdentity = (task: TaskState): void => {
    if (byId.has(task.id))
      throw new RecordValidationError("dependency_target_ambiguous");
    byId.set(task.id, task);
    for (const value of [task.id, ...task.aliases]) {
      const key = aliasKey(value);
      const existing = aliases.get(key);
      if (existing !== undefined && existing !== task.id)
        throw new RecordValidationError("dependency_target_ambiguous");
      aliases.set(key, task.id);
    }
  };
  for (const task of initial) indexIdentity(task);
  const indexEdges = (task: TaskState): void => {
    const resolvedDependencies = task.dependencies.map(resolveFromAliases);
    dependenciesMap.set(task.id, resolvedDependencies);
    if (task.parentId) parentOf.set(task.id, resolveFromAliases(task.parentId));
  };
  for (const task of initial) indexEdges(task);
  // The initial collection must arrive already validated (snapshot() does
  // this); re-run the authoritative structural walk so session state starts
  // from proven-good data.
  validateTaskGraph([...byId.values()]);

  const unindexRow = (task: TaskState): void => {
    byId.delete(task.id);
    for (const value of [task.id, ...task.aliases]) {
      const key = aliasKey(value);
      if (aliases.get(key) === task.id) aliases.delete(key);
    }
    dependenciesMap.delete(task.id);
    parentOf.delete(task.id);
  };

  /** Validates and indexes one replacement; returns its canonical spelling. */
  const apply = (next: TaskState): TaskState => {
    const previous = byId.get(next.id);
    if (!previous) throw new RecordValidationError("batch_link_target_absent");
    unindexRow(previous);
    try {
      indexIdentity(next);
      const canonicalDependencies = next.dependencies.map(resolveFromAliases);
      if (canonicalDependencies.some((id) => id === next.id))
        throw new RecordValidationError("dependency_self_edge");
      if (new Set(canonicalDependencies).size !== canonicalDependencies.length)
        throw new RecordValidationError("dependency_duplicate_edge");
      let parentResolved: CanonicalId | undefined;
      if (next.parentId) {
        parentResolved = resolveFromAliases(next.parentId);
        if (parentResolved === next.id)
          throw new RecordValidationError("parent_self_edge");
      }
      const canonicalRow: TaskState = {
        ...next,
        dependencies: canonicalDependencies,
        parentId: parentResolved,
      };
      dependenciesMap.set(next.id, canonicalDependencies);
      if (parentResolved) parentOf.set(next.id, parentResolved);
      else parentOf.delete(next.id);
      // A cycle introduced here must involve this row: walk outward from it.
      const seenParentChain = new Set<CanonicalId>();
      let parentCursor: CanonicalId | undefined = next.id;
      while (parentCursor && parentOf.has(parentCursor)) {
        if (seenParentChain.has(parentCursor))
          throw new RecordValidationError("parent_cycle");
        seenParentChain.add(parentCursor);
        parentCursor = parentOf.get(parentCursor);
      }
      // Soundness: the session starts from a proven-valid graph and exactly
      // one row changes per apply, so any NEW dependency cycle must pass
      // through this row's subgraph. A single rooted DFS therefore matches
      // the authoritative full walk while keeping per-operation cost local.
      const visiting = new Set<CanonicalId>();
      const walkDependencies = (id: CanonicalId): void => {
        if (visiting.has(id))
          throw new RecordValidationError("dependency_cycle");
        visiting.add(id);
        for (const dependency of dependenciesMap.get(id) ?? [])
          walkDependencies(dependency);
        visiting.delete(id);
      };
      walkDependencies(next.id);
      byId.set(next.id, canonicalRow);
      return canonicalRow;
    } catch (error) {
      unindexRow(next);
      try {
        indexIdentity(previous);
        indexEdges(previous);
      } catch {
        /* identity previously existed: restoration cannot fail */
      }
      throw error;
    }
  };
  return {
    apply,
    get size(): number {
      return byId.size;
    },
    snapshotRows(): readonly TaskState[] {
      return [...byId.values()];
    },
  };
}

/**
 * Pure forward/back reference closure between one task and one milestone.
 * Callers persist both returned records in the same commit path.
 */
export function closeMilestoneReference(
  task: TaskState,
  milestone: MilestoneTaskSide,
  link: boolean,
): { readonly task: TaskState; readonly milestone: MilestoneTaskSide } {
  taskState(task);
  if (!milestoneIdPattern.test(milestone.id))
    throw new RecordValidationError("milestone_id_invalid");
  const linked = milestone.taskIds.includes(task.id);
  if (link) {
    if (task.milestoneId !== undefined && task.milestoneId !== milestone.id)
      throw new RecordValidationError("milestone_reference_conflict");
    if (!linked && task.milestoneId === milestone.id)
      throw new RecordValidationError("milestone_reference_drift");
    if (linked && task.milestoneId === milestone.id) return { task, milestone };
    const nextTaskIds = linked
      ? [...milestone.taskIds]
      : [...milestone.taskIds, task.id];
    // Deterministic ordering: canonical id order, duplicates fail closed.
    nextTaskIds.sort(compareTaskIds);
    if (new Set(nextTaskIds).size !== nextTaskIds.length)
      throw new RecordValidationError("milestone_task_duplicate");
    return {
      task: taskState({ ...task, milestoneId: milestone.id }),
      milestone: { ...milestone, taskIds: nextTaskIds },
    };
  }
  if (task.milestoneId !== milestone.id || !linked)
    throw new RecordValidationError("milestone_reference_drift");
  return {
    task: taskState({ ...task, milestoneId: undefined }),
    milestone: {
      ...milestone,
      taskIds: milestone.taskIds.filter((id) => id !== task.id),
    },
  };
}

/** Fails loud when any milestone forward/back reference pair is open or dangling. */
export function validateMilestoneClosure(
  tasks: readonly TaskState[],
  milestones: readonly MilestoneTaskSide[],
): void {
  const seen = new Set(milestones.map((m) => m.id));
  if (
    seen.size !== milestones.length ||
    milestones.some((m) => !milestoneIdPattern.test(m.id))
  )
    throw new RecordValidationError("milestone_id_invalid");
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const task of tasks)
    if (task.milestoneId !== undefined && !seen.has(task.milestoneId))
      throw new RecordValidationError("milestone_reference_dangling");
  for (const m of milestones) {
    const seenTaskIds = new Set(m.taskIds);
    if (seenTaskIds.size !== m.taskIds.length)
      throw new RecordValidationError("milestone_task_duplicate");
    for (const taskId of m.taskIds) {
      const task = byId.get(taskId);
      if (!task || task.milestoneId !== m.id)
        throw new RecordValidationError("milestone_reference_dangling");
    }
  }
}

/**
 * A sort key that reads the number in a task, draft, milestone or decision id
 * as a number: `SM-2` sorts before `SM-10`, where a plain string comparison
 * puts `SM-10` first.
 */
export function taskIdSortKey(id: string): string {
  return id.replace(/\d+/g, (digits) => digits.padStart(20, "0"));
}

/** Ids that differ only in leading zeros (`T-7`, `T-007`) fall back to the raw text, so the order stays total. */
export function compareTaskIds(left: string, right: string): number {
  return (
    taskIdSortKey(left).localeCompare(taskIdSortKey(right)) ||
    left.localeCompare(right)
  );
}

/** Pure, deterministic ready-set evaluation; validates the whole graph before returning anything. */
export function evaluateReadySet(
  tasks: readonly TaskState[],
  now: Date,
  policy = defaultLifecyclePolicy,
): ReadySet {
  const configured = lifecyclePolicy(policy);
  const links = validateTaskGraph(tasks);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  // A dependency is satisfied by ANY terminal status, closed included: the
  // ADR has consumers read terminal membership, never a Done literal (QCLI-331).
  const finished = allTerminalStatuses(configured);
  const ready: CanonicalId[] = [];
  const excluded: ReadinessReason[] = [];
  for (const task of [...tasks].sort((a, b) => compareTaskIds(a.id, b.id))) {
    if (task.status !== configured.statuses[0]) {
      excluded.push({ taskId: task.id, reason: "lifecycle_ineligible" });
      continue;
    }
    if (
      (links.get(task.id) ?? []).some((id) => {
        const dependency = byId.get(id);
        return !dependency || !finished.includes(dependency.status);
      })
    ) {
      excluded.push({ taskId: task.id, reason: "dependency_incomplete" });
      continue;
    }
    if (activeBlockers(task.blockers).length) {
      excluded.push({ taskId: task.id, reason: "explicitly_blocked" });
      continue;
    }
    if (task.gates.some((gate) => gate.state === "pending")) {
      excluded.push({ taskId: task.id, reason: "pending_gate" });
      continue;
    }
    if (claimState(task, now) === "live") {
      excluded.push({ taskId: task.id, reason: "live_claim" });
      continue;
    }
    ready.push(task.id);
  }
  return { ready, excluded };
}

export function searchTasks(
  tasks: readonly TaskState[],
  query: string,
): readonly TaskState[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...tasks].sort((a, b) => compareTaskIds(a.id, b.id));
  return tasks
    .filter((task) =>
      [
        task.id,
        task.title,
        task.summary ?? "",
        task.description ?? "",
        ...task.aliases,
        ...task.labels,
      ]
        .join("\n")
        .toLocaleLowerCase()
        .includes(needle),
    )
    .sort((a, b) => compareTaskIds(a.id, b.id));
}

export function findTask(
  tasks: readonly TaskState[],
  reference: string,
): TaskState {
  const matches = tasks.filter((task) =>
    [task.id, ...task.aliases].some(
      (value) => aliasKey(value) === aliasKey(reference),
    ),
  );
  if (matches.length === 0) throw new RecordValidationError("task_not_found");
  if (matches.length > 1)
    throw new RecordConflictError("task_reference_ambiguous");
  const match = matches[0];
  if (!match) throw new RecordValidationError("task_not_found");
  return match;
}
