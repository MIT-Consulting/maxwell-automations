---
name: max-setup
description: >-
  Set up Max on a repository, register it with the daemon, check roadmap readiness,
  upgrade Max, diagnose failures, or adopt an existing backlog into docs/roadmap/.
  Use when the operator asks to set up Max, install Maxwell, register a repo,
  check if Max is ready, upgrade Max, fix Max setup, or convert backlog markdown
  into Max's roadmap format. Routes agents through CLI output — never reimplements
  version-specific product logic.
---

# Max Setup

Router over Max CLI commands. The CLI owns version facts, refusal text, and
readiness classification; this skill says which command to run and how to act on
the result.

## Make `max` callable first

Before any `max …` command, ensure one invocation path works from this checkout:

1. **`npm link -w @lca/cli`** — global `max` / `lca` on PATH after
   `npm run build -w @lca/cli`.
2. **`npx lca …`** — no link; substitute `npx lca` everywhere this skill says
   `max`.
3. **Existing global `max`** — only when `max --version` already succeeds from
   this checkout's build.

Do not print bare `max …` examples until one path is confirmed.

## Setup order (new workspace)

1. Read `engines.node` in `package.json`. Compare to `node --version`. If Node
   is below the required floor, surface the CLI's Node-floor refusal text
   **verbatim** and stop — never run nvm, fnm, or installers yourself.
2. `npm ci` → `npm run build` (or `npm run build -w @lca/cli` when iterating CLI).
3. `max skills install` (or `npx lca skills install`).
4. `max up` — daemon must be running before roadmap readiness.
5. `max workspace add <path>` — register the target repository.
6. Bare `max doctor` — Environment (Node/npm/skills drift) and Roadmaps summary.
7. Targeted readiness: `max doctor <workspace> --json` (or `max doctor -w <id> --json`).

Only exit 0 on targeted `--json` doctor means setup is done. Never declare
success on your own judgment.

### Environment ownership (text doctor only)

Bare doctor has no `fixable_by`. Use this table:

| Finding | Owner | Action |
| --- | --- | --- |
| Node below floor | user | Surface refusal verbatim; stop |
| npm missing / wrong | user | Ask operator to fix Node/npm |
| skills drift | cli | Run printed `max skills install` fix |

### Readiness loop (`--json` only)

Text doctor lacks `fixable_by`. Always use `max doctor <workspace> --json`.

For each finding in the report:

- **`fixable_by: cli`** — run the printed `fix` command exactly.
- **`fixable_by: agent`** — perform the bounded edit, show the diff, do not commit.
- **`fixable_by: user`** — stop and ask the operator.

Repeat until exit code 0. Green doctor is the only done signal.

Cite [docs/roadmap-format.md](../../docs/roadmap-format.md) **Minimum to kick off**
for kickoff rules instead of reproducing them here.

## Upgrade branch

1. `max update check` — read the **Upgrade actions** block in output.
2. `max update --apply --dry-run` — inspect refusals and planned steps.
3. Ask the operator to confirm before `max update --apply`.
4. On any refusal (`node-floor`, dirty tree, active runs, …), surface the refusal
   line verbatim and stop. Never bypass a refusal.

## Diagnose branch

1. Bare `max doctor` — Environment and daemon health.
2. `max doctor <workspace>` or `max doctor <runId>` for targeted reports.
3. `max doctor --report` when the operator needs a pasteable support bundle.

**Never:** probe `state.sqlite`, grep agent transcripts, run `lca down` or
`max down`, call `POST /api/shutdown`, use stop helpers, or restart the daemon
from an agent session.

## Adopt branch

When readiness state is `adoptable`, follow the sidecar:

```text
adoption.md
```

Present every candidate; **never pick by mtime**. Wait for the operator's
canonical-source choice before editing. Cite [docs/roadmap-format.md](../../docs/roadmap-format.md) **Adopting an
existing backlog** for format rules.

## Create branch (empty workspace)

When state is `empty`: `max roadmap init`, then rerun targeted `--json` doctor.

## Ready branch

When state is `ready` and doctor exits 0, setup is complete. Point the operator
at [docs/implement-fully-protocol.md](../../docs/implement-fully-protocol.md) or
README Getting Started for next steps.
