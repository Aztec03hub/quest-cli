import {
  AgentInstructionError,
  type AgentInstructionPort,
} from "../../ports/agent-instructions.ts";
import type { AgentSkillSource } from "../../ports/workspaces.ts";
import { QUEST_VERSION } from "../version.ts";

export { AgentInstructionError } from "../../ports/agent-instructions.ts";

export const codexInstructionPath = "AGENTS.md";
export const claudeInstructionPath = "CLAUDE.md";
export const antigravityInstructionPath = "GEMINI.md";

/**
 * Which agent's instruction file the managed block targets. Defaults to
 * "codex" (AGENTS.md) everywhere so existing callers are unaffected.
 *
 * QCLI-159/255: "codex" (AGENTS.md) also covers pi and OpenCode, which read
 * AGENTS.md (or CLAUDE.md) directly with no dedicated file of their own --
 * confirmed against each tool's own docs before adding anything, per the
 * fleet's "do not guess filenames" instruction. "antigravity" (GEMINI.md) is
 * a genuine fourth file: Google's own docs (antigravity.google/docs/cli/
 * best-practices/) name GEMINI.md as Antigravity's own dedicated file,
 * parallel to CLAUDE.md for Claude Code, distinct from the AGENTS.md it also
 * reads as a shared fallback -- and Gemini CLI (a separate product) reads the
 * same GEMINI.md file too (geminicli.com/docs/cli/gemini-md/), so this
 * target is genuinely shared between the two, the same way AGENTS.md is
 * shared across many tools.
 */
export type AgentInstructionTarget = "claude" | "codex" | "antigravity";

export function agentInstructionPathForTarget(
  target: AgentInstructionTarget = "codex",
): string {
  if (target === "claude") return claudeInstructionPath;
  if (target === "antigravity") return antigravityInstructionPath;
  return codexInstructionPath;
}

const begin = "<!-- quest:agent-instructions:begin -->";
const end = "<!-- quest:agent-instructions:end -->";

/** The small, versioned contract which agents may rely on after opt-in. The
 * CI hint names the exact --target the reader needs, so a claude-target block
 * doesn't tell its reader to run the codex-target check.
 *
 * `version` defaults to the installed CLI's own {@link QUEST_VERSION} but is
 * accepted as a parameter so {@link checkQuestAgentInstructions} can build the
 * same template around an arbitrary version string when checking whether a
 * stored block differs *only* in that one embedded number (QCLI-228). */
function questAgentInstructionsFor(
  target: AgentInstructionTarget = "codex",
  version: string = QUEST_VERSION,
): string {
  const targetFlag = target !== "codex" ? ` --target ${target}` : "";
  return `${begin}
# Quest agent instructions

This project uses Quest CLI ${version} for tracker operations. Run \`quest manifest --json\` to discover the supported command contract.

Read the matching guide before tracker work: \`quest instructions overview\` for the command set and machine contract, \`quest instructions task-creation\` before creating or splitting tasks, \`quest instructions task-execution\` before claiming, planning, or recording progress, \`quest instructions task-finalization\` before checking acceptance criteria or closing a task, and \`quest instructions workspace\` for initialization, managed instructions, and Backlog.md migration. \`quest instructions --list\` lists every guide. Search for an existing record with \`quest search "<query>" --json\` before creating one, and run \`quest help <command>\` for a command's options and examples.

Quest writes require an explicit actor declaration: \`--actor <id> --actor-kind human\` for a person, or \`--actor <id> --actor-kind delegated-agent --accountable-human <id>\` for an agent acting on a person's behalf. Do not edit Quest-authored records directly. CI should run \`quest agents --check --require-installed${targetFlag}\`: current instructions, and a version-only difference (only the pinned Quest CLI version number is stale) both exit 0; missing, drifted, or malformed managed instructions exit 6. Quest does not retry write conflicts automatically; callers should read the latest task state and perform their own bounded retry when a command returns conflict/exit 5.
${end}\n`;
}

/** Matches the one place a version is embedded in the managed block's prose. */
const EMBEDDED_VERSION_PATTERN =
  /Quest CLI (\d+\.\d+\.\d+) for tracker operations\./;

