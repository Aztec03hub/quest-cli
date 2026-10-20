import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { questGuides } from "../../src/application/agents/guides.ts";
import { commandManifest } from "../../src/application/command-contract.ts";
import { commandHelp } from "../../src/application/command-help.ts";
import { runQuest } from "../../src/cli/main.ts";

/**
 * Every `quest` command a guide shows must actually run (QCLI-148).
 *
 * QCLI-141 shipped a task-finalization recipe calling `task edit
 * --final-summary` before that flag existed, so the guide exited 2 at the last
 * step of every task. A reviewer caught it by executing the guide by hand.
 *
 * The hard part of a guard like this is not running the commands, it is
 * finding them. An extractor that silently skips what it does not recognize
 * gives false confidence: the guide looks covered and is not. So every
 * non-empty line inside a fence must be recognized as a command, and an
 * unrecognized one fails rather than disappearing.
 */

/** Recipes use these; each is asserted to be reachable and used. */
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  "<id>": "T-1",
  "<actor>": "guide-runner",
  "<title>": "A created task",
  "<label>": "seeded",
  "<why this exists>": "because the guide says so",
  "<observable outcome>": "the outcome is observable",
  "<what changed and why>": "changed the thing, and why",
  "<what changed, why, how it was verified>": "changed it; tests verify it",
  "<what review changed>": "review found one more thing",
  // QCLI-163: the task-creation guide's two-pass dependency recipe creates a
  // third task (the pre-seeded task above is T-1, and task-creation's own
  // first recipe already creates T-2 via --dependency <id>) and then names
  // it as the dependency target -- guide order is load-bearing here too.
  "<target-id>": "T-3",
  // QCLI-226: the checklist-renumbering recipe creates a fourth task (after
  // T-1's pre-seed and QCLI-163's T-2/T-3) and edits/views only that one, so
  // it never touches T-1's own checklist -- which task-finalization's guide
  // still depends on later in this same run.
  "<checklist-id>": "T-4",
  // QCLI-331: task-finalization's close recipes retire two never-worked
  // tasks the creation guide made, leaving T-1's completion path untouched.
  "<duplicate-id>": "T-3",
  "<survivor-id>": "T-1",
  "<abandoned-id>": "T-4",
  "<why it will not be done>": "overtaken by events",
};

/** How many fenced recipes each guide is expected to carry. */
const EXPECTED_RECIPES: Readonly<Record<string, number>> = {
  overview: 0,
  "task-creation": 8,
  "task-execution": 3,
  "task-finalization": 6,
  workspace: 0,
};

/**
 * Fenced recipes. A fence may be language-tagged and a line may carry a shell
 * prompt; both are ordinary markdown habits, and neither may cause a recipe to
 * vanish. Anything inside a fence that is not a recognizable `quest` command
 * throws, because the alternative is skipping it in silence.
 */
function recipesIn(guide: string, content: string): readonly string[] {
  const found: string[] = [];
  for (const block of content
    .replaceAll("\r\n", "\n")
    .matchAll(/^ *```[a-zA-Z]*\n([\s\S]*?)^ *```/gm)) {
    const joined = (block[1] ?? "").replace(/\\\n\s*/g, " ");
    for (const raw of joined.split("\n")) {
      const line = raw.trim().replace(/^\$\s+/, "");
      if (line.length === 0) continue;
      if (!line.startsWith("quest "))
        throw new Error(
          `guide ${guide} has a fenced line that is not a quest command, so nothing would run it: ${line}`,
        );
      found.push(line);
    }
  }
  return found;
}

/**
 * Inline backticked spans. These are references -- "run `quest doctor`" --
 * often deliberately incomplete, so the obligation is that the command they
 * name and any flag they show are real, not that they run.
 *
 * Only spans beginning `quest ` are examined. The overview guide's command
 * table lists bare spellings like `task edit-batch`. Those are NOT examined
 * here; the ones inside a LIFECYCLE group (a family with a `<group> list`
 * verb) are covered from the other direction by the manifest-to-guide check in
 * command-contract.test.ts. A bare span outside those groups -- `completion
 * bash`, `check`, `browser` -- is checked by neither, so it reads as prose
 * here rather than as a machine-verified reference.
 */
