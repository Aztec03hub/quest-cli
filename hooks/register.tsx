import { atom, read, update } from "claude-code";
import type {
  EngineInterface,
  Register,
  Timer,
  UiOpenResult,
} from "claude-code";

import type { RepoRow, StatusFilter, Tab, TaskDetail, View } from "../types";
import {
  COLUMNS,
  FRAME_COLUMNS,
  STATUSES,
  actorArgs,
  alertChanges,
  alertToasts,
  awayLine,
  commentArg,
  decisionListArgs,
  filterRows,
  isAlertsState,
  isSizeHeld,
  isStoredView,
  isWideLayout,
  keptWidthNotice,
  listArgs,
  paneSize,
  parseAcrossRefs,
  parseAlerts,
  parseDecisionList,
  parseTaskList,
  parseTaskOutcome,
  parseTaskView,
  repoNameFromGitCommonDir,
  waitingStatus,
} from "./quest";
import type {
  AlertDecision,
  AlertTask,
  AlertsState,
  Placement,
  Viewport,
} from "./quest";

const PANE = "quest-board";
// The pane's way in since QCLI-441: the engine lists this tool to Claude as
// `mcp__opum-quest__dashboard`, and the generated `quest` skill routes
// "quest dashboard" -- with `full` or a task id after it, fleet mode having
// gone with QCLI-490 -- to it, sending every other argument to the CLI. There
// is no slash command:
// the plugin's own skill owns `/opum-quest:quest`, so a command named `quest`
// is refused by the engine, and a refused registration makes the whole
// `session.start` hook throw (measured, QCLI-440).
const DASHBOARD_TOOL = "dashboard";
const DASHBOARD_TOOL_NAME = `mcp__opum-quest__${DASHBOARD_TOOL}`;
const REFRESH_MS = 60_000;
// No clock tick may spawn more than this many subprocesses (QCLI-490, DEC-172
// (4bg) item 1 (d)). The refresh tick runs two -- one `task list` and one
// `git status`; the alerts tick runs its two reads and, when it had to NAME the
// repository, the one `git rev-parse` that takes (QCLI-494, DEC-172 (4bl)),
// plus -- still inside this budget -- the `task view` it uses to tell a Done
// task from a Closed one.
const MAX_TICK_CHILDREN = 3;
const PREFS_KEY = "opum-quest.board.view";

const board = atom({ plugin: "opum-quest", key: "board" } as const, {
  rows: [],
  refreshedAt: null,
  isLoading: false,
});
const view = atom({ plugin: "opum-quest", key: "view" } as const, {
  tab: "list",
  status: "In Progress",
  query: "",
  isCollapsed: false,
  isFull: false,
  readRefs: false,
  selected: null,
  pending: null,
});
const detail = atom({ plugin: "opum-quest", key: "detail" } as const, {
  key: null,
  task: null,
  error: null,
  isLoading: false,
});
const edits = atom({ plugin: "opum-quest", key: "edits" } as const, {
  isWriting: false,
  uncommitted: 0,
});

// Who pane edits are recorded as; the plugin's `actor` option.
let actor = "jdnewhouse";

// This session's own repository -- the only one the board reads or writes
// (QCLI-490, DEC-172 (4bg) item 1 (a): fleet mode is gone). It is resolved from
// the session on first need, so a process the auto-start gate left alone runs
// no `git` until something actually reads.
let localRepo: string | null = null;
let isUncommittedResolved = false;
let pluginOptions: Record<string, unknown> = {};
const dirs = new Map<string, string>();

// The size the surface last reported, so a pane opened outside a draw --
// `session.start`, or a `dashboard` tool call -- can still ask for the full
// size. Only `ui.render` measures the surface, and it fills both axes; an
// axis nothing has measured yet is left out of what is asked for.
let viewport: Partial<Viewport> = {};

// The body the docked pane last drew, when the last pane draw was a dock.
// DEC-154 rule 2 as amended: a docked render's `viewport.columns` is the
// transcript column, so the terminal width is that column plus this drawn
// width plus the divider -- all from the same render -- and the full ask is
// that less the engine's margin. Null before any dock has drawn.
let lastDockBodyColumns: number | null = null;

// The numbers the full mode this session last asked for, and whether that ask
// has so far gone ungranted -- the module's reading of "a width is holding"
// (DEC-154 rule 3). The ask sets it and a later full draw at the ask's own
// size clears it, so it is an OUTCOME rather than a shortfall: amended rule 2
// forbids re-asking on a resize, so after a granted ask a widening lifts what
// full mode would ask for while the pane keeps the grant, and the shortfall
// that opens up has no width of anyone's behind it (QCLI-456, the defect
// opum-ai/lore-cli#486 F2 found in its own pane). The render that fires the
// mode's own ask is suppressed -- it drew before the surface answered -- and
// each placement reads the axis it is sized on: the dock across, the inline
// block down.
let fullAsk: { columns?: number; rows?: number } | null = null;
let awaitingGrant = false;

// How the pane last drew, for the `dashboard` tool's own line: the record of
// what happened -- the placement, the size the surface actually granted, what
// was asked, whether that counts as granted, and whether a width is holding
// (the ask's outcome) -- not what the open asked for. A line only trusts it
// when its mode still matches the view the call applied.
let lastRendered: {
  isFull: boolean;
  isCollapsed: boolean;
  placement: Placement;
  drawn: number;
  asked: number | null;
  granted: boolean | null;
  holding: boolean;
} | null = null;

// Whether this session has made its full-size ask with numbers. DEC-154 rule 2
// as amended: a full ask is made once per toggle -- a person's `z`, or a tool
// call with `full`, using the latest render's numbers -- and a stored full mode
// restored at `session.start` asks once more on its first render, because the
// session start runs before any draw and cannot size it. Never on a resize or a
// redraw: re-asking whenever the measured width moved is what chased
// 96 -> 79 -> 96 on the operator's surface.
let fullAskMade = false;

function dirFor(repo: string): string {
  return dirs.get(repo) ?? repo;
}

// The root the name below was derived from, so the one `git rev-parse` it takes
// is spawned ONCE per root rather than on every read. A session's repository
// does not change under it, and two reads inside one tick (readScopes and
// countUncommitted) both resolve it -- without this, a refresh tick spawned
// four children where the budget is three (QCLI-490, DEC-172 (4bg) item 1 (d)).
let localRoot: string | null = null;

/**
 * The session's own repository, AND the subprocesses this call spent naming it:
 * 1 when it ran the `git rev-parse`, 0 when the name was already known for this
 * root. The cost is RETURNED rather than stashed in module state, so a tick
 * charges exactly what its own call spent (QCLI-494, DEC-172 (4bl)).
 */
async function resolveLocalAndReport(
  $: EngineInterface,
): Promise<{ repo: string; spent: 0 | 1 }> {
  const root = await $.session.root();
  if (localRepo !== null && localRoot === root) {
    dirs.set(localRepo, root);

    return { repo: localRepo, spent: 0 };
  }
  let name = root.replace(/\/+$/, "").split("/").pop() ?? root;
  try {
    const ran = await $.process.run(
      ["git", "-C", root, "rev-parse", "--git-common-dir"],
      {
        timeoutMs: 10_000,
      },
    );
    if (ran.exitCode === 0) {
      name = repoNameFromGitCommonDir(root, ran.stdout.trim() || null);
    }
  } catch {
    // Not a checkout, or git is not on PATH: the directory name will do.
  }
  localRepo = name;
  localRoot = root;
  dirs.set(name, root);

  return { repo: name, spent: 1 };
}

// Reads this session's own repo, the one place the pane may write, from the session.
async function resolveLocal($: EngineInterface): Promise<string> {
  return (await resolveLocalAndReport($)).repo;
}

async function quest($: EngineInterface, repo: string, args: string[]) {
  const ran = await $.process.run(["quest", ...args, "--json"], {
    cwd: dirFor(repo),
    timeoutMs: 20_000,
  });
  if (ran.exitCode !== 0) {
    let reason = ran.stderr.trim().split("\n")[0] || `exit ${ran.exitCode}`;
    try {
      const body = JSON.parse(ran.stdout || ran.stderr) as {
        message?: unknown;
      };
      if (typeof body.message === "string") {
        reason = body.message;
      }
    } catch {
      // Not JSON: keep the first stderr line.
    }
    throw Object.assign(new Error(reason), { exitCode: ran.exitCode });
  }

  return ran.stdout;
}

