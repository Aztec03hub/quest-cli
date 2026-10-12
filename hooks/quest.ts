// The Quest board's non-drawing half: the argv every read and write builds and
// the parsers for both `task list` shapes.
//
// It is a separate module from `register.tsx` so each of those can be tested
// against the engine without a surface -- the tests import this file directly.

import type {
  Coverage,
  QuestTask,
  RepoRow,
  StatusFilter,
  TaskDetail,
  View,
} from "../types";

export const STATUSES: { value: StatusFilter; label: string }[] = [
  { value: "In Progress", label: "In progress" },
  { value: "open", label: "All open" },
  { value: "To Do", label: "To do" },
  { value: "Paused", label: "Paused" },
  { value: "Done", label: "Done (latest 50)" },
  { value: "Closed", label: "Closed (latest 50)" },
];

// The kanban's columns: the open statuses, in the order work moves.
export const COLUMNS = ["To Do", "In Progress", "Paused"] as const;

// The pane's geometry, all of it here so the sizes are computed and tested
// without a surface (QCLI-435).

/** The dock width the pane asks for normally. */
export const DOCK_COLUMNS = 64;

/** The rail it collapses to: the third state beside normal and full. */
export const RAIL_COLUMNS = 22;

/**
 * Cells a full dock request leaves the transcript, in the request itself.
 *
 * The engine clamps a dock request to `columns - 24` on 2.1.288 (read from
 * cc-patch's decompiled build and measured by lore-cli, LCLI-674; ruled in
 * opum-doc DEC-154, 2026-10-03). The first design kept 20, which the engine
 * never granted.
 *
 * DEC-154 rule 2 as amended (seq 230, 2026-10-03): the dock's ask is this
 * margin less the TERMINAL width, reconstructed from the render by
 * `dockedTerminalColumns` -- a docked render's `viewport.columns` is the
 * transcript column, not the terminal.
 */
export const FULL_MARGIN_COLUMNS = 24;

/** Rows the engine keeps for the prompt under an inline pane. */
export const PROMPT_FLOOR_ROWS = 8;

/** Rows of transcript it keeps visible above one. */
export const TRANSCRIPT_PEEK_ROWS = 3;

/** The prompt area an inline full pane leaves below it (DEC-154's rows - 11). */
export const FULL_MARGIN_ROWS = PROMPT_FLOOR_ROWS + TRANSCRIPT_PEEK_ROWS;

/** The narrowest a full pane is ever asked for. */
export const MIN_PANE_ROWS = 5;

/**
 * The frame column a docked pane's body sits inside, between it and the
 * transcript: the body the render reports is one cell narrower than the width
 * the person's kept size names.
 *
 * Measured on Claude Code 2.1.288 (QCLI-454): a dock whose person-set width is
 * 80 reports `bodyColumns` 79. The kept-width notice adds this back so it names
 * the same number `pluginPanes.dockColumns` holds (DEC-154 counts the store's
 * value, "Width kept at 80").
 *
 * The same cell is the divider `dockedTerminalColumns` adds back when it
 * reconstructs the terminal from a docked render: transcript column + drawn
 * body + this = the terminal (120 + 79 + 1 = 200, measured).
 */
export const FRAME_COLUMNS = 1;

/**
 * At or above this body width the board draws the list and the detail side by
 * side instead of the detail below the list.
 */
export const WIDE_COLUMNS = 120;

/**
 * Cells of slack before a granted size counts as one the person set rather
 * than the full size asked for.
 *
 * `bodyColumns` and `scroll.bodyRows` are the body INSIDE the frame, so a
 * granted request still reads a couple of cells under it; a person who dragged
 * the pane moved it further than that. Without the slack every draw would call
 * a granted request a held one.
 */
export const SIZE_SLACK = 4;

/** The size the surface measured, as `ui.render` reports it under `e.viewport`. */
export type Viewport = { columns: number; rows: number };

/** Where the surface seated a pane: beside the transcript, or above the prompt. */
export type Placement = "dock" | "inline";

