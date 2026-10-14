/**
 * QCLI-266. One description of every command's argument shape, read by both
 * `quest help` (human) and `quest manifest` (machine) so the two surfaces
 * cannot disagree with each other, and by the argv parser so neither can
 * disagree with what the CLI actually accepts.
 *
 * The defect this closes: a caller reading only help and the manifest could
 * not write a valid `task create` on the first try. Neither surface said the
 * title is positional rather than `--title`, nor that `--acceptance-criteria`
 * takes one JSON array while `--label` is a repeatable scalar. A list of flag
 * NAMES cannot carry arity, and `quest manifest`'s `fields` array listed the
 * domain field `title` beside real flags with nothing to tell them apart.
 */

/** What a caller has to put after the flag, or in the positional slot. */
export type ParameterValue =
  | "none"
  /** One scalar token. */
  | "string"
  /** One JSON array in a single pass: --acceptance-criteria '["a","b"]'. */
  | "json-array"
  /** One JSON array of objects: --comments '[{"id":...,"body":...}]'. */
  | "json-objects";

export interface FlagParameter {
  readonly value: ParameterValue;
  /** Pass the flag once per item (--label a --label b), never as a JSON array. */
  readonly repeatable?: true;
  /**
   * The element shapes a checklist array accepts (QCLI-313). ADDITIVE and
   * optional on purpose: `value` stays `json-array`, so a consumer switching
   * on it is unaffected, and one that reads this learns the object form
   * exists. Widening the `ParameterValue` union instead would have been the
   * tidier-looking change and would break any consumer matching that union
   * exhaustively.
   *
   * It is here because the object form used to be discoverable from exactly
   * one place in the CLI's entire output -- the usage error for an object
   * array missing `index` -- so an agent reading `quest manifest --json` to
   * learn the contract concluded the flag took strings, and was wrong. Three
   * of them did within hours.
   */
  readonly items?: string;
}

export interface PositionalParameter {
  readonly name: string;
  readonly required: boolean;
  readonly value: ParameterValue;
}

/**
 * Flags taking one JSON array. `rejectArrayLookingValue` enforces the converse
 * for repeatable flags (QCLI-250), so these two sets must stay disjoint --
 * `flagValueKinds` asserts exactly that, and a test pins it.
 */
export const JSON_ARRAY_FLAGS = [
  "--acceptance-criteria",
  "--definition-of-done",
  "--plan",
  "--implementation-notes",
] as const;

/** Takes one JSON array of structured objects, not bare strings. */
export const JSON_OBJECT_FLAGS = ["--comments", "--add-comment"] as const;

/**
 * The checklist flags: a JSON array whose elements may be bare strings OR
 * `{index,text,checked}` objects (QCLI-313). `--plan` and
 * `--implementation-notes` share `json-array` and are NOT checklists -- they
 * hold no checked state and take strings only, which is why this is its own
 * set rather than all of `JSON_ARRAY_FLAGS`.
 */
export const CHECKLIST_FLAGS = [
  "--acceptance-criteria",
  "--definition-of-done",
] as const;

/** The element shapes a checklist flag accepts, as the manifest reports them. */
export const CHECKLIST_ITEM_SHAPE = "string | {index,text,checked}";

/**
 * Flags that take no value. Lifted out of the argv parser so help and the
 * manifest report exactly what the parser enforces rather than a copy of it.
 */
export const BOOLEAN_FLAGS = [
  "--agent-instructions",
  "--check",
  "--require-installed",
  "--update-instructions",
  "--confirm",
  "--dry-run",
  "--include-archived",
  "--all",
  "--clear-parent",
  "--clear-milestone",
  "--clear-ac",
  "--clear-dod",
  "--clear-final-summary",
  "--force",
  "--preserve-source-ids",
  "--reconfigure",
  "--list",
  "--ready",
  "--unassigned",
  "--unresolved-at-completion",
  // QCLI-415: selects the continuity check (`quest check --continuity --base
  // <ref>`); a mode selector that carries no value of its own.
  "--continuity",
  // QCLI-417: `--across-refs` selects the repository-true view on `task list`,
  // and `--allow-partial` keeps a partial answer usable (exit 0 with
  // coverage.complete false) instead of failing closed on it.
  "--across-refs",
  "--allow-partial",
] as const;

/**
 * Flags passed once per item. These are the same lists the `task create` and
 * `task edit` argv parsing hands to `flags()`; importing them here rather than
 * repeating them is what keeps the reported arity and the enforced arity the
 * same thing.
 */
export const REPEATABLE_CREATE_FLAGS = [
  "--label",
  "--doc",
  "--alias",
  "--assignee",
  "--reference",
  "--modified-file",
  "--dependency",
] as const;

export const REPEATABLE_EDIT_FLAGS = [
  "--add-label",
  "--remove-label",
  "--doc",
  "--add-plan",
  "--remove-plan",
  "--add-note",
  "--remove-note",
  "--append-final-summary",
  "--add-comment",
  "--remove-comment",
  "--add-dependency",
  "--remove-dependency",
  "--add-assignee",
  "--remove-assignee",
  "--add-reference",
  "--remove-reference",
  "--add-modified-file",
  "--remove-modified-file",
  "--check-ac",
  "--uncheck-ac",
  "--remove-ac",
  "--check-dod",
  "--uncheck-dod",
  "--remove-dod",
] as const;

