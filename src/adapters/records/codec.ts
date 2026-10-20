import type { z } from "zod";

import { RecordValidationError } from "../../domain/records.ts";

/** Decode authored bytes strictly: malformed UTF-8 and unsupported schemas never normalize input. */
export function decodeAuthoredRecord<T>(
  bytes: Uint8Array,
  schema: z.ZodType<T>,
): T {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RecordValidationError("Authored record is not valid UTF-8.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RecordValidationError("Authored record is not valid JSON.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RecordValidationError(
      "Unsupported or malformed authored record schema.",
    );
  }
  return parsed.data;
}

export function encodeAuthoredRecord(
  record: unknown,
  schema: z.ZodType,
): Uint8Array {
  const parsed = schema.safeParse(record);
  if (!parsed.success)
    throw new RecordValidationError(
      "Unsupported or malformed authored record schema.",
    );
  // Newline-terminated, as every other record writer in the store is
  // (planning.json, tasks/, drafts/), so a question file ends like the rest.
  return new TextEncoder().encode(`${JSON.stringify(parsed.data)}\n`);
}
