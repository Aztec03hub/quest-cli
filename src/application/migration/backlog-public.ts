import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Milestone } from "../../domain/planning/planning.ts";
import {
  type Alias,
  alias,
  type AliasCollision,
  canonicalIdPrefixPattern,
  type CanonicalId,
  assertAliasesAvailable,
  collectAliasCollisions,
  RecordConflictError,
  RecordValidationError,
} from "../../domain/records.ts";
import {
  canonicalizeTaskLinks,
  compareTaskIds,
  type TaskState,
  taskState,
} from "../../domain/tasks/tasks.ts";
import type {
  BacklogImportRecord,
  BacklogImportSource,
  MigrationTransactionRepository,
  PublicTaskRepository,
} from "../../ports/backlog-import.ts";
import type { PlanningRepository } from "../../ports/planning.ts";

export interface BacklogImportMapping {
  readonly sourceIdentifier: string;
  readonly sourceFolder: string;
  readonly targetIdentifier: string;
  readonly aliases: readonly string[];
}

/**
 * One mapping where the preserved-ids run actually changed the id (QCLI-168):
 * a dotted subtask id has no flat equivalent, so it is translated to a freshly
 * minted one rather than kept verbatim. `reason` makes that visible without
 * cross-referencing `aliases` -- the only way `sourceIdentifier` survives is
 * as an alias on the target, and a reader should not have to know that to see
 * this is a translated pair, not two unrelated ids.
 */
export interface BacklogRenumberedMapping {
  readonly sourceIdentifier: string;
  readonly targetIdentifier: string;
  readonly reason: "dotted_subtask_translated";
}

/** Selects one id family (Backlog display prefix) to import with its source
 * ids preserved verbatim, instead of the default positional renumbering.
 * A source backlog holding more than one family (QCLI-160: lore-cli's
 * LCLI+LORE, opum-doc's ODOC+OCLI) is imported one family per run, on
 * purpose -- merging two families into one target namespace was ruled out
 * as inventing a scheme the source data does not itself have. */
export interface BacklogPreservationOptions {
  readonly family: string;
}

export interface BacklogExcludedRecord {
  readonly sourceIdentifier: string;
  readonly family?: string;
}

export interface BacklogUnpreservableRecord {
  readonly sourceIdentifier: string;
  readonly reason: "malformed_source_id" | "parent_not_found";
  readonly detail?: string;
}

/**
 * Thrown instead of failing on the first problem, so the operator sees every
 * id collision and every unpreservable record in one report and can resolve
 * them together rather than rediscovering the next one on a second preview.
 */
export class BacklogMigrationRefusedError extends Error {
  readonly kind = "conflict" as const;
  constructor(
    message: string,
    readonly details: {
      readonly collisions: readonly AliasCollision[];
      readonly unpreservable: readonly BacklogUnpreservableRecord[];
    },
  ) {
    super(message);
  }
}

interface Receipt {
  readonly schemaVersion: 1;
  readonly kind: "migration.backlog.receipt";
  readonly digest: string;
  readonly sourceFingerprint: string;
  readonly mappings: readonly BacklogImportMapping[];
  readonly state: "applying" | "applied" | "failed" | "rolled-back";
  readonly survivors: readonly string[];
  readonly taskFingerprints: Readonly<Record<string, string>>;
}

