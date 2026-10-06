# Max

**Maxwell** — Managed Agent eXecution With Event-Linked Logic.

Local agent factory. Scheduled, git-triggered, file-watched, chat-driven Cursor
agents run on your machine via the
[Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript) in local mode —
no cloud execution dependency. A Kanban dashboard shows automations by workspace,
runs needing input, and history. Agents can pause and ask the operator.

**Clones and forks welcome. Contributions are closed.** This is a reference
implementation: no public PR review, no community triage. Licensed
[Apache-2.0](./LICENSE). Provenance: [NOTICE](./NOTICE).
Fork/upgrade: [`docs/forking.md`](docs/forking.md).

The CLI is **`max`**. `lca` is a permanent alias. Not the Zendesk MySQL CDC tool.

> **Status:** Core platform and implement-fully are live, including named role
> profiles, optional researcher/gatekeeper roles, review-owned phase closeout,
> Files navigation, dashboard Alerts prefs with ntfy, and a **serial overnight queue**
> (`max queue` — see [configuration](./docs/configuration.md#serial-implement-fully-queue-lca-queue)).
> A separate architect role is optional (`plan-skeleton` only); omit it and planner covers skeleton planning.
> Config: [`docs/configuration.md`](docs/configuration.md) ·
> Troubleshooting: [`docs/troubleshooting.md`](docs/troubleshooting.md) ·
> Implement-fully: [`docs/implement-fully-protocol.md`](docs/implement-fully-protocol.md) ·
> Roadmap format: [`docs/roadmap-format.md`](docs/roadmap-format.md) ·
> Brand: [`docs/brand.md`](docs/brand.md).

## Highlights

- **Runtime:** `@cursor/sdk` local mode (typed event stream, durable multi-turn,
  cross-process resume, native skill/MCP/rule pickup).
- **Needs-Input:** a local `ask_user` MCP tool — a real blocking tool call, not
  stdout sentinel parsing.
- **Full harness:** `settingSources: ["all"]` so workspace + user-level skills, MCP
  servers, and rules are available to every run.
- **Model variants:** automations, runs, chats, and workspace defaults persist full
  Cursor `ModelSelection` values (base id + catalog parameters). Scalar YAML
  `model: grok-4.6` still works; see
  [configuration → Model selection](./docs/configuration.md#model-selection).
- **Triggers:** cron, git hooks, file-watch, and a generic `command` trigger
  (test-failure is just `command: npm test`).
- **State:** SQLite (`better-sqlite3`) for runs, events, input requests, history.
- **Concurrency:** configurable cap (`settings.maxConcurrentRuns`); excess runs
  queue and start as slots free. Queued runs survive a daemon restart.
- **Reliability:** the daemon self-heals stuck runs — boot reconciliation of
  orphaned active runs, a spawn timeout, a runtime stall watchdog, and a shared
  bounded-retry policy, all reason-coded across log/events/toast
  (`spawnTimeoutMs` / `runStallTimeoutMs` / `maxSpawnAttempts` / `retryBackoffMs`).
- **History export:** JSON/CSV from the dashboard, the `lca export` verb, or
  `GET /api/runs/export`.
- **File viewer deep links:** an agent writes a plan/doc in the workspace and
  emits `http://<host>:3747/?view=files&workspace=<id>&path=<rel>` in its final
  message — the transcript renders it clickable, and the Files view opens that
  file (markdown preview). URL contract and workspace-id derivation:
  [configuration → File viewer deep links](./docs/configuration.md#file-viewer-deep-links).

## Getting Started

From a Max checkout, use **`npm ci`** (not bare `npm install`) so the lockfile
and `engine-strict` Node floor are honored.

```bash
npm ci
npm run build
# ~/.cursor-local-automations/.env  →  CURSOR_API_KEY=crsr_...
npm link -w @lca/cli    # global max/lca — or use npx lca … everywhere below
max skills install      # or: npm run install:skill — copies max-setup + pipeline skills
max up                  # start the daemon (required before roadmap readiness)
max workspace add <path>   # register your project repo
max doctor              # Environment + Roadmaps summary
max doctor <path> --json   # readiness loop (fixable_by); exit 0 = ready
```

**Branches after doctor:**

- **Create** (empty): `max roadmap init`
- **Adopt** (competing backlog files): follow the `max-setup` skill and
  [Adopting an existing backlog](./docs/roadmap-format.md#adopting-an-existing-backlog)
- **Ready**: kick off documented work with `max implement-fully --feature b42`

Fresh Cursor chats in this checkout should read [AGENTS.md](./AGENTS.md) first,
then invoke the **`max-setup`** skill for setup, upgrade, and adoption.

Check skill drift anytime: `max skills install --check`. `max update --apply` installs skills for the version it lands on.

### CLI (`max`, alias `lca`)

With the daemon running, drive it from the terminal (`npm run build` first, or
`node packages/cli/dist/index.js …`):

```bash
max list                 # automations + recent run states (all workspaces)
max list --workspace <id|name|path>   # same view, one workspace (-w)
max workspace add <path> # register a repository with the daemon
max doctor [runId|chatId|workspace]  # run/chat, roadmap readiness, or daemon health
max doctor <path> --json # typed readiness report (agents — text lacks fixable_by)
max doctor --report      # pasteable support bundle
max roadmap init [dir]   # scaffold docs/roadmap/00-index.md when empty
max roadmap fix [workspace] [--yes]   # additive index repairs
max update check         # approved release + Upgrade actions
max update --apply --dry-run   # inspect apply plan without stopping daemon
max update --from <file> [--dry-run]   # install a test bundle on a public clone
max update --stable                     # return to the release saved by --from
max skills install [--check|--dry-run]   # sync bundled skills to ~/.cursor/skills/
max enable <id|name>     # arm an automation (disable to disarm)
max run <id|name>        # trigger a run; prompts inline if it asks for input
max implement-fully --feature b42   # documented work (or b-dm58; --idea for new work)
max implement-fully --feature b42 --execute   # execute mode (pre-planned contracts)
max logs <runId>         # tail and follow a run's events (--no-follow to just print)
max answer <runId> text  # answer a run waiting on input
max pause <runId>        # park a running automation for steering chat
max resume <runId> [note…]  # resume a paused run (optional operator note)
max export --format csv  # export run history (--workspace <id|name>, --out <file>)
max remote on <ip>       # view the dashboard from another device (e.g. phone over Tailscale)
```

`max remote` manages remote access (`status`/`on`/`off`/`allow`/`deny`) — see the
[configuration reference](./docs/configuration.md#remote-access-eg-viewing-the-dashboard-on-your-phone-over-tailscale).

`max list --workspace` / `-w` filters both automations and recent runs on the CLI
using the same workspace id, name, or path matching as `max export` (the daemon
still returns full lists; filtering is client-side).

From a workspace chat, attach a live run and **steer** it with
`POST /api/chats/:id/steer` (dashboard **Steer** control) — guidance is queued on
the run and lands after the current turn without interrupting it.

Identifiers resolve by the YAML `id`, the display name, or a unique id prefix. Override the daemon
location with `LCA_DAEMON_URL` (or `LCA_PORT`).

## Configuration

Global config lives in `~/.cursor-local-automations/automations.yaml` (workspace
list + daemon `settings`); per-workspace automations in
`<workspace>/.cursor/automations/*.yaml`. Tune concurrency and event retention
via `settings:` or the `LCA_MAX_CONCURRENT` / `LCA_EVENT_RETENTION` /
`LCA_MAX_EVENT_BYTES` env vars; tune spawn reliability via `spawnTimeoutMs` /
`runStallTimeoutMs` / `maxSpawnAttempts` / `retryBackoffMs` (or their `LCA_*`
overrides). See the full
[configuration reference](docs/configuration.md) and
[troubleshooting guide](docs/troubleshooting.md).

Verify: `npm run verify:phase1` … `npm run verify:phase7` (most need an API key).