/**
 * The size a full pane asks for: the largest the surface allows, less what the
 * design keeps for the transcript (docked) or the prompt (inline).
 *
 * `columns` and `rows` are asked for together rather than one being picked from
 * the placement, because each is ignored where it does not apply -- the dock
 * ignores `rows`, the inline block ignores `columns` -- so asking both is
 * right whichever shape the surface seats the pane in.
 *
 * Either axis is left out when it is not known: `session.start` runs before any
 * draw, and a request is not a grant, so the surface's own default stands and a
 * stored full mode asks once, when a render first reports a viewport (DEC-154
 * rule 2 as amended: once per toggle, never on a resize or a redraw).
 *
 * The docked `columns` this computes is the fallback for a pane whose drawn
 * body is not yet known; `dockFullColumns` is the dock's measured form.
 */
export function fullPaneSize(viewport: Partial<Viewport> | null): {
  columns?: number;
  rows?: number;
} {
  const size: { columns?: number; rows?: number } = {};
  if (viewport?.columns !== undefined) {
    size.columns = Math.max(
      RAIL_COLUMNS,
      viewport.columns - FULL_MARGIN_COLUMNS,
    );
  }
  if (viewport?.rows !== undefined) {
    size.rows = Math.max(MIN_PANE_ROWS, viewport.rows - FULL_MARGIN_ROWS);
  }

  return size;
}

/**
 * The terminal's width, from a docked pane's own render facts: the transcript
 * column it draws beside and the body it drew, both from the same render, plus
 * the divider between them.
 *
 * Null until both are known -- `session.start` runs before any draw, and the
 * dock's body only arrives with a render. A docked `viewport.columns` is the
 * transcript column, not the terminal (measured, QCLI-454: 120 + 79 + 1 = 200
 * at a 200-column terminal, 90 + 109 + 1 = 200 at another session's), which is
 * why the terminal is reconstructed rather than read off the render.
 */
export function dockedTerminalColumns(
  viewport: Partial<Viewport> | null,
  bodyColumns: number | null,
): number | null {
  if (viewport?.columns === undefined || bodyColumns === null) {
    return null;
  }

  return viewport.columns + bodyColumns + FRAME_COLUMNS;
}

/**
 * The columns a full pane asks for while DOCKED: the whole terminal less the
 * engine's transcript margin (DEC-154 rule 2 as amended, 2026-10-03).
 *
 * A docked pane cannot use `viewport.columns` directly for this -- that is the
 * transcript column, so the ask would come out narrower than the pane already
 * is, and the surface would grant it as-is: the full toggle would change
 * nothing on screen (QCLI-454, measured against the operator's report). Null
 * when the drawn body is not known yet.
 */
export function dockFullColumns(
  viewport: Partial<Viewport> | null,
  bodyColumns: number | null,
): number | null {
  const terminal = dockedTerminalColumns(viewport, bodyColumns);

  return terminal === null
    ? null
    : Math.max(RAIL_COLUMNS, terminal - FULL_MARGIN_COLUMNS);
}

/**
 * The size the pane asks `$.ui.open` for, from the two states the view holds.
 *
 * Collapsed is the rail and wins over full, so collapsing from full mode lands
 * on the rail and expanding returns to whichever of the other two was stored.
 *
 * `dockBodyColumns` is the body the docked pane last drew, when one is known:
 * with it, a docked full asks for the whole terminal (via `dockFullColumns`)
 * rather than for the transcript column the render's viewport reports. Without
 * it -- no draw yet, or an inline pane -- `fullPaneSize`'s own arithmetic
 * stands, which is also the only shape an inline pane can use.
 */
export function paneSize(
  state: { isCollapsed: boolean; isFull: boolean },
  viewport: Partial<Viewport> | null,
  dockBodyColumns: number | null = null,
): { columns?: number; rows?: number } {
  if (state.isCollapsed) {
    return { columns: RAIL_COLUMNS };
  }
  if (state.isFull) {
    const size = fullPaneSize(viewport);
    const docked = dockFullColumns(viewport, dockBodyColumns);
    if (docked !== null) {
      size.columns = docked;
    }

    return size;
  }

  return { columns: DOCK_COLUMNS };
}

/** Whether the board draws its list and detail side by side at this width. */
export function isWideLayout(bodyColumns: number): boolean {
  return bodyColumns >= WIDE_COLUMNS;
}

