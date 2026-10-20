import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  type TaskVocabulary,
  vocabularyListProblem,
} from "../../domain/tasks/vocabulary.ts";
import {
  WorkspaceError,
  type WorkspaceConfiguration,
  type WorkspaceIdentity,
  type WorkspacePort,
} from "../../ports/workspaces.ts";

/** Reads one `key = "value"` line from the small, self-authored TOML subset
 * Quest writes; undefined when the key is absent, quoteless, or malformed. */
function tomlString(content: string, key: string): string | undefined {
  const match = content.match(
    new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*$`, "mu"),
  );
  return match
    ? match[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    : undefined;
}

/** Same as tomlString, scoped to a `[table]` section's body (up to the next
 * `[...]` header or EOF) so a same-named key outside the table never matches. */
function tomlTableString(
  content: string,
  table: string,
  key: string,
): string | undefined {
  const header = content.match(new RegExp(`^\\[${table}\\]\\s*$`, "mu"));
  if (!header || header.index === undefined) return undefined;
  const bodyStart = header.index + header[0].length;
  const rest = content.slice(bodyStart);
  const nextHeader = rest.match(/^\[.*\]\s*$/mu);
  const body =
    nextHeader && nextHeader.index !== undefined
      ? rest.slice(0, nextHeader.index)
      : rest;
  return tomlString(body, key);
}

/**
 * QCLI-330: the `[tasks]` table's `types` and `priorities` arrays. This is
 * the one table Quest reads through a real TOML parser, because the values
 * are arrays and the line-matching helpers above read only strings.
 *
 * Presence is decided from the PARSED document, never a line match
 * (reviewer finding 1): `[ tasks ]`, `["tasks"]`, an inline
 * `tasks = {...}` and dotted `tasks.priorities = [...]` are all valid TOML,
 * and all mean a table is configured. A malformed `[tasks]` throws
 * `invalid_task_vocabulary` -- the one error the CLI carries instead of
 * throwing -- so a declared table never silently reads as open, which is
 * what let `init --reconfigure` overwrite a configured set.
 *
 * The rest of the file keeps its lenient line-based reads, so an unrelated
 * TOML problem leaves the vocabulary open rather than being attributed to
 * `[tasks]` (reviewer finding 4). A file that does not parse at all fails
 * closed only when a `[tasks]`-looking section is present; otherwise the
 * vocabulary is open, exactly as it was before QCLI-330.
 *
 * A table that carries neither `types` nor `priorities` is refused too: it
 * declares nothing, and reading it as open would be the same silent trap.
 * Unknown keys beside a recognised one are ignored, the way `[agents]`
 * ignores keys it does not read, so a newer Quest can extend the table
 * without an older one failing on it.
 */
function tomlTaskVocabulary(content: string): TaskVocabulary | undefined {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(content);
  } catch {
    // The file does not parse, so presence is a best-effort line heuristic
    // that must recognise EVERY spelling a parsed file can carry -- a
    // bracketed section, an inline `tasks = {...}` or a dotted
    // `tasks.priorities = [...]` -- or a doubly-broken file would read as
    // open and be overwritten by `init --reconfigure`.
    if (!/^\s*(\[\s*"?tasks"?\s*\]|tasks\s*[.=])/mu.test(content))
      return undefined;
    throw new WorkspaceError(
      "invalid_task_vocabulary",
      ".quest/workspace.toml: the [tasks] table could not be parsed as TOML.",
    );
  }
  const table = (parsed as { tasks?: unknown }).tasks;
  if (table === undefined) return undefined;
  if (table === null || typeof table !== "object" || Array.isArray(table))
    throw new WorkspaceError(
      "invalid_task_vocabulary",
      ".quest/workspace.toml: [tasks] must be a table.",
    );
  const entries = table as Record<string, unknown>;
  if (entries.types === undefined && entries.priorities === undefined)
    throw new WorkspaceError(
      "invalid_task_vocabulary",
      '.quest/workspace.toml: [tasks] declares neither "types" nor "priorities"; a table that configures nothing cannot be read as open, or `quest init --reconfigure` would overwrite it. Remove the table to leave the fields open.',
    );
  const vocabulary: {
    types?: readonly string[];
    priorities?: readonly string[];
  } = {};
  for (const key of ["types", "priorities"] as const) {
    const value = entries[key];
    if (value === undefined) continue;
    const problem = vocabularyListProblem(value);
    if (problem !== undefined)
      throw new WorkspaceError(
        "invalid_task_vocabulary",
        `.quest/workspace.toml: tasks.${key} ${problem}.`,
      );
    vocabulary[key] = value as readonly string[];
  }
  return vocabulary;
}

async function git(path: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", path, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0)
    throw new WorkspaceError("not_git_worktree", "Path is not a Git worktree.");
  return (await new Response(process.stdout).text()).trim();
}

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

async function assertNoSymlinkEscape(
  root: string,
  target: string,
): Promise<void> {
  let current = root;
  for (const part of relative(root, target).split(sep)) {
    if (!part) continue;
    current = join(current, part);
    try {
      if (
        (await lstat(current)).isSymbolicLink() &&
        !contained(root, await realpath(current))
      ) {
        throw new WorkspaceError(
          "unsafe_path",
          "Workspace path escapes through a symlink.",
        );
      }
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      break; // the remaining leaf will be created only after its parents are checked
    }
  }
}

export class LocalWorkspacePort implements WorkspacePort {
  async inspect(path: string): Promise<WorkspaceIdentity> {
    const suppliedPath = await realpath(path);
    if (
      (await git(suppliedPath, ["rev-parse", "--is-bare-repository"])) ===
      "true"
    ) {
      throw new WorkspaceError(
        "bare_repository",
        "Quest requires a non-bare Git worktree.",
      );
    }
    const worktreePath = await realpath(
      resolve(
        suppliedPath,
        await git(suppliedPath, ["rev-parse", "--show-toplevel"]),
      ),
    );
    const commonDirectory = await realpath(
      resolve(
        worktreePath,
        await git(worktreePath, ["rev-parse", "--git-common-dir"]),
      ),
    );
    return { commonDirectory, worktreePath };
  }

  async writeInitialization(path: string, content: string): Promise<void> {
    const root = await realpath(path);
    const target = resolve(root, ".quest", "workspace.toml");
    if (!contained(root, target))
      throw new WorkspaceError(
        "unsafe_path",
        "Workspace path escapes its root.",
      );
    await assertNoSymlinkEscape(root, target);
    try {
      await stat(target);
      throw new WorkspaceError(
        "already_initialized",
        "Workspace is already initialized.",
      );
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
    }
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    await assertNoSymlinkEscape(root, target);
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
  }

  async writeConfiguration(path: string, content: string): Promise<void> {
    const root = await realpath(path);
    const target = resolve(root, ".quest", "workspace.toml");
    if (!contained(root, target))
      throw new WorkspaceError(
        "unsafe_path",
        "Workspace path escapes its root.",
      );
    await assertNoSymlinkEscape(root, target);
    const parent = dirname(target);
    await mkdir(parent, { recursive: true });
    await assertNoSymlinkEscape(root, target);
    await writeFile(target, content, "utf8");
  }

  async hasOwnedContent(path: string): Promise<boolean> {
    const root = await realpath(path);
    const questRoot = join(root, ".quest");
    if (await this.exists(join(questRoot, "planning.json"))) return true;
    for (const sub of [
      "tasks",
      "completed",
      "drafts",
      // QCLI-445: a workspace holding only question records owns content too.
      "questions",
      join("archive", "tasks"),
      join("archive", "drafts"),
    ]) {
      try {
        if ((await readdir(join(questRoot, sub))).length > 0) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return false;
  }

  async readConfiguration(path: string): Promise<WorkspaceConfiguration> {
    const root = await realpath(path);
    const target = resolve(root, ".quest", "workspace.toml");
    let content: string;
    try {
      content = await readFile(target, "utf8");
    } catch {
      return { schemaVersion: 1 };
    }
    const name = tomlString(content, "name");
    const taskIdPrefix = tomlString(content, "taskIdPrefix");
    // QCLI-330: the vocabulary is computed BEFORE the skill_source check so
    // an unrelated configuration error can never mask a broken [tasks]
    // table into reading as open (reviewer finding 2, second pass).
    const taskVocabulary = tomlTaskVocabulary(content);
    const agentSkillSourceRaw = tomlTableString(
      content,
      "agents",
      "skill_source",
    );
    if (
      agentSkillSourceRaw !== undefined &&
      agentSkillSourceRaw !== "repo" &&
      agentSkillSourceRaw !== "plugin" &&
      agentSkillSourceRaw !== "none"
    )
      throw new WorkspaceError(
        "invalid_configuration",
        `.quest/workspace.toml: agents.skill_source must be "repo", "plugin", or "none", got "${agentSkillSourceRaw}".`,
      );
    return {
      schemaVersion: 1,
      ...(name ? { name } : {}),
      ...(taskIdPrefix ? { taskIdPrefix } : {}),
      ...(agentSkillSourceRaw ? { agentSkillSource: agentSkillSourceRaw } : {}),
      ...(taskVocabulary ? { taskVocabulary } : {}),
    };
  }

  async readRegistry(
    registryPath: string,
  ): Promise<readonly WorkspaceIdentity[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(registryPath, "utf8"));
      if (
        !Array.isArray(parsed) ||
        !parsed.every(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            typeof (entry as WorkspaceIdentity).commonDirectory === "string" &&
            typeof (entry as WorkspaceIdentity).worktreePath === "string",
        )
      ) {
        throw new WorkspaceError(
          "registry_invalid",
          "Workspace registry is invalid.",
        );
      }
      return parsed as WorkspaceIdentity[];
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(
        "registry_invalid",
        "Workspace registry is invalid.",
      );
    }
  }

  async writeRegistry(
    registryPath: string,
    entries: readonly WorkspaceIdentity[],
  ): Promise<void> {
    await mkdir(dirname(registryPath), { recursive: true });
    await writeFile(
      registryPath,
      `${JSON.stringify(entries, null, 2)}\n`,
      "utf8",
    );
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
}