/** `task edit-batch`'s repeatable set: the edit set minus the checklist and
 * final-summary flags, which a batch item expresses in its patch instead. */
export const REPEATABLE_EDIT_BATCH_FLAGS = [
  "--add-label",
  "--remove-label",
  "--doc",
  "--add-plan",
  "--remove-plan",
  "--add-note",
  "--remove-note",
  "--add-comment",
  "--remove-comment",
  "--add-dependency",
  "--remove-dependency",
  "--add-assignee",
  "--remove-assignee",
  "--add-reference",
  "--remove-reference",
  "--add-modified-file",
  "--remove-modified-file",
] as const;

/** `task list`'s repeatable filters. */
export const REPEATABLE_LIST_FLAGS = [
  "--label",
  "--exclude-status",
  "--assignee",
  "--type",
  // QCLI-417: `--across-refs` takes an explicit population, and both ways of
  // naming it are per-item -- `--ref origin/dev --ref refs/heads/other`, or
  // `--pr 12 --pr 14`.
  "--ref",
  "--pr",
] as const;

/**
 * Repeatability is PER COMMAND, not global: `--type` is one scalar on
 * `task create` and a repeatable filter on `task list`. A single merged set
 * gets that wrong in the direction that matters, telling a caller to repeat a
 * flag the command accepts once.
 */
const REPEATABLE_BY_COMMAND: Readonly<Record<string, readonly string[]>> = {
  "task create": REPEATABLE_CREATE_FLAGS,
  "task edit": REPEATABLE_EDIT_FLAGS,
  "task edit-batch": REPEATABLE_EDIT_BATCH_FLAGS,
  "task list": REPEATABLE_LIST_FLAGS,
  // QCLI-417: the same parser branch, so the same arity. Keyed separately
  // because both `quest help` and `quest manifest` look this up by the
  // ENTRY's own name, and a missing key would report `--ref <string>` -- a
  // caller reading that would pass one ref and silently read only one.
  "task list --across-refs": REPEATABLE_LIST_FLAGS,
  // QCLI-445: `question ask` takes one `--option` per choice (the parser is
  // handed this same list), so the manifest must report it repeatable rather
  // than as a single scalar.
  "question ask": ["--option"],
};
const BOOLEAN = new Set<string>(BOOLEAN_FLAGS);
const JSON_ARRAY = new Set<string>(JSON_ARRAY_FLAGS);
const JSON_OBJECT = new Set<string>(JSON_OBJECT_FLAGS);
const CHECKLIST = new Set<string>(CHECKLIST_FLAGS);

/** The value shape of one flag on one command, from the sets the parser uses. */
export function flagParameter(
  flag: string,
  commandName: string,
): FlagParameter {
  if (BOOLEAN.has(flag)) return { value: "none" };
  if (JSON_OBJECT.has(flag)) return { value: "json-objects" };
  if (CHECKLIST.has(flag))
    return { value: "json-array", items: CHECKLIST_ITEM_SHAPE };
  if (JSON_ARRAY.has(flag)) return { value: "json-array" };
  if ((REPEATABLE_BY_COMMAND[commandName] ?? []).includes(flag))
    return { value: "string", repeatable: true };
  return { value: "string" };
}

/** How a flag reads in `quest help`: `--label <string, repeatable>`. */
export function describeFlag(flag: string, commandName: string): string {
  const { value, repeatable, items } = flagParameter(flag, commandName);
  if (value === "none") return flag;
  if (items !== undefined) return `${flag} <${value}: ${items}>`;
  return `${flag} <${repeatable ? `${value}, repeatable` : value}>`;
}

/**
 * Positional arguments, derived from the command's own `usage` string rather
 * than hand-listed beside it. Deriving is the point: a hand-written list is a
 * second place to forget, and `usage` is already authored and already correct.
 *
 * The grammar `usage` is written in: tokens after the command words, up to the
 * first flag. `<id>` and `"<title>"` are required, `[<guide>]` and `[topic]`
 * optional. Everything from the first `--flag` onward is flags and their
 * values, so `--digest <digest>` never reads as a positional.
 */
export function positionalParameters(
  usage: string,
): readonly PositionalParameter[] {
  const positionals: PositionalParameter[] = [];
  for (const raw of usage.split(/\s+/).slice(1)) {
    const optional = raw.startsWith("[");
    const unbracketed = raw.replace(/^\[|\]$/g, "");
    const quoted = /^["']/.test(unbracketed);
    const token = unbracketed.replace(/^["']|["']$/g, "");
    if (token.startsWith("--")) break;
    // A literal command word (`task`, `backlog`) is bare. A placeholder is
    // marked: angle-bracketed, quoted, or square-bracketed as optional.
    if (!token.startsWith("<") && !quoted && !optional) continue;
    positionals.push({
      name: token.replace(/^<|>$/g, ""),
      required: !optional,
      value: "string",
    });
  }
  return positionals;
}