/**
 * Whether the surface kept a size the person set instead of granting the size
 * asked for, so the pane can say so rather than claiming a size it did not get.
 */
export function isSizeHeld(granted: number, asked: number): boolean {
  return granted < asked - SIZE_SLACK;
}

/**
 * The line a docked full pane shows while the surface is keeping the person's
 * own width, or null when there is none to show.
 *
 * DEC-154, rule 3: a kept width is the person's choice, and while one holds
 * full mode says so plainly -- naming the width the way
 * `pluginPanes.dockColumns` holds it -- rather than showing a generic hint.
 * Only a dock can keep one, and only full mode speaks of it: the inline block
 * is content-sized, so a short one is honest and needs no notice, and the
 * normal dock and the rail ask for fixed sizes.
 *
 * `holding` is the ask's OUTCOME -- a full ask that so far went ungranted --
 * not a reading of the drawn width against what full mode would ask for now.
 * A re-derived ask moves under the pane: after a GRANTED ask a widening
 * resize lifts it while the pane keeps the granted width and nothing is
 * re-asked (amended rule 2), and the drawn width alone then reported a width
 * the person had set when nothing was held (QCLI-456, the defect
 * opum-ai/lore-cli#486 F2 found in its own pane). The outcome is tracked at
 * the ask instead: only an ask that was made can have gone ungranted.
 */
export function keptWidthNotice(
  state: { isCollapsed: boolean; isFull: boolean },
  placement: Placement,
  drawn: number,
  holding: boolean,
): string | null {
  if (state.isCollapsed || !state.isFull || placement !== "dock" || !holding) {
    return null;
  }

  return `Width kept at ${drawn + FRAME_COLUMNS} (you set it): drag the pane edge to change`;
}

/**
 * Whether a value read back from the pane's prefs is one this board stored.
 *
 * Its job is to survive the field changing between releases: a view stored by
 * an older build has no `isFull`, and one stored by a newer build may carry a
 * field this build does not know, so every field but the ones a pane cannot
 * draw without is optional here and defaulted where it is read.
 */
export function isStoredView(
  value: unknown,
): value is Pick<
  View,
  "tab" | "status" | "isCollapsed" | "isFull" | "readRefs"
> {
  const v = value as Partial<View> | null;

  // A view stored by a version that still had fleet mode carries a `scope`
  // ("fleet" or "local") and a `repo`. Nothing checks or reads them any more --
  // the board is this session's own repository only -- so an older stored view
  // is accepted as it is and reads as local rather than being refused
  // (QCLI-490, DEC-172 (4bg) item 1 (a)).
  return (
    !!v &&
    (v.tab === "list" || v.tab === "kanban") &&
    STATUSES.some((s) => s.value === v.status) &&
    typeof v.isCollapsed === "boolean" &&
    (typeof v.isFull === "boolean" || v.isFull === undefined) &&
    (typeof v.readRefs === "boolean" || v.readRefs === undefined)
  );
}

/**
 * The arguments one `quest task list` read takes.
 *
 * The across-refs read answers about the repository -- origin/dev plus every
 * open pull request head into it -- where the plain read answers about the
 * checkout, uncommitted records included. It costs a forge call per
 * repository, which is why it is the toggle and not the default.
 *
 * `--allow-partial` keeps a ref the run could not read from turning the whole
 * read into a refusal (exit 6): the row draws the incompleteness instead,
 * which is the point the flag exists for.
 */