function mentionsIn(content: string): readonly string[] {
  return [...content.matchAll(/`(quest [^`]+)`/g)].map((span) =>
    (span[1] ?? "").replaceAll("\n", " ").trim(),
  );
}

const manifestNames = new Set(
  commandManifest.commands.map((entry: { name: string }) => entry.name),
);

/** The manifest command a mention names, or undefined if it names none. */
function namedCommand(mention: string): string | undefined {
  const words = mention
    .slice("quest ".length)
    .split(/\s+/)
    .filter(
      (word) =>
        word.length > 0 && !/^[-<[("']/.test(word) && !word.endsWith("."),
    );
  for (let length = words.length; length > 0; length -= 1) {
    const candidate = words.slice(0, length).join(" ");
    if (manifestNames.has(candidate)) return candidate;
  }
  return undefined;
}

/** Splits a shown command into argv, substituting placeholder tokens. */
function argvFor(command: string): readonly string[] {
  const tokens = command.match(/(?:[^\s'"]|'[^']*'|"[^"]*")+/g) ?? [];
  return tokens.slice(1).map((token) => {
    const bare = token.replace(/^["']|["']$/g, "");
    // Scan inside the token too: a placeholder nested in a JSON argument is
    // still a placeholder, and an unmapped one must fail rather than be
    // passed through as literal text.
    for (const nested of bare.matchAll(/<[^>]+>/g))
      if (PLACEHOLDERS[nested[0]] === undefined)
        throw new Error(
          `guide command uses an unmapped placeholder ${nested[0]}: ${command}`,
        );
    return PLACEHOLDERS[bare] ?? bare;
  });
}

test("every quest command the guides show actually runs (QCLI-148)", async () => {
  const store = await mkdtemp(join(tmpdir(), "quest-guide-commands-"));
  const previous = process.env.QUEST_TASK_STORE;
  process.env.QUEST_TASK_STORE = store;
  try {
    // T-1 carries two acceptance criteria because the finalization guide
    // checks positions 1 and 2.
    await runQuest(
      [
        "task",
        "create",
        "Seeded",
        "--acceptance-criteria",
        '["first","second"]',
        "--label",
        "seeded",
        "--actor",
        "seed",
        "--actor-kind",
        "human",
        "--json",
      ],
      false,
    );

    const used = new Set<string>();
    // Guide order is load-bearing rather than incidental: `task complete` is
    // an illegal transition from To Do, so the finalization recipe is correct
    // only because task-execution has already set In Progress. Running each
    // guide against its own store reports a false failure -- verified.
    for (const guide of questGuides) {
      const recipes = recipesIn(guide.name, guide.content);
      // Exact, not a floor: a recipe the extractor stops seeing must fail
      // here rather than quietly reduce the count.
      expect({ guide: guide.name, recipes: recipes.length }).toEqual({
        guide: guide.name,
        recipes: EXPECTED_RECIPES[guide.name] ?? -1,
      });
      for (const command of recipes) {
        for (const placeholder of command.matchAll(/<[^>]+>/g))
          used.add(placeholder[0]);
        const result = await runQuest([...argvFor(command)], false);
        expect({
          guide: guide.name,
          command,
          exitCode: result.exitCode,
        }).toEqual({ guide: guide.name, command, exitCode: 0 });
      }
    }

    // The placeholder map stays honest in both directions: an unmapped one
    // throws above, and a mapped one no recipe uses is dead weight here.
    expect([...used].sort()).toEqual(Object.keys(PLACEHOLDERS).sort());

    // Exit 0 only proves the CLI accepted the recipes. This proves the
    // sequence produced the state the guides promise it produces.
    const task = JSON.parse(
      (await runQuest(["task", "view", "T-1", "--json"], false)).stdout,
    ).data;
    expect(task).toMatchObject({
      status: "Done",
      plan: ["1. ...", "2. ..."],
      finalSummary: `${PLACEHOLDERS["<what changed, why, how it was verified>"]}\n\n${PLACEHOLDERS["<what review changed>"]}`,
      acceptanceCriteria: [
        { index: 0, text: "first", checked: true },
        { index: 1, text: "second", checked: true },
      ],
    });
    expect(task.implementationNotes).toContain(
      PLACEHOLDERS["<what changed and why>"],
    );
  } finally {
    if (previous === undefined) delete process.env.QUEST_TASK_STORE;
    else process.env.QUEST_TASK_STORE = previous;
    await rm(store, { recursive: true, force: true });
  }
});

test("every quest command and flag the guides mention is real (QCLI-148)", () => {
  // The reference half. A guide naming a command or flag that does not exist
  // is the same defect as a recipe that does not run, and `overview` and
  // `workspace` are almost entirely references.
  const guideNames = new Set(questGuides.map((guide) => guide.name));
  for (const guide of questGuides) {
    const unknownCommands: string[] = [];
    const unknownFlags: string[] = [];
    const unknownGuides: string[] = [];
    for (const mention of mentionsIn(guide.content)) {
      const command = namedCommand(mention);
      if (command === undefined) {
        unknownCommands.push(mention);
        continue;
      }
      // --json and --plain are output modes every command takes, so no
      // per-command help list carries them.
      const documented = new Set([
        ...(commandHelp[command as keyof typeof commandHelp]?.flags ?? []),
        "--json",
        "--plain",
      ]);
      for (const word of mention.split(/\s+/))
        if (/^--[a-z][a-z-]*$/.test(word) && !documented.has(word))
          unknownFlags.push(`${mention} -> ${word}`);
      // A cross-reference to another guide must name one that exists.
      if (command === "instructions")
        for (const word of mention
          .slice("quest instructions".length)
          .split(/\s+/))
          if (word.length > 0 && !word.startsWith("-") && !guideNames.has(word))
            unknownGuides.push(`${mention} -> ${word}`);
    }
    expect({
      guide: guide.name,
      unknownCommands,
      unknownFlags,
      unknownGuides,
    }).toEqual({
      guide: guide.name,
      unknownCommands: [],
      unknownFlags: [],
      unknownGuides: [],
    });
  }
});