/**
 * The Backlog.md CLI installer's own managed block (QCLI-215). A workspace
 * migrated off Backlog.md via `migration backlog apply` predictably still
 * carries this -- the migration path retires the tracker, not the leftover
 * instructions telling every agent to consult it first. Bounded to exactly
 * this delimited block: no prose parsing, and no touching anything else in
 * the file. The version comment inside varies by installed Backlog.md
 * release, so it is matched generically rather than pinned.
 */
const BACKLOG_GUIDELINES_PATTERN =
  /<!-- BACKLOG\.MD GUIDELINES START -->[\s\S]*?<!-- BACKLOG\.MD GUIDELINES END -->\n?/gu;

function hasBacklogGuidelinesBlock(content: string): boolean {
  return content.match(BACKLOG_GUIDELINES_PATTERN) !== null;
}

/** Removes the Backlog.md installer's block, if present, and nothing else. */
function stripBacklogGuidelinesBlock(content: string): string {
  return content.replace(BACKLOG_GUIDELINES_PATTERN, "");
}

/** Byte-identical to the pre-QCLI-227 constant, for callers (e.g. the bare
 * `quest instructions` command) that don't yet know about --target. */
export const questAgentInstructions = questAgentInstructionsFor("codex");

export type AgentInstructionCheck =
  | { readonly state: "missing" }
  | { readonly state: "current" }
  | { readonly state: "version-only"; readonly message: string }
  | { readonly state: "drift"; readonly message: string }
  | { readonly state: "orphaned"; readonly message: string };

function managedBlocks(content: string): readonly string[] {
  const blocks = content.match(
    /<!-- quest:agent-instructions:begin -->[\s\S]*?<!-- quest:agent-instructions:end -->/gu,
  );
  return blocks ?? [];
}

/**
 * Checks the managed region without interpreting or normalizing user-authored
 * text.
 *
 * A block whose only difference from the current template is its one
 * embedded version number reports `"version-only"`, not `"drift"` (QCLI-228):
 * the block's guidance is still byte-identical prose, and `agents --check`
 * gating on a routine patch/minor version bump alone -- with no other content
 * change -- was failing CI closed on drift that was not real. Any other
 * difference, including a version bump paired with a real prose change,
 * still reports `"drift"`.
 */
export function checkQuestAgentInstructions(
  content: string | undefined,
  target: AgentInstructionTarget = "codex",
): AgentInstructionCheck {
  if (content === undefined) return { state: "missing" };
  const result = checkQuestBlockOnly(content, target);
  // A leftover Backlog.md installer block is a real, actionable contradiction
  // (QCLI-215) -- every agent obeying both is told to consult a tracker the
  // Quest migration exists specifically to retire. Only override an
  // otherwise-healthy result: a block that already needs fixing for its own
  // reasons keeps that message, and `--update-instructions` clears both
  // problems in the same pass regardless.
  if (
    (result.state === "current" || result.state === "version-only") &&
    hasBacklogGuidelinesBlock(content)
  ) {
    return {
      state: "drift",
      message:
        "This file still carries the Backlog.md installer's guidelines block, which the Quest migration this workspace completed is meant to retire. Run `quest agents --update-instructions` to remove it.",
    };
  }
  return result;
}

function checkQuestBlockOnly(
  content: string,
  target: AgentInstructionTarget,
): AgentInstructionCheck {
  const begins = content.split(begin).length - 1;
  const ends = content.split(end).length - 1;
  const blocks = managedBlocks(content);
  if (begins === 0 && ends === 0) return { state: "missing" };
  if (begins !== 1 || ends !== 1 || blocks.length !== 1) {
    return {
      state: "drift",
      message: "Quest agent instruction markers are malformed or duplicated.",
    };
  }
  const block = `${blocks[0]}\n`;
  const expected = questAgentInstructionsFor(target);
  if (block !== expected) {
    const storedVersion = block.match(EMBEDDED_VERSION_PATTERN)?.[1];
    if (
      storedVersion !== undefined &&
      block.replace(
        EMBEDDED_VERSION_PATTERN,
        `Quest CLI ${QUEST_VERSION} for tracker operations.`,
      ) === expected
    ) {
      return {
        state: "version-only",
        message: `Quest agent instruction block records Quest CLI ${storedVersion}; the installed CLI is ${QUEST_VERSION}. Content is otherwise current.`,
      };
    }
    return {
      state: "drift",
      message: `Quest agent instruction block differs from version ${QUEST_VERSION}.`,
    };
  }
  return { state: "current" };
}

