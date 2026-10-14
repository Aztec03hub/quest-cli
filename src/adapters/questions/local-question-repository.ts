import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  type Question,
  questionRecord,
  questionRecordSchema,
} from "../../domain/questions/questions.ts";
import { RecordValidationError } from "../../domain/records.ts";
import type {
  QuestionRepository,
  QuestionTransaction,
} from "../../ports/questions.ts";
import {
  decodeAuthoredRecord,
  encodeAuthoredRecord,
} from "../records/codec.ts";

const QUESTION_FILE = /^Q-[1-9][0-9]*\.json$/;
const LOCK_WAIT_MS = 2000;

function sequence(id: string): number {
  return Number(id.slice("Q-".length));
}

/**
 * One JSON file per question under `<root>/.quest/questions/`, matching the
 * record path opum-doc's design fixes (`Q-N.json`). Decoding is strict (the
 * shared `codec`), each write is atomic (a temp file, then `rename`), and
 * `transact` holds the store's inter-process lock across the read and the
 * write, the same mkdir-based lock the task store uses
 * (`local-task-repository.ts`). That lock is what makes allocation and the
 * read-modify-write safe: two concurrent asks cannot both mint `Q-N`, and a
 * concurrent answer or withdraw cannot lose a write -- the loser reports a
 * conflict rather than overwriting.
 */
export class LocalQuestionRepository implements QuestionRepository {
  constructor(private readonly root: string) {}

  private directory(): string {
    return join(this.root, ".quest", "questions");
  }

  private lockPath(): string {
    return join(this.directory(), ".write.lock");
  }

  private async acquireLock(): Promise<boolean> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      try {
        await mkdir(this.lockPath());
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await Bun.sleep(5);
    }
    return false;
  }

  async readAll(): Promise<readonly Question[]> {
    let names: readonly string[];
    try {
      names = await readdir(this.directory());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new RecordValidationError("Invalid question storage.");
    }
    const records: Question[] = [];
    for (const name of names) {
      if (!QUESTION_FILE.test(name)) continue;
      // A read that fails (a vanished or unreadable file) is a storage error,
      // never a raw fs exception escaping the port.
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(join(this.directory(), name)));
      } catch {
        throw new RecordValidationError("Invalid question storage.");
      }
      const decoded = decodeAuthoredRecord(bytes, questionRecordSchema);
      records.push(questionRecord(decoded as Question));
    }
    return records.sort(
      (left, right) => sequence(left.id) - sequence(right.id),
    );
  }

  async transact<T>(
    operation: (
      records: readonly Question[],
    ) => Promise<QuestionTransaction<T>>,
  ): Promise<
    | { readonly kind: "success"; readonly value: T }
    | { readonly kind: "conflict" }
  > {
    await mkdir(this.directory(), { recursive: true });
    if (!(await this.acquireLock())) return { kind: "conflict" as const };
    try {
      const records = await this.readAll();
      const { write, value } = await operation(records);
      if (write !== undefined) await this.persist(write);
      return { kind: "success" as const, value };
    } finally {
      await rm(this.lockPath(), { recursive: true, force: true });
    }
  }

  private async persist(record: Question): Promise<void> {
    const validated = questionRecord(record);
    const target = join(this.directory(), `${validated.id}.json`);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await writeFile(
      temporary,
      encodeAuthoredRecord(validated, questionRecordSchema),
    );
    await rename(temporary, target);
  }
}