export function listArgs(status: StatusFilter, readRefs: boolean): string[] {
  const isTerminal = status === "Done" || status === "Closed";
  const filters =
    status === "open"
      ? [
          "--exclude-status",
          "Done",
          "--exclude-status",
          "Closed",
          "--limit",
          "200",
        ]
      : ["--status", status, "--limit", isTerminal ? "50" : "200"];

  return readRefs ? ["--across-refs", "--allow-partial", ...filters] : filters;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** Reads `quest task list --json` output down to the fields the list draws. */
export function parseTaskList(stdout: string): QuestTask[] {
  const parsed = JSON.parse(stdout) as { data?: unknown };
  if (!Array.isArray(parsed.data)) {
    throw new Error("quest output has no data array");
  }

  return parsed.data.map((raw) => {
    const task = raw as Record<string, unknown>;

    return {
      id: String(task.id ?? "?"),
      title: String(task.title ?? ""),
      status: String(task.status ?? ""),
      priority: typeof task.priority === "string" ? task.priority : null,
      labels: asStrings(task.labels),
      proposedBy: null,
      conflict: false,
    };
  });
}

type AcrossRefState = { status?: unknown; refProvenance?: { ref?: unknown } };

/**
 * The status to draw for an id whose states may disagree.
 *
 * `origin/dev` is the landed truth; an entry that exists only on a pull
 * request head carries that state instead. The first state is the fallback,
 * and `conflict` on the entry is what tells the reader the others exist.
 */
export function pickState(states: readonly AcrossRefState[]): string {
  const landed = states.find(
    (state) => state.refProvenance?.ref === "origin/dev",
  );
  const chosen = landed ?? states[0];

  return typeof chosen?.status === "string" ? chosen.status : "";
}

export function parseCoverage(value: unknown): Coverage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const coverage = value as {
    complete?: unknown;
    refsRead?: unknown;
    refsUnreadable?: unknown;
  };

  return {
    complete: coverage.complete === true,
    refsRead: Array.isArray(coverage.refsRead) ? coverage.refsRead.length : 0,
    refsUnreadable: asStrings(coverage.refsUnreadable),
  };
}

/**
 * Reads `quest task list --across-refs --json` output.
 *
 * The envelope differs from the plain read in both directions: the entries
 * carry `states` per ref rather than a single status, and coverage sits beside
 * `data` at the top level, not inside it.
 */
export function parseAcrossRefs(stdout: string): {
  tasks: QuestTask[];
  coverage: Coverage | null;
} {
  const parsed = JSON.parse(stdout) as { data?: unknown; coverage?: unknown };
  if (!Array.isArray(parsed.data)) {
    throw new Error("quest output has no data array");
  }

  const tasks = parsed.data.map((raw) => {
    const entry = raw as {
      id?: unknown;
      title?: unknown;
      proposedBy?: unknown;
      conflict?: unknown;
      states?: unknown;
    };
    const states = Array.isArray(entry.states)
      ? (entry.states as AcrossRefState[])
      : [];

    return {
      id: String(entry.id ?? "?"),
      title: String(entry.title ?? ""),
      status: pickState(states),
      priority: null,
      labels: [],
      proposedBy:
        typeof entry.proposedBy === "string" ? entry.proposedBy : null,
      conflict: entry.conflict === true,
    };
  });

  return { tasks, coverage: parseCoverage(parsed.coverage) };
}

/** Reads `quest task view --json` output down to the fields the detail draws. */
export function parseTaskView(stdout: string): TaskDetail {
  const parsed = JSON.parse(stdout) as { data?: unknown };
  const task = parsed.data as Record<string, unknown> | undefined;
  if (!task || typeof task !== "object") {
    throw new Error("quest output has no task");
  }
  const criteria = Array.isArray(task.acceptanceCriteria)
    ? task.acceptanceCriteria
    : [];
  const notes = asStrings(task.implementationNotes);
  const dependencies = Array.isArray(task.dependencies)
    ? task.dependencies.map((dep) =>
        typeof dep === "string"
          ? dep
          : String((dep as { id?: unknown }).id ?? "?"),
      )
    : [];

  return {
    id: String(task.id ?? "?"),
    title: String(task.title ?? ""),
    status: String(task.status ?? ""),
    priority: typeof task.priority === "string" ? task.priority : null,
    type: typeof task.type === "string" ? task.type : null,
    labels: asStrings(task.labels),
    description: String(task.description ?? ""),
    revision: typeof task.revision === "string" ? task.revision : null,
    criteria: criteria.map((item, at) => {
      const one = item as {
        text?: unknown;
        checked?: unknown;
        position?: unknown;
      };

      return {
        text: String(one.text ?? ""),
        isChecked: one.checked === true,
        position: typeof one.position === "number" ? one.position : at + 1,
      };
    }),
    comments: (Array.isArray(task.comments) ? task.comments : []).map(
      (item) => {
        const one = item as {
          authorId?: unknown;
          body?: unknown;
          createdAt?: unknown;
        };

        return {
          author: String(one.authorId ?? "?"),
          body: String(one.body ?? ""),
          createdAt: String(one.createdAt ?? ""),
        };
      },
    ),
    dependencies,
    latestNote: notes.length > 0 ? (notes[notes.length - 1] ?? null) : null,
    updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : null,
  };
}

