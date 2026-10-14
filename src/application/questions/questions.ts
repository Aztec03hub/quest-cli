import {
  answerQuestion,
  askQuestion,
  type Question,
  type QuestionAnswerInput,
  type QuestionAskInput,
  type QuestionStatus,
  type QuestionWithdrawInput,
  withdrawQuestion,
} from "../../domain/questions/questions.ts";
import {
  RecordConflictError,
  RecordValidationError,
} from "../../domain/records.ts";
import type { QuestionRepository } from "../../ports/questions.ts";

const QUESTION_STATUSES: readonly QuestionStatus[] = [
  "open",
  "answered",
  "withdrawn",
];

/**
 * The question use cases opum-doc's seq 179(a) design specifies: `ask`,
 * `answer`, `withdraw`, `list` and `view`. The record validation and the
 * state-transition rules live in the domain module; this service owns only the
 * read-modify-write against the repository.
 *
 * The writes run inside `repository.transact`, so the read and the write are
 * one critical section under the store lock: a concurrent ask cannot mint a
 * duplicate id, and a concurrent answer or withdraw cannot lose a write. The
 * loser never overwrites: a concurrent ask reports a store conflict (exit 5),
 * and a concurrent answer or withdraw reports `question_not_open` (exit 6)
 * when the record already moved, or a store conflict (exit 5) when the lock
 * wait expires.
 */
export class QuestionService {
  constructor(private readonly repository: QuestionRepository) {}

  async list(status?: string): Promise<readonly Question[]> {
    if (
      status !== undefined &&
      !QUESTION_STATUSES.includes(status as QuestionStatus)
    ) {
      throw new RecordValidationError("question_status_invalid");
    }
    const all = await this.repository.readAll();
    return status === undefined
      ? all
      : all.filter((record) => record.status === status);
  }

  async view(id: string): Promise<Question> {
    const record = (await this.repository.readAll()).find(
      (entry) => entry.id === id,
    );
    if (!record) throw new RecordValidationError("question_not_found");
    return record;
  }

  /**
   * `explicit` distinguishes the two ways the candidate id can already be
   * taken: a caller who named it with `--id` gets a validation error (exit 6,
   * the id is occupied), while an auto-allocated id that lost a race to a
   * concurrent ask is a conflict (exit 5).
   */
  async ask(
    id: string,
    input: QuestionAskInput,
    explicit = false,
  ): Promise<Question> {
    const record = askQuestion(id, input);
    const outcome = await this.repository.transact(async (records) => {
      if (records.some((existing) => existing.id === id)) {
        throw explicit
          ? new RecordValidationError("question_already_exists")
          : new RecordConflictError("question_id_taken");
      }
      return { write: record, value: record };
    });
    if (outcome.kind === "conflict")
      throw new RecordConflictError("question_store_conflict");
    return outcome.value;
  }

  async answer(id: string, input: QuestionAnswerInput): Promise<Question> {
    const outcome = await this.repository.transact(async (records) => {
      const current = records.find((record) => record.id === id);
      if (!current) throw new RecordValidationError("question_not_found");
      const next = answerQuestion(current, input);
      return { write: next, value: next };
    });
    if (outcome.kind === "conflict")
      throw new RecordConflictError("question_store_conflict");
    return outcome.value;
  }

  async withdraw(id: string, input: QuestionWithdrawInput): Promise<Question> {
    const outcome = await this.repository.transact(async (records) => {
      const current = records.find((record) => record.id === id);
      if (!current) throw new RecordValidationError("question_not_found");
      const next = withdrawQuestion(current, input);
      return { write: next, value: next };
    });
    if (outcome.kind === "conflict")
      throw new RecordConflictError("question_store_conflict");
    return outcome.value;
  }
}