export interface BacklogPreview {
  readonly sourceFingerprint: string;
  readonly digest: string;
  readonly mappings: readonly BacklogImportMapping[];
  readonly requiresApproval: true;
  /** Records left behind because they belong to a different id family than
   * the one selected for preservation. Only present in preservation mode. */
  readonly excluded?: readonly BacklogExcludedRecord[];
  /** The subset of `mappings` whose id actually changed (QCLI-168), so a
   * consumer does not have to diff the full list by hand to find out what a
   * preserved-ids run is about to change. Additive: `mappings` itself is
   * unchanged and still carries every record. Only present in preservation
   * mode -- the positional (non-preserved) path renumbers every record, so
   * isolating "the ones that changed" there would just repeat the full list. */
  readonly renumbered?: readonly BacklogRenumberedMapping[];
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function receiptPath(root: string, digest: string): string {
  return join(root, ".quest", "migrations", "backlog", `${digest}.json`);
}

async function save(path: string, receipt: Receipt): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt)}\n`, "utf8");
  await rename(temporary, path);
}

async function load(path: string): Promise<Receipt | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Backlog writes its dates in three shapes: a bare date (`2025-06-01`), a
 * zone-less local datetime (`2025-06-02 14:23`), and occasionally full
 * ISO-8601. Quest's own stamps are always ISO-8601 UTC, and QCLI-137 made
 * `createdAt`/`updatedAt` sortable. Promoting the source form verbatim made
 * that sort compare mixed formats lexicographically — a space sorts before
 * `T`, so same-instant records interleaved by format rather than by time — and
 * made `new Date(value)` parse imported records in the host's timezone while
 * parsing native ones in UTC.
 *
 * Two decisions this encodes (QCLI-152):
 *
 * Zone-less input is read as UTC, not as local time. The source states no
 * offset, and reading it as local would make the same file import to different
 * instants on different machines — the import would stop being deterministic,
 * which matters more here than guessing the author's chair correctly.
 *
 * A bare date normalises to midnight UTC. That is the canonical instant for
 * "that day", not a claim about the hour; the alternative, refusing to promote
 * it, would leave a whole Backlog corpus unsortable, which is the defect this
 * closes.
 *
 * Anything that does not parse is dropped rather than turned into a wrong
 * date. Nothing is lost by that: the raw source value is retained verbatim in
 * the provenance blob above, so a reader can always recover what Backlog
 * actually wrote.
 */
function isoTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;
  const candidate = dateOnly.test(trimmed)
    ? `${trimmed}T00:00:00.000Z`
    : zoneless.test(trimmed)
      ? `${trimmed.replace(" ", "T")}Z`
      : trimmed;
  const parsed = Date.parse(candidate);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function importedTask(
  record: BacklogImportRecord,
  id: string,
  milestoneId?: string,
): TaskState {
  return taskState({
    id: id as CanonicalId,
    aliases: record.aliases,
    title: record.title,
    status: record.status ?? "To Do",
    // The raw source is intentional: it prevents a partial Quest task schema
    // from silently dropping Backlog fields while the public model evolves.
    description: record.rawMarkdown,
    summary: JSON.stringify({
      backlog: {
        sourcePath: record.sourcePath,
        sourceFolder: record.sourceFolder,
        git: record.git,
        assignees: record.assignees,
        references: record.references,
        modifiedFiles: record.modifiedFiles,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    }),
    priority: record.priority,
    type: record.type,
    ordinal: record.ordinal,
    // Carry the source dates onto the record itself (QCLI-137), not only into
    // the provenance blob. An imported task with no createdAt would sort last
    // forever with its real date sitting two layers away in the same record.
    // Normalised, not copied: see isoTimestamp above (QCLI-152). The blob keeps
    // the raw source form, so source fidelity is not traded for sortability.
    createdAt: isoTimestamp(record.createdAt),
    updatedAt: isoTimestamp(record.updatedAt),
    // Reindexed positionally (not by the source's own #N marker) because
    // normalizeCheckList requires each item's index to equal its array
    // position; preserving `checked` here is the whole point (QCLI-157).
    acceptanceCriteria: record.acceptanceCriteria.map((item, index) => ({
      index,
      text: item.text,
      checked: item.checked,
    })),
    definitionOfDone: record.definitionOfDone.map((item, index) => ({
      index,
      text: item.text,
      checked: item.checked,
    })),
    plan: record.implementationPlan ? [record.implementationPlan] : [],
    implementationNotes: [
      ...(record.implementationNotes ? [record.implementationNotes] : []),
      ...(record.finalSummary ? [record.finalSummary] : []),
    ],
    comments: record.comments.map((comment) => ({
      id: `backlog-${comment.index}`,
      authorId: comment.author ?? "backlog-import",
      body: comment.body,
      createdAt: comment.createdAt ?? "1970-01-01T00:00:00.000Z",
    })),
    labels: record.labels,
    documentation: record.documentation,
    parentId: record.parentTaskId,
    dependencies: record.dependencies,
    milestoneId,
    blockers: [],
    gates: [],
    gateEvents: [],
    source: { system: "backlog", reference: record.sourceIdentifier },
  });
}

/** A Backlog display prefix, e.g. "ODOC" from "ODOC-63.2". */
function sourceFamily(sourceIdentifier: string): string | undefined {
  return sourceIdentifier.match(/^([A-Za-z][A-Za-z0-9]*)-/)?.[1];
}

/** The immediate parent implied by dotted subtask numbering: the id with its
 * last ".N" segment stripped ("ODOC-63.2" -> "ODOC-63", "QCLI-97.5.2" ->
 * "QCLI-97.5"). Only a fallback -- an explicit parentTaskId from the source
 * frontmatter always takes precedence. */
function derivedParentId(sourceIdentifier: string): string {
  return sourceIdentifier.replace(/\.[1-9][0-9]*$/, "");
}

/**
 * Backlog's dotted subtask numbering (QCLI-97.5.2) has no equivalent in
 * Quest's canonical id, which is strictly `<prefix>-<int>` (QCLI-160):
 * allocateCanonicalId and canonicalId() both reject a dot. Quest already has
 * the model for "child of" -- a flat id plus parentId, exactly what native
 * subtask creation (nextTaskId) already does -- so a dotted source id is
 * translated rather than refused or dropped: it gets a freshly minted flat
 * id in the selected family, its dotted spelling survives as an alias (every
 * existing reference to it still resolves), and its parent is threaded
 * through so canonicalizeTaskLinks resolves the link at apply time the same
 * way it already resolves every other migrated cross-reference.
 *
 * A record whose id is neither flat nor dotted in the selected family, or
 * whose parent cannot be found anywhere in the destination or this same
 * batch, is refused at BATCH scope (opag ruling, QCLI-160): the run stops
 * and reports every such record together with every id collision, rather
 * than silently excluding it or shipping a tracker with a dangling link.
 */
function previewWithPreservedIds(
  snapshot: {
    readonly fingerprint: string;
    readonly records: readonly BacklogImportRecord[];
  },
  occupied: readonly Alias[],
  existingTaskRecords: readonly { readonly task: { readonly id: string } }[],
  options: BacklogPreservationOptions,
): { preview: BacklogPreview; records: readonly BacklogImportRecord[] } {
  const { family } = options;
  if (!canonicalIdPrefixPattern.test(family))
    throw new RecordValidationError("backlog_source_family_invalid");
  const marker = `${family}-`;
  const flatPattern = new RegExp(`^${family}-[1-9][0-9]*$`);
  const dottedPattern = new RegExp(`^${family}-[1-9][0-9]*(\\.[1-9][0-9]*)+$`);

  const inFamily = snapshot.records.filter(
    (record) => sourceFamily(record.sourceIdentifier) === family,
  );
  const excluded: BacklogExcludedRecord[] = snapshot.records
    .filter((record) => sourceFamily(record.sourceIdentifier) !== family)
    .map((record) => ({
      sourceIdentifier: record.sourceIdentifier,
      family: sourceFamily(record.sourceIdentifier),
    }));

  // Flat ids reserve their numbers into the mint ceiling before any dotted
  // id is minted, so a freshly minted id can never land on one a later
  // record in the batch preserves verbatim.
  let mintCounter = existingTaskRecords.reduce((maximum, entry) => {
    if (!entry.task.id.startsWith(marker)) return maximum;
    const numeric = Number(entry.task.id.slice(marker.length));
    return Number.isSafeInteger(numeric) ? Math.max(maximum, numeric) : maximum;
  }, 0);
  for (const record of inFamily)
    if (flatPattern.test(record.sourceIdentifier)) {
      const numeric = Number(record.sourceIdentifier.slice(marker.length));
      if (Number.isSafeInteger(numeric))
        mintCounter = Math.max(mintCounter, numeric);
    }

  const unpreservable: BacklogUnpreservableRecord[] = [];
  const assigned: {
    readonly record: BacklogImportRecord;
    readonly targetIdentifier: string;
    readonly parentSourceId?: string;
  }[] = [];
  for (const record of inFamily) {
    if (flatPattern.test(record.sourceIdentifier)) {
      assigned.push({ record, targetIdentifier: record.sourceIdentifier });
    } else if (dottedPattern.test(record.sourceIdentifier)) {
      mintCounter += 1;
      assigned.push({
        record,
        targetIdentifier: `${family}-${mintCounter}`,
        parentSourceId:
          record.parentTaskId ?? derivedParentId(record.sourceIdentifier),
      });
    } else {
      unpreservable.push({
        sourceIdentifier: record.sourceIdentifier,
        reason: "malformed_source_id",
      });
    }
  }

  // A parent reference resolves against the existing destination (already
  // occupied) or any in-family record's own id/aliases -- whether that
  // record preserves its id verbatim or was itself just minted a flat one.
  // Multi-level dotted chains resolve transitively through the same alias
  // mechanism canonicalizeTaskLinks already uses for every other migrated
  // cross-reference.
  const knownAliasKeys = new Set(occupied.map((entry) => entry.key));
  for (const record of inFamily)
    for (const candidate of [record.sourceIdentifier, ...record.aliases])
      knownAliasKeys.add(alias(candidate).key);
  for (const entry of assigned) {
    if (entry.parentSourceId === undefined) continue;
    if (!knownAliasKeys.has(alias(entry.parentSourceId).key))
      unpreservable.push({
        sourceIdentifier: entry.record.sourceIdentifier,
        reason: "parent_not_found",
        detail: entry.parentSourceId,
      });
  }

  const unpreservableIds = new Set(
    unpreservable.map((entry) => entry.sourceIdentifier),
  );
  const preservable = assigned.filter(
    (entry) => !unpreservableIds.has(entry.record.sourceIdentifier),
  );
  // Same per-mapping dedup as the positional path (QCLI-157): a task's own
  // id and its own registered aliases legitimately coincide.
  const candidates = preservable.flatMap((entry) => {
    const perTask = new Map<string, string>();
    for (const candidate of [entry.targetIdentifier, ...entry.record.aliases]) {
      const key = alias(candidate).key;
      if (!perTask.has(key)) perTask.set(key, candidate);
    }
    return [...perTask.values()];
  });
  const collisions = collectAliasCollisions(candidates, occupied);

  if (unpreservable.length > 0 || collisions.length > 0) {
    const parts: string[] = [];
    if (collisions.length) parts.push(`${collisions.length} id collision(s)`);
    if (unpreservable.length)
      parts.push(`${unpreservable.length} unpreservable record(s)`);
    throw new BacklogMigrationRefusedError(
      `Backlog id preservation refused: ${parts.join(", ")}. See the itemized report for detail. No further flag resolves a remaining id collision here: rename or remove the conflicting record in the destination workspace, or rename the id in the source, then retry.`,
      { collisions, unpreservable },
    );
  }

  const mappings: BacklogImportMapping[] = preservable.map((entry) => ({
    sourceIdentifier: entry.record.sourceIdentifier,
    sourceFolder: entry.record.sourceFolder,
    targetIdentifier: entry.targetIdentifier,
    aliases: entry.record.aliases,
  }));
  // Derived from `mappings`, not new source data, so it stays out of the
  // digest: the CAS precondition `apply --digest` checks against must not
  // shift just because this display-only view of the same data was added.
  const renumbered: BacklogRenumberedMapping[] = mappings
    .filter((mapping) => mapping.targetIdentifier !== mapping.sourceIdentifier)
    .map((mapping) => ({
      sourceIdentifier: mapping.sourceIdentifier,
      targetIdentifier: mapping.targetIdentifier,
      reason: "dotted_subtask_translated" as const,
    }));
  const records = preservable.map((entry) =>
    entry.parentSourceId !== undefined
      ? { ...entry.record, parentTaskId: entry.parentSourceId }
      : entry.record,
  );
  const digest = fingerprint({
    sourceFingerprint: snapshot.fingerprint,
    mappings,
    family,
    excluded,
  });
  return {
    preview: {
      sourceFingerprint: snapshot.fingerprint,
      digest,
      mappings,
      requiresApproval: true,
      excluded,
      renumbered,
    },
    records,
  };
}

async function previewInternal(
  source: BacklogImportSource,
  repository: PublicTaskRepository,
  taskIdPrefix: string,
  preserveSourceIds?: BacklogPreservationOptions,
): Promise<{
  preview: BacklogPreview;
  records: readonly BacklogImportRecord[];
}> {
  const snapshot = await source.readSnapshot();
  // Scoped to the selected family when one is given (QCLI-162): a legacy
  // duplicate inside a family this run is not importing is not this run's
  // problem to refuse on. Without a family, the whole snapshot is what gets
  // imported, so every record's integrity stays load-bearing -- unchanged.
  const relevantDuplicateIds = preserveSourceIds
    ? snapshot.crossFolderDuplicateIds.filter(
        (id) => sourceFamily(id) === preserveSourceIds.family,
      )
    : snapshot.crossFolderDuplicateIds;
  if (relevantDuplicateIds.length)
    throw new Error("backlog_cross_folder_duplicate_id");
  const existing = await repository.readAll();
  const occupied: Alias[] = existing.taskRecords.flatMap((entry) => [
    alias(entry.task.id),
    ...entry.task.aliases.map(alias),
  ]);
  if (preserveSourceIds)
    return previewWithPreservedIds(
      snapshot,
      occupied,
      existing.taskRecords,
      preserveSourceIds,
    );
  // Targets the destination workspace's own configured taskIdPrefix (QCLI-157)
  // instead of a hardcoded "T-": a migration must land in the same id family
  // native `quest task create` already uses there, not a disconnected island.
  const marker = `${taskIdPrefix}-`;
  const highest = existing.taskRecords.reduce((maximum, entry) => {
    if (!entry.task.id.startsWith(marker)) return maximum;
    const numeric = Number(entry.task.id.slice(marker.length));
    return Number.isSafeInteger(numeric) ? Math.max(maximum, numeric) : maximum;
  }, 0);
  const mappings = snapshot.records.map((record, index) => ({
    sourceIdentifier: record.sourceIdentifier,
    sourceFolder: record.sourceFolder,
    targetIdentifier: `${taskIdPrefix}-${highest + index + 1}`,
    aliases: record.aliases,
  }));
  // Deduped per mapping, not globally: a task's own newly minted canonical
  // id and its own registered aliases legitimately coincide (most visibly
  // when the destination taskIdPrefix matches the source's own display
  // prefix, so e.g. "FX-1" is both the new id and the bare source alias for
  // that SAME task) -- that is not a collision. assertAliasesAvailable has
  // no per-record grouping of its own, so it cannot tell "claimed by this
  // exact task, about to receive that string as its own alias" apart from
  // "claimed by a different task"; only the caller knows which candidates
  // belong to the same mapping (QCLI-157).
  const candidates = mappings.flatMap((mapping) => {
    const perTask = new Map<string, string>();
    for (const candidate of [mapping.targetIdentifier, ...mapping.aliases]) {
      const key = alias(candidate).key;
      if (!perTask.has(key)) perTask.set(key, candidate);
    }
    return [...perTask.values()];
  });
  try {
    assertAliasesAvailable(candidates, occupied);
  } catch (error) {
    // Deliberately cause-agnostic about WHICH of two collision shapes this
    // is -- positional renumbering shifting an allocation when a dotted
    // subtask flattens, or a genuine, unrelated id already live in the
    // destination -- since the two look identical from here and claiming
    // one would be a diagnosis this code cannot make (QCLI-155, QCLI-166's
    // 2026-09-02 opum-agent migration-preview report). What changed
    // (fleet-reported, 2026-09-09): naming only the renumbering remedy left
    // an operator hitting the OTHER cause reading advice that cannot work
    // for them, with no way to tell which one they have -- confirmed live,
    // --preserve-source-ids does not resolve a genuine dual claim, it only
    // re-reports it as "Backlog id preservation refused". Name both causes
    // and both remedies instead of picking one.
    if (error instanceof RecordConflictError)
      throw new RecordConflictError(
        `${error.message} If this is from positional renumbering (for example a dotted subtask flattening and shifting a later allocation), --preserve-source-ids --source-family <PREFIX> avoids it by keeping each record's own source id instead. If instead this exact id is already a live, unrelated claim in the destination workspace, --preserve-source-ids will not resolve it -- rename or remove the conflicting record in the destination, or rename the id in the source, before retrying.`,
      );
    throw error;
  }
  const digest = fingerprint({
    sourceFingerprint: snapshot.fingerprint,
    mappings,
  });
  return {
    preview: {
      sourceFingerprint: snapshot.fingerprint,
      digest,
      mappings,
      requiresApproval: true,
    },
    records: snapshot.records,
  };
}

