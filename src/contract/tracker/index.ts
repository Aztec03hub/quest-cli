/**
 * Public, dependency-free subprocess contract for a tracker consumer.
 *
 * This module deliberately contains only records a consumer can obtain from
 * Quest's stdout/stderr.  It neither imports nor exposes Quest task internals.
 */
export const TRACKER_CONTRACT_VERSION = 1 as const;
export const MIN_QUEST_VERSION = "0.1.0";
export const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * The Quest package version this adapter boundary describes. It is a literal
 * rather than an import because this module is deliberately dependency-free —
 * see the file header — so a test asserts it equals QUEST_VERSION instead, and
 * it must be bumped with every release.
 *
 * Lore's gate is no longer an exact-match allowlist: as of lore 0.3.5 it
 * applies MIN_QUEST_VERSION with a `>=` floor plus selection-time gating, so a
 * newer Quest is accepted without a paired Lore release. This constant states
 * what the boundary was built and qualified against; it is not a version
 * consumers are required to match.
 */
export const QUEST_ADAPTER_PINNED_VERSION = "0.13.0" as const;

/**
 * The schema-1 manifest descriptors the adapter boundary requires from the
 * pinned Quest package: public discovery, the mutating workspace bootstrap,
 * the complete read/write task surface, the live status-flow payload, and the
 * explicit Backlog-migration lifecycle with their advertised fields.
 *
 * This is the Lore-facing authority for descriptor coverage; `probe()`'s
 * local `required` table enforces the deeper consumer-side field/filter
 * contract for the task surface only.
 */
export const ADAPTER_REQUIRED_MANIFEST_COMMANDS = [
  { name: "manifest", kind: "manifest.registry", mutates: false },
  { name: "version", kind: null, mutates: false },
  { name: "init", kind: "workspace.initialized", mutates: true },
  { name: "task status-flow", kind: "task.status-flow", mutates: false },
  { name: "task list", kind: "task.list", mutates: false },
  { name: "task view", kind: "task.view", mutates: false },
  { name: "search", kind: "task.search", mutates: false },
  { name: "task create", kind: "task.created", mutates: true },
  { name: "task edit", kind: "task.updated", mutates: true },
  {
    name: "migration backlog preview",
    kind: "migration.backlog-preview",
    mutates: false,
    fields: ["digest", "mappings", "requiresApproval", "sourceFingerprint"],
  },
  {
    name: "migration backlog apply",
    kind: "migration.backlog-applied",
    mutates: true,
    fields: ["digest"],
  },
  {
    name: "migration backlog status",
    kind: "migration.backlog-status",
    mutates: false,
    fields: ["digest"],
  },
  {
    name: "migration backlog rollback",
    kind: "migration.backlog-rolled-back",
    mutates: true,
    fields: ["digest"],
  },
] as const;

/**
 * Every diagnostic Quest can emit, matching the canonical DiagnosticEnvelope.
 * `usage` and `uncaught` are reachable through this adapter: the checklist
 * collision rules deliberately live in the CLI (QCLI-146), so a caller that
 * combines a replacement with an index operation gets `usage` back from
 * `quest` rather than a client-side guess.
 */
export type TrackerOutcome =
  | "usage"
  | "not_found"
  | "denied"
  | "conflict"
  | "validation"
  | "drift"
  | "uncaught";

export interface TrackerDiagnostic {
  readonly error_type: TrackerOutcome;
  readonly message: string;
  readonly input?: unknown;
}

export interface TrackerProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

/** A runner receives argv, never a shell command string. */
export interface TrackerProcessRunner {
  run(
    argv: readonly string[],
    options: { readonly timeoutMs: number },
  ): Promise<TrackerProcessResult>;
}

export interface TrackerManifestEntry {
  readonly name: string;
  readonly schemaVersion: number;
  readonly kind: string | null;
  readonly mutates: boolean;
  readonly fields?: readonly string[];
  readonly filters?: readonly string[];
}
export interface TrackerManifest {
  readonly commands: readonly TrackerManifestEntry[];
}

