import {
  type Decision,
  decision,
  type Milestone,
  milestone,
} from "../../domain/planning/planning.ts";
import {
  aliasKey,
  RecordConflictError,
  RecordValidationError,
} from "../../domain/records.ts";
import type { PlanningRepository } from "../../ports/planning.ts";
import {
  compareTaskIds,
  defaultLifecyclePolicy,
  isOffFlowStatus,
  isRetiredPausedStatus,
  type LifecyclePolicy,
  resolutionProblem,
  TASK_LOCATIONS,
  type TaskResolution,
  type TaskState,
} from "../../domain/tasks/tasks.ts";
import {
  type TaskVocabulary,
  vocabularyDrift,
} from "../../domain/tasks/vocabulary.ts";
import type { TaskReader } from "../tasks/tasks.ts";

export type {
  PlanningRepository,
  PlanningSnapshot,
} from "../../ports/planning.ts";

export type PlanningMutationResult = Awaited<
  ReturnType<PlanningRepository["write"]>
>;

async function persistedPlanningRecord<T>(
  record: T,
  write: Promise<PlanningMutationResult>,
): Promise<{
  readonly record: T;
  readonly result: Extract<
    PlanningMutationResult,
    { readonly kind: "success" }
  >;
}> {
  const result = await write;
  if (result.kind === "conflict")
    throw new RecordConflictError("planning_snapshot_conflict");
  return { record, result };
}

export interface ProjectOverview {
  readonly tasks: {
    /**
     * Every task record the reader can see, across all retention locations --
     * NOT just `.quest/tasks/`. QCLI-339: counting the active directory alone
     * meant `task complete` REMOVED a record from the counts (total fell by
     * one, the terminal bucket never grew), so a successful write looked like
     * a failed one. See `byLocation` for the narrower populations.
     */
    readonly total: number;
    /** Also across all retention locations, for the same reason as `total`. */
    readonly byStatus: Readonly<Record<string, number>>;
    /**
     * How `total` divides across storage locations, so the active and
     * retained populations are visibly two rather than one unlabelled
     * number. Every known location is present, including zeroes.
     *
     * Omitted ONLY by a reader that cannot report locations (a
     * `TaskReadSnapshot` without `taskRecords`). Its absence therefore means
     * "this reader could not say", never "there are none" -- which is why
     * the zeroes above are spelled out rather than left implicit.
     */
    readonly byLocation?: Readonly<Record<string, number>>;
  };
  readonly milestones: {
    readonly open: number;
    readonly closed: number;
    /**
     * Retired milestones, counted as neither `open` nor `closed` (QCLI-140).
     * Reported so the exclusion is visible in the output rather than only in
     * the implementation: without it `open + closed` silently summed to less
     * than the milestones on record. QCLI-340, the milestone half of
     * QCLI-339's ruling.
     */
    readonly archived: number;
  };
  readonly decisions: Readonly<Record<string, number>>;
}

export interface PlanningBoard {
  readonly columns: readonly {
    readonly status: string;
    readonly taskIds: readonly string[];
  }[];
  readonly milestones: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly taskIds: readonly string[];
  }[];
}

export interface PlanningDoctorReport {
  readonly healthy: boolean;
  readonly issues: readonly (
    | {
        readonly code: "milestone_task_not_found";
        readonly milestoneId: string;
        readonly taskId: string;
      }
    | {
        /**
         * An active task whose status is on neither the configured ladder
         * nor the paused slot, so no transition command can move it
         * (QCLI-302). `hint` names the repair when one exists.
         */
        readonly code: "task_status_off_flow";
        readonly taskId: string;
        readonly status: string;
        readonly hint: string;
      }
    | {
        /**
         * QCLI-331: a resolution that breaks its own rules -- a closed
         * record with none or a malformed one, or a resolution on a record
         * that is not closed. Reported, never rewritten: the record was
         * hand-edited, and only its author knows which half is right.
         */
        readonly code: "task_resolution_invalid";
        readonly taskId: string;
        readonly status: string;
        /** Absent when the record at the closed status carries none. */
        readonly resolution?: TaskResolution;
        readonly hint: string;
      }
    | {
        /** QCLI-331: a well-formed resolution whose survivor names no task. */
        readonly code: "task_resolution_survivor_not_found";
        readonly taskId: string;
        readonly status: string;
        readonly survivor: string;
        readonly hint: string;
      }
    | {
        /**
         * QCLI-330: the workspace declares a [tasks] table that cannot be
         * read. Reported so doctor can name the problem without failing
         * itself -- reads carry on, writes refuse (reviewer finding 2).
         */
        readonly code: "task_vocabulary_invalid";
        readonly hint: string;
      }
    | {
        /**
         * QCLI-330: a stored `type` or `priority` outside the workspace's
         * configured set. Reported, never rewritten: the ADR keeps history
         * as written. `normalizesTo` is present when only case differs, so
         * a caller can tell a spelling from a genuinely foreign value.
         */
        readonly code: "task_vocabulary_off_set";
        readonly taskId: string;
        readonly field: "type" | "priority";
        readonly value: string;
        readonly normalizesTo?: string;
        readonly hint: string;
      }
  )[];
}