/** The search and repo filters, applied to what was fetched. */
export function filterRows(rows: RepoRow[], query: string): RepoRow[] {
  const needle = query.trim().toLowerCase();

  return rows.map((row) => ({
    ...row,
    tasks: needle
      ? row.tasks.filter((task) =>
          [task.id, task.title, ...task.labels].some((field) =>
            field.toLowerCase().includes(needle),
          ),
        )
      : row.tasks,
  }));
}

// The arguments every pane edit adds: the operator, acting in their own pane.
export function actorArgs(id: string): string[] {
  return ["--actor", id, "--actor-kind", "human"];
}

/** A comment as Quest stores one. */
export function commentArg(
  author: string,
  body: string,
  nowMs: number,
): string {
  const createdAt = new Date(nowMs).toISOString();

  return JSON.stringify([
    { id: `c-${nowMs}`, authorId: author, body, createdAt },
  ]);
}

/**
 * The session's own repository, by name.
 *
 * `git rev-parse --git-common-dir` names the repository rather than the
 * worktree the session may be running in, so a worktree session still keys its
 * row -- and its writes -- to the repository the operator knows.
 */
export function repoNameFromGitCommonDir(
  root: string,
  commonDir: string | null,
): string {
  const fallback = root.replace(/\/+$/, "").split("/").pop() ?? root;
  if (!commonDir) {
    return fallback;
  }
  const dotGit = (
    commonDir.startsWith("/") ? commonDir : `${root}/${commonDir}`
  ).replace(/\/+$/, "");
  if (!dotGit.endsWith(".git")) {
    return fallback;
  }

  return dotGit.slice(0, -"/.git".length).split("/").pop() ?? fallback;
}

// The alerts check: what the board tells the operator about while they are
// working somewhere else. Everything here is pure -- the argv, the parsers, and
// the comparison against the last state seen -- so it is tested without a
// surface; the reads, the clock and the toasts live in `register.tsx`.

/** What the plugin's `alerts` option offers. */
export type AlertsSetting = "all" | "decisions" | "off";

/**
 * The `alerts` option as the check reads it.
 *
 * A value outside the three reads as the default rather than as a refusal: the
 * engine reads a stored value outside a field's `options` as unset, so an
 * option nobody set has to read the same way here.
 */
export function parseAlerts(value: unknown): AlertsSetting {
  return value === "decisions" || value === "off" ? value : "all";
}

/** One decision as `quest decision list` reports it. */
export type DecisionEntry = {
  id: string;
  title: string;
  status: string;
};

/**
 * One decision as the check reads it: the record, and the workspace it was read
 * from.
 *
 * The repository is carried because a decision id is minted per workspace --
 * `highestSequence` reads that workspace's own `planning.json` -- so the same
 * `DEC-3` in two repositories is two decisions, and comparing them by id alone
 * would call one of them the other's resolution. The toasts print it for the
 * same reason: an id alone cannot say which workspace it names.
 */
export type AlertDecision = DecisionEntry & { repo: string };

/** The arguments the check reads decisions with. `decision list` takes none. */
export function decisionListArgs(): string[] {
  return ["decision", "list"];
}

/** Reads `quest decision list --json` down to the fields the check reads. */
export function parseDecisionList(stdout: string): DecisionEntry[] {
  const parsed = JSON.parse(stdout) as { data?: unknown };
  if (!Array.isArray(parsed.data)) {
    throw new Error("quest output has no data array");
  }

  return parsed.data.map((raw) => {
    const decision = raw as Record<string, unknown>;

    return {
      id: String(decision.id ?? "?"),
      title: String(decision.title ?? ""),
      status: String(decision.status ?? ""),
    };
  });
}