export interface TrackerCheckItem {
  readonly index: number;
  readonly text: string;
  readonly checked: boolean;
  /**
   * 1-based, always `index + 1` (QCLI-269). Present on every item Quest
   * returns; absent when this type is used to author an item for a write
   * (`TrackerEditPatch`/`TrackerCreateInput`), since position is derived from
   * array order rather than something a caller chooses. Pass it straight to
   * `checkAcceptanceCriteria`/etc -- `index` is not what those take.
   */
  readonly position?: number;
}
export interface TrackerSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly labels: readonly string[];
  readonly summary?: string;
  readonly priority?: string;
  readonly type?: string;
  readonly assignees?: readonly string[];
  readonly ordinal?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  /**
   * Repo-relative path to the record's current JSON file (QCLI-220), e.g.
   * ".quest/tasks/QCLI-1.json". Tracks the task's lifecycle location, so it
   * moves when a task is completed or archived -- callers that persist it
   * (a rendered link, say) should expect staleness after such a move rather
   * than treating it as a stable identifier. The task id is the stable one.
   */
  readonly path?: string;
  /**
   * QCLI-277: present on `task.view` only. Capture it and supply it back as
   * `task edit --if-revision <revision>`'s precondition so a stale read is
   * refused with a conflict instead of silently overwritten.
   */
  readonly revision?: string;
}
export interface TrackerTask extends TrackerSummary {
  readonly description?: string;
  readonly acceptanceCriteria: readonly (string | TrackerCheckItem)[];
  readonly definitionOfDone: readonly (string | TrackerCheckItem)[];
  readonly plan: readonly string[];
  readonly implementationNotes: readonly string[];
  readonly comments: readonly unknown[];
  readonly documentation: readonly string[];
  readonly dependencies: readonly string[];
  readonly parentId?: string;
  readonly milestoneId?: string;
  readonly finalSummary?: string;
  readonly references?: readonly string[];
  readonly modifiedFiles?: readonly string[];
  /**
   * QCLI-331: why a task at the closed status was retired. `survivor` names
   * the task that carries the work forward (duplicate/superseded only).
   */
  readonly resolution?: { readonly kind: string; readonly survivor?: string };
}
export interface TrackerManifestCommand {
  readonly name: string;
  readonly schemaVersion: number;
  readonly kind: string | null;
  readonly mutates: boolean;
  readonly fields?: readonly string[];
  readonly filters?: readonly string[];
}
export interface TrackerStatusFlow {
  readonly statuses: readonly string[];
  /**
   * The ladder's terminal statuses, always a subset of `statuses`. It does
   * NOT list `closedStatus` yet (QCLI-331): decide "is this task finished"
   * by membership here OR equality with `closedStatus`, never by a `"Done"`
   * literal. `closedStatus` joins this list in a later release.
   */
  readonly terminalStatuses: readonly string[];
  /** QCLI-229: absent when the workspace has pause/start disabled. */
  readonly pausedStatus?: string;
  /**
   * QCLI-325: false while `pausedStatus` is a BUILT-IN literal that no
   * user-reachable knob sets (opum-doc relay 570, DEC-172 (4af)). Emitted
   * beside `pausedStatus` so a consumer can tell from the output alone that
   * the value is not theirs to change.
   */
  readonly pausedStatusConfigurable?: boolean;
  /**
   * QCLI-331: the second terminal status, reached only by `task close`;
   * absent when the workspace has close disabled.
   */
  readonly closedStatus?: string;
  /** QCLI-331: the resolution kinds `task close` accepts. */
  readonly resolutions?: readonly string[];
}
export interface TrackerCreateInput {
  readonly title: string;
  readonly summary?: string;
  readonly description?: string;
  readonly labels?: readonly string[];
  readonly documentation?: readonly string[];
  readonly priority?: string;
  readonly type?: string;
  readonly ordinal?: number;
  readonly aliases?: readonly string[];
  readonly acceptanceCriteria?: readonly (string | TrackerCheckItem)[];
  readonly definitionOfDone?: readonly (string | TrackerCheckItem)[];
  readonly plan?: readonly string[];
  readonly implementationNotes?: readonly string[];
  readonly comments?: readonly unknown[];
  readonly assignees?: readonly string[];
  readonly references?: readonly string[];
  readonly modifiedFiles?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly parentId?: string;
  readonly milestoneId?: string;
  readonly finalSummary?: string;
}
/**
 * Undefined preserves a field; arrays replace their corresponding full field.
 *
 * Layer-boundary note: this public contract type intentionally mirrors the
 * application-layer `EditPatchVocabulary` (src/application/tasks/edit-patch.ts)
 * one-to-one; the fold behavior itself lives there. Keep both lists in sync.
 */