export interface PlanningCleanupPlan {
  readonly milestoneIds: readonly string[];
  readonly decisionIds: readonly string[];
  readonly dryRun: boolean;
}

function byIdentifier<T extends { readonly id: string }>(
  left: T,
  right: T,
): number {
  const [leftPrefix, leftNumber] = left.id.split("-");
  const [rightPrefix, rightNumber] = right.id.split("-");
  return (
    leftPrefix.localeCompare(rightPrefix) ||
    Number(leftNumber).valueOf() - Number(rightNumber).valueOf()
  );
}

function sortedCounts(
  values: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * QCLI-330's doctor half. Every location is checked, like
 * resolutionIssues: the question is whether a stored value is in the set, and
 * a completed record's value is as stored as an active one's. An open field
 * (absent from the vocabulary) reports nothing, which is what keeps an
 * unconfigured workspace's doctor exactly as it was.
 */
function vocabularyIssues(
  tasks: readonly TaskState[],
  vocabulary: TaskVocabulary,
): PlanningDoctorReport["issues"] {
  const issues: PlanningDoctorReport["issues"][number][] = [];
  for (const task of [...tasks].sort((a, b) => compareTaskIds(a.id, b.id)))
    for (const drift of vocabularyDrift(task, vocabulary)) {
      const allowed =
        (drift.field === "type" ? vocabulary.types : vocabulary.priorities) ??
        [];
      issues.push({
        code: "task_vocabulary_off_set",
        taskId: task.id,
        field: drift.field,
        value: drift.value,
        ...(drift.normalizesTo === undefined
          ? {}
          : { normalizesTo: drift.normalizesTo }),
        hint:
          `${task.id} has ${drift.field} ${JSON.stringify(drift.value)}, outside the configured set (${allowed.join(", ")}). ` +
          (drift.normalizesTo === undefined
            ? `Nothing rewrites it. \`quest task edit ${task.id} --${drift.field} <value>\` sets an allowed one, or add the value to [tasks] in .quest/workspace.toml.`
            : `Only case differs; \`quest task edit ${task.id} --${drift.field} ${drift.normalizesTo}\` stores the configured spelling. Nothing rewrites it for you.`),
      });
    }
  return issues;
}

/**
 * QCLI-331's doctor half. Every location is checked, unlike
 * `task_status_off_flow`: a closed record lives in completed/ by design, so
 * an active-only scan would miss exactly the records this is about. Shape
 * comes from the domain's `resolutionProblem`, the same predicate
 * `task close` refuses with, so doctor and close cannot disagree on what a
 * valid resolution is. A survivor is only looked up when the shape is
 * otherwise valid, so one bad record is one issue, not two.
 */
function resolutionIssues(
  tasks: readonly TaskState[],
  lifecycle: LifecyclePolicy,
): PlanningDoctorReport["issues"] {
  const known = new Set(
    tasks.flatMap((task) => [task.id, ...task.aliases].map(aliasKey)),
  );
  const issues: PlanningDoctorReport["issues"][number][] = [];
  for (const task of [...tasks].sort((a, b) => compareTaskIds(a.id, b.id))) {
    const problem = resolutionProblem(task, lifecycle);
    if (problem !== undefined) {
      issues.push({
        code: "task_resolution_invalid",
        taskId: task.id,
        status: task.status,
        ...(task.resolution === undefined
          ? {}
          : { resolution: task.resolution }),
        hint:
          `${task.id} ${problem}. ` +
          (task.status === lifecycle.closedStatus
            ? `Reopen it with \`quest task demote ${task.id} --to "${lifecycle.statuses[0]}"\`, then close it again with \`quest task close ${task.id} --resolution <duplicate|superseded|wont-do>\`.`
            : "Only `quest task close` writes a resolution; the field was edited by hand, and doctor does not guess which half is right."),
      });
      continue;
    }
    const survivor = task.resolution?.survivor;
    if (survivor !== undefined && !known.has(aliasKey(survivor)))
      issues.push({
        code: "task_resolution_survivor_not_found",
        taskId: task.id,
        status: task.status,
        survivor,
        hint: `${task.id}'s survivor ${survivor} names no task in any location. Reopen it with \`quest task demote ${task.id} --to "${lifecycle.statuses[0]}"\` and close it again naming a survivor that exists.`,
      });
  }
  return issues;
}

/** Typed planning records. CLI wiring deliberately remains at the composition root. */
export class PlanningService {
  constructor(private readonly repository: PlanningRepository) {}

  async listMilestones(includeArchived = false): Promise<readonly Milestone[]> {
    return [...(await this.repository.read()).milestones]
      .filter((item) => includeArchived || item.archived !== true)
      .sort(byIdentifier);
  }
  async listDecisions(): Promise<readonly Decision[]> {
    return [...(await this.repository.read()).decisions].sort(byIdentifier);
  }
  async viewMilestone(id: string): Promise<Milestone> {
    const record = (await this.repository.read()).milestones.find(
      (item) => item.id === id,
    );
    if (!record) throw new RecordValidationError("milestone_not_found");
    return record;
  }
  async viewDecision(id: string): Promise<Decision> {
    const record = (await this.repository.read()).decisions.find(
      (item) => item.id === id,
    );
    if (!record) throw new RecordValidationError("decision_not_found");
    return record;
  }
  async createMilestone(value: Milestone, operationId: string) {
    const snapshot = await this.repository.read();
    const record = milestone(value);
    if (snapshot.milestones.some((item) => item.id === record.id))
      throw new RecordValidationError("milestone_already_exists");
    return persistedPlanningRecord(
      record,
      this.repository.write({
        expectedRevision: snapshot.revision,
        milestones: [...snapshot.milestones, record],
        decisions: snapshot.decisions,
        operationId,
      }),
    );
  }
  async createDecision(value: Decision, operationId: string) {
    const snapshot = await this.repository.read();
    const record = decision(value);
    if (snapshot.decisions.some((item) => item.id === record.id))
      throw new RecordValidationError("decision_already_exists");
    return persistedPlanningRecord(
      record,
      this.repository.write({
        expectedRevision: snapshot.revision,
        milestones: snapshot.milestones,
        decisions: [...snapshot.decisions, record],
        operationId,
      }),
    );
  }
  async updateMilestone(value: Milestone, operationId: string) {
    const snapshot = await this.repository.read();
    const record = milestone(value);
    if (!snapshot.milestones.some((item) => item.id === record.id))
      throw new RecordValidationError("milestone_not_found");
    return persistedPlanningRecord(
      record,
      this.repository.write({
        expectedRevision: snapshot.revision,
        milestones: snapshot.milestones.map((item) =>
          item.id === record.id ? record : item,
        ),
        decisions: snapshot.decisions,
        operationId,
      }),
    );
  }
  async updateDecision(value: Decision, operationId: string) {
    const snapshot = await this.repository.read();
    const record = decision(value);
    if (!snapshot.decisions.some((item) => item.id === record.id))
      throw new RecordValidationError("decision_not_found");
    return persistedPlanningRecord(
      record,
      this.repository.write({
        expectedRevision: snapshot.revision,
        milestones: snapshot.milestones,
        decisions: snapshot.decisions.map((item) =>
          item.id === record.id ? record : item,
        ),
        operationId,
      }),
    );
  }
  /**
   * Retires a milestone without destroying it. Unlike {@link deleteMilestone}
   * this deliberately accepts a milestone that still carries task references:
   * preserving them is the reason to archive rather than delete.
   */
  async archiveMilestone(id: string, operationId: string) {
    const snapshot = await this.repository.read();
    const existing = snapshot.milestones.find((item) => item.id === id);
    if (!existing) throw new RecordValidationError("milestone_not_found");
    if (existing.archived === true)
      throw new RecordValidationError(
        "milestone_lifecycle_already_at_destination",
      );
    const record = milestone({ ...existing, archived: true });
    return persistedPlanningRecord(
      record,
      this.repository.write({
        expectedRevision: snapshot.revision,
        milestones: snapshot.milestones.map((item) =>
          item.id === record.id ? record : item,
        ),
        decisions: snapshot.decisions,
        operationId,
      }),
    );
  }
  async deleteMilestone(id: string, operationId: string) {
    const snapshot = await this.repository.read();
    const existing = snapshot.milestones.find((item) => item.id === id);
    if (!existing) throw new RecordValidationError("milestone_not_found");
    if (existing.taskIds.length > 0)
      throw new RecordValidationError("milestone_has_task_references");
    return persistedPlanningRecord(
      existing,
      this.repository.write({
        expectedRevision: snapshot.revision,
        milestones: snapshot.milestones.filter((item) => item.id !== id),
        decisions: snapshot.decisions,
        operationId,
      }),
    );
  }
  async deleteDecision(id: string, operationId: string) {
    const snapshot = await this.repository.read();
    const existing = snapshot.decisions.find((item) => item.id === id);
    if (!existing) throw new RecordValidationError("decision_not_found");
    return persistedPlanningRecord(
      existing,
      this.repository.write({
        expectedRevision: snapshot.revision,
        milestones: snapshot.milestones,
        decisions: snapshot.decisions.filter((item) => item.id !== id),
        operationId,
      }),
    );
  }
  async overview(tasks: TaskReader): Promise<ProjectOverview> {
    const [planning, taskSnapshot] = await Promise.all([
      this.repository.read(),
      tasks.readAll(),
    ]);
    // QCLI-339: count every located record, not `tasks`, which
    // `LocalTaskRepository.readAll` narrows to `location === "tasks"`. The
    // snapshot already carries all three locations, so this costs no extra
    // read. A reader that omits `taskRecords` falls back to the narrow array
    // and reports no `byLocation`, rather than claiming a location it does
    // not know.
    const located = taskSnapshot.taskRecords;
    const countedTasks =
      located?.map((record) => record.task) ?? taskSnapshot.tasks;
    const byStatus: Record<string, number> = {};
    for (const task of countedTasks)
      byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
    let byLocation: Record<string, number> | undefined;
    if (located) {
      byLocation = Object.fromEntries(
        TASK_LOCATIONS.map((location) => [location, 0]),
      );
      for (const record of located)
        byLocation[record.location] = (byLocation[record.location] ?? 0) + 1;
    }
    const decisions: Record<string, number> = {};
    for (const item of planning.decisions)
      decisions[item.status] = (decisions[item.status] ?? 0) + 1;
    return {
      tasks: {
        total: countedTasks.length,
        byStatus: sortedCounts(byStatus),
        // Deliberately NOT sortedCounts: this is a fixed vocabulary, so the
        // JSON keeps the canonical lifecycle order (active, then the
        // retention locations in the order a record reaches them). That is a
        // JSON-ONLY property -- `renderHumanPayload` alphabetises every map,
        // so `--plain` prints archive/tasks first regardless. Said here
        // because the alternative is a comment the renderer quietly
        // contradicts.
        ...(byLocation === undefined ? {} : { byLocation }),
      },
      milestones: {
        // Archived milestones are retired, so they count as neither -- that
        // is QCLI-140's decision and QCLI-340 does NOT reopen it. What
        // QCLI-340 fixes is that the exclusion used to live only in this
        // comment: `open` and `closed` silently summed to less than the
        // milestones on record, with nothing in the OUTPUT saying so. The
        // `archived` count below makes the excluded population visible
        // without folding it back into open or closed work.
        open: planning.milestones.filter(
          (item) => item.archived !== true && item.status === "open",
        ).length,
        closed: planning.milestones.filter(
          (item) => item.archived !== true && item.status === "closed",
        ).length,
        archived: planning.milestones.filter((item) => item.archived === true)
          .length,
      },
      // Decisions are NOT affected by the same narrowing, audited rather than
      // assumed (QCLI-340): a Decision record has no `archived` field at all,
      // and `superseded` is one of its three reported statuses rather than a
      // hidden exclusion, so this count already covers every decision on
      // record.
      decisions: sortedCounts(decisions),
    };
  }
  async search(query: string): Promise<{
    readonly milestones: readonly Milestone[];
    readonly decisions: readonly Decision[];
  }> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) throw new RecordValidationError("search_query_required");
    const snapshot = await this.repository.read();
    const matches = (value: string | undefined) =>
      value?.toLocaleLowerCase().includes(needle) ?? false;
    return {
      milestones: snapshot.milestones
        .filter(
          (item) =>
            matches(item.id) ||
            matches(item.title) ||
            matches(item.description),
        )
        .sort(byIdentifier),
      decisions: snapshot.decisions
        .filter(
          (item) =>
            matches(item.id) ||
            matches(item.title) ||
            matches(item.context) ||
            matches(item.outcome),
        )
        .sort(byIdentifier),
    };
  }
  async board(tasks: TaskReader): Promise<PlanningBoard> {
    const [planning, taskSnapshot] = await Promise.all([
      this.repository.read(),
      tasks.readAll(),
    ]);
    const grouped = new Map<string, string[]>();
    for (const task of taskSnapshot.tasks) {
      const entries = grouped.get(task.status) ?? [];
      entries.push(task.id);
      grouped.set(task.status, entries);
    }
    return {
      columns: [...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([status, taskIds]) => ({
          status,
          taskIds: taskIds.sort(compareTaskIds),
        })),
      milestones: [...planning.milestones].sort(byIdentifier).map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        taskIds: [...item.taskIds].sort(compareTaskIds),
      })),
    };
  }
  /**
   * The board as a standalone Markdown artifact (QCLI-143).
   *
   * `board --json` serves machines and `quest browser` serves a live view;
   * what neither gives you is something to paste into a pull request. Titles
   * are joined here because {@link board} returns bare ids, and a column of
   * ids is not a board anyone can read.
   *
   * Statuses are emitted in the configured lifecycle order rather than
   * alphabetically, because a board reads To Do, In Progress, Done.
   */
  async boardMarkdown(
    tasks: TaskReader,
    statuses: readonly string[],
  ): Promise<string> {
    const [rendered, snapshot] = await Promise.all([
      this.board(tasks),
      tasks.readAll(),
    ]);
    const titles = new Map(
      snapshot.tasks.map((task) => [String(task.id), task.title]),
    );
    // Every configured status gets a column, including empty ones: a board
    // with a column missing reads as though that state does not exist.
    const byStatus = new Map(
      rendered.columns.map((column) => [column.status, column.taskIds]),
    );
    const extra = rendered.columns
      .map((column) => column.status)
      .filter((status) => !statuses.includes(status))
      .sort((left, right) => left.localeCompare(right));
    const columns = [...statuses, ...extra].map((status) => ({
      status,
      taskIds: byStatus.get(status) ?? [],
    }));
    const lines = ["# Board", ""];
    for (const column of columns) {
      lines.push(`## ${column.status} (${column.taskIds.length})`, "");
      if (column.taskIds.length === 0) lines.push("_No tasks._", "");
      for (const id of column.taskIds)
        lines.push(`- **${id}** ${titles.get(id) ?? ""}`.trimEnd());
      if (column.taskIds.length > 0) lines.push("");
    }
    if (rendered.milestones.length > 0) {
      lines.push("## Milestones", "");
      for (const milestone of rendered.milestones)
        lines.push(
          `- **${milestone.id}** ${milestone.title} — ${milestone.status}` +
            (milestone.taskIds.length > 0
              ? ` (${milestone.taskIds.join(", ")})`
              : ""),
        );
      lines.push("");
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }
  /**
   * QCLI-249: this deliberately checks only milestone-task references, not
   * the task dependency/parent graph -- it never calls validateTaskGraph, so
   * a broken parent or dependency edge (e.g. one pointing at an archived
   * task) can leave `doctor` reporting healthy while `task list --ready`
   * throws on the exact same workspace. `--ready`/evaluateReadySet is the
   * actual graph-closure validator; `doctor` and `--ready` are not
   * reconciled here, since making `doctor` also validate the graph is new
   * surface, not this bug's fix. See QCLI-249's notes for the reasoning.
   */
  async doctor(
    tasks: TaskReader,
    lifecycle: LifecyclePolicy = defaultLifecyclePolicy,
    vocabulary: TaskVocabulary = {},
    vocabularyProblem?: string,
  ): Promise<PlanningDoctorReport> {
    const [planning, taskSnapshot] = await Promise.all([
      this.repository.read(),
      tasks.readAll(),
    ]);
    const records = taskSnapshot.taskRecords ?? taskSnapshot.tasks;
    const known = new Set(
      records.map((record) => ("task" in record ? record.task.id : record.id)),
    );
    const milestoneIssues = planning.milestones
      .flatMap((item) =>
        item.taskIds
          .filter((taskId) => !known.has(taskId))
          .map((taskId) => ({
            code: "milestone_task_not_found" as const,
            milestoneId: item.id,
            taskId,
          })),
      )
      .sort(
        (left, right) =>
          compareTaskIds(left.milestoneId, right.milestoneId) ||
          compareTaskIds(left.taskId, right.taskId),
      );
    // QCLI-302: only ACTIVE records are checked, because the repair the hint
    // names (`task start`) reaches active records alone. A retained record
    // at an off-flow status is retired, not stranded.
    const offFlowIssues = records
      .flatMap((record) =>
        "task" in record
          ? record.location === "tasks"
            ? [record.task]
            : []
          : [record],
      )
      .filter((task) => isOffFlowStatus(task.status, lifecycle))
      .map((task) => ({
        code: "task_status_off_flow" as const,
        taskId: task.id,
        status: task.status,
        hint: isRetiredPausedStatus(task.status, lifecycle)
          ? `"${task.status}" is the paused status of an earlier release; ` +
            `\`quest task start ${task.id} --actor <name> --actor-kind human\` ` +
            `resumes it` +
            (lifecycle.pausedStatus
              ? `, and \`quest task pause ${task.id}\` then parks it at "${lifecycle.pausedStatus}".`
              : ".")
          : `"${task.status}" is on neither the configured status ladder ` +
            `(${lifecycle.statuses.join(", ")})` +
            (lifecycle.pausedStatus
              ? ` nor the paused status ("${lifecycle.pausedStatus}")`
              : "") +
            `; no transition command can leave it.`,
      }))
      .sort((left, right) => compareTaskIds(left.taskId, right.taskId));
    const issues = [
      ...milestoneIssues,
      ...offFlowIssues,
      ...resolutionIssues(
        records.map((record) => ("task" in record ? record.task : record)),
        lifecycle,
      ),
      ...vocabularyIssues(
        records.map((record) => ("task" in record ? record.task : record)),
        vocabulary,
      ),
      ...(vocabularyProblem === undefined
        ? []
        : [
            {
              code: "task_vocabulary_invalid" as const,
              hint: vocabularyProblem,
            },
          ]),
    ];
    return { healthy: issues.length === 0, issues };
  }
  /**
   * Cleanup has an intentionally narrow, explicit target: closed milestones
   * and superseded decisions. It defaults to a non-mutating preview.
   */
  async cleanup(
    request: { readonly dryRun?: boolean; readonly confirmed?: boolean },
    operationId: string,
  ): Promise<PlanningCleanupPlan | PlanningMutationResult> {
    const snapshot = await this.repository.read();
    // Archiving exists to preserve the record, so cleanup is not its reaper:
    // an archived milestone is retired deliberately and stays retrievable.
    const milestoneIds = snapshot.milestones
      .filter(
        (item) =>
          item.archived !== true &&
          item.status === "closed" &&
          item.taskIds.length === 0,
      )
      .map((item) => item.id)
      .sort(compareTaskIds);
    const decisionIds = snapshot.decisions
      .filter((item) => item.status === "superseded")
      .map((item) => item.id)
      .sort(compareTaskIds);
    const plan: PlanningCleanupPlan = {
      milestoneIds,
      decisionIds,
      dryRun: request.dryRun ?? true,
    };
    if (plan.dryRun) return plan;
    if (!request.confirmed)
      throw new RecordValidationError("cleanup_confirmation_required");
    return this.repository.write({
      expectedRevision: snapshot.revision,
      milestones: snapshot.milestones.filter(
        (item) => !milestoneIds.includes(item.id),
      ),
      decisions: snapshot.decisions.filter(
        (item) => !decisionIds.includes(item.id),
      ),
      operationId,
    });
  }
}