async function readRepo(
  $: EngineInterface,
  repo: string,
  status: StatusFilter,
  readRefs: boolean,
): Promise<RepoRow> {
  try {
    const stdout = await quest($, repo, [
      "task",
      "list",
      ...listArgs(status, readRefs),
    ]);
    if (readRefs) {
      const { tasks, coverage } = parseAcrossRefs(stdout);

      return { repo, tasks, error: null, coverage };
    }

    return { repo, tasks: parseTaskList(stdout), error: null, coverage: null };
  } catch (error) {
    return {
      repo,
      tasks: [],
      error: error instanceof Error ? error.message : String(error),
      coverage: null,
    };
  }
}

let isRefreshing = false;
let isRefreshQueued = false;

/**
 * Reads this session's own repository.
 *
 * A refresh asked for while one is in flight is not dropped -- it is queued,
 * and the loop reads again with the view as it stands then. Dropping it left
 * the board drawing the previous view: a filter pressed during a read settled
 * back into the read it was meant to replace. This queue is the EXPLICIT
 * refresh path -- the button, a tab or filter change, a write -- so a person's
 * ask that lands mid-read is COALESCED into one more read rather than lost.
 * The clock tick is the other path and does not reach here while it is running:
 * it SKIPS its own tick instead, so a slow read can never stack ticks
 * (QCLI-490, DEC-172 (4bg) item 1 (c)).
 */
async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) {
    isRefreshQueued = true;
    return;
  }
  isRefreshing = true;
  try {
    do {
      isRefreshQueued = false;
      await readScopes($);
    } while (isRefreshQueued);
  } finally {
    isRefreshing = false;
  }
}

async function readScopes($: EngineInterface): Promise<void> {
  await resolveLocal($);
  await ensureUncommitted($);
  const { status: picked, tab, readRefs } = await read($, view);
  const status: StatusFilter = tab === "kanban" ? "open" : picked;
  await update($, board, (current) => ({ ...current, isLoading: true }));
  const rows =
    localRepo === null ? [] : [await readRepo($, localRepo, status, readRefs)];
  const refreshedAt = await $.clock.now();
  await update($, board, () => ({ rows, refreshedAt, isLoading: false }));
}

