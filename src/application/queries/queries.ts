import {
  compareTaskIds,
  searchTasks,
  type TaskState,
} from "../../domain/tasks/tasks.ts";
import type { TaskReader } from "../tasks/tasks.ts";
import type { WorkspaceEntry } from "../workspaces/workspaces.ts";

/** A read-only view of a disposable projection.  This port intentionally has no repair operation. */
export interface ProjectionTaskReader {
  readAll(): Promise<ProjectionTaskSnapshot>;
}

export interface ProjectionTaskSnapshot {
  /** The enrolled worktree that this projection was built for. */
  readonly workspaceId: string;
  /** The authoritative revision at which the projection was built. */
  readonly revision: string;
  readonly tasks: readonly TaskState[];
}

export type QuerySource = "projection" | "authoritative";

export interface TaskQueryResult {
  readonly tasks: readonly TaskState[];
  readonly source: QuerySource;
  /** Why the authoritative in-memory result was used instead of a projection. */
  readonly projection: "matching" | "unavailable" | "stale";
}

/**
 * Read routing for one enrolled workspace.
 *
 * The authoritative snapshot is deliberately read before considering SQLite:
 * a projection is usable only when it identifies this workspace and the same
 * revision.  Reading a missing, stale, corrupt, or incompatible projection is
 * never a reason to create, refresh, or repair it.
 */
export class WorkspaceTaskQueries {
  constructor(
    private readonly workspaceId: string,
    private readonly authoritative: TaskReader,
    private readonly projection?: ProjectionTaskReader,
  ) {}

  async list(): Promise<TaskQueryResult> {
    const authoritative = await this.authoritative.readAll();
    const projection = await this.readMatchingProjection(
      authoritative.revision,
      authoritative.tasks,
    );
    if (projection.snapshot)
      return {
        tasks: [...projection.snapshot.tasks].sort((a, b) =>
          compareTaskIds(a.id, b.id),
        ),
        source: "projection",
        projection: "matching",
      };
    return {
      tasks: [...authoritative.tasks].sort((a, b) =>
        compareTaskIds(a.id, b.id),
      ),
      source: "authoritative",
      projection: projection.state,
    };
  }

  async search(query: string): Promise<TaskQueryResult> {
    const result = await this.list();
    return { ...result, tasks: searchTasks(result.tasks, query) };
  }

  private async readMatchingProjection(
    revision: string,
    authoritative: readonly TaskState[],
  ): Promise<{
    readonly snapshot?: ProjectionTaskSnapshot;
    readonly state: "unavailable" | "stale";
  }> {
    if (!this.projection) return { state: "unavailable" };
    try {
      const snapshot = await this.projection.readAll();
      return snapshot.workspaceId === this.workspaceId &&
        snapshot.revision === revision &&
        sameTasks(snapshot.tasks, authoritative)
        ? { snapshot, state: "unavailable" }
        : { state: "stale" };
    } catch {
      return { state: "unavailable" };
    }
  }
}

function sameTasks(
  left: readonly TaskState[],
  right: readonly TaskState[],
): boolean {
  const encode = (tasks: readonly TaskState[]) =>
    tasks
      .map((task) => JSON.stringify(task))
      .sort()
      .join("\n");
  return encode(left) === encode(right);
}

export interface EnrolledWorkspaceQueryMember {
  /** This collection is the explicit enrollment boundary; callers must not add discovered worktrees. */
  readonly workspace: WorkspaceEntry;
  readonly queries?: WorkspaceTaskQueries;
}

export interface WorkspaceQueryResult extends TaskQueryResult {
  readonly workspace: WorkspaceEntry;
}

export interface MissingWorkspace {
  readonly workspace: WorkspaceEntry;
  readonly reason: "missing" | "invalid" | "unavailable";
}

export interface CrossWorkspaceQueryResult {
  readonly workspaces: readonly WorkspaceQueryResult[];
  readonly missing: readonly MissingWorkspace[];
}

/** Executes list and search only for entries supplied by explicit enrollment. */
export class EnrolledWorkspaceQueries {
  constructor(
    private readonly members: readonly EnrolledWorkspaceQueryMember[],
  ) {}

  async list(): Promise<CrossWorkspaceQueryResult> {
    return this.collect((queries) => queries.list());
  }

  async search(query: string): Promise<CrossWorkspaceQueryResult> {
    return this.collect((queries) => queries.search(query));
  }

  private async collect(
    execute: (queries: WorkspaceTaskQueries) => Promise<TaskQueryResult>,
  ): Promise<CrossWorkspaceQueryResult> {
    const missing: MissingWorkspace[] = [];
    const readable: EnrolledWorkspaceQueryMember[] = [];
    for (const member of this.members) {
      if (
        member.workspace.state === "missing" ||
        member.workspace.state === "invalid"
      ) {
        missing.push({
          workspace: member.workspace,
          reason: member.workspace.state,
        });
      } else if (!member.queries) {
        missing.push({ workspace: member.workspace, reason: "unavailable" });
      } else {
        readable.push(member);
      }
    }
    const results = await Promise.all(
      readable.map(async (member) => ({
        workspace: member.workspace,
        ...(await execute(member.queries as WorkspaceTaskQueries)),
      })),
    );
    return { workspaces: results, missing };
  }
}
