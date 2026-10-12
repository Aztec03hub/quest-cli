// The Quest board's state contract and the shapes the pane draws from.
//
// `.claude-plugin/plugin.json` names this file as the plugin's `types`, and
// `claude plugin validate` holds every `$.state` key the hooks module names to
// what is declared under `PluginState` here. The `hooks/` module imports these
// types with `import type`, so this file carries no runtime code.

/** One task as the board draws it in a row. */
export type QuestTask = {
  id: string;
  title: string;
  status: string;
  /** Null in the across-refs read, which reports no priority. */
  priority: string | null;
  /** Empty in the across-refs read, which reports no labels. */
  labels: string[];
  /** `owner/repo#N` when the record exists only on a pull request head. */
  proposedBy: string | null;
  /** True when the refs disagree about this id's status. */
  conflict: boolean;
};

/** What the across-refs read says it actually managed to read. */
export type Coverage = {
  complete: boolean;
  refsRead: number;
  refsUnreadable: string[];
};

/** One repository's row: its tasks, or why it could not be read. */
export type RepoRow = {
  repo: string;
  tasks: QuestTask[];
  error: string | null;
  /** Null unless the row was read across refs. */
  coverage: Coverage | null;
};

// "open" is every status but Done and Closed; the rest are Quest statuses.
export type StatusFilter =
  | "open"
  | "In Progress"
  | "To Do"
  | "Paused"
  | "Done"
  | "Closed";

export type Tab = "list" | "kanban";

export type Board = {
  rows: RepoRow[];
  refreshedAt: number | null;
  isLoading: boolean;
};

export type View = {
  tab: Tab;
  status: StatusFilter;
  query: string;
  isCollapsed: boolean;
  /** The full-screen toggle: the largest pane the surface allows, or the normal size. */
  isFull: boolean;
  /** Read across refs (`quest task list --across-refs`) instead of the working tree. */
  readRefs: boolean;
  selected: { repo: string; id: string } | null;
  pending: "complete" | null;
};

export type Edits = {
  isWriting: boolean;
  uncommitted: number;
};

export type TaskDetail = {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  type: string | null;
  labels: string[];
  description: string;
  revision: string | null;
  criteria: { text: string; isChecked: boolean; position: number }[];
  comments: { author: string; body: string; createdAt: string }[];
  dependencies: string[];
  latestNote: string | null;
  updatedAt: string | null;
};

export type Detail = {
  key: string | null;
  task: TaskDetail | null;
  error: string | null;
  isLoading: boolean;
};

declare module "claude-code" {
  interface PluginState {
    "opum-quest": { board: Board; view: View; detail: Detail; edits: Edits };
  }
}