/**
 * One task as the check reads it: open now, or the state it left the open set
 * for.
 */
export type AlertTask = {
  repo: string;
  id: string;
  title: string;
  status: string;
  priority: string | null;
  /** The kind a Closed task was retired under; null on every other task. */
  resolution: string | null;
};

/**
 * Reads `quest task view --json` down to the fields the check classifies on.
 *
 * `parseTaskView` reads the detail the pane draws; a task that left the open
 * set is told Done from Closed by its status and, when it was closed, by why --
 * neither of which the pane's own reader keeps.
 */
export function parseTaskOutcome(stdout: string): Omit<AlertTask, "repo"> {
  const parsed = JSON.parse(stdout) as { data?: unknown };
  const task = parsed.data as Record<string, unknown> | undefined;
  if (!task || typeof task !== "object") {
    throw new Error("quest output has no task");
  }
  const resolution = task.resolution as { kind?: unknown } | undefined;

  return {
    id: String(task.id ?? "?"),
    title: String(task.title ?? ""),
    status: String(task.status ?? ""),
    priority: typeof task.priority === "string" ? task.priority : null,
    resolution: typeof resolution?.kind === "string" ? resolution.kind : null,
  };
}

/** The last state the check saw, as `$.store` keeps it. */
export type AlertsState = {
  /** `${repo}:${id}` -> status, the same reason `AlertDecision` carries its repo. */
  decisions: Record<string, string>;
  /** Repository -> task id -> status, over the tasks open at that check. */
  tasks: Record<string, Record<string, string>>;
};

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    Object.values(value).every((one) => typeof one === "string")
  );
}

/**
 * Whether a value read back from the store is a state this build wrote.
 *
 * A stored state that does not pass reads as no state at all, and the check
 * then records a baseline rather than toasting a session's worth of changes it
 * cannot be sure it has not already shown.
 */
export function isAlertsState(value: unknown): value is AlertsState {
  const state = value as Partial<AlertsState> | null;

  return (
    !!state &&
    typeof state === "object" &&
    isStringMap(state.decisions) &&
    !!state.tasks &&
    typeof state.tasks === "object" &&
    Object.values(state.tasks).every((one) => isStringMap(one))
  );
}

/** What one check found worth telling the operator about. */
export type AlertChanges = {
  /** Decisions that have just become `proposed`. */
  waiting: AlertDecision[];
  /** Decisions that were `proposed` and are not any more, with their repo. */
  decided: { repo: string; id: string; status: string }[];
  /** Open tasks that have moved to Paused. */
  paused: AlertTask[];
  /** Tasks that left the open set at the closed status. */
  closed: AlertTask[];
  /** Tasks that left the open set at Done with a high priority. */
  done: AlertTask[];
};

/** Everything one check read, from the repositories it could read. */
export type AlertsSeen = {
  decisions: readonly AlertDecision[];
  open: readonly AlertTask[];
  /** The tasks that were open last check and are not now, each looked up once. */
  departed: readonly AlertTask[];
};

/**
 * The alert-worthy changes between the last state seen and this check's read.
 *
 * Only changes a person would act on: a task starting, or a normal-priority
 * task finishing, is drawn in the pane and says nothing. Decisions are alert-
 * worthy whichever way they move, so `decisions` mode stops after them.
 */
export function alertChanges(
  previous: AlertsState,
  seen: AlertsSeen,
  setting: AlertsSetting,
): AlertChanges {
  const changes: AlertChanges = {
    waiting: [],
    decided: [],
    paused: [],
    closed: [],
    done: [],
  };
  for (const decision of seen.decisions) {
    const was = previous.decisions[`${decision.repo}:${decision.id}`];
    if (decision.status === "proposed" && was !== "proposed") {
      changes.waiting.push(decision);
    }
    if (was === "proposed" && decision.status !== "proposed") {
      changes.decided.push({
        repo: decision.repo,
        id: decision.id,
        status: decision.status,
      });
    }
  }
  if (setting !== "all") {
    return changes;
  }
  for (const task of seen.open) {
    const was = previous.tasks[task.repo]?.[task.id];
    if (was !== undefined && was !== task.status && task.status === "Paused") {
      changes.paused.push(task);
    }
  }
  for (const task of seen.departed) {
    if (task.status === "Closed") {
      changes.closed.push(task);
    }
    if (task.status === "Done" && task.priority === "high") {
      changes.done.push(task);
    }
  }

  return changes;
}