async function loadDetail(
  $: EngineInterface,
  repo: string,
  id: string,
): Promise<void> {
  const key = `${repo}:${id}`;
  await update($, detail, () => ({
    key,
    task: null,
    error: null,
    isLoading: true,
  }));
  try {
    const stdout = await quest($, repo, [
      "task",
      "view",
      id,
      "--max-notes",
      "3",
    ]);
    const task = parseTaskView(stdout);
    await update($, detail, (current) =>
      current.key === key
        ? { key, task, error: null, isLoading: false }
        : current,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await update($, detail, (current) =>
      current.key === key
        ? { key, task: null, error: message, isLoading: false }
        : current,
    );
  }
}

async function countUncommitted($: EngineInterface): Promise<void> {
  await resolveLocal($);
  if (!localRepo) {
    return;
  }
  const ran = await $.process.run(
    ["git", "status", "--porcelain", "--", ".quest"],
    {
      cwd: dirFor(localRepo),
      timeoutMs: 10_000,
    },
  );
  const uncommitted =
    ran.exitCode === 0
      ? ran.stdout.split("\n").filter((line) => line.trim() !== "").length
      : 0;
  await update($, edits, (current) => ({ ...current, uncommitted }));
}

/**
 * Reads the unlanded count once, on whichever comes first: the session start,
 * or the first read -- the same two paths discovery uses, and for the same
 * reason. `claude plugin test` never fires `session.start`, so a kit-mounted
 * pane drew no window at all, and no window looks exactly like nothing worth
 * warning about.
 *
 * The count is what makes the id-collision window visible. `quest task create`
 * takes the next id from the working tree plus every LOCAL ref, so a record
 * that is written but not yet committed is invisible to this repository's
 * other checkouts, and a create in one of those can mint the same id.
 * Measured on this branch: two checkouts of one repository, one record each
 * left uncommitted, both minted T-1; committing the first closed the window
 * and the next create minted T-2.
 */
async function ensureUncommitted($: EngineInterface): Promise<void> {
  if (isUncommittedResolved) {
    return;
  }
  isUncommittedResolved = true;
  await countUncommitted($);
}

// The alerts check. It keeps a clock of its own rather than hanging off a draw,
// because an alert matters most when the pane is closed: it is the one read
// here that is not about what the pane is showing.
const ALERTS_MS = 120_000;
const ALERTS_KEY = "opum-quest.board.alerts";

// Whether the check has been started, and whether it has run once. The first
// check of a session records a baseline -- or, when a state was already stored,
// reports what moved while no session was running; every later one is a change
// since the check before it.
let isAlertsStarted = false;
let isAlertsChecked = false;

// The status line this session pinned, so a count that has not moved is not
// pinned again on every check.
let waitingShown: string | undefined;

type AlertsRead = {
  repo: string;
  decisions: AlertDecision[];
  open: AlertTask[];
};

/**
 * Reads one repository for the check: its decisions and its open tasks.
 *
 * Null when either read failed, and that is the whole of the failure handling.
 * A repository that cannot be read is skipped for this check -- neither its
 * decisions nor its tasks are compared, and what it last reported is left
 * standing -- and the board's own "Could not read" line covers it where the
 * person can see it. The check never toasts about its own read errors.
 */
async function readAlerts(
  $: EngineInterface,
  repo: string,
): Promise<AlertsRead | null> {
  try {
    const decisions = parseDecisionList(
      await quest($, repo, decisionListArgs()),
    );
    const open = parseTaskList(await quest($, repo, listArgs("open", false)));
    const tasks: AlertTask[] = open.map((task) => ({
      repo,
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      resolution: null,
    }));

    return {
      repo,
      decisions: decisions.map((decision) => ({ repo, ...decision })),
      open: tasks,
    };
  } catch {
    return null;
  }
}

/** One `quest task view`, for a task that was open last check and is not now. */
async function lookUpTask(
  $: EngineInterface,
  repo: string,
  id: string,
): Promise<AlertTask | null> {
  try {
    const outcome = parseTaskOutcome(
      await quest($, repo, ["task", "view", id, "--max-notes", "1"]),
    );

    return { repo, ...outcome };
  } catch {
    return null;
  }
}

/** The status line the count of waiting decisions asks for: pinned or cleared. */
function setWaiting($: EngineInterface, waiting: number): void {
  const text = waitingStatus(waiting);
  if (text === waitingShown) {
    return;
  }
  waitingShown = text;
  $.ui.status(text);
}

async function checkAlerts($: EngineInterface): Promise<void> {
  const setting = parseAlerts(pluginOptions.alerts);
  if (setting === "off") {
    // Off is off: nothing is read and nothing is stored, and a count this
    // session pinned comes down rather than standing with nothing keeping it
    // current.
    if (waitingShown !== undefined) {
      waitingShown = undefined;
      $.ui.status(undefined);
    }

    return;
  }
  try {
    // The child this call may spend naming the repository is charged to the
    // tick below: it is a subprocess like any other (QCLI-494).
    const resolved = await resolveLocalAndReport($);
    const stored = await $.store.get(ALERTS_KEY);
    const isBaseline = !isAlertsState(stored);
    const previous: AlertsState = isBaseline
      ? { decisions: {}, tasks: {} }
      : stored;
    // This session's own repository only (QCLI-490), so a check costs two
    // children -- `decision list` and `task list` -- instead of two per
    // repository across a fleet.
    const one = localRepo === null ? null : await readAlerts($, localRepo);
    const read = one === null ? [] : [one];
    if (read.length === 0) {
      return;
    }
    const decisions = read.flatMap((one) => one.decisions);
    const open = read.flatMap((one) => one.open);
    // A task that left the open set is told Done from Closed by looking at it
    // once -- and only in a repository this check could read, since a
    // repository it could not read has left nothing to compare against.
    const openIds = new Map<string, Set<string>>();
    for (const task of open) {
      const ids = openIds.get(task.repo) ?? new Set<string>();
      ids.add(task.id);
      openIds.set(task.repo, ids);
    }
    // Classifying a departed task costs a third child, and a tick's budget is
    // {@link MAX_TICK_CHILDREN} (QCLI-490, DEC-172 (4bg) item 1 (d)). A tick
    // that finds more departed ids than the budget allows classifies what it
    // can and CARRIES the rest in the stored state below, so the next tick sees
    // them as departed again and none is ever lost -- the loop this replaced
    // spawned one child per departed task, unbounded.
    const departed: AlertTask[] = [];
    const carried: string[] = [];
    // Each read repo costs TWO children -- its `decision list` and its
    // `task list` -- so the reads spend twice their count. Seeding this with
    // `read.length` alone let the tick spawn four (QCLI-490 review round 1,
    // blocker): two reads plus two `task view` look-ups. QCLI-494 (DEC-172
    // (4bl)): the child `resolveLocalAndReport` spent naming the repository is
    // charged here too, so the bound of three holds by ARITHMETIC rather than
    // by the caller having resolved first -- the Pane render starts this check
    // ahead of its own resolveLocal.
    let spent = resolved.spent + read.length * 2;
    for (const [repo, ids] of Object.entries(previous.tasks)) {
      if (!read.some((one) => one.repo === repo)) {
        continue;
      }
      for (const id of Object.keys(ids)) {
        if (openIds.get(repo)?.has(id)) {
          continue;
        }
        if (spent >= MAX_TICK_CHILDREN) {
          carried.push(`${repo}\u0000${id}`);
          continue;
        }
        spent += 1;
        const left = await lookUpTask($, repo, id);
        if (left) {
          departed.push(left);
        }
      }
    }

    const changes = alertChanges(
      previous,
      { decisions, open, departed },
      setting,
    );
    setWaiting(
      $,
      decisions.filter((decision) => decision.status === "proposed").length,
    );
    if (isBaseline) {
      // The first check after install shows nothing: there is no earlier state
      // for a change to be a change from.
    } else if (isAlertsChecked) {
      for (const toast of alertToasts(changes)) {
        $.ui.toast(toast.text, { timeoutMs: toast.timeoutMs });
      }
    } else {
      // The first check after a restart: everything that moved while no session
      // was running, as one line rather than a dozen.
      const line = awayLine(changes);
      if (line) {
        $.ui.toast(line, { timeoutMs: 8_000 });
      }
    }
    isAlertsChecked = true;

    const tasks: AlertsState["tasks"] = { ...previous.tasks };
    for (const one of read) {
      tasks[one.repo] = {};
    }
    // Re-add the ids this tick could not afford to classify, with the status
    // they carried before, so they stay in the stored state and read as
    // departed again next tick rather than being dropped unclassified.
    for (const key of carried) {
      const [repo = "", id = ""] = key.split("\u0000");
      const ids = tasks[repo] ?? {};
      ids[id] = previous.tasks[repo]?.[id] ?? "";
      tasks[repo] = ids;
    }
    for (const task of open) {
      const ids = tasks[task.repo] ?? {};
      ids[task.id] = task.status;
      tasks[task.repo] = ids;
    }
    const seen: AlertsState["decisions"] = { ...previous.decisions };
    for (const decision of decisions) {
      seen[`${decision.repo}:${decision.id}`] = decision.status;
    }
    await $.store.set(ALERTS_KEY, { decisions: seen, tasks });
  } catch {
    // Quiet on purpose: a check that toasts about its own read errors is the
    // noise the alerts exist to keep down.
  }
}

/**
 * Starts the alerts check: once now, and every {@link ALERTS_MS} after that.
 *
 * Started from `session.start` and, on whichever comes first, the first draw --
 * the same two paths the uncommitted count uses, and for the same
 * reason: `claude plugin test` never fires `session.start`, so a kit-mounted
 * pane would otherwise never alert at all.
 */
// The alerts clock's handle, kept so `session.end` can cancel it, and its
// in-flight guard, so a check slower than its period is SKIPPED rather than
// started on top of itself (QCLI-490, DEC-172 (4bg) item 1 (c)).
let alertsTimer: Timer | null = null;
let isAlertsTicking = false;

/**
 * One check, guarded in flight. The whole callback is the guarded unit, so a
 * tick that finds the previous one still running is skipped -- the shape the
 * host-load incident had, where every tick's `void (async …)` returned at once
 * and the next started over it.
 */
function tickAlerts($: EngineInterface): void {
  if (isAlertsTicking) {
    return;
  }
  isAlertsTicking = true;
  void (async () => {
    try {
      await checkAlerts($);
    } finally {
      isAlertsTicking = false;
    }
  })();
}

/**
 * Starts the alerts check: once now, and every {@link ALERTS_MS} after that.
 *
 * Started from `session.start` and, on whichever comes first, the first draw --
 * the same two paths the uncommitted count uses, and for the same reason:
 * `claude plugin test` never fires `session.start`, so a kit-mounted pane would
 * otherwise never alert at all. Registered ONCE per process (the module guard),
 * its handle kept, and cancelled at `session.end`.
 */
function startAlerts($: EngineInterface): void {
  if (isAlertsStarted) {
    return;
  }
  isAlertsStarted = true;
  tickAlerts($);
  alertsTimer = $.clock.every(ALERTS_MS, () => {
    tickAlerts($);
  });
}

// The pane's ONE refresh clock for this process, and the guards that keep it
// single (QCLI-490, DEC-172 (4bg) item 1 (c)). `$.clock.every` hands back a
// handle, but the engine does not serialize a callback that returns before its
// work is done: the old code fired `void (async …)()` and returned at once, so
// a slow read-back let the next tick start on top of it. Two guards stand in
// for the serialization the engine cannot give a `void` callback: the
// registration is guarded once per process, and the WHOLE callback is guarded
// in flight, so a tick that finds the previous one running is skipped.
let refreshTimer: Timer | null = null;
let isRefreshTicking = false;

/**
 * Registers the refresh clock ONCE per process; every later call is a no-op.
 * Called where the pane is actually opened -- the interactive `session.start`,
 * or an explicit open (the `dashboard` tool, the band's button) in a process
 * the auto-start gate left alone -- and cancelled at `session.end`.
 */
function ensureClock($: EngineInterface): void {
  if (refreshTimer !== null) {
    return;
  }
  refreshTimer = $.clock.every(REFRESH_MS, () => {
    if (isRefreshTicking) {
      return;
    }
    isRefreshTicking = true;
    void (async () => {
      try {
        const panes = await $.ui.panes();
        if (panes.some((pane) => pane.id === PANE && pane.isShown)) {
          await refresh($);
          await countUncommitted($);
        }
      } finally {
        isRefreshTicking = false;
      }
    })();
  });
}

// Runs one Quest write in this session's own repo, then reloads what it touched.
async function write(
  $: EngineInterface,
  id: string,
  args: string[],
  done: string,
): Promise<boolean> {
  if (!localRepo) {
    return false;
  }
  const repo = localRepo;
  let isSaved = false;
  await update($, edits, (current) => ({ ...current, isWriting: true }));
  try {
    await quest($, repo, [...args, ...actorArgs(actor)]);
    $.ui.toast(done);
    isSaved = true;
  } catch (error) {
    const failure = error as Error & { exitCode?: number };
    $.ui.toast(
      failure.exitCode === 5
        ? `${id} changed since you opened it. It has been reloaded; try again.`
        : `Could not save ${id}: ${failure.message}`,
    );
  } finally {
    await update($, edits, (current) => ({ ...current, isWriting: false }));
  }
  const { selected } = await read($, view);
  if (selected && selected.repo === repo && selected.id === id) {
    await loadDetail($, repo, id);
  }
  await refresh($);
  await countUncommitted($);

  return isSaved;
}

async function editTask(
  $: EngineInterface,
  task: TaskDetail,
  args: string[],
  done: string,
) {
  const guard = task.revision ? ["--if-revision", task.revision] : [];
  await write($, task.id, ["task", "edit", task.id, ...args, ...guard], done);
}

async function createTask($: EngineInterface, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed || !localRepo) {
    return;
  }
  const repo = localRepo;
  try {
    const stdout = await quest($, repo, [
      "task",
      "create",
      trimmed,
      ...actorArgs(actor),
    ]);
    const id = String(
      (JSON.parse(stdout) as { data?: { id?: unknown } }).data?.id ?? "",
    );
    $.ui.toast(id ? `Created ${id}` : "Created the task");
    await refresh($);
    await countUncommitted($);
    if (id) {
      await select($, repo, id);
    }
  } catch (error) {
    $.ui.toast(
      `Could not create the task: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function closeTask($: EngineInterface, task: TaskDetail): Promise<void> {
  const answer = await $.ui.ask(`Close ${task.id} as won't do?`, [
    "Close it",
    "Keep it",
  ]);
  if (answer === "Close it") {
    await write(
      $,
      task.id,
      ["task", "close", task.id, "--resolution", "wont-do"],
      `Closed ${task.id}`,
    );
  }
}

