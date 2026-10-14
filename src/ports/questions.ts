import type { Question } from "../domain/questions/questions.ts";

/** What one locked operation asks the repository to persist. */
export interface QuestionTransaction<T> {
  /** The record to write before the lock is released, if the operation writes. */
  readonly write?: Question;
  /** The value the operation returns to its caller. */
  readonly value: T;
}

/**
 * Persistence boundary for the question record store (QCLI-445). One record per
 * file at `.quest/questions/<id>.json` -- the shape opum-doc's design specifies
 * -- so unlike the single-file planning snapshot there is no cross-record
 * snapshot revision to compare and swap.
 *
 * Id allocation and the read-modify-write are made atomic by the store's own
 * inter-process lock (see `transact`), the same mechanism the task store uses,
 * so a concurrent ask cannot mint a duplicate id and a concurrent answer or
 * withdraw cannot lose a write -- the loser reports a conflict rather than
 * overwriting.
 */
export interface QuestionRepository {
  /** Every stored question, in ascending id order. */
  readAll(): Promise<readonly Question[]>;
  /**
   * Run one read-modify-write while holding the store lock. The callback is
   * handed the records read WHILE the lock is held; whatever it returns as
   * `write` is persisted before the lock is released. Returns `conflict` when
   * the lock cannot be taken within the wait budget.
   */
  transact<T>(
    operation: (
      records: readonly Question[],
    ) => Promise<QuestionTransaction<T>>,
  ): Promise<
    | { readonly kind: "success"; readonly value: T }
    | { readonly kind: "conflict" }
  >;
}
