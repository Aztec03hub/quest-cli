import {
  foldEditPatch,
  type EditPatchVocabulary as TrackerEditPatch,
} from "../../../application/tasks/edit-patch.ts";
import {
  type TaskListQuery,
  type TaskService,
  type TaskWriteConflict,
  taskResolutionKinds,
} from "../../../application/tasks/tasks.ts";

type TrackerTask = Awaited<ReturnType<TaskService["view"]>>;
/** view/list carry the record's current path (QCLI-220); other kinds don't. */
type TrackerTaskWithPath = Awaited<ReturnType<TaskService["viewWithPath"]>>;
type TrackerTaskInput = Parameters<TaskService["create"]>[1];

/**
 * Derived from {@link TrackerTask} rather than imported from
 * `domain/tasks/tasks.ts` directly: `cli` may only depend on `application`
 * (scripts/check-layers.mjs), and `TaskState`'s own checklist shape already
 * flows through {@link TaskService}'s return types.
 */
type TaskCheckList = TrackerTask["acceptanceCriteria"];
type TaskCheckItem = Exclude<TaskCheckList[number], string>;

/**
 * QCLI-269: `--check-ac`/`--uncheck-ac`/`--remove-ac` (and the `--*-dod`
 * equivalents) address a checklist item by 1-based position, but every
 * checklist a caller could read back only ever carried the domain's own
 * 0-based `index` -- there was no surface printing the number those flags
 * actually take. A caller who read `index` and passed it straight to
 * `--check-ac` addressed the item before the one they meant, silently, for
 * every in-range value except the first.
 *
 * `position` is additive and presentation-only: it is computed here, at the
 * boundary that builds every read/write envelope, and never touches the
 * persisted domain shape (`TaskCheckItem` in domain/tasks/tasks.ts stays
 * `{index, text, checked}`). A caller can now read `position` off any
 * checklist item and pass it back to `--check-ac`/etc. verbatim -- no
 * index-plus-one arithmetic, and no separate numbered list to consult.
 */
export interface TaskCheckItemView extends TaskCheckItem {
  readonly position: number;
}

/** Adds `position` to every entry; legacy bare strings are 0-based by array order (matches normalizeCheckList). */
function withPositions(list: TaskCheckList): readonly TaskCheckItemView[] {
  return list.map((entry, arrayIndex) => {
    const item: TaskCheckItem =
      typeof entry === "string"
        ? { index: arrayIndex, text: entry, checked: false }
        : entry;
    return { ...item, position: item.index + 1 };
  });
}

interface Checklisted {
  readonly acceptanceCriteria: TaskCheckList;
  readonly definitionOfDone: TaskCheckList;
}

/** `T` with both checklists' entries carrying {@link TaskCheckItemView}'s `position`. */
export type WithCheckPositions<T extends Checklisted> = Omit<
  T,
  "acceptanceCriteria" | "definitionOfDone"
> & {
  readonly acceptanceCriteria: readonly TaskCheckItemView[];
  readonly definitionOfDone: readonly TaskCheckItemView[];
};

/**
 * Applies {@link withPositions} to both checklists of any task-shaped record.
 * Exported so `src/cli/main.ts`'s five direct lifecycle commands
 * (complete/archive/pause/start/demote) -- which build their envelopes
 * without going through {@link dispatchTrackerTaskCommand} -- can carry the
 * same `position` field instead of silently omitting it (QCLI-252's
 * cross-reference).
 */
export function withCheckPositions<T extends Checklisted>(
  task: T,
): WithCheckPositions<T> {
  return {
    ...task,
    acceptanceCriteria: withPositions(task.acceptanceCriteria),
    definitionOfDone: withPositions(task.definitionOfDone),
  };
}

export interface TaskCommandActor {
  readonly id: string;
  readonly kind: "human" | "delegated-agent";
  readonly accountableHumanId?: string;
}

export type TaskCommandRequest =
  | { readonly command: "status-flow" }
  | ({ readonly command: "list" } & TaskListQuery)
  | {
      readonly command: "view";
      readonly reference: string;
      /**
       * QCLI-276 / DEC-3: caps `implementationNotes` to the most recent N
       * entries (the array's tail -- notes append chronologically, see
       * `mergeList` in `application/tasks/edit-patch.ts`). Opt-in and
       * additive: absent means the full, unbounded record, byte-for-byte
       * unchanged from before this flag existed. QCLI-312: N may be 0, which
       * returns an empty `implementationNotes` and `notesOmitted` equal to the
       * whole note count.
       */
      readonly maxNotes?: number;
    }
  | { readonly command: "search"; readonly query: string }
  | {
      readonly command: "create";
      readonly id: string;
      readonly input: TrackerTaskInput;
      readonly operationId: string;
      readonly actor: TaskCommandActor;
    }
  | {
      readonly command: "edit";
      readonly reference: string;
      readonly patch: TrackerEditPatch;
      readonly operationId: string;
      readonly actor: TaskCommandActor;
      /** QCLI-277: see {@link TaskEditOptions.ifRevision}. */
      readonly ifRevision?: string;
    }
  | {
      readonly command: "edit-batch";
      readonly actor: TaskCommandActor;
      readonly items: readonly {
        readonly reference: string;
        readonly operationId?: string;
        readonly patch?: Partial<TrackerEditPatch>;
        /** QCLI-277: per-item precondition; see `TaskService.editBatch`'s `ifRevision`. */
        readonly ifRevision?: string;
      }[];
    };