async function savePrefs($: EngineInterface): Promise<void> {
  const { tab, status, isCollapsed, isFull, readRefs } = await read($, view);
  await $.store.set(PREFS_KEY, {
    tab,
    status,
    isCollapsed,
    isFull,
    readRefs,
  });
}

/**
 * Opens the pane at the size the two states ask for, with the viewport and the
 * drawn dock body the caller knows.
 *
 * `focus` is asked for only on a full toggle a PERSON starts -- the `z` key or
 * the button beside it. Everywhere else it is left off, and the cases that are
 * easy to mistake for a toggle are the ones that matter: a full mode restored
 * at `session.start`, the one ask that mode owes on its first render, and the
 * `dashboard` tool call, which Claude may make unasked. None of those is a
 * person asking for the pane, so none may take the keyboard off the prompt.
 *
 * A full open that carries numbers marks the session's ask as made (DEC-154
 * rule 2 as amended): every numbered full ask is made through here -- at a
 * toggle, or on the first render of a restored full mode -- and a resize or a
 * redraw never makes a second one. An open before any draw (a `session.start`)
 * asks the surface's own default and leaves the ask owed.
 *
 * The numbers are kept, and the ask stands ungranted until a full draw comes
 * within the slack of them (QCLI-456): the kept-width line and the tool's
 * short-size phrase read that outcome, so they claim a width the person set
 * only while THIS ask is the one that went ungranted.
 */
async function openPane(
  $: EngineInterface,
  state: Pick<View, "isCollapsed" | "isFull">,
  size: Partial<Viewport> = viewport,
  isFocused = false,
  dockBody: number | null = lastDockBodyColumns,
): Promise<UiOpenResult> {
  const asked = paneSize(state, size, dockBody);
  if (
    state.isFull &&
    !state.isCollapsed &&
    (asked.columns !== undefined || asked.rows !== undefined)
  ) {
    fullAskMade = true;
    fullAsk = { columns: asked.columns, rows: asked.rows };
    awaitingGrant = true;
  }

  return await $.ui.open({
    id: PANE,
    title: "Quest",
    ...(isFocused && !state.isCollapsed ? { focus: true as const } : {}),
    ...asked,
  });
}

async function setCollapsed(
  $: EngineInterface,
  isCollapsed: boolean,
): Promise<void> {
  await update($, view, (current) => ({ ...current, isCollapsed }));
  await savePrefs($);
  await $.ui.close({ id: PANE });
  await openPane($, await read($, view));
}

/**
 * The band's Open press: the person asking for the board, so the pane it seats
 * is placed at any width.
 *
 * The invalidate is what takes the band back down. The band is drawn only while
 * the pane waits undrawn, and without a redraw it would stand beneath a board
 * the press just seated.
 */
async function openBoardFromBand($: EngineInterface): Promise<void> {
  await openPane($, await read($, view), viewport, true);
  $.ui.invalidate("ui.render");
}

/**
 * The full-screen toggle: the largest pane the surface allows, or the normal
 * size, with the choice stored beside the pane's other settings. The caller is
 * a person's own press, so the pane is re-placed and handed the keyboard.
 */
async function setFull($: EngineInterface, isFull: boolean): Promise<void> {
  await setFullState($, isFull);
  await $.ui.close({ id: PANE });
  await openPane($, await read($, view), viewport, true);
}

/**
 * Records the full-size choice and nothing else: the shape the `dashboard`
 * tool uses, because a tool call is not a person asking for the pane and the
 * open it goes on to make must not take the keyboard. That open is what asks,
 * and it marks the session's ask as made (DEC-154 rule 2 as amended: one ask
 * per toggle).
 *
 * The mark is set here, before the view flips, when the toggle's ask will
 * carry the render's numbers: a draw landing between the flip and that open
 * then asks no second time. Measured on the seq 230 probe (QCLI-454): without
 * this, the first full toggle of a session opened twice, identical both
 * times; with it, once. Before any draw there are no numbers, nothing is
 * marked, and the first render still owes the ask.
 */
async function setFullState(
  $: EngineInterface,
  isFull: boolean,
): Promise<void> {
  if (isFull) {
    const asked = paneSize(
      { isCollapsed: false, isFull: true },
      viewport,
      lastDockBodyColumns,
    );
    if (asked.columns !== undefined || asked.rows !== undefined) {
      fullAskMade = true;
    }
  }
  await update($, view, (current) => ({ ...current, isFull }));
  await savePrefs($);
}

async function setTab($: EngineInterface, tab: Tab): Promise<void> {
  await update($, view, (current) => ({ ...current, tab, selected: null }));
  await savePrefs($);
  await refresh($);
}

async function setStatus(
  $: EngineInterface,
  status: StatusFilter,
): Promise<void> {
  await update($, view, (current) => ({ ...current, status, selected: null }));
  await savePrefs($);
  await refresh($);
}

async function setReadRefs(
  $: EngineInterface,
  readRefs: boolean,
): Promise<void> {
  await update($, view, (current) => ({
    ...current,
    readRefs,
    selected: null,
  }));
  await savePrefs($);
  await refresh($);
}

async function select(
  $: EngineInterface,
  repo: string,
  id: string,
): Promise<void> {
  await update($, view, (current) => ({
    ...current,
    selected: { repo, id },
    pending: null,
  }));
  await loadDetail($, repo, id);
}

/**
 * Resolves a bare task id to the repository that holds it, so the `dashboard`
 * tool's `task` can name one without the caller knowing where it lives.
 *
 * The board's own rows cannot answer this: they are read at one status filter,
 * so a task that is Done would read as unknown while existing. One `task view`
 * is the existence check that depends on the filter. A repository that cannot
 * be read is not a match either way -- the board's own "Could not read" line
 * reports that, and this probe decides nothing about it.
 */
async function findTask(
  $: EngineInterface,
  id: string,
): Promise<{ repo: string; id: string } | null> {
  const candidates = localRepo === null ? [] : [localRepo];
  for (const repo of candidates) {
    try {
      await quest($, repo, ["task", "view", id, "--max-notes", "1"]);
      return { repo, id };
    } catch {
      // Not in this workspace, or this one could not be read: ask the next.
    }
  }

  return null;
}