/**
 * Adds or replaces exactly the Quest-owned block. Surrounding text is preserved
 * byte-for-byte; malformed existing markers are deliberately not overwritten.
 *
 * Also removes a leftover Backlog.md installer block, if present (QCLI-215).
 * Branching above is on the Quest block's own state alone, unaffected by
 * whether a Backlog block is also present -- the removal is an unconditional
 * final pass over whatever content that branching already produced, so it
 * applies identically whether the Quest block was current, drifted, or
 * missing.
 */
export function applyQuestAgentInstructions(
  content: string | undefined,
  target: AgentInstructionTarget = "codex",
): string {
  const expected = questAgentInstructionsFor(target);
  const check = checkQuestBlockOnly(content ?? "", target);
  const withQuestBlock = ((): string => {
    if (check.state === "current") return content ?? expected;
    if (check.state === "drift" || check.state === "version-only") {
      const blocks = managedBlocks(content ?? "");
      const [block] = blocks;
      if (blocks.length !== 1 || !block)
        throw new AgentInstructionError(check.message);
      return (content ?? "").replace(block, expected.trimEnd());
    }
    if (!content) return expected;
    return `${content}${content.endsWith("\n") ? "\n" : "\n\n"}${expected}`;
  })();
  return stripBacklogGuidelinesBlock(withQuestBlock);
}

/** Writes the opt-in instruction file only when its managed block changes. */
export async function updateQuestAgentInstructions(
  port: AgentInstructionPort,
  path = codexInstructionPath,
  target: AgentInstructionTarget = "codex",
): Promise<AgentInstructionCheck> {
  const current = await port.read(path);
  const check = checkQuestAgentInstructions(current, target);
  if (check.state === "current") return check;
  await port.write(path, applyQuestAgentInstructions(current, target));
  return { state: "current" };
}

/** Reads the opt-in instruction file for a non-mutating drift check. */
export async function inspectQuestAgentInstructions(
  port: AgentInstructionPort,
  path = codexInstructionPath,
  target: AgentInstructionTarget = "codex",
): Promise<AgentInstructionCheck> {
  return checkQuestAgentInstructions(await port.read(path), target);
}

export const questSkillPath = ".claude/skills/quest/SKILL.md";

/** Where the opum-quest Claude Code plugin's copy of the skill is committed,
 * relative to the repository root. The marketplace federates the plugin from
 * this repository at a release tag, so this file is what plugin users get. */
export const pluginSkillRelPath = "skills/quest/SKILL.md";

/** The Quest skill, generated for where it ships from. "repo" is the copy
 * `quest agents` writes into a workspace; "plugin" is the committed
 * pluginSkillRelPath. They differ only in the sentence saying where the skill
 * came from, so the plugin copy cannot drift from what the CLI generates
 * (QCLI-372). On a plugin-copy drift failure, regenerate it with
 * `bun run scripts/plugin-skill.mjs --write`. */
export function questSkillDoc(source: "repo" | "plugin"): string {
  const provenance =
    source === "plugin"
      ? `This skill is a pointer, not a manual, installed from the \`opum-quest\` Claude Code
plugin rather than generated into this repository. The guidance ships inside the CLI,
so it cannot drift from the release you have installed:`
      : `This skill is a pointer, not a manual. The guidance ships inside the CLI, so it cannot
drift from the release you have installed:`;
  return `---
name: quest
description: "Drive this repo's task tracker with the quest CLI instead of editing backlog/tracker state directly. Use whenever creating, listing, viewing, editing, completing, or archiving tasks, drafts, milestones, or decisions in a Quest-initialized workspace. Run \`quest instructions --list\` for the workflow guides and \`quest help [command]\` for full usage."
---

# quest — tracker CLI

${provenance}

- \`quest instructions --list\` — the workflow guides, one line each.
- \`quest instructions overview\` — start here.
- \`quest instructions\` — the versioned protocol block Quest manages in your instructions file (AGENTS.md, CLAUDE.md, or GEMINI.md).
- \`quest help [command]\` — exact flags; \`quest manifest --json\` for the machine registry.

\`quest dashboard\` — then \`full\` or a task id, in any combination — opens the board in ONE
call to \`mcp__opum-quest__dashboard\` (\`full\`, \`task\`), so "quest dashboard full" asks for
both. Every argument that does not start at \`dashboard\` goes to the \`quest\` CLI as before
— "quest board" included, which the CLI already serves. Where the tool is unavailable
(Claude Code older than 2.1.287, a \`claude -p\` run, or mods off), say the pane is
unavailable here and answer from the CLI instead.

Drive tracker state through \`quest\`, never by editing \`.quest/\` by hand.

Coming from Backlog.md? The \`migrate-from-backlog\` skill drives
\`quest migration backlog\` preview, apply, status and rollback.
`;
}