export interface TrackerEditPatch {
  readonly status?: string;
  readonly title?: string;
  readonly priority?: string;
  readonly type?: string;
  readonly ordinal?: number;
  readonly summary?: string;
  readonly description?: string;
  readonly finalSummary?: string;
  readonly clearFinalSummary?: boolean;
  readonly appendFinalSummary?: readonly string[];
  readonly labels?: readonly string[];
  readonly addLabels?: readonly string[];
  readonly removeLabels?: readonly string[];
  readonly documentation?: readonly string[];
  readonly plan?: readonly string[];
  readonly addPlan?: readonly string[];
  readonly removePlan?: readonly string[];
  readonly implementationNotes?: readonly string[];
  readonly addNotes?: readonly string[];
  readonly removeNotes?: readonly string[];
  readonly comments?: readonly unknown[];
  readonly addComments?: readonly unknown[];
  readonly removeComments?: readonly string[];
  readonly acceptanceCriteria?:
    | readonly (string | TrackerCheckItem)[]
    | undefined;
  readonly definitionOfDone?:
    | readonly (string | TrackerCheckItem)[]
    | undefined;
  /**
   * Index-addressed checklist operations (QCLI-138, exposed here by QCLI-146).
   * Positions are 1-based, as on the CLI — note that {@link TrackerCheckItem}
   * `index` is 0-based on read, so addressing the item you just read means
   * passing `index + 1`, not `index`. Addressing one entry leaves the rest
   * byte-identical, so an adapter no longer has to read-modify-write a whole
   * checklist to tick one box. The CLI owns the collision rules: a replacement
   * combined with these, `clear` combined with anything, or one position given
   * contradictory operations are all usage errors from `quest`, and are
   * deliberately not second-guessed here.
   */
  readonly checkAcceptanceCriteria?: readonly number[];
  readonly uncheckAcceptanceCriteria?: readonly number[];
  readonly removeAcceptanceCriteria?: readonly number[];
  readonly clearAcceptanceCriteria?: boolean;
  readonly checkDefinitionOfDone?: readonly number[];
  readonly uncheckDefinitionOfDone?: readonly number[];
  readonly removeDefinitionOfDone?: readonly number[];
  readonly clearDefinitionOfDone?: boolean;
  readonly addDependencies?: readonly string[];
  readonly removeDependencies?: readonly string[];
  readonly parentId?: string;
  readonly clearParent?: boolean;
  readonly milestoneId?: string;
  readonly clearMilestone?: boolean;
  readonly addAssignees?: readonly string[];
  readonly removeAssignees?: readonly string[];
  readonly addReferences?: readonly string[];
  readonly removeReferences?: readonly string[];
  readonly addModifiedFiles?: readonly string[];
  readonly removeModifiedFiles?: readonly string[];
}
export interface TrackerWriteActor {
  readonly id: string;
  readonly kind: "human" | "delegated-agent";
  readonly accountableHumanId?: string;
}

