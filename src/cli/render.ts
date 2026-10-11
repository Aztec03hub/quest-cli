/**
 * Renders structured command payloads without coupling the human surface to a
 * particular result kind. Keys are sorted so the same payload always produces
 * the same bytes, independent of construction order. Empty arrays render the
 * intentional human marker `(empty)` (never bare JSON); empty objects keep
 * their established `{}` form.
 */
export function renderHumanPayload(
  payload: unknown,
  priorityKeys: readonly string[] = [],
): string {
  return `${renderLines(payload, 0, priorityKeys).join("\n")}\n`;
}

function renderLines(
  value: unknown,
  indentation: number,
  priorityKeys: readonly string[] = [],
): readonly string[] {
  const prefix = " ".repeat(indentation);
  if (value === null || typeof value !== "object")
    return [`${prefix}${renderScalar(value)}`];

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}(empty)`];
    return value.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") {
        if (typeof entry === "string" && entry.includes("\n"))
          return [
            `${prefix}-`,
            ...entry.split("\n").map((line) => `${prefix}  | ${line}`),
          ];
        return [`${prefix}- ${renderScalar(entry)}`];
      }
      return [
        `${prefix}-`,
        ...renderLines(entry, indentation + 2, priorityKeys),
      ];
    });
  }

  // QCLI-266: `quest help` puts `summary` and `usage` above the fields and
  // flags dump, because those two lines are the only ones that show the
  // positional form and a reader truncating the output has to reach them.
  // Everything else stays alphabetical, so output remains deterministic.
  const rank = (key: string) => {
    const index = priorityKeys.indexOf(key);
    return index === -1 ? priorityKeys.length : index;
  };
  // QCLI-272: Object.entries keeps a key whose value is JS `undefined`
  // (unlike JSON.stringify, which drops it), so an object literal that
  // assigns an absent optional field straight from a possibly-undefined
  // variable -- rather than conditionally spreading it in -- would otherwise
  // print the literal word "undefined" here. Filtering before the emptiness
  // check matches JSON's own semantics and this renderer's existing
  // empty-object convention: an object left with nothing to show renders
  // `{}`, not a wall of absent keys.
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(
      ([left], [right]) =>
        rank(left) - rank(right) || (left < right ? -1 : left > right ? 1 : 0),
    );
  if (entries.length === 0) return [`${prefix}{}`];
  return entries.flatMap(([key, entry]) => {
    if (entry === null || typeof entry !== "object") {
      // QCLI-409: a MULTI-LINE string value is delimited -- its lines render
      // under the key, each prefixed with `| ` -- so content embedded in a
      // value cannot read as live record fields. A Backlog-migrated record
      // carries its original frontmatter inside `description` (including a
      // `status: To Do` line), which rendered indistinguishably from the
      // record's own `status` and made `quest task list | grep -c status:`
      // count far more than the record count. A single-line string is
      // unchanged.
      if (typeof entry === "string" && entry.includes("\n"))
        return [
          `${prefix}${key}:`,
          ...entry.split("\n").map((line) => `${prefix}  | ${line}`),
        ];
      return [`${prefix}${key}: ${renderScalar(entry)}`];
    }
    return [
      `${prefix}${key}:`,
      ...renderLines(entry, indentation + 2, priorityKeys),
    ];
  });
}

function renderScalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

/**
 * QCLI-312 / DEC-161: the `--fields` human form. One row per record, the
 * selected fields TAB-separated in the caller's order -- a narrow,
 * line-oriented read rather than the nested default dump. Scalar values render
 * as they do in {@link renderHumanPayload} (strings raw, everything else
 * compact JSON); an absent or null field is the empty string, so a row always
 * has exactly one column per named field. An empty projection keeps the
 * established `(empty)` marker.
 */
export function renderTabSeparatedRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  fields: readonly string[],
): string {
  if (rows.length === 0) return "(empty)\n";
  return `${rows
    .map((row) => fields.map((field) => renderTabField(row[field])).join("\t"))
    .join("\n")}\n`;
}

function renderTabField(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