/** A tool argument as it was given, for an error result that names it. */
function quoted(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/**
 * The `dashboard` tool's one line, naming what it opened and the state it
 * applied -- the design's own example reads "Opened the Quest, OCLI-8
 * selected." (`pane-dashboard-tool-design.md`).
 *
 * The size it names is the one the surface granted, read off the pane's draw
 * that follows the open (DEC-154 rule 4): "full size" only when the drawn
 * size is within the frame slack of the ask; otherwise the drawn size and
 * why; and "full requested" when no draw has answered yet.
 *
 * The dock's short case mirrors rule 3's pane line -- the width the person
 * set, named as the pane's own width -- but only while that draw read a width
 * as holding: a shortfall with nothing holding (a grant the surface honoured,
 * then a resize or a drag under it, with nothing re-asked) names no owner
 * (seq 234, ODOC-OP-2026-10-03-65; QCLI-457), so it says the pane kept its
 * width instead of claiming the width is kept.
 */
function dashboardOpened(
  isFull: boolean | undefined,
  taskId: string | null,
  draw: {
    placement: Placement;
    drawn: number;
    granted: boolean | null;
    holding: boolean;
  } | null,
): string {
  const parts = ["Opened the Quest"];
  if (taskId) {
    parts.push(`${taskId} selected`);
  }
  const head = parts.join(", ");

  if (isFull === true) {
    if (draw === null) {
      return `${head}, full requested.`;
    }
    if (draw.granted === true) {
      return `${head}, full size.`;
    }

    return draw.placement === "dock"
      ? draw.holding
        ? `${head} at ${draw.drawn + FRAME_COLUMNS} columns; the width is kept.`
        : `${head} at ${draw.drawn + FRAME_COLUMNS} columns; the pane kept its width.`
      : `${head} at ${draw.drawn} rows; the screen keeps room for the prompt.`;
  }
  if (isFull === false) {
    return `${head}, normal size.`;
  }

  return `${head}.`;
}

/**
 * The tool's line when the surface kept the pane the call asked for undrawn.
 *
 * The floor is the engine's, not this mod's and not a constant: an unasked open
 * is placed from 144 terminal columns, or 110 for a pane id the person opened
 * before, and the engine remembers that across sessions. So this line quotes
 * the engine's own `reason` for the open it just made rather than composing a
 * number of its own (seq 213); below the floor the pane waits with no
 * `ui.render` raised at all. The band above the prompt carries the person's own
 * way in, and a press is placed at any width.
 */
function dashboardWaiting(reason: string | undefined): string {
  const waiting = reason
    ? `The Quest is waiting — ${reason}`
    : "The Quest is not shown.";

  return `${waiting} Press Open on the band above the prompt.`;
}

/**
 * Whether the board's pane is on screen right now, read from the engine's own
 * record.
 *
 * The tool reports on this, not on what its `$.ui.open` asked for: an open that
 * returned without error still leaves the pane waiting undrawn when the
 * terminal is under the floor an unasked pane is placed from, and a result
 * claiming otherwise names a pane the person cannot see (QCLI-444, seq 182).
 * Placed and shown are two facts -- a pane can be open, drawn and behind
 * another of the plugin's own -- and the board's one pane is only the second
 * when both hold.
 */
async function boardIsShown($: EngineInterface): Promise<boolean> {
  const panes = await $.ui.panes();
  const pane = panes.find((one) => one.id === PANE);

  return pane !== undefined && pane.isPlaced && pane.isShown;
}

function clockTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

function statusWords(status: StatusFilter): string {
  return status === "open" ? "open" : status.toLowerCase();
}

function shortName(repo: string): string {
  return repo.replace(/^opum-/, "");
}

/** What the across-refs read managed to read, folded over the rows. */
export function coverageLine(
  rows: RepoRow[],
  readRefs: boolean,
): string | null {
  if (!readRefs) {
    return null;
  }
  const read = rows.filter((row) => row.coverage !== null);
  if (read.length === 0) {
    return null;
  }
  const refs = read.reduce(
    (sum, row) => sum + (row.coverage?.refsRead ?? 0),
    0,
  );
  const partial = read.filter((row) => row.coverage?.complete !== true);
  if (partial.length === 0) {
    return `Across refs: ${refs} ref${refs === 1 ? "" : "s"} read, complete.`;
  }

  return `Across refs: ${refs} read, INCOMPLETE in ${partial
    .map((row) => row.repo)
    .join(
      ", ",
    )} -- a ref could not be read there, so an empty row is unread rather than empty.`;
}

export const register: Register = (on, options) => {
  pluginOptions = options;
  if (typeof options.actor === "string" && options.actor.trim()) {
    actor = options.actor.trim();
  }

  on("session.start", async ($, e, next) => {
    // The auto-start gate (QCLI-490, DEC-172 (4bg) item 1 (b)). A teammate
    // process carries CLAUDECODE=1; a headless/`-p` run, the SDK and a
    // dynamic-workflow child arrive with `!e.isInteractive`. Mod clocks running
    // in EVERY Claude process were the 2026-10-12 host-load incident (load
    // reached ~315), and this pane opened and re-read in every one of them. In
    // such a process: no pane, no clock and no read-back -- so not one child is
    // spawned for a view nobody draws. The tool is still registered below, so a
    // person's explicit open (the `dashboard` tool, the band's button) works in
    // a gated process too and starts the clock from then on.
    const gated = !e.isInteractive || (await $.env.get("CLAUDECODE")) === "1";

    const stored = await $.store.get(PREFS_KEY);
    if (isStoredView(stored)) {
      await update($, view, (current) => ({
        ...current,
        ...stored,
        isFull: stored.isFull === true,
        readRefs: stored.readRefs === true,
        selected: null,
      }));
    }

    // The board's way in. No slash command is registered: the plugin's own
    // skill owns `/opum-quest:quest`, so the engine refuses a command named
    // `quest`, and `quest-board` was dropped with it (QCLI-440, seq 176). The
    // skill routes the board's words to this tool instead.
    //
    // The description is listed to Claude in every session that loads the mod,
    // so it stays to two sentences.
    await $.tool.register({
      name: DASHBOARD_TOOL,
      description:
        "Open the Quest pane: the tasks being worked on in this session's own repository, and the detail of one. Use it when the person asks to see the board or a task in the pane.",
      inputSchema: {
        type: "object",
        properties: {
          full: {
            type: "boolean",
            description: "Open at the largest size the surface allows.",
          },
          task: {
            type: "string",
            description: "A task id to open in the detail view.",
          },
        },
      },
    });
    // A session starts before any draw: nothing has been measured, nothing has
    // been asked, and no full draw has taught the header anything. Whatever a
    // previous run of this module left behind -- reachable only where one copy
    // is shared, as in a test -- is not this session's own.
    viewport = {};
    lastDockBodyColumns = null;
    fullAskMade = false;
    fullAsk = null;
    awaitingGrant = false;

    // A gated process stops here. Everything below opens the pane, reads the
    // repository, or registers a clock, and none of it is wanted for a view
    // nobody draws -- this is the branch that makes a teammate or headless
    // process spawn zero children.
    if (gated) {
      return next(e);
    }

    await resolveLocal($);

    // No viewport has been measured yet -- `session.start` runs ahead of the
    // first draw -- so a stored full mode opens at the surface's default and
    // the first render asks once more, now that it can size it (DEC-154 rule 2
    // as amended).
    await openPane($, await read($, view));
    void refresh($);
    void ensureUncommitted($);
    startAlerts($);
    // The refresh clock, registered once per process. An explicit open in a
    // gated process registers it too, so the pane polls (only while shown) from
    // that open on.
    ensureClock($);

    return next(e);
  });

  // The clocks belong to this process, so `session.end` is where they are
  // cancelled (QCLI-490, DEC-172 (4bg) item 1 (c)): nothing else stops them,
  // and a timer left running would poll for a session that is gone. A fresh
  // `session.start` in the same process can register new ones.
  on("session.end", async (_$, e, next) => {
    refreshTimer?.cancel();
    refreshTimer = null;
    isRefreshTicking = false;
    alertsTimer?.cancel();
    alertsTimer = null;
    isAlertsStarted = false;
    isAlertsTicking = false;

    return next(e);
  });

  // The engine lists the registered `dashboard` tool to Claude as
  // `mcp__opum-quest__dashboard` and routes a call here.
  on("tool.call", { tool: DASHBOARD_TOOL_NAME }, async ($, e) => {
    // Bad input is reported, never guessed at -- the design's rule for a task
    // id applies to `full` as well, and a rejected call opens nothing at all.
    const full: boolean | undefined =
      typeof e.full === "boolean" ? e.full : undefined;
    if (e.full !== undefined && full === undefined) {
      return {
        deny: `Unknown full ${quoted(e.full)}: the Quest takes true or false. Nothing was opened.`,
      };
    }
    const wanted = typeof e.task === "string" ? e.task.trim() : undefined;
    if (e.task !== undefined && !wanted) {
      return {
        deny: `Unknown task ${quoted(e.task)}: the Quest takes a task id. Nothing was opened.`,
      };
    }

    await resolveLocal($);
    // Resolved before anything is opened, so an id that resolves nowhere
    // leaves the pane as it was rather than showing some other task.
    const target = wanted ? await findTask($, wanted) : null;
    if (wanted && !target) {
      return {
        deny: `Unknown task ${quoted(wanted)}: no Quest workspace on the board holds it. Nothing was opened.`,
      };
    }

    if (full !== undefined) {
      await setFullState($, full);
    }
    if (target) {
      await select($, target.repo, target.id);
    }
    // Re-placed so a size just chosen is the one drawn, and WITHOUT focus:
    // Claude may call this unasked while the person is typing, and the pane
    // never takes the keyboard for that (the design's rule, and the same one a
    // full mode restored at `session.start` follows).
    await $.ui.close({ id: PANE });
    const opened = await openPane($, await read($, view));
    // A person's or a model's open in a process the auto-start gate left alone
    // registers the clock here, so the pane polls (only while shown) from this
    // open on; it is a no-op when `session.start` already registered it.
    ensureClock($);
    void refresh($);

    // What the call reports is what the engine's record says happened, not what
    // the open asked for: an unasked pane waits undrawn below the floor it is
    // placed from, and the model reads this line as fact. The waiting line
    // quotes this open's own `reason` for why, so the floor it names is the
    // engine's number rather than one composed here. The size it names is the
    // last draw's own record, trusted only while that draw still matches the
    // mode this call applied (QCLI-454): a full claim the surface did not
    // grant is the line this replaces.
    const current = await read($, view);
    const draw =
      full === true &&
      lastRendered?.isFull === true &&
      lastRendered.isCollapsed === false &&
      current.isFull &&
      !current.isCollapsed
        ? lastRendered
        : null;
    return {
      result: (await boardIsShown($))
        ? dashboardOpened(full, target?.id ?? null, draw)
        : dashboardWaiting(opened.isPlaced ? undefined : opened.reason),
    };
  });

  // The board's way in on a terminal too narrow to seat a pane nobody asked
  // for, and the reason the tool's own line can be honest: `$.ui.open` places
  // an UNASKED pane only from 144 terminal columns, so the open at
  // `session.start` -- and a `dashboard` call, which Claude may make unasked --
  // leaves the board waiting undrawn with no way to reach it. A press is the
  // person asking, and a person's ask is placed at any width.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const panes = await $.ui.panes();
    const pane = panes.find((one) => one.id === PANE);
    if (!pane || pane.isPlaced) {
      return next(e);
    }
    const { Box, Button, Text } = $.ui.resolve(e);

    // The line names the focus step the `o` hotkey needs: a letter hotkey
    // reaches the Button only once the band holds the focus (ctrl+x tab), where
    // a click needs none and a bare `o` in the composer only types into it
    // (seq 213, with the waiting line above).
    return (
      <Box>
        <Text>Quest ready · </Text>
        <Button
          key="open-board"
          label="Open"
          hotkey="o"
          onPress={() => void openBoardFromBand($)}
        />
        <Text> (ctrl+x tab, o)</Text>
      </Box>
    );
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    startAlerts($);
    const { rows, refreshedAt, isLoading } = await read($, board);
    if (e.surface === "mobile") {
      const { Box, Text } = $.ui.resolve(e);
      const total = rows.reduce((sum, row) => sum + row.tasks.length, 0);

      return (
        <Box flexDirection="column">
          <Text>
            {total} tasks. Open the board in the terminal or desktop to filter.
          </Text>
        </Box>
      );
    }
    const { Box, Button, Input, Markdown, Select, Text } = $.ui.resolve(e);
    const current = await read($, view);
    const width = Math.max(16, e.props.bodyColumns);

    // A draw is the only place the surface is measured. The viewport and the
    // docked body are kept so a toggle outside a draw asks with the latest
    // render's numbers, and a full mode restored at `session.start` -- which
    // could not size it -- asks once here, on its first render. DEC-154 rule 2
    // as amended: every other ask belongs to a toggle, and a resize or a
    // redraw never asks again.
    //
    // This ask is the pane's own, not a person's, so it is made WITHOUT focus:
    // the person may be typing, and a pane that grabbed the keyboard on a
    // redraw they did not make would move their keys mid-word.
    if (e.viewport) {
      viewport = { columns: e.viewport.columns, rows: e.viewport.rows };
    }
    lastDockBodyColumns =
      e.props.placement === "dock" ? e.props.bodyColumns : null;
    // The ask this draw fires, if the stored mode still owes one. The ask's
    // numbers are set synchronously by `openPane` below, so this draw is also
    // the first draw that can speak of the width (seq 243): the kept-width
    // line must not wait on a later repaint, because an ask that changes
    // nothing on a surface that keeps its width has no reason to force one,
    // and the line then never reaches the pane (the operator's re-test).
    const owesFullAsk =
      e.viewport !== undefined &&
      current.isFull &&
      !current.isCollapsed &&
      !fullAskMade;
    if (owesFullAsk) {
      void openPane($, current, viewport);
    }

    const shown = filterRows(rows, current.query);
    const busy = shown.filter((row) => row.tasks.length > 0);
    const failed = rows.filter((row) => row.error !== null);
    const total = busy.reduce((sum, row) => sum + row.tasks.length, 0);
    const refsLine = coverageLine(rows, current.readRefs);
    const hasConflict = rows.some((row) =>
      row.tasks.some((task) => task.conflict),
    );
    // A width the surface kept rather than granted is said out loud, so the
    // pane does not claim a size it did not get. What is kept is the ask's
    // OUTCOME, not a reading of this draw against what full mode would ask
    // for now: after a granted ask a widening lifts the fresh ask while the
    // pane keeps the grant and nothing is re-asked, and that shortfall has no
    // width of anyone's behind it (QCLI-456). The dock is measured across and
    // the inline block down, so each reads the axis of the ask it made
    // (DEC-154 rules 1 and 3: the dock says the width is kept; an inline
    // block is content-sized and needs no notice). Whether THIS draw may
    // carry the line -- including the draw that makes the ask -- is decided
    // below, where the ask's outcome is read.
    const drawnAxis =
      e.props.placement === "dock"
        ? e.props.bodyColumns
        : e.props.scroll.bodyRows;
    const inFull = current.isFull && !current.isCollapsed;
    const askedAxis = !inFull
      ? null
      : e.props.placement === "dock"
        ? (fullAsk?.columns ?? null)
        : (fullAsk?.rows ?? null);
    const isShort = askedAxis !== null && isSizeHeld(drawnAxis, askedAxis);
    if (askedAxis !== null && !isShort && !owesFullAsk) {
      // A full draw at the size the ask named is a grant: this machine honours
      // asks, so nothing is holding any more.
      awaitingGrant = false;
    }
    // The draw that MAKES the ask carries the line too (seq 243), but only
    // when it is genuinely short of the ask it just made: the ask's numbers
    // are in by the time this runs, an ask that goes ungranted proves nothing
    // further, and a draw after it is not owed -- a surface that keeps its
    // width has no reason to repaint, so waiting for one is how the line goes
    // missing on the very surface it is about. A draw already at the ask's
    // size is a surface that grants, and claims nothing; a surface that grants
    // LATER clears the reading on the draw that answers it, so the claim never
    // survives the answer.
    const holding = inFull && awaitingGrant && (!owesFullAsk || isShort);
    const notice = keptWidthNotice(
      current,
      e.props.placement,
      drawnAxis,
      holding,
    );
    lastRendered = {
      isFull: current.isFull,
      isCollapsed: current.isCollapsed,
      placement: e.props.placement,
      drawn: drawnAxis,
      asked: askedAxis,
      granted: askedAxis === null ? null : !isShort,
      holding,
    };
    if (current.isCollapsed) {
      return (
        <Box flexDirection="column">
          {rows.map((row) => (
            <Text
              dimColor={row.tasks.length === 0}
              color={row.error ? "red" : undefined}
              wrap="truncate"
            >
              {shortName(row.repo).padEnd(width - 4)}
              {row.error ? " ?" : String(row.tasks.length).padStart(3)}
            </Text>
          ))}
          <Box marginTop={1}>
            <Text dimColor>
              {total} {statusWords(current.status)}{" "}
            </Text>
          </Box>
          <Button
            key="expand"
            label="Expand"
            hotkey="c"
            onPress={() => void setCollapsed($, false)}
          />
        </Box>
      );
    }

    const summary =
      refreshedAt === null
        ? "Reading the trackers…"
        : `${total} ${statusWords(current.status)} ${total === 1 ? "task" : "tasks"} in ${localRepo ?? "this repo"}, checked ${clockTime(refreshedAt)}${isLoading ? ", refreshing" : ""}${current.readRefs ? " (across refs)" : ""}`;

    const selectedKey = current.selected
      ? `${current.selected.repo}:${current.selected.id}`
      : null;
    const open = selectedKey ? await read($, detail) : null;
    // At 120 body columns or more the list and the detail go side by side; the
    // detail then sits beside the list rather than under it, so the list is no
    // longer cut short to leave it room.
    const isSideBySide = open !== null && isWideLayout(e.props.bodyColumns);
    const listWidth = isSideBySide
      ? Math.max(24, Math.floor((width - 1) / 2))
      : width;
    const detailWidth = isSideBySide
      ? Math.max(24, width - listWidth - 1)
      : width;
    const listRoom =
      open && !isSideBySide
        ? Math.max(5, e.props.scroll.bodyRows - 18)
        : Number.POSITIVE_INFINITY;
    let drawn = 0;
    await resolveLocal($);
    const task = open?.task ?? null;
    const canEdit =
      !!task &&
      current.selected?.repo === localRepo &&
      task.status !== "Done" &&
      task.status !== "Closed";
    const selectedRow = current.selected
      ? rows
          .find((row) => row.repo === current.selected?.repo)
          ?.tasks.find((one) => one.id === current.selected?.id)
      : undefined;
    const { isWriting, uncommitted } = await read($, edits);
    const banner =
      uncommitted > 0 && localRepo ? (
        <Box marginTop={1}>
          <Text color="yellow" wrap="truncate">
            {uncommitted} tracker {uncommitted === 1 ? "change" : "changes"} in{" "}
            {localRepo} not committed yet. Until they land, this repository's
            other checkouts cannot see the ids in them and can mint the same
            ones.{" "}
          </Text>
          <Button
            key="land"
            label="Ask Claude to land them"
            onPress={() =>
              void $.prompt.fill({
                text: `Land the uncommitted Quest tracker changes in ${localRepo} through a branch and pull request, following the opum-sdlc skill. Land them promptly: until they are committed, this repository's other checkouts cannot see the task ids in them and can mint the same ones.`,
                mode: "replace",
              })
            }
          />
        </Box>
      ) : null;

    const tabs = (
      <Box>
        <Button
          key="tab-list"
          label="List"
          hotkey="1"
          variant={current.tab === "list" ? "primary" : undefined}
          onPress={() => void setTab($, "list")}
        />
        <Text> </Text>
        <Button
          key="tab-kanban"
          label="Kanban"
          hotkey="2"
          variant={current.tab === "kanban" ? "primary" : undefined}
          onPress={() => void setTab($, "kanban")}
        />
      </Box>
    );

    if (current.tab === "kanban") {
      const columnWidth = Math.max(
        10,
        Math.floor((width - 2) / COLUMNS.length),
      );
      const tasks = shown.flatMap((row) =>
        row.tasks.map((task) => ({ repo: row.repo, task })),
      );

      return (
        <Box flexDirection="column">
          {tabs}
          <Input
            key="search"
            placeholder="Filter by id, title or label"
            value={current.query}
            submitLabel="Filter"
            onInput={(value: string) =>
              void update($, view, (v) => ({ ...v, query: value }))
            }
            onSubmit={(value: string) =>
              void update($, view, (v) => ({ ...v, query: value }))
            }
          />
          <Text dimColor wrap="truncate">
            {refreshedAt === null
              ? "Reading the trackers…"
              : `${tasks.length} open ${tasks.length === 1 ? "task" : "tasks"} in ${localRepo ?? "this repo"}, checked ${clockTime(refreshedAt)}. Read-only: open a task from the List tab to change it.`}
          </Text>
          {banner}
          <Box marginTop={1}>
            {COLUMNS.map((column) => {
              const cards = tasks.filter((item) => item.task.status === column);

              return (
                <Box flexDirection="column" width={columnWidth} marginRight={1}>
                  <Text bold wrap="truncate">
                    {column} ({cards.length})
                  </Text>
                  {cards.slice(0, 30).map((item) => (
                    <Text
                      wrap="truncate"
                      color={
                        item.task.priority === "high" ? "yellow" : undefined
                      }
                    >
                      {item.task.id}
                    </Text>
                  ))}
                  {cards.length > 30 && (
                    <Text dimColor>{cards.length - 30} more</Text>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        {tabs}
        <Box>
          <Button
            key="refs"
            label="Refs"
            hotkey="g"
            variant={current.readRefs ? "primary" : undefined}
            onPress={() => void setReadRefs($, !current.readRefs)}
          />
          <Text> </Text>
          <Button
            key="refresh"
            label="Refresh"
            hotkey="r"
            onPress={() => void refresh($)}
          />
          <Text> </Text>
          <Button
            key="full"
            label={
              // The CURRENT mode as state, the key as a hint (seq 243,
              // opum-doc's ruling): "Normal size" named the action and read
              // as the current size. The kept-width line below says what a
              // kept width is doing; the header does not try to.
              current.isFull ? "Full · z for normal" : "Normal · z for full"
            }
            hotkey="z"
            variant={current.isFull ? "primary" : undefined}
            onPress={() => void setFull($, !current.isFull)}
          />
          <Text> </Text>
          <Button
            key="collapse"
            label="Collapse"
            hotkey="c"
            onPress={() => void setCollapsed($, true)}
          />
        </Box>
        <Input
          key="search"
          placeholder="Filter by id, title or label"
          value={current.query}
          submitLabel="Filter"
          onInput={(value: string) =>
            void update($, view, (v) => ({
              ...v,
              query: value,
              selected: null,
            }))
          }
          onSubmit={(value: string) =>
            void update($, view, (v) => ({ ...v, query: value }))
          }
        />
        <Box>
          <Select
            key="status"
            label="Status"
            value={current.status}
            options={STATUSES}
            onSelect={(value: string) =>
              void setStatus($, value as StatusFilter)
            }
          />
          {/* The repo Select went with fleet mode (QCLI-490): the board reads
              this session's own repository and nothing else. */}
        </Box>
        <Text dimColor wrap="truncate">
          {summary}
        </Text>
        {notice && (
          <Text dimColor wrap="truncate">
            {notice}
          </Text>
        )}
        {refsLine && (
          <Text
            dimColor={!refsLine.includes("INCOMPLETE")}
            color={refsLine.includes("INCOMPLETE") ? "yellow" : undefined}
            wrap="truncate"
          >
            {refsLine}
          </Text>
        )}
        {hasConflict && (
          <Text dimColor wrap="truncate">
            * marks a task whose refs disagree about its status; origin/dev is
            drawn where it has one. Resolving it is that repository&apos;s
            session&apos;s call.
          </Text>
        )}
        {localRepo && (
          <Input
            key="new-task"
            placeholder={`New task in ${localRepo}`}
            submitLabel="Create"
            onSubmit={(value: string) => void createTask($, value)}
          />
        )}
        {banner}

        <Box key="layout" flexDirection={isSideBySide ? "row" : "column"}>
          <Box flexDirection="column" width={listWidth}>
            {refreshedAt !== null && total === 0 && failed.length === 0 && (
              <Box marginTop={1}>
                <Text dimColor>
                  {current.query
                    ? "No tasks match. Clear the filter or pick another status."
                    : `No ${statusWords(current.status)} tasks in this repo.`}
                </Text>
              </Box>
            )}

            {busy.map((row) => {
              if (drawn >= listRoom) {
                return null;
              }

              return (
                <Box key={row.repo} flexDirection="column" marginTop={1}>
                  <Text bold>{row.repo}</Text>
                  {row.tasks.map((task) => {
                    drawn += 1;
                    if (drawn > listRoom) {
                      return null;
                    }
                    const key = `${row.repo}:${task.id}`;
                    const mark = task.conflict
                      ? "*"
                      : task.priority === "high"
                        ? "!"
                        : " ";
                    const proposed = task.proposedBy
                      ? `  [${task.proposedBy}]`
                      : "";
                    const label = `${mark} ${task.id}  ${task.title}${proposed}`;
                    if (key === selectedKey) {
                      return (
                        <Text key={key} inverse wrap="truncate">
                          {label}
                        </Text>
                      );
                    }

                    return (
                      <Button
                        key={`row:${key}`}
                        plain
                        label={
                          label.length > listWidth
                            ? `${label.slice(0, listWidth - 1)}…`
                            : label
                        }
                        onPress={() => void select($, row.repo, task.id)}
                      />
                    );
                  })}
                </Box>
              );
            })}
            {drawn > listRoom && (
              <Text dimColor>
                {drawn - listRoom} more. Close the details to see them all.
              </Text>
            )}

            {failed.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text color="red">Could not read:</Text>
                {failed.map((row) => (
                  <Text key={row.repo} dimColor wrap="truncate">
                    {"  "}
                    {row.repo}: {row.error}
                  </Text>
                ))}
              </Box>
            )}
          </Box>

          {open && (
            <Box
              flexDirection="column"
              width={detailWidth}
              marginTop={isSideBySide ? 0 : 1}
            >
              <Text dimColor>{"─".repeat(detailWidth)}</Text>
              {open.isLoading && (
                <Text dimColor>Loading {current.selected?.id}…</Text>
              )}
              {open.error && (
                <Text color="red">
                  Could not load {current.selected?.id}: {open.error}
                </Text>
              )}
              {open.error && selectedRow?.proposedBy && (
                <Text dimColor wrap="wrap">
                  {current.selected?.id} exists on {selectedRow.proposedBy} and
                  not in this checkout, so the detail reads nothing here. It is
                  on the board from the refs read.
                </Text>
              )}
              {open.task && (
                <Box flexDirection="column">
                  <Text bold wrap="wrap">
                    {open.task.id} {open.task.title}
                  </Text>
                  <Text dimColor wrap="truncate">
                    {[
                      open.task.status,
                      open.task.priority
                        ? `${open.task.priority} priority`
                        : null,
                      open.task.type,
                      open.task.updatedAt
                        ? `updated ${open.task.updatedAt.slice(0, 16).replace("T", " ")}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </Text>
                  {open.task.labels.length > 0 && (
                    <Text dimColor wrap="truncate">
                      Labels: {open.task.labels.join(", ")}
                    </Text>
                  )}
                  {open.task.description && (
                    <Box marginTop={1}>
                      <Markdown
                        text={
                          open.task.description.length > 700
                            ? `${open.task.description.slice(0, 700)}…`
                            : open.task.description
                        }
                      />
                    </Box>
                  )}
                  {open.task.criteria.length > 0 && (
                    <Box flexDirection="column" marginTop={1}>
                      <Text>
                        Acceptance criteria,{" "}
                        {open.task.criteria.filter((c) => c.isChecked).length}{" "}
                        of {open.task.criteria.length} checked
                      </Text>
                      {open.task.criteria.slice(0, 8).map((item) =>
                        canEdit && task ? (
                          <Button
                            key={`ac:${item.position}`}
                            plain
                            label={`${item.isChecked ? "☑" : "☐"} ${item.text}`.slice(
                              0,
                              detailWidth,
                            )}
                            onPress={() =>
                              void editTask(
                                $,
                                task,
                                [
                                  item.isChecked
                                    ? "--uncheck-ac"
                                    : "--check-ac",
                                  String(item.position),
                                ],
                                `${item.isChecked ? "Unchecked" : "Checked"} criterion ${item.position} on ${task.id}`,
                              )
                            }
                          />
                        ) : (
                          <Text
                            key={`ac:${item.position}`}
                            dimColor={item.isChecked}
                            wrap="truncate"
                          >
                            {item.isChecked ? "☑ " : "☐ "}
                            {item.text}
                          </Text>
                        ),
                      )}
                    </Box>
                  )}
                  {open.task.dependencies.length > 0 && (
                    <Text dimColor wrap="truncate">
                      Depends on {open.task.dependencies.join(", ")}
                    </Text>
                  )}
                  {open.task.latestNote && (
                    <Box flexDirection="column" marginTop={1}>
                      <Text>Latest note</Text>
                      <Text dimColor wrap="wrap">
                        {open.task.latestNote.length > 400
                          ? `${open.task.latestNote.slice(0, 400)}…`
                          : open.task.latestNote}
                      </Text>
                    </Box>
                  )}
                </Box>
              )}
              {open.task && open.task.comments.length > 0 && (
                <Box flexDirection="column" marginTop={1}>
                  <Text>Comments</Text>
                  {open.task.comments.slice(-3).map((comment) => (
                    <Text
                      key={`${comment.author}-${comment.createdAt}`}
                      dimColor
                      wrap="wrap"
                    >
                      {comment.author},{" "}
                      {comment.createdAt.slice(0, 16).replace("T", " ")}:{" "}
                      {comment.body.length > 300
                        ? `${comment.body.slice(0, 300)}…`
                        : comment.body}
                    </Text>
                  ))}
                </Box>
              )}
              {open.task &&
                current.selected &&
                current.selected.repo !== localRepo && (
                  <Box marginTop={1}>
                    <Text dimColor wrap="wrap">
                      Read-only here. {current.selected.repo} is edited from its
                      own session.
                    </Text>
                  </Box>
                )}
              {canEdit && task && (
                <Box flexDirection="column" marginTop={1}>
                  <Box>
                    {(task.status === "To Do" || task.status === "Paused") && (
                      <Button
                        key="start"
                        label={task.status === "Paused" ? "Resume" : "Start"}
                        hotkey="s"
                        onPress={() =>
                          void write(
                            $,
                            task.id,
                            ["task", "start", task.id],
                            `${task.status === "Paused" ? "Resumed" : "Started"} ${task.id}`,
                          )
                        }
                      />
                    )}
                    {task.status === "In Progress" && (
                      <Button
                        key="pause"
                        label="Pause"
                        hotkey="p"
                        onPress={() =>
                          void write(
                            $,
                            task.id,
                            ["task", "pause", task.id],
                            `Paused ${task.id}`,
                          )
                        }
                      />
                    )}
                    {task.status === "In Progress" && <Text> </Text>}
                    {task.status === "In Progress" && (
                      <Button
                        key="complete"
                        label="Complete"
                        hotkey="d"
                        onPress={() =>
                          void update($, view, (v) => ({
                            ...v,
                            pending: "complete" as const,
                          }))
                        }
                      />
                    )}
                    <Text> </Text>
                    <Button
                      key="close-task"
                      label="Close as won't do"
                      onPress={() => void closeTask($, task)}
                    />
                  </Box>
                  {current.pending === "complete" && (
                    <Box flexDirection="column" marginTop={1}>
                      <Input
                        key="final-summary"
                        label="Final summary"
                        placeholder="What happened, in a sentence or two"
                        submitLabel="Complete"
                        onSubmit={(value: string) =>
                          void (async () => {
                            const summaryText = value.trim();
                            const isSaved = await write(
                              $,
                              task.id,
                              [
                                "task",
                                "complete",
                                task.id,
                                ...(summaryText
                                  ? ["--final-summary", summaryText]
                                  : []),
                              ],
                              `Completed ${task.id}`,
                            );
                            if (isSaved) {
                              await update($, view, (v) => ({
                                ...v,
                                pending: null,
                              }));
                            }
                          })()
                        }
                      />
                      <Button
                        key="cancel-complete"
                        label="Cancel"
                        onPress={() =>
                          void update($, view, (v) => ({ ...v, pending: null }))
                        }
                      />
                    </Box>
                  )}
                  <Select
                    key="priority"
                    label="Priority"
                    value={task.priority ?? "medium"}
                    options={[
                      { value: "high", label: "High" },
                      { value: "medium", label: "Medium" },
                      { value: "low", label: "Low" },
                    ]}
                    onSelect={(value: string) =>
                      void (
                        value !== task.priority &&
                        editTask(
                          $,
                          task,
                          ["--priority", value],
                          `Set ${task.id} to ${value} priority`,
                        )
                      )
                    }
                  />
                  <Input
                    key="rename"
                    placeholder="Rename to…"
                    submitLabel="Rename"
                    onSubmit={(value: string) =>
                      void (
                        value.trim() &&
                        value.trim() !== task.title &&
                        editTask(
                          $,
                          task,
                          ["--title", value.trim()],
                          `Renamed ${task.id}`,
                        )
                      )
                    }
                  />
                  <Input
                    key="label"
                    placeholder="Add a label"
                    submitLabel="Add label"
                    onSubmit={(value: string) =>
                      void (
                        value.trim() &&
                        editTask(
                          $,
                          task,
                          ["--add-label", value.trim()],
                          `Labelled ${task.id} ${value.trim()}`,
                        )
                      )
                    }
                  />
                  <Input
                    key="comment"
                    placeholder="Add a comment"
                    submitLabel="Comment"
                    onSubmit={(value: string) =>
                      void (async () => {
                        const body = value.trim();
                        if (!body) {
                          return;
                        }
                        const now = await $.clock.now();
                        await editTask(
                          $,
                          task,
                          ["--add-comment", commentArg(actor, body, now)],
                          `Commented on ${task.id}`,
                        );
                      })()
                    }
                  />
                  {isWriting && <Text dimColor>Saving…</Text>}
                </Box>
              )}
              <Box marginTop={1}>
                <Button
                  key="copy"
                  label="Copy id"
                  hotkey="y"
                  onPress={(pressed) =>
                    void (
                      current.selected &&
                      $.ui.copy({
                        text: current.selected.id,
                        surface: pressed.surface,
                      })
                    )
                  }
                />
                <Text> </Text>
                <Button
                  key="close-detail"
                  label="Close details"
                  hotkey="x"
                  onPress={() =>
                    void update($, view, (v) => ({ ...v, selected: null }))
                  }
                />
              </Box>
            </Box>
          )}
        </Box>
      </Box>
    );
  });
};