interface ResultEnvelope {
  readonly schemaVersion: number;
  readonly kind: string;
  readonly data: unknown;
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isCheckList(
  value: unknown,
): value is readonly (string | TrackerCheckItem)[] {
  if (!Array.isArray(value)) return false;
  const items = value as readonly unknown[];
  let authoredItems = false;
  for (let position = 0; position < items.length; position += 1) {
    const item = items[position];
    if (typeof item === "string") continue;
    authoredItems = true;
    if (
      !item ||
      typeof item !== "object" ||
      (item as TrackerCheckItem).index !== position ||
      typeof (item as TrackerCheckItem).text !== "string" ||
      typeof (item as TrackerCheckItem).checked !== "boolean"
    )
      return false;
    // QCLI-269: when present, `position` must be `index + 1` -- it is a
    // derived field, never an independent one a response could drift on.
    const declaredPosition = (item as TrackerCheckItem).position;
    if (declaredPosition !== undefined && declaredPosition !== position + 1)
      return false;
  }
  // Authored item lists must be complete: every position carries an item.
  return !authoredItems || items.every((item) => typeof item !== "string");
}

function isSummary(value: unknown): value is TrackerSummary {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<TrackerSummary>;
  return (
    typeof task.id === "string" &&
    typeof task.title === "string" &&
    typeof task.status === "string" &&
    isStringArray(task.labels) &&
    (task.summary === undefined || typeof task.summary === "string") &&
    (task.priority === undefined || typeof task.priority === "string") &&
    (task.type === undefined || typeof task.type === "string") &&
    (task.assignees === undefined || isStringArray(task.assignees)) &&
    (task.ordinal === undefined || Number.isFinite(task.ordinal)) &&
    (task.createdAt === undefined || typeof task.createdAt === "string") &&
    (task.updatedAt === undefined || typeof task.updatedAt === "string") &&
    (task.path === undefined || typeof task.path === "string") &&
    (task.revision === undefined || typeof task.revision === "string")
  );
}

function isTask(value: unknown): value is TrackerTask {
  if (!isSummary(value)) return false;
  const task = value as Partial<TrackerTask>;
  return (
    (task.description === undefined || typeof task.description === "string") &&
    isCheckList(task.acceptanceCriteria) &&
    isCheckList(task.definitionOfDone) &&
    isStringArray(task.plan) &&
    isStringArray(task.implementationNotes) &&
    Array.isArray(task.comments) &&
    isStringArray(task.documentation) &&
    isStringArray(task.dependencies) &&
    (task.parentId === undefined || typeof task.parentId === "string") &&
    (task.milestoneId === undefined || typeof task.milestoneId === "string") &&
    (task.finalSummary === undefined ||
      typeof task.finalSummary === "string") &&
    (task.references === undefined || isStringArray(task.references)) &&
    (task.modifiedFiles === undefined || isStringArray(task.modifiedFiles))
  );
}

function validData(kind: string, data: unknown): boolean {
  switch (kind) {
    case "task.status-flow":
      return (
        !!data &&
        typeof data === "object" &&
        isStringArray((data as Partial<TrackerStatusFlow>).statuses) &&
        isStringArray((data as Partial<TrackerStatusFlow>).terminalStatuses)
      );
    case "task.list":
    case "task.search":
      return Array.isArray(data) && data.every(isSummary);
    case "task.view":
    case "task.created":
    case "task.updated":
      return isTask(data);
    default:
      return true;
  }
}

function parseSemver(
  value: string,
): readonly [number, number, number] | undefined {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\n?$/.exec(
    value,
  );
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

function semverAtLeast(actual: string, floor: string): boolean {
  const left = parseSemver(actual);
  const right = parseSemver(floor);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    const actualPart = left[index];
    const floorPart = right[index];
    if (actualPart === undefined || floorPart === undefined) return false;
    if (actualPart !== floorPart) return actualPart > floorPart;
  }
  return true;
}

function trackerError(
  error_type: TrackerOutcome,
  message: string,
): TrackerDiagnostic {
  return { error_type, message };
}

function parseDiagnostic(stderr: string): TrackerDiagnostic | undefined {
  try {
    const parsed: unknown = JSON.parse(stderr);
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = parsed as Partial<TrackerDiagnostic>;
    return typeof value.error_type === "string" &&
      typeof value.message === "string"
      ? (value as TrackerDiagnostic)
      : undefined;
  } catch {
    return undefined;
  }
}

function parseEnvelope(
  result: TrackerProcessResult,
  expectedKind: string,
): ResultEnvelope {
  if (result.timedOut)
    throw trackerError("drift", "Quest subprocess timed out.");
  if (result.exitCode !== 0) {
    throw (
      parseDiagnostic(result.stderr) ??
      trackerError(
        "drift",
        "Quest subprocess failed without a valid diagnostic.",
      )
    );
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== "object") throw new Error();
    const envelope = parsed as Partial<ResultEnvelope>;
    if (
      envelope.schemaVersion !== TRACKER_CONTRACT_VERSION ||
      envelope.kind !== expectedKind ||
      !("data" in envelope) ||
      !validData(expectedKind, envelope.data)
    )
      throw new Error();
    return envelope as ResultEnvelope;
  } catch {
    throw trackerError(
      "drift",
      `Quest returned an invalid ${expectedKind} envelope.`,
    );
  }
}

