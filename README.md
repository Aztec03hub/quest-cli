# quest

> A deterministic, LLM-free task tracker CLI — the record layer coding agents
> and humans write to, and that tools like `lore` couple to over JSON.

`quest` is the tracker of record for repository-resident work: tasks, drafts,
decisions, and milestones live as plain JSON under `.quest/`, committed to Git
alongside the code they describe. There is no server, no database, and no LLM
in `quest`'s core — every command is deterministic, reproducible, and
CI/agent-safe (non-interactive by default, stable semantic exit codes,
machine-readable `--json`).

- Built on **Bun + TypeScript** with an exact-pinned **Commander** parser; a
  versioned capability manifest (`quest manifest --json`) is the live,
  authoritative description of the command surface.
- Published on npm as **`@opum-ai/quest`** (bin `quest`) with six
  exact-pinned platform packages, including Windows ARM64.
- The agent bridge is a generated managed block in **`CLAUDE.md`**,
  **`AGENTS.md`**, or **`GEMINI.md`** (Claude Code, Codex/OpenCode/pi/etc., and
  Google Antigravity/Gemini CLI respectively) plus `quest instructions` for
  just-in-time, task-shaped guidance.

> **Status: released.** The release tag, the qualified workflow artifacts, all
> seven public `@opum-ai/quest*` npm packages, and a clean registry install
> agree on one published version. This file deliberately does not restate that
> number, and `bun run check:packages` fails the release if it reappears: a
> version hand-maintained here goes stale the moment the next release lands,
> and because `README.md` ships inside the tarball, the npm page then
> advertises the wrong one permanently -- version pages are immutable. npm and
> the repository's tags both show the current version already. Releases are
> qualified in lockstep with `@opum-ai/lore`. See
> [`docs/reference/quest-cli-release-truth.md`](docs/reference/quest-cli-release-truth.md).

---

## The headline: every write declares who made it

`quest` never accepts an anonymous write. Every command that mutates a
record — `task create`, `task edit`, `task complete`, and the rest — requires
an explicit actor declaration:

```bash
quest task edit QCLI-1 --status "In Progress" \
  --actor jdnewhouse --actor-kind human
```

or, when the actor performing the write is an agent rather than the human it
answers to:

```bash
quest task edit QCLI-1 --status "In Progress" \
  --actor my-agent-session --actor-kind delegated-agent \
  --accountable-human jdnewhouse
```