/** One toast the check shows, and how long it stays. */
export type AlertToast = { text: string; timeoutMs: number };

/** More alert-worthy task changes than this in one check become one toast. */
export const BATCH_AT = 3;

/** A resolution kind as a toast reads it: `wont-do` is "won't do". */
function resolutionWords(kind: string): string {
  return kind === "wont-do" ? "won't do" : kind;
}

/** The toast for a task retired at the closed status. */
function closedText(task: AlertTask): string {
  const why = task.resolution ? ` (${resolutionWords(task.resolution)})` : "";

  return `${task.id} closed${why} in ${task.repo}`;
}

/** The one toast a check with more than {@link BATCH_AT} task changes shows.
 *
 * The line points at the `dashboard` tool by the words that reach it -- the
 * board's slash command was retired, so `/quest` is not a command any more and
 * naming it here would send the person nowhere (QCLI-444, seq 182).
 */
export function batchLine(changes: AlertChanges): string {
  const counts: readonly (readonly [number, string])[] = [
    [changes.done.length, "done"],
    [changes.paused.length, "paused"],
    [changes.closed.length, "closed"],
  ];
  const total = counts.reduce((sum, [count]) => sum + count, 0);
  const named = counts
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(", ");

  return `${total} updates: ${named}. Open the board: /quest dashboard`;
}

/**
 * The toasts one check shows: the decisions first, each its own, then the task
 * changes -- individually, or as one batch once there are more than
 * {@link BATCH_AT} of them.
 *
 * Decisions are never folded into the batch. A waiting decision is something
 * the person has to answer, and "3 updates" is not a line they can act on.
 *
 * Both decision toasts name the repository, because the id alone does not
 * identify the decision: ids are minted per workspace, so two trackers can
 * both hold a `DEC-3` and the person can be looking at either (QCLI-444).
 */
export function alertToasts(changes: AlertChanges): AlertToast[] {
  const toasts: AlertToast[] = [];
  for (const decision of changes.waiting) {
    toasts.push({
      text: `${decision.repo} ${decision.id} needs a decision: ${decision.title}`,
      timeoutMs: 10_000,
    });
  }
  for (const decision of changes.decided) {
    toasts.push({
      text: `${decision.repo} ${decision.id} decided: ${decision.status}`,
      timeoutMs: 6_000,
    });
  }
  const tasks: AlertToast[] = [
    ...changes.paused.map((task) => ({
      text: `${task.id} paused in ${task.repo}: ${task.title}`,
      timeoutMs: 8_000,
    })),
    ...changes.closed.map((task) => ({
      text: closedText(task),
      timeoutMs: 6_000,
    })),
    ...changes.done.map((task) => ({
      text: `${task.id} done: ${task.title}`,
      timeoutMs: 6_000,
    })),
  ];
  if (tasks.length > BATCH_AT) {
    toasts.push({ text: batchLine(changes), timeoutMs: 8_000 });
  } else {
    toasts.push(...tasks);
  }

  return toasts;
}

/**
 * The one line a first check after a restart shows, or null when nothing moved
 * while no session was running.
 */
export function awayLine(changes: AlertChanges): string | null {
  const waiting = changes.waiting.length;
  const updates =
    changes.paused.length + changes.closed.length + changes.done.length;
  const parts: string[] = [];
  if (waiting > 0) {
    parts.push(`${waiting} decision${waiting === 1 ? "" : "s"} waiting`);
  }
  if (updates > 0) {
    parts.push(`${updates} update${updates === 1 ? "" : "s"}`);
  }

  return parts.length === 0 ? null : `While you were away: ${parts.join(", ")}`;
}

/** The status line that stands while decisions wait, or undefined for none. */
export function waitingStatus(waiting: number): string | undefined {
  return waiting > 0
    ? `Quest: ${waiting} decision${waiting === 1 ? "" : "s"} waiting`
    : undefined;
}
