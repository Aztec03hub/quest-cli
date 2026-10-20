import { z } from "zod";

import { RecordValidationError } from "../records.ts";

/**
 * QCLI-445 / opum-doc seq 179(a): a `question` is the record by which a session
 * asks the operator something that blocks work, replacing the blocking
 * AskUserQuestion turn with a record the operator answers in the Quest pane.
 *
 * The record SHAPE is opum-doc's design
 * (`docs/reference/operator-questions-in-quest-design.md`): `id`, `title`,
 * `context`, `options`, `recommended`, `status` and `answer`. Two fields the
 * design's prose implies but does not spell out are settled here:
 *
 * - `withdrawal` holds the `--reason` that `question withdraw` requires. A
 *   required flag whose value is nowhere in the record would be a flag that
 *   silently discards its input, so the reason is persisted beside `answer`,
 *   with the same `actor` and a timestamp.
 * - `createdAt`/`updatedAt` mirror every other per-file record in this store.
 *
 * `status` is the design's three-value set: `open` -> `answered` or
 * `withdrawn`. The two terminal states are mutually exclusive.
 */
export type QuestionId = `Q-${number}`;
export type QuestionStatus = "open" | "answered" | "withdrawn";

export interface QuestionOption {
  readonly key: string;
  readonly label: string;
  readonly description: string;
}

/** The operator's answer: their own words, verbatim, and how it arrived. */
export interface QuestionAnswer {
  /** The chosen option key, when the operator picked one. */
  readonly choice?: string;
  /** Free text, verbatim, when the operator typed their own answer. */
  readonly text?: string;
  readonly answeredAt: string;
  readonly actor: string;
  /**
   * How the answer arrived. `quest question answer --via <value>` records this;
   * the Quest board pane passes `quest-board-pane`, and opum-doc treats any
   * other `via` as a finding rather than an operator answer (the design's
   * forgery guard). Absent when the caller supplied no `--via`.
   */
  readonly via?: string;
}

/** The record left behind when a question no longer needs asking.
 * DEC-190 fixes the field names: `by` (the actor) and `at` (the time). */
export interface QuestionWithdrawal {
  readonly reason: string;
  readonly by: string;
  readonly at: string;
}

export interface Question {
  readonly id: QuestionId;
  readonly title: string;
  readonly context?: string;
  readonly options: readonly QuestionOption[];
  readonly recommended?: string;
  readonly status: QuestionStatus;
  readonly answer?: QuestionAnswer;
  readonly withdrawal?: QuestionWithdrawal;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface QuestionAskInput {
  readonly title: string;
  readonly context?: string;
  readonly options: readonly QuestionOption[];
  readonly recommended?: string;
  readonly createdAt?: string;
}

export interface QuestionAnswerInput {
  readonly choice?: string;
  readonly text?: string;
  readonly actor: string;
  readonly via?: string;
  readonly answeredAt?: string;
}

export interface QuestionWithdrawInput {
  readonly reason: string;
  readonly actor: string;
  readonly withdrawnAt?: string;
}

const questionIdSchema = z
  .string()
  .regex(/^Q-[1-9][0-9]*$/) as z.ZodType<QuestionId>;
const optionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
});
const answerSchema = z.object({
  choice: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  answeredAt: z.string().min(1),
  actor: z.string().min(1),
  via: z.string().min(1).optional(),
});
const withdrawalSchema = z.object({
  reason: z.string().min(1),
  by: z.string().min(1),
  at: z.string().min(1),
});
export const questionRecordSchema = z.object({
  id: questionIdSchema,
  title: z.string().min(1),
  context: z.string().optional(),
  options: z.array(optionSchema),
  recommended: z.string().min(1).optional(),
  status: z.enum(["open", "answered", "withdrawn"]),
  answer: answerSchema.optional(),
  withdrawal: withdrawalSchema.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

function unique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length)
    throw new RecordValidationError(`${name} cannot contain duplicates.`);
}

export function questionId(value: string): QuestionId {
  if (!/^Q-[1-9][0-9]*$/.test(value))
    throw new RecordValidationError(`Invalid question id: ${value}`);
  return value as QuestionId;
}

/** Structural validation shared by every entry point that stores a record. */
export function questionRecord(value: Question): Question {
  const parsed = questionRecordSchema.safeParse(value);
  if (!parsed.success)
    throw new RecordValidationError("Invalid question record.");
  const record = parsed.data as Question;
  unique(
    record.options.map((option) => option.key),
    "Question option keys",
  );
  if (
    record.recommended !== undefined &&
    !record.options.some((option) => option.key === record.recommended)
  ) {
    throw new RecordValidationError(
      "Question recommended key is not one of its options.",
    );
  }
  if (record.status === "answered" && record.answer === undefined)
    throw new RecordValidationError("An answered question needs an answer.");
  if (record.status === "withdrawn" && record.withdrawal === undefined)
    throw new RecordValidationError("A withdrawn question needs a withdrawal.");
  return record;
}

/** DEC-190: `ask` requires 2 to 4 options and a recommendation naming one of
 * them. A text-only answer through the pane's "Other" stays allowed. */
export function askQuestion(id: string, input: QuestionAskInput): Question {
  if (input.options.length < 2 || input.options.length > 4)
    throw new RecordValidationError("question_options_out_of_range");
  if (input.recommended === undefined)
    throw new RecordValidationError("question_recommend_required");
  if (!input.options.some((option) => option.key === input.recommended))
    throw new RecordValidationError("question_recommend_not_an_option");
  const at = input.createdAt ?? new Date().toISOString();
  return questionRecord({
    ...input,
    id: questionId(id),
    status: "open",
    createdAt: at,
    updatedAt: at,
  });
}

/** Answering is legal only from `open`; `answered` and `withdrawn` are terminal. */
export function answerQuestion(
  record: Question,
  input: QuestionAnswerInput,
): Question {
  if (record.status !== "open")
    throw new RecordValidationError("question_not_open");
  if (input.choice === undefined && input.text === undefined)
    throw new RecordValidationError("question_answer_required");
  if (
    input.choice !== undefined &&
    !record.options.some((option) => option.key === input.choice)
  ) {
    throw new RecordValidationError("question_choice_not_an_option");
  }
  const at = input.answeredAt ?? new Date().toISOString();
  return questionRecord({
    ...record,
    status: "answered",
    answer: {
      ...(input.choice !== undefined ? { choice: input.choice } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
      answeredAt: at,
      actor: input.actor,
      ...(input.via !== undefined ? { via: input.via } : {}),
    },
    updatedAt: at,
  });
}

export function withdrawQuestion(
  record: Question,
  input: QuestionWithdrawInput,
): Question {
  if (record.status !== "open")
    throw new RecordValidationError("question_not_open");
  const at = input.withdrawnAt ?? new Date().toISOString();
  return questionRecord({
    ...record,
    status: "withdrawn",
    withdrawal: { reason: input.reason, by: input.actor, at },
    updatedAt: at,
  });
}