export class BacklogImportService {
  constructor(
    private readonly root: string,
    private readonly source: BacklogImportSource,
    private readonly repository: MigrationTransactionRepository,
    private readonly planning: PlanningRepository,
    private readonly taskIdPrefix: string = "T",
  ) {}

  async preview(
    preserveSourceIds?: BacklogPreservationOptions,
  ): Promise<BacklogPreview> {
    return (
      await previewInternal(
        this.source,
        this.repository,
        this.taskIdPrefix,
        preserveSourceIds,
      )
    ).preview;
  }

  async apply(
    digest: string,
    preserveSourceIds?: BacklogPreservationOptions,
  ): Promise<Receipt> {
    const { root, source, repository, taskIdPrefix } = this;
    const path = receiptPath(root, digest);
    const previous = await load(path);
    if (previous?.state === "applied") {
      const snapshot = await source.readSnapshot();
      if (snapshot.fingerprint !== previous.sourceFingerprint)
        throw new Error("migration_source_fingerprint_conflict");
      return previous;
    }
    const { preview, records } = await previewInternal(
      source,
      repository,
      taskIdPrefix,
      preserveSourceIds,
    );
    if (preview.digest !== digest)
      throw new Error("migration_approval_digest_mismatch");
    const receipt: Receipt = previous ?? {
      schemaVersion: 1,
      kind: "migration.backlog.receipt",
      digest,
      sourceFingerprint: preview.sourceFingerprint,
      mappings: preview.mappings,
      state: "applying",
      survivors: [],
      taskFingerprints: {},
    };
    await save(path, receipt);
    const survivors = new Set(receipt.survivors);
    const fingerprints = { ...receipt.taskFingerprints };
    // Milestone names map deterministically: sorted distinct source names,
    // reusing an existing planning milestone with the same exact title,
    // otherwise allocating the next free M-<n> id.
    const planningSnapshot = await this.planning.read();
    const milestoneNames = Array.from(
      new Set(
        records
          .map((record) => record.milestone?.trim())
          .filter((name): name is string => !!name),
      ),
    ).sort();
    const byTitle = new Map(
      planningSnapshot.milestones.map((m) => [m.title, m]),
    );
    let nextMilestoneNumber = planningSnapshot.milestones.reduce(
      (maximum, m) => Math.max(maximum, Number(m.id.slice(2))),
      0,
    );
    const milestoneIdForName = new Map<string, string>();
    for (const name of milestoneNames) {
      const existing = byTitle.get(name);
      if (existing) {
        milestoneIdForName.set(name, existing.id);
        continue;
      }
      nextMilestoneNumber += 1;
      milestoneIdForName.set(name, `M-${nextMilestoneNumber}`);
    }
    // Closure is computed over every mapping (not only non-survivors) so a
    // resumed migration still yields fully closed forward/back references.
    const rawImports = preview.mappings.map((mapping, index) => {
      const record = records[index];
      if (!record) throw new Error("migration_source_record_missing");
      const name = record.milestone?.trim();
      const milestoneId = name ? milestoneIdForName.get(name) : undefined;
      return {
        task: importedTask(record, mapping.targetIdentifier, milestoneId),
        milestoneId,
      };
    });
    // A Backlog record's parentId/dependencies are raw pre-migration source
    // ids (registered above as aliases on the sibling task they name), not
    // the new canonical ids. Every other write path resolves links through
    // canonicalizeTaskLinks before persisting; migration must too, or a
    // migrated child's parentId keeps pointing at a string no current task
    // actually has as its id, and --parent/--dependency lookups silently
    // find nothing post-import (QCLI-157).
    const linkedForImport = await repository.readAll();
    const canonicalById = new Map(
      canonicalizeTaskLinks([
        ...linkedForImport.taskRecords.map((entry) => entry.task),
        ...rawImports.map((entry) => entry.task),
      ]).map((task) => [task.id, task]),
    );
    const taskChanges: {
      readonly task: TaskState;
      readonly location: "tasks";
    }[] = [];
    const imported: { id: string; milestoneId?: string }[] = [];
    for (let index = 0; index < preview.mappings.length; index++) {
      const mapping = preview.mappings[index];
      const { milestoneId } = rawImports[index];
      const task = canonicalById.get(mapping.targetIdentifier);
      if (!task) throw new Error("migration_source_record_missing");
      const current = await repository.readAll();
      const existing = current.taskRecords.find(
        (entry) => entry.task.id === task.id,
      );
      if (existing && fingerprint(existing.task) === fingerprints[task.id]) {
        survivors.add(task.id);
        continue;
      }
      survivors.add(task.id);
      fingerprints[task.id] = fingerprint(task);
      taskChanges.push({ task, location: "tasks" });
      imported.push({ id: task.id, milestoneId });
    }
    // Closure over every mapping (not only non-survivors) so a resumed
    // migration still yields closed forward/back references.
    const milestones = new Map<string, Milestone>();
    for (const name of milestoneNames) {
      const existing = byTitle.get(name);
      const id = milestoneIdForName.get(name);
      if (!id) continue;
      const members = new Set(existing?.taskIds ?? []);
      for (const entry of imported)
        if (entry.milestoneId === id) members.add(entry.id);
      milestones.set(id, {
        // Spread first so a reused milestone keeps every field this import
        // does not own -- `archived` above all, which a field-by-field
        // rebuild would silently clear.
        ...existing,
        id: id as Milestone["id"],
        title: name,
        description: existing?.description,
        status: existing?.status ?? "open",
        taskIds: Array.from(members).sort(compareTaskIds),
      });
    }
    await save(path, {
      ...receipt,
      survivors: Array.from(survivors).sort(),
      taskFingerprints: fingerprints,
    });
    if (taskChanges.length > 0) {
      const current = await repository.readAll();
      const result = await repository.applyTransaction({
        expectedTaskRevision: current.revision,
        expectedPlanningRevision: planningSnapshot.revision,
        operationId: `backlog-import-${digest}`,
        ownedPaths: [
          ".quest/migrations/backlog",
          ...taskChanges.map(({ task }) => `.quest/tasks/${task.id}.json`),
        ],
        taskChanges,
        milestones: [
          ...planningSnapshot.milestones.filter((m) => !milestones.has(m.id)),
          ...Array.from(milestones.values()),
        ],
        decisions: planningSnapshot.decisions,
      });
      if (result.kind === "conflict") {
        const failed = {
          ...receipt,
          state: "failed" as const,
          survivors: Array.from(survivors).sort(),
          taskFingerprints: fingerprints,
        };
        await save(path, failed);
        return failed;
      }
    }
    const after = await source.readSnapshot();
    if (after.fingerprint !== preview.sourceFingerprint) {
      const failed = {
        ...receipt,
        state: "failed" as const,
        survivors: Array.from(survivors).sort(),
        taskFingerprints: fingerprints,
      };
      await save(path, failed);
      return failed;
    }
    const applied = {
      ...receipt,
      state: "applied" as const,
      survivors: Array.from(survivors).sort(),
      taskFingerprints: fingerprints,
    };
    await save(path, applied);
    return applied;
  }