A missing `--actor-kind` is rejected outright ("Tracker writes require an
explicit actor declaration"); an invalid value names itself and lists the
valid kinds. This is deliberate, load-bearing provenance, not an
afterthought — it is what lets a record say not just *what* changed but *who*
is accountable for it, which matters most exactly when the actor is an
autonomous agent.

Tools couple to `quest` the same way `quest` couples to Git: by reading its
deterministic JSON, never by parsing prose or editing `.quest/` files
directly. `lore` is the reference consumer — see
[Lore dependency and adapter contract evidence](docs/reference/quest-cli-lore-dependency-and-adapter-contract-evidence.md).

---

## Install

The package and bin are `@opum-ai/quest` and `quest`:

```bash
# Node / npm
npx @opum-ai/quest --help

# Bun
bunx @opum-ai/quest --help

# Global npm install
npm install -g @opum-ai/quest
```

The launcher installs only the matching script-free platform package for your
OS/architecture, so a current install requires no install-script approval
exception. There is no native addon and nothing to compile locally.

Or add it to a project:

```bash
bun add -d @opum-ai/quest   # or: npm i -D @opum-ai/quest
```

The npm package is a dual artifact: a tiny Node `.cjs` launcher plus a
per-platform compiled binary (built with `bun build --compile`), delivered as
`optionalDependencies` — macOS, Linux, and Windows, each on `x64` and `arm64`.

---

## Quickstart

Every command is non-interactive by default and emits stable, semantic exit
codes. Output has three modes: pretty (default, color on a TTY), `--plain`
(ANSI-free stable text), and `--json` (a `{schemaVersion, kind, data}`
envelope on stdout, with errors on stderr as `{error_type, message, hint}`).
The one interactive path is `quest init` on a bare TTY invocation, which runs
a guided setup (project name, task ID prefix, a multi-select for which
instruction file(s) to write) — any flag or a non-TTY stdin runs it fully
non-interactively instead.

```bash
# 1. Initialize a Quest workspace in the current Git worktree.
quest init --name "My Project" --task-id-prefix ABC

# 2. Create a task. Every write needs an actor.
quest task create "Fix the flaky retry loop" \
  --description "Retries don't back off; a burst of failures thundering-herds the API." \
  --acceptance-criteria '["Retry loop applies exponential backoff with jitter"]' \
  --actor jdnewhouse --actor-kind human

# 3. Move it forward.
quest task edit ABC-1 --status "In Progress" --actor jdnewhouse --actor-kind human

# 4. See what's actually ready to work — dependencies resolved, blockers respected.
quest task list --ready --json

# 5. Finish it with evidence, not on faith.
quest task edit ABC-1 --check-ac 1 --actor jdnewhouse --actor-kind human
quest task edit ABC-1 --final-summary "Added exponential backoff with jitter; verified via the retry-storm test." \
  --actor jdnewhouse --actor-kind human
quest task complete ABC-1 --actor jdnewhouse --actor-kind human
```

`--json` is the additive-only machine contract:

```bash
$ quest task view ABC-1 --json
{
  "schemaVersion": 1,
  "kind": "task.view",
  "data": { "id": "ABC-1", "status": "Done", "title": "Fix the flaky retry loop", "..." : "..." },
  "principal": null
}
```

Semantic exit codes (uniform across commands, matching `lore`'s own
convention): `0` success, `1` uncaught, `2` usage, `3` not found, `4` denied,
`5` conflict, `6` validation or drift. The full, live command surface is
self-describing: `quest manifest --json` lists every command with its kind and
whether it mutates; `quest help <command>` shows flags, fields, and examples
for any command, including two-word ones (`quest help task edit`).

---

## How coding agents use quest

`quest` is CLI-first for humans **and** agents. Its agent bridge is generated,
not bespoke:

- `quest agents --update-instructions --target claude|codex|antigravity`
  writes (or refreshes) a managed block in `CLAUDE.md`, `AGENTS.md`, or
  `GEMINI.md` pointing an agent at `quest instructions` and the write
  contract above.
- `quest instructions overview` — and the more specific `quest instructions
  task-creation` / `task-execution` / `task-finalization` / `workspace` —
  print task-shaped guidance on demand for any agent or human, so onboarding
  doesn't depend on a human reading a wiki page first.
- `quest agents --check --require-installed --target <target>` verifies an
  installed instructions block is current, for CI: exit `0` on current
  instructions (including a version-only diff on a routine bump), exit `6` on
  missing, drifted, or malformed ones.

An agent's typical loop: run `quest instructions overview` before answering or
acting, read/search/create/update tasks with `--json` and an explicit actor,
and check acceptance criteria only with evidence in hand.

---

## Migrating from Backlog.md

`quest migration backlog preview --source <path> --json` previews a
Backlog.md-to-Quest cutover — digest, mappings, and (with
`--preserve-source-ids`) exactly what a dotted-subtask renumbering would
change — before `quest migration backlog apply` commits to it. See the
[Backlog adoption and migration playbook](docs/reference/quest-cli-backlog-adoption-and-migration-playbook.md).

---

## Documentation

The full design lives in this repo's OKF bundle under
[`docs/`](docs/index.md), authored and kept coherent with [`lore`](https://github.com/opum-ai/lore-cli):

- [Documentation index](docs/index.md) — the OKF root and reading hub.
- [Component charter](docs/reference/quest-cli-component-charter.md) — what
  this repository owns, consumes, and routes elsewhere.
- [Component contracts and delivery graph](docs/reference/quest-cli-component-contracts-and-delivery-graph.md).
- [Packaging contract](docs/reference/quest-cli-packaging-contract.md) and
  [release truth](docs/reference/quest-cli-release-truth.md).
- [ADRs](docs/adr/index.md) — the significant, hard-to-reverse decisions.

---

## Contributing

This is a public repository (`main` + `dev`; `dev` is the default branch,
`main` is the release branch, fast-forward only). See
[CONTRIBUTING](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and
[SECURITY](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Opum AI.
