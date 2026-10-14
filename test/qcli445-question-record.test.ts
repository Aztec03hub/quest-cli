import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runQuest } from "../src/cli/main.ts";
import { LocalQuestionRepository } from "../src/adapters/questions/local-question-repository.ts";
import { QuestionService } from "../src/application/questions/questions.ts";
import { RecordConflictError } from "../src/domain/records.ts";

/**
 * QCLI-445 / opum-doc seq 179(a): the `question` record and its ask/answer/
 * withdraw/list/view commands, as specified in opum-doc's
 * `docs/reference/operator-questions-in-quest-design.md`. The board-pane UI and
 * its forgery guard are QCLI-446; this suite covers the CLI half, including the
 * `via` field and the rule that an answer names a human actor.
 */

const OPERATOR = ["--actor", "operator-1", "--actor-kind", "human"];

async function withStore(
  body: (
    run: (argv: readonly string[]) => Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>,
  ) => Promise<void>,
): Promise<void> {
  const store = await mkdtemp(join(tmpdir(), "quest-q445-"));
  const previous = process.env.QUEST_TASK_STORE;
  process.env.QUEST_TASK_STORE = store;
  try {
    await body((argv) => runQuest(argv, false));
  } finally {
    if (previous === undefined) delete process.env.QUEST_TASK_STORE;
    else process.env.QUEST_TASK_STORE = previous;
    await rm(store, { recursive: true, force: true });
  }
}