  async status(digest: string): Promise<Receipt> {
    const receipt = await load(receiptPath(this.root, digest));
    if (!receipt) throw new Error("migration_not_found");
    return receipt;
  }

  async rollback(digest: string): Promise<Receipt> {
    const { root, repository } = this;
    const path = receiptPath(root, digest);
    const receipt = await this.status(digest);
    if (receipt.state === "rolled-back") return receipt;
    const survivors: string[] = [];
    const removedIds = new Set<string>();
    for (const mapping of receipt.mappings) {
      const snapshot = await repository.readAll();
      const located = snapshot.taskRecords.find(
        (entry) => entry.task.id === mapping.targetIdentifier,
      );
      if (!located) continue;
      if (
        fingerprint(located.task) !==
        receipt.taskFingerprints[mapping.targetIdentifier]
      ) {
        survivors.push(mapping.targetIdentifier);
        continue;
      }
      const result = await repository.writeLifecycle({
        expectedRevision: snapshot.revision,
        operationId: `backlog-rollback-${digest}`,
        ownedPaths: [`.quest/${located.location}/${located.task.id}.json`],
        taskChanges: [
          { taskId: located.task.id, location: located.location, remove: true },
        ],
        draftChanges: [],
      });
      if (result.kind === "conflict") survivors.push(mapping.targetIdentifier);
      else removedIds.add(mapping.targetIdentifier);
    }
    // Keep forward/back closure: strip removed task ids from milestone
    // membership instead of leaving dangling milestone back-references.
    if (removedIds.size > 0) {
      const planningSnapshot = await this.planning.read();
      const result = await this.planning.write({
        expectedRevision: planningSnapshot.revision,
        operationId: `backlog-rollback-${digest}`,
        decisions: planningSnapshot.decisions,
        milestones: planningSnapshot.milestones.map((m) => ({
          ...m,
          taskIds: m.taskIds.filter((id) => !removedIds.has(id)),
        })),
      });
      if (result.kind === "conflict")
        for (const mapping of receipt.mappings)
          survivors.push(mapping.targetIdentifier);
    }
    const rolled = {
      ...receipt,
      state: "rolled-back" as const,
      survivors: survivors.sort(),
    };
    await save(path, rolled);
    return rolled;
  }
}

export async function removeBacklogReceiptForTest(
  root: string,
  digest: string,
): Promise<void> {
  await rm(receiptPath(root, digest), { force: true });
}