/** Mirrors the public tracker contract's edit vocabulary (QCLI-97.11.6). */

export type TaskCommandResponse =
  | {
      readonly schemaVersion: 1;
      readonly kind: "task.status-flow";
      readonly data: {
        readonly statuses: readonly string[];
        readonly terminalStatuses: readonly string[];
        /** QCLI-229: absent when the workspace has pause/start disabled. */
        readonly pausedStatus?: string;
        /**
         * QCLI-325: false while `pausedStatus` is a BUILT-IN literal no
         * user-reachable knob sets (opum-doc relay 570, DEC-172 (4af)); emitted
         * beside `pausedStatus` so a consumer can read the situation from the
         * output alone.
         */
        readonly pausedStatusConfigurable?: boolean;
        /**
         * QCLI-331: the terminal status `task close` reaches. NOT listed in
         * `terminalStatuses` yet (see the status-flow case below), so a
         * consumer needs both to know every terminal status. Absent, with
         * `resolutions`, when the workspace has close disabled.
         */
        readonly closedStatus?: string;
        readonly resolutions?: readonly string[];
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "task.list";
      readonly data: readonly WithCheckPositions<TrackerTaskWithPath>[];
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "task.view";
      // QCLI-277: `revision` is additive so a caller can capture it here and
      // later supply it back as `task edit --if-revision`'s precondition.
      readonly data: WithCheckPositions<TrackerTaskWithPath> & {
        readonly revision: string;
        /**
         * QCLI-276 / DEC-3: `notesOmitted` is additive and conditional --
         * present (even at 0) whenever `--max-notes` was supplied, absent
         * entirely otherwise. It is never emitted alongside the unbounded
         * default read, so it cannot be a required field on the base type.
         */
        readonly notesOmitted?: number;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "task.created" | "task.updated";
      readonly data: WithCheckPositions<TrackerTask>;
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "task.search";
      readonly data: readonly WithCheckPositions<TrackerTask>[];
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: "task.batch-updated";
      readonly data: {
        readonly items: readonly (
          | {
              readonly kind: "updated";
              readonly reference: string;
              readonly operationId: string;
              readonly task: WithCheckPositions<TrackerTask>;
            }
          | {
              readonly kind: "error";
              readonly reference: string;
              readonly operationId: string;
              readonly message: string;
            }
        )[];
        readonly applied: number;
        readonly failed: number;
        readonly revision: string;
      };
    };

function requireWriteActor(actor: TaskCommandActor): void {
  if (
    !actor.id ||
    (actor.kind !== "human" && actor.kind !== "delegated-agent")
  ) {
    throw new Error("tracker_write_actor_required");
  }
  if (actor.kind === "delegated-agent" && !actor.accountableHumanId) {
    throw new Error("tracker_delegated_actor_requires_accountable_human");
  }
}

/**
 * QCLI-277: carries the losing write's `actualRevision` (when the result
 * was shaped like a {@link TaskWriteConflict}) from `recordFromMutation`/
 * `taskFromMutation` out to `main.ts`'s catch handler, which names it in
 * the diagnostic's `input` so a caller can re-read without a second round
 * trip -- same exit-5 `tracker_write_conflict` shape as before, just no
 * longer discarding data the mutation result already carried.
 */
export class TrackerWriteConflictError extends Error {
  readonly actualRevision?: string;
  /**
   * QCLI-425: present only when the conflict was the `--if-revision` guard's
   * own refusal, holding the revision the caller sent (the guard echoes it
   * verbatim as the conflict's `expectedRevision`). Absent on every other
   * conflict -- including a workspace CAS race, whose `expectedRevision` is
   * the snapshot revision and NOT anything a caller sent -- which is what
   * lets `main.ts` name the cause it established instead of asserting a
   * concurrent change for both.
   */
  readonly sentRevision?: string;
  constructor(actualRevision?: string, sentRevision?: string) {
    super("tracker_write_conflict");
    this.name = "TrackerWriteConflictError";
    this.actualRevision = actualRevision;
    this.sentRevision = sentRevision;
  }
}

function conflictFieldsOf(result: { readonly kind: string }): {
  readonly actualRevision?: string;
  readonly sentRevision?: string;
} {
  if (result.kind !== "conflict") return {};
  const candidate = result as Partial<TaskWriteConflict>;
  return {
    actualRevision:
      typeof candidate.actualRevision === "string"
        ? candidate.actualRevision
        : undefined,
    sentRevision:
      candidate.code === "revision_precondition_failed" &&
      typeof candidate.expectedRevision === "string"
        ? candidate.expectedRevision
        : undefined,
  };
}

function taskFromMutation(
  result: Awaited<ReturnType<TaskService["create"]>>,
): TrackerTask {
  return recordFromMutation(result, "task");
}

/**
 * QCLI-264: every single-record mutating command puts the written record
 * itself in `data`, never the service's internal mutation envelope. (The
 * batch route is a report rather than a record and keeps its own shape,
 * records at `data.items[].task`.) Unwrapping here is what
 * keeps `task complete` readable the same way as `task edit`; passing the
 * result through instead nests the record under `task`/`draft`, exposes the
 * repository `revision` hash, and shadows the envelope's semantic `kind` with
 * a second `kind: "success"`. A conflict is an exit-5 failure, not a success
 * envelope carrying `kind: "conflict"`, which is what the raw pass-through
 * used to emit.
 */
export function recordFromMutation<
  Result extends { readonly kind: string },
  Field extends keyof Extract<Result, { readonly kind: "success" }> & string,
>(
  result: Result,
  field: Field,
): Extract<Result, { readonly kind: "success" }>[Field] {
  if (result.kind !== "success") {
    const fields = conflictFieldsOf(result);
    throw new TrackerWriteConflictError(
      fields.actualRevision,
      fields.sentRevision,
    );
  }
  return (result as Extract<Result, { readonly kind: "success" }>)[field];
}

/** Maps the public tracker vocabulary without choosing a repository or actor identity provider. */
export async function dispatchTrackerTaskCommand(
  tasks: TaskService,
  request: TaskCommandRequest,
): Promise<TaskCommandResponse> {
  switch (request.command) {
    case "status-flow":
      // Reports the service's configured policy; the default policy is the historical spelling.
      return {
        schemaVersion: 1,
        kind: "task.status-flow",
        data: {
          statuses: tasks.lifecycle.statuses,
          // QCLI-331 (shape B): the LADDER's terminal statuses only, so
          // `terminalStatuses` stays a subset of `statuses`. Every published
          // lore-cli refuses the tracker as drift when it is not, before every
          // tracker operation. The closed status is reported beside it as
          // `closedStatus`; it joins `terminalStatuses` in a later release,
          // once a tolerant lore is the floor.
          terminalStatuses: tasks.lifecycle.terminalStatuses,
          ...(tasks.lifecycle.pausedStatus !== undefined
            ? {
                pausedStatus: tasks.lifecycle.pausedStatus,
                // QCLI-325 (opum-doc relay 570, DEC-172 (4af)): the paused
                // status is a BUILT-IN literal for now. No runtime path
                // populates it from user configuration -- createTaskService
                // passes the default policy as a constant, and nothing reads
                // workspace.toml for lifecycle config -- so this flag lets a
                // reader of status-flow output tell from the CLI alone that
                // the value is not theirs to change, without reading source or
                // asking. If it ever becomes configurable it becomes true (its
                // own design task with lore-cli), and this flag is what flips.
                pausedStatusConfigurable: false,
              }
            : {}),
          ...(tasks.lifecycle.closedStatus !== undefined
            ? {
                closedStatus: tasks.lifecycle.closedStatus,
                resolutions: taskResolutionKinds,
              }
            : {}),
        },
      };
    case "list": {
      const { command: _command, ...query } = request;
      return {
        schemaVersion: 1,
        kind: "task.list",
        data: (await tasks.listFilteredWithPath(query)).map(withCheckPositions),
      };
    }
    case "view": {
      // QCLI-277: revision comes from one authoritative read alongside the
      // task itself (viewWithRevision), so it always describes the exact
      // snapshot the rest of `data` was built from.
      //
      // QCLI-276 / DEC-3: the application layer keeps returning the full,
      // untrimmed record (it stays the source of truth for any other
      // caller); --max-notes projection happens only here, at the
      // CLI-facing boundary.
      const { task, revision } = await tasks.viewWithRevision(
        request.reference,
      );
      const full = { ...withCheckPositions(task), revision };
      // Notes append chronologically (mergeList pushes new entries at the
      // array's end), so "most recent N" is the tail slice. QCLI-312: a cap of
      // 0 means NONE, which `slice(-0)` gets WRONG -- `slice(0)` returns the
      // WHOLE array, so the zero cap returned the full record with
      // notesOmitted 0. Handle it explicitly: empty notes, every note omitted.
      const capped =
        request.maxNotes === undefined || request.maxNotes === 0
          ? []
          : full.implementationNotes.slice(-request.maxNotes);
      const recorded =
        request.maxNotes === undefined
          ? full
          : {
              ...full,
              implementationNotes: capped,
              notesOmitted: full.implementationNotes.length - capped.length,
            };
      // The full (or, under --max-notes, capped) record is returned as-is,
      // matching the declared `task.view` data type. `--fields` projection is
      // the caller's job at the CLI boundary (main.ts), the same place
      // `task list --fields` projects -- so this command never widens or
      // narrows `data`'s declared shape.
      return { schemaVersion: 1, kind: "task.view", data: recorded };
    }
    case "search":
      return {
        schemaVersion: 1,
        kind: "task.search",
        data: (await tasks.search(request.query)).map(withCheckPositions),
      };
    case "create":
      requireWriteActor(request.actor);
      return {
        schemaVersion: 1,
        kind: "task.created",
        data: withCheckPositions(
          taskFromMutation(
            await tasks.create(request.id, request.input, request.operationId),
          ),
        ),
      };
    case "edit": {
      requireWriteActor(request.actor);
      // QCLI-122: resolve the current task and its authoritative snapshot in
      // one read, then apply the mutation from that same snapshot instead of
      // performing two independent full-collection reads per public edit.
      const prepared = await tasks.prepareMutation(request.reference);
      // QCLI-374: a stale --if-revision must be refused as a conflict before
      // the patch is folded, because folding validates removals against the
      // CURRENT record and throws a QCLI-297 miss when a concurrent writer
      // already removed the value. editOn then refuses the empty patch.
      // QCLI-310: `taskRevision` is the resolved RECORD's revision -- the same
      // value `task view --json` hands out and `editOn` checks against -- not
      // `snapshot.revision`, which is the whole store's.
      const stale =
        request.ifRevision !== undefined &&
        request.ifRevision !== prepared.taskRevision;
      const patch = stale
        ? {}
        : buildEditPatch(prepared.task, request.patch, tasks);
      return {
        schemaVersion: 1,
        kind: "task.updated",
        data: withCheckPositions(
          taskFromMutation(
            await tasks.editOn(
              prepared.snapshot,
              request.reference,
              patch as Parameters<TaskService["edit"]>[1],
              request.operationId,
              { ifRevision: request.ifRevision },
            ),
          ),
        ),
      };
    }
    case "edit-batch": {
      requireWriteActor(request.actor);
      const result = await tasks.editBatch(
        request.items.map((item, index) => ({
          reference: item.reference,
          operationId: item.operationId ?? `batch-item-${index + 1}`,
          patch: (item.patch ?? {}) as Partial<
            import("../../../domain/tasks/tasks.ts").TaskState &
              TrackerEditPatch
          >,
          ifRevision: item.ifRevision,
        })),
      );
      if (result.kind === "conflict")
        throw new TrackerWriteConflictError(result.actualRevision);
      return {
        schemaVersion: 1,
        kind: "task.batch-updated",
        data: {
          items: result.items.map((item) =>
            item.kind === "updated"
              ? { ...item, task: withCheckPositions(item.task) }
              : item,
          ),
          applied: result.items.filter((item) => item.kind === "updated")
            .length,
          failed: result.items.filter((item) => item.kind === "error").length,
          revision: result.revision,
        },
      };
    }
  }
}

/**
 * Folds the public replace/add/remove/clear vocabulary into one deterministic
 * TaskState patch: current minus removed, then new entries not already present.
 */
function _mergeList(
  current: readonly string[],
  added: readonly string[] | undefined,
  removed: readonly string[] | undefined,
): readonly string[] {
  const dropped = new Set(removed ?? []);
  const result = current.filter((value) => !dropped.has(value));
  for (const value of added ?? [])
    if (!result.includes(value)) result.push(value);
  return result;
}

function _mergeComments(
  current: readonly unknown[],
  added: readonly unknown[] | undefined,
  removed: readonly string[] | undefined,
): readonly unknown[] {
  const dropped = new Set(removed ?? []);
  const isCommentId = (comment: unknown): boolean =>
    !!comment &&
    typeof comment === "object" &&
    typeof (comment as { id?: unknown }).id === "string";
  const result = current.filter((comment) => {
    const id = isCommentId(comment) ? (comment as { id: string }).id : "";
    return !dropped.has(id);
  });
  for (const comment of added ?? [])
    if (!result.includes(comment)) result.push(comment);
  return result;
}

function buildEditPatch(
  current: TrackerTask,
  patch: TrackerEditPatch,
  tasks: TaskService,
): Record<string, unknown> {
  return foldEditPatch(current, patch, (status) => tasks.resolveStatus(status));
}