async function ask(
  run: (argv: readonly string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>,
  extra: readonly string[] = [],
) {
  return run([
    "question",
    "ask",
    "--title",
    "Ship it?",
    "--context",
    "the evidence and the trade-offs",
    "--option",
    "A=Yes:ship now",
    "--option",
    "B=No:wait",
    "--recommend",
    "A",
    ...OPERATOR,
    ...extra,
    "--json",
  ]);
}

test("ask allocates Q-N and stores the record the design specifies (QCLI-445)", async () => {
  await withStore(async (run) => {
    const asked = await ask(run);
    expect({ exitCode: asked.exitCode, stderr: asked.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const record = JSON.parse(asked.stdout).data;
    expect(record.id).toBe("Q-1");
    expect(record.status).toBe("open");
    expect(record.title).toBe("Ship it?");
    expect(record.context).toBe("the evidence and the trade-offs");
    expect(record.recommended).toBe("A");
    expect(record.options).toEqual([
      { key: "A", label: "Yes", description: "ship now" },
      { key: "B", label: "No", description: "wait" },
    ]);
    // DEC-190: timestamps are carried; `withdrawal` is present ONLY when the
    // question is withdrawn, so an open one must not carry it at all.
    expect(typeof record.createdAt).toBe("string");
    expect(typeof record.updatedAt).toBe("string");
    expect(record.withdrawal).toBeUndefined();

    // A second ask allocates the next sequence.
    expect(JSON.parse((await ask(run)).stdout).data.id).toBe("Q-2");
  });
});

test("ask with zero options is refused by the range rule (DEC-190)", async () => {
  await withStore(async (run) => {
    const result = await run([
      "question",
      "ask",
      "--title",
      "T",
      "--recommend",
      "A",
      ...OPERATOR,
      "--json",
    ]);
    expect({
      exitCode: result.exitCode,
      error: JSON.parse(result.stderr),
    }).toEqual({
      exitCode: 6,
      error: {
        error_type: "validation",
        message: "question_options_out_of_range",
        principal: null,
      },
    });
  });
});

test("ask requires 2 to 4 options and a --recommend naming one of them (DEC-190)", async () => {
  await withStore(async (run) => {
    const askArgs = (
      options: readonly string[],
      recommend: readonly string[],
    ): readonly string[] => [
      "question",
      "ask",
      "--title",
      "T",
      ...options.flatMap((option) => ["--option", option]),
      ...recommend,
      ...OPERATOR,
      "--json",
    ];
    const two = ["A=Yes:y", "B=No:n"];

    // REFUSED, each pinning the RULE by its message, not only the exit code.
    const refused: readonly (readonly [string, readonly string[], string])[] = [
      [
        "1 option",
        askArgs(["A=Yes:y"], ["--recommend", "A"]),
        "question_options_out_of_range",
      ],
      [
        "5 options",
        askArgs(
          ["A=1:a", "B=2:b", "C=3:c", "D=4:d", "E=5:e"],
          ["--recommend", "A"],
        ),
        "question_options_out_of_range",
      ],
      ["missing --recommend", askArgs(two, []), "question_recommend_required"],
      [
        "unknown --recommend key",
        askArgs(two, ["--recommend", "C"]),
        "question_recommend_not_an_option",
      ],
    ];
    for (const [label, argv, message] of refused) {
      const result = await run(argv);
      expect({
        label,
        exitCode: result.exitCode,
        error: JSON.parse(result.stderr),
      }).toEqual({
        label,
        exitCode: 6,
        error: { error_type: "validation", message, principal: null },
      });
    }

    // ACCEPTED: 2 and 4 options, with a recommendation naming a given key.
    const twoOptions = await run(askArgs(two, ["--recommend", "A"]));
    expect(twoOptions.exitCode).toBe(0);
    expect(
      (JSON.parse(twoOptions.stdout).data as { options: unknown[] }).options,
    ).toHaveLength(2);
    const fourOptions = await run(
      askArgs(["A=1:a", "B=2:b", "C=3:c", "D=4:d"], ["--recommend", "D"]),
    );
    expect(fourOptions.exitCode).toBe(0);
    const fourRecord = JSON.parse(fourOptions.stdout).data as {
      options: unknown[];
      recommended: string;
    };
    expect(fourRecord.options).toHaveLength(4);
    expect(fourRecord.recommended).toBe("D");
  });
});

test("ask/answer/view/list round-trip, and via records how the answer arrived (QCLI-445)", async () => {
  await withStore(async (run) => {
    const asked = JSON.parse((await ask(run)).stdout).data as {
      updatedAt: string;
    };
    // A millisecond apart keeps the "updatedAt advances" assertion deterministic.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const view = await run(["question", "view", "Q-1", "--json"]);
    expect(JSON.parse(view.stdout).data.id).toBe("Q-1");

    const open = await run(["question", "list", "--status", "open", "--json"]);
    expect(
      JSON.parse(open.stdout).data.map((r: { id: string }) => r.id),
    ).toEqual(["Q-1"]);

    const answered = await run([
      "question",
      "answer",
      "Q-1",
      "--choice",
      "A",
      "--via",
      "quest-board-pane",
      ...OPERATOR,
      "--json",
    ]);
    expect({ exitCode: answered.exitCode, stderr: answered.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    const record = JSON.parse(answered.stdout).data;
    expect(record.status).toBe("answered");
    expect(record.answer.choice).toBe("A");
    expect(record.answer.actor).toBe("operator-1");
    expect(record.answer.via).toBe("quest-board-pane");
    expect(typeof record.answer.answeredAt).toBe("string");
    expect(record.withdrawal).toBeUndefined();
    // updatedAt advances to the answer time.
    expect(record.updatedAt).toBe(record.answer.answeredAt);
    expect(record.updatedAt > asked.updatedAt).toBe(true);

    // A SECOND answer is refused: the two terminal states are exclusive.
    const doubleAnswer = await run([
      "question",
      "answer",
      "Q-1",
      "--choice",
      "B",
      ...OPERATOR,
      "--json",
    ]);
    expect(doubleAnswer.exitCode).toBe(6);
    expect(JSON.parse(doubleAnswer.stderr).message).toBe("question_not_open");

    // The answered question leaves the open filter.
    const stillOpen = await run([
      "question",
      "list",
      "--status",
      "open",
      "--json",
    ]);
    expect(JSON.parse(stillOpen.stdout).data).toEqual([]);
    const answeredList = await run([
      "question",
      "list",
      "--status",
      "answered",
      "--json",
    ]);
    expect(
      JSON.parse(answeredList.stdout).data.map((r: { id: string }) => r.id),
    ).toEqual(["Q-1"]);
  });
});

test("an answer may carry free text instead of a choice (QCLI-445)", async () => {
  await withStore(async (run) => {
    await ask(run);
    const answered = await run([
      "question",
      "answer",
      "Q-1",
      "--text",
      "do the third thing instead",
      ...OPERATOR,
      "--json",
    ]);
    expect(answered.exitCode).toBe(0);
    expect(JSON.parse(answered.stdout).data.answer.text).toBe(
      "do the third thing instead",
    );
  });
});

test("an answer must record a human actor -- a delegated agent is refused (QCLI-445)", async () => {
  await withStore(async (run) => {
    await ask(run);
    const refused = await run([
      "question",
      "answer",
      "Q-1",
      "--choice",
      "A",
      "--actor",
      "agent-7",
      "--actor-kind",
      "delegated-agent",
      "--accountable-human",
      "operator-1",
      "--json",
    ]);
    expect(refused.exitCode).toBe(4);
    expect(JSON.parse(refused.stderr).error_type).toBe("denied");
    // The record is untouched: the question is still open.
    const view = await run(["question", "view", "Q-1", "--json"]);
    expect(JSON.parse(view.stdout).data.status).toBe("open");
  });
});

test("withdraw records its reason and is one of two terminal states (QCLI-445)", async () => {
  await withStore(async (run) => {
    const asked = JSON.parse((await ask(run)).stdout).data as {
      updatedAt: string;
    };
    // A millisecond apart keeps the "updatedAt advances" assertion deterministic.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const withdrawn = await run([
      "question",
      "withdraw",
      "Q-1",
      "--reason",
      "no longer relevant",
      ...OPERATOR,
      "--json",
    ]);
    expect(withdrawn.exitCode).toBe(0);
    const record = JSON.parse(withdrawn.stdout).data;
    expect(record.status).toBe("withdrawn");
    // DEC-190 fixes the field names: reason, by, at.
    expect(record.withdrawal.reason).toBe("no longer relevant");
    expect(record.withdrawal.by).toBe("operator-1");
    expect(typeof record.withdrawal.at).toBe("string");
    expect(record.withdrawal.actor).toBeUndefined();
    expect(record.withdrawal.withdrawnAt).toBeUndefined();
    // updatedAt advances to the withdrawal time.
    expect(record.updatedAt).toBe(record.withdrawal.at);
    expect(record.updatedAt > asked.updatedAt).toBe(true);

    // Answering a question that is no longer open is refused by name.
    const late = await run([
      "question",
      "answer",
      "Q-1",
      "--choice",
      "A",
      ...OPERATOR,
      "--json",
    ]);
    expect(late.exitCode).toBe(6);
    expect(JSON.parse(late.stderr).message).toBe("question_not_open");

    // ...and so is a SECOND withdrawal.
    const again = await run([
      "question",
      "withdraw",
      "Q-1",
      "--reason",
      "again",
      ...OPERATOR,
      "--json",
    ]);
    expect(again.exitCode).toBe(6);
    expect(JSON.parse(again.stderr).message).toBe("question_not_open");
  });
});

test("a --choice naming no option key is refused (QCLI-445)", async () => {
  await withStore(async (run) => {
    await ask(run);
    const result = await run([
      "question",
      "answer",
      "Q-1",
      "--choice",
      "Z",
      ...OPERATOR,
      "--json",
    ]);
    expect(result.exitCode).toBe(6);
    expect(JSON.parse(result.stderr).message).toBe(
      "question_choice_not_an_option",
    );
  });
});

test("view of an unknown question is a not_found diagnostic on exit 3 (QCLI-445)", async () => {
  await withStore(async (run) => {
    const missing = await run(["question", "view", "Q-9", "--json"]);
    expect(missing.exitCode).toBe(3);
    expect(JSON.parse(missing.stderr).error_type).toBe("not_found");
  });
});

test("ask honours an explicit --id and refuses a duplicate (QCLI-445)", async () => {
  await withStore(async (run) => {
    const explicit = await ask(run, ["--id", "Q-42"]);
    expect(JSON.parse(explicit.stdout).data.id).toBe("Q-42");
    const duplicate = await ask(run, ["--id", "Q-42"]);
    expect(duplicate.exitCode).toBe(6);
    expect(JSON.parse(duplicate.stderr).error_type).toBe("validation");
  });
});

test("concurrent asks for one allocated id: exactly one wins, the other conflicts (QCLI-445)", async () => {
  // The proof for the store lock. Two asks racing for the SAME allocated id --
  // the shape two processes that both read an empty store produce -- must not
  // both write it. With the lock one wins and the other reports a conflict;
  // with the lock bypassed both read empty, both write Q-1 and both succeed,
  // so this test is RED on the unlocked code (verified by mutation).
  const store = await mkdtemp(join(tmpdir(), "quest-q445-race-"));
  try {
    const service = new QuestionService(new LocalQuestionRepository(store));
    const input = {
      title: "Concurrent",
      options: [
        { key: "A", label: "Yes", description: "y" },
        { key: "B", label: "No", description: "n" },
      ],
      recommended: "A",
    };
    const settled = await Promise.allSettled([
      service.ask("Q-1", input),
      service.ask("Q-1", input),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      RecordConflictError,
    );
    const stored = await new LocalQuestionRepository(store).readAll();
    expect(stored.map((record) => record.id)).toEqual(["Q-1"]);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});

test("concurrent asks cannot mint the same id; the loser reports a conflict (QCLI-445)", async () => {
  // The store lock is what makes id allocation and the read-modify-write one
  // critical section. Without it every process below reads an empty store,
  // allocates Q-1 and overwrites the others, so all eight report Q-1 -- this
  // test is RED on that code (verified by disabling the lock).
  const store = await mkdtemp(join(tmpdir(), "quest-q445-race-"));
  const main = new URL("../src/cli/main.ts", import.meta.url).pathname;
  try {
    const children = Array.from({ length: 8 }, () =>
      Bun.spawn(
        [
          process.execPath,
          main,
          "question",
          "ask",
          "--title",
          "Concurrent",
          "--option",
          "A=Yes:y",
          "--option",
          "B=No:n",
          "--recommend",
          "A",
          ...OPERATOR,
          "--json",
        ],
        {
          cwd: store,
          env: { ...process.env, QUEST_TASK_STORE: store },
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    );
    const results = await Promise.all(
      children.map(async (child) => ({
        exitCode: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      })),
    );

    const succeeded = results.filter((result) => result.exitCode === 0);
    const failed = results.filter((result) => result.exitCode !== 0);
    expect(succeeded.length).toBeGreaterThan(0);
    // Every loser is a conflict (exit 5), never a silent overwrite.
    for (const failure of failed) {
      expect(JSON.parse(failure.stderr).error_type).toBe("conflict");
    }
    // No two successes share an id.
    const ids = succeeded.map(
      (result) => JSON.parse(result.stdout).data.id as string,
    );
    expect(new Set(ids).size).toBe(ids.length);
    // The store holds exactly the ids that succeeded.
    const stored = (await readdir(join(store, ".quest", "questions")))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
    expect(stored).toEqual([...ids].sort());
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});