/** The bundled Quest skill, installed opt-in alongside the managed AGENTS.md
 * block. Entirely Quest-owned: unlike the managed block, the whole file is
 * either an exact match or drifted, never merged into surrounding content. */
export const questSkillContent = questSkillDoc("repo");

/** True when this workspace generates no per-repo skill file, so absence is
 * the healthy state and a present file is orphaned rather than current.
 * "plugin" and "none" agree here and differ only in what they assert about
 * where the skill comes from -- see AgentSkillSource (QCLI-309). */
export function generatesQuestSkillFile(
  skillSource: AgentSkillSource,
): boolean {
  return skillSource === "repo";
}

/** Whole-file check: the skill is entirely Quest-owned, so any content other
 * than an exact match is drift, not something to merge. Under
 * skillSource "plugin", the skill ships from the opum-quest Claude Code
 * plugin instead of this repository; under "none" it ships from nowhere and
 * this workspace has no quest skill at all. In BOTH cases absence is the
 * healthy state, and any present file (byte-exact or not) is reported
 * "orphaned" -- present when it should not exist -- rather than
 * "missing"/"current"/"drift". Only the message differs, because only the
 * assertion differs: "none" must never say a plugin provides the skill. */
export function checkQuestSkillFile(
  content: string | undefined,
  skillSource: AgentSkillSource = "repo",
): AgentInstructionCheck {
  if (!generatesQuestSkillFile(skillSource)) {
    if (content === undefined) return { state: "current" };
    const reason =
      skillSource === "plugin"
        ? 'this workspace\'s agents.skillSource is "plugin", so the quest skill ships from the opum-quest Claude Code plugin instead of this repository'
        : 'this workspace\'s agents.skillSource is "none", so it generates no quest skill file and none ships from anywhere else';
    return {
      state: "orphaned",
      message: `${questSkillPath} should not exist: ${reason}. Delete it, or run \`quest agents --force\` to remove it if it exactly matches the generated content.`,
    };
  }
  if (content === undefined) return { state: "missing" };
  if (content === questSkillContent) return { state: "current" };
  return {
    state: "drift",
    message: "Quest skill file differs from the bundled version.",
  };
}

/**
 * Writes the bundled skill file only when it differs from what is installed
 * (skillSource "repo"), or removes an orphaned one under skillSource
 * "plugin" or "none" -- but ONLY when force is given AND the on-disk bytes
 * exactly match what Quest itself would generate. A hand-edited or otherwise
 * differing file is never removed, force or not: it stays "orphaned" until
 * deleted by hand or restored to the exact generated bytes.
 */
export async function updateQuestSkillFile(
  port: AgentInstructionPort,
  path = questSkillPath,
  skillSource: AgentSkillSource = "repo",
  force = false,
): Promise<AgentInstructionCheck> {
  const current = await port.read(path);
  const check = checkQuestSkillFile(current, skillSource);
  if (!generatesQuestSkillFile(skillSource)) {
    if (check.state === "orphaned" && force && current === questSkillContent) {
      await port.remove(path);
      return { state: "current" };
    }
    return check;
  }
  if (check.state === "current") return check;
  await port.write(path, questSkillContent);
  return { state: "current" };
}

/** Reads the installed skill file for a non-mutating drift check. */
export async function inspectQuestSkillFile(
  port: AgentInstructionPort,
  path = questSkillPath,
  skillSource: AgentSkillSource = "repo",
): Promise<AgentInstructionCheck> {
  return checkQuestSkillFile(await port.read(path), skillSource);
}