function requireActor(actor: TrackerWriteActor | undefined): TrackerWriteActor {
  if (
    !actor?.id ||
    (actor.kind !== "human" && actor.kind !== "delegated-agent")
  ) {
    throw trackerError(
      "denied",
      "Tracker writes require an explicit actor declaration.",
    );
  }
  if (actor.kind === "delegated-agent" && !actor.accountableHumanId) {
    throw trackerError(
      "denied",
      "Delegated tracker writes require an accountable human.",
    );
  }
  return actor;
}

function actorArguments(actor: TrackerWriteActor): readonly string[] {
  return actor.kind === "human"
    ? ["--actor", actor.id, "--actor-kind", "human"]
    : [
        "--actor",
        actor.id,
        "--actor-kind",
        "delegated-agent",
        "--accountable-human",
        actor.accountableHumanId ?? "",
      ];
}

function appendRepeated(
  argv: string[],
  flag: string,
  values: readonly unknown[] | undefined,
): void {
  for (const value of values ?? []) argv.push(flag, String(value));
}

/**
 * Bounded, argv-safe adapter suitable for lore-cli or another external
 * consumer. Reads have no actor; every write carries an explicit actor.
 */
export class QuestTrackerClient {
  constructor(
    private readonly runner: TrackerProcessRunner,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  private run(argv: readonly string[]) {
    return this.runner.run(argv, { timeoutMs: this.timeoutMs });
  }

  async probe(): Promise<{
    readonly version: string;
    readonly manifest: TrackerManifest;
  }> {
    const versionResult = await this.run(["--version"]);
    if (
      versionResult.timedOut ||
      versionResult.exitCode !== 0 ||
      !parseSemver(versionResult.stdout)
    ) {
      throw trackerError(
        "drift",
        "Quest did not return a bare semver version.",
      );
    }
    if (!semverAtLeast(versionResult.stdout, MIN_QUEST_VERSION)) {
      throw trackerError(
        "drift",
        `Quest ${versionResult.stdout.trim()} is older than ${MIN_QUEST_VERSION}.`,
      );
    }
    const envelope = parseEnvelope(
      await this.run(["manifest", "--json"]),
      "manifest.registry",
    );
    const manifest = envelope.data as Partial<TrackerManifest>;
    const commands = manifest.commands;
    // Exact fields/filters advertisement is part of the contract: omissions and drift both fail closed.
    const required: readonly {
      readonly name: string;
      readonly kind: string;
      readonly mutates: boolean;
      readonly fields?: readonly string[];
      readonly filters?: readonly string[];
    }[] = [
      {
        name: "task status-flow",
        kind: "task.status-flow",
        mutates: false,
        fields: [
          "statuses",
          "terminalStatuses",
          "pausedStatus",
          "pausedStatusConfigurable",
          "closedStatus",
          "resolutions",
        ],
      },
      {
        name: "task list",
        kind: "task.list",
        mutates: false,
        filters: [
          "assignee",
          "exclude-status",
          "fields",
          "include-archived",
          "label",
          "limit",
          "milestone",
          "parent",
          "priority",
          "ready",
          "search",
          "sort",
          "status",
          "type",
          "unassigned",
          "unresolved-at-completion",
        ],
        fields: [
          "acceptanceCriteria",
          "aliases",
          "assignees",
          "blockers",
          "claim",
          "comments",
          "createdAt",
          "definitionOfDone",
          "dependencies",
          "description",
          "documentation",
          "finalSummary",
          "gateEvents",
          "gates",
          "id",
          "implementationNotes",
          "labels",
          "milestoneId",
          "modifiedFiles",
          "ordinal",
          "parentId",
          "path",
          "plan",
          "priority",
          "references",
          "resolution",
          "source",
          "status",
          "summary",
          "title",
          "type",
          "unresolvedAtCompletion",
          "updatedAt",
        ],
      },
      {
        name: "task view",
        kind: "task.view",
        mutates: false,
        filters: ["fields", "max-notes"],
        fields: [
          "acceptanceCriteria",
          "aliases",
          "assignees",
          "blockers",
          "claim",
          "comments",
          "createdAt",
          "definitionOfDone",
          "dependencies",
          "description",
          "documentation",
          "finalSummary",
          "gateEvents",
          "gates",
          "id",
          "implementationNotes",
          "labels",
          "milestoneId",
          "modifiedFiles",
          "notesOmitted",
          "ordinal",
          "parentId",
          "path",
          "plan",
          "priority",
          "references",
          "resolution",
          "revision",
          "source",
          "status",
          "summary",
          "title",
          "type",
          "unresolvedAtCompletion",
          "updatedAt",
        ],
      },
      {
        name: "search",
        kind: "task.search",
        mutates: false,
        filters: ["query"],
        fields: [
          "acceptanceCriteria",
          "aliases",
          "assignees",
          "blockers",
          "claim",
          "comments",
          "createdAt",
          "definitionOfDone",
          "dependencies",
          "description",
          "documentation",
          "finalSummary",
          "gateEvents",
          "gates",
          "id",
          "implementationNotes",
          "labels",
          "milestoneId",
          "modifiedFiles",
          "ordinal",
          "parentId",
          "plan",
          "priority",
          "references",
          "resolution",
          "source",
          "status",
          "summary",
          "title",
          "type",
          "unresolvedAtCompletion",
          "updatedAt",
        ],
      },
      {
        name: "task create",
        kind: "task.created",
        mutates: true,
        fields: [
          "acceptanceCriteria",
          "aliases",
          "assignees",
          "comments",
          "definitionOfDone",
          "description",
          "documentation",
          "finalSummary",
          "implementationNotes",
          "labels",
          "milestoneId",
          "modifiedFiles",
          "ordinal",
          "parentId",
          "plan",
          "priority",
          "references",
          "summary",
          "title",
          "type",
        ],
      },
      {
        name: "task edit",
        kind: "task.updated",
        mutates: true,
        fields: [
          "acceptanceCriteria",
          "addAssignees",
          "addComments",
          "addDependencies",
          "addLabels",
          "addModifiedFiles",
          "addNotes",
          "addPlan",
          "addReferences",
          "appendFinalSummary",
          "checkAcceptanceCriteria",
          "checkDefinitionOfDone",
          "clearAcceptanceCriteria",
          "clearDefinitionOfDone",
          "clearFinalSummary",
          "clearMilestone",
          "clearParent",
          "comments",
          "definitionOfDone",
          "description",
          "documentation",
          "finalSummary",
          "implementationNotes",
          "labels",
          "milestoneId",
          "ordinal",
          "parentId",
          "plan",
          "priority",
          "removeAcceptanceCriteria",
          "removeAssignees",
          "removeComments",
          "removeDefinitionOfDone",
          "removeDependencies",
          "removeLabels",
          "removeModifiedFiles",
          "removeNotes",
          "removePlan",
          "removeReferences",
          "status",
          "summary",
          "title",
          "type",
          "uncheckAcceptanceCriteria",
          "uncheckDefinitionOfDone",
        ],
      },
    ];
    const sorted = (values: readonly string[] | undefined): readonly string[] =>
      [...(values ?? [])].sort();
    if (
      !Array.isArray(commands) ||
      required.some((entry) => {
        const match = commands.find(
          (command) =>
            command?.name === entry.name &&
            command.schemaVersion === TRACKER_CONTRACT_VERSION &&
            command.kind === entry.kind &&
            command.mutates === entry.mutates,
        );
        if (!match) return true;
        return (
          JSON.stringify(sorted(match.fields)) !==
            JSON.stringify(sorted(entry.fields)) ||
          JSON.stringify(sorted(match.filters)) !==
            JSON.stringify(sorted(entry.filters))
        );
      })
    ) {
      throw trackerError(
        "drift",
        "Quest manifest does not advertise the tracker contract.",
      );
    }
    return {
      version: versionResult.stdout.trim(),
      manifest: manifest as TrackerManifest,
    };
  }

  async statusFlow(): Promise<TrackerStatusFlow> {
    return parseEnvelope(
      await this.run(["task", "status-flow", "--json"]),
      "task.status-flow",
    ).data as TrackerStatusFlow;
  }
  async list(
    options: {
      readonly status?: string;
      readonly labels?: readonly string[];
    } = {},
  ): Promise<readonly TrackerSummary[]> {
    const argv = ["task", "list", "--json"];
    if (options.status) argv.push("--status", options.status);
    appendRepeated(argv, "--label", options.labels);
    return parseEnvelope(await this.run(argv), "task.list")
      .data as readonly TrackerSummary[];
  }
  async view(id: string): Promise<TrackerTask> {
    return parseEnvelope(
      await this.run(["task", "view", id, "--json"]),
      "task.view",
    ).data as TrackerTask;
  }
  async search(query: string): Promise<readonly TrackerSummary[]> {
    return parseEnvelope(
      await this.run(["search", query, "--json"]),
      "task.search",
    ).data as readonly TrackerSummary[];
  }
  async create(
    input: TrackerCreateInput,
    actor?: TrackerWriteActor,
  ): Promise<TrackerTask> {
    const declared = requireActor(actor);
    const argv = [
      "task",
      "create",
      input.title,
      "--json",
      ...actorArguments(declared),
    ];
    if (input.summary !== undefined) argv.push("--summary", input.summary);
    if (input.description !== undefined)
      argv.push("--description", input.description);
    appendRepeated(argv, "--label", input.labels);
    appendRepeated(argv, "--doc", input.documentation);
    if (input.priority !== undefined) argv.push("--priority", input.priority);
    if (input.type !== undefined) argv.push("--type", input.type);
    if (input.ordinal !== undefined)
      argv.push("--ordinal", String(input.ordinal));
    appendRepeated(argv, "--alias", input.aliases);
    if (input.acceptanceCriteria !== undefined)
      argv.push(
        "--acceptance-criteria",
        JSON.stringify(input.acceptanceCriteria),
      );
    if (input.definitionOfDone !== undefined)
      argv.push("--definition-of-done", JSON.stringify(input.definitionOfDone));
    if (input.plan !== undefined)
      argv.push("--plan", JSON.stringify(input.plan));
    if (input.implementationNotes !== undefined)
      argv.push(
        "--implementation-notes",
        JSON.stringify(input.implementationNotes),
      );
    if (input.comments !== undefined)
      argv.push("--comments", JSON.stringify(input.comments));
    appendRepeated(argv, "--assignee", input.assignees);
    appendRepeated(argv, "--reference", input.references);
    appendRepeated(argv, "--modified-file", input.modifiedFiles);
    appendRepeated(argv, "--dependency", input.dependencies);
    if (input.parentId !== undefined) argv.push("--parent", input.parentId);
    if (input.milestoneId !== undefined)
      argv.push("--milestone", input.milestoneId);
    if (input.finalSummary !== undefined)
      argv.push("--final-summary", input.finalSummary);
    return parseEnvelope(await this.run(argv), "task.created")
      .data as TrackerTask;
  }
  async edit(
    id: string,
    patch: TrackerEditPatch,
    actor?: TrackerWriteActor,
  ): Promise<TrackerTask> {
    const declared = requireActor(actor);
    const argv = ["task", "edit", id, "--json", ...actorArguments(declared)];
    if (patch.status !== undefined) argv.push("--status", patch.status);
    if (patch.title !== undefined) argv.push("--title", patch.title);
    if (patch.priority !== undefined) argv.push("--priority", patch.priority);
    if (patch.type !== undefined) argv.push("--type", patch.type);
    if (patch.ordinal !== undefined)
      argv.push("--ordinal", String(patch.ordinal));
    if (patch.summary !== undefined) argv.push("--summary", patch.summary);
    if (patch.description !== undefined)
      argv.push("--description", patch.description);
    if (patch.finalSummary !== undefined)
      argv.push("--final-summary", patch.finalSummary);
    if (patch.clearFinalSummary === true) argv.push("--clear-final-summary");
    appendRepeated(argv, "--append-final-summary", patch.appendFinalSummary);
    if (patch.labels !== undefined)
      argv.push("--labels", JSON.stringify(patch.labels));
    appendRepeated(argv, "--add-label", patch.addLabels);
    appendRepeated(argv, "--remove-label", patch.removeLabels);
    appendRepeated(argv, "--doc", patch.documentation);
    if (patch.plan !== undefined)
      argv.push("--plan", JSON.stringify(patch.plan));
    appendRepeated(argv, "--add-plan", patch.addPlan);
    appendRepeated(argv, "--remove-plan", patch.removePlan);
    if (patch.implementationNotes !== undefined)
      argv.push("--notes", JSON.stringify(patch.implementationNotes));
    appendRepeated(argv, "--add-note", patch.addNotes);
    appendRepeated(argv, "--remove-note", patch.removeNotes);
    if (patch.comments !== undefined)
      argv.push("--comments", JSON.stringify(patch.comments));
    appendRepeated(argv, "--add-comment", patch.addComments);
    appendRepeated(argv, "--remove-comment", patch.removeComments);
    if (patch.acceptanceCriteria !== undefined)
      argv.push(
        "--acceptance-criteria",
        JSON.stringify(patch.acceptanceCriteria),
      );
    if (patch.definitionOfDone !== undefined)
      argv.push("--definition-of-done", JSON.stringify(patch.definitionOfDone));
    appendRepeated(argv, "--check-ac", patch.checkAcceptanceCriteria);
    appendRepeated(argv, "--uncheck-ac", patch.uncheckAcceptanceCriteria);
    appendRepeated(argv, "--remove-ac", patch.removeAcceptanceCriteria);
    if (patch.clearAcceptanceCriteria === true) argv.push("--clear-ac");
    appendRepeated(argv, "--check-dod", patch.checkDefinitionOfDone);
    appendRepeated(argv, "--uncheck-dod", patch.uncheckDefinitionOfDone);
    appendRepeated(argv, "--remove-dod", patch.removeDefinitionOfDone);
    if (patch.clearDefinitionOfDone === true) argv.push("--clear-dod");
    appendRepeated(argv, "--add-dependency", patch.addDependencies);
    appendRepeated(argv, "--remove-dependency", patch.removeDependencies);
    if (patch.parentId !== undefined) argv.push("--parent", patch.parentId);
    if (patch.clearParent === true) argv.push("--clear-parent");
    if (patch.milestoneId !== undefined)
      argv.push("--milestone", patch.milestoneId);
    if (patch.clearMilestone === true) argv.push("--clear-milestone");
    appendRepeated(argv, "--add-assignee", patch.addAssignees);
    appendRepeated(argv, "--remove-assignee", patch.removeAssignees);
    appendRepeated(argv, "--add-reference", patch.addReferences);
    appendRepeated(argv, "--remove-reference", patch.removeReferences);
    appendRepeated(argv, "--add-modified-file", patch.addModifiedFiles);
    appendRepeated(argv, "--remove-modified-file", patch.removeModifiedFiles);
    return parseEnvelope(await this.run(argv), "task.updated")
      .data as TrackerTask;
  }
}
