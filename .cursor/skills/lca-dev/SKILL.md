---
name: lca-dev
description: >-
  Run a local cursor-local-automations (Max) dev session via verbs: up, down,
  status, doctor, runs, reset, prune, help. Also the first call when the user
  references the latest/most recent failure, error, halt, stuck run, or asks
  what's running — resolve via `lca doctor` / runs, do not probe SQLite.
  Triggers: /lca-dev, /lca-dev <verb>, "start automations", "open lca dashboard",
  "lca status", "lca doctor", "what failed", "latest failure", "halted pipeline",
  "what's running", "start fresh", "prune workspaces", "stop the daemon",
  "tear down lca".
---

# LCA Dev Session

Verb-dispatched control for a local **cursor-local-automations** loop. The product
is named **Max** (the `lca` CLI, `lca-dev` skill, and all `lca` verbs are
unchanged implementation-facing names for Max). Pick the verb that matches the
user's intent; default bare `/lca-dev` to **up**.

**Source of truth:** the cross-platform **`lca` CLI** (`packages/cli`). Skill scripts in
`.cursor/skills/lca-dev/scripts/` are thin wrappers that invoke `node packages/cli/dist/index.js …`
(via `_lca.ps1`, building the CLI if needed). Prefer `lca` directly when already in the repo:

| CLI | Same as skill |
|-----|----------------|
| `lca up` / `lca up prod` | `/lca-dev up` |
| `lca up dev` | `/lca-dev dev` |
| `lca down` | `/lca-dev down` |
| `lca status` | `/lca-dev status` |
| `lca doctor [runId]` | diagnose a run or daemon health + recent failures |
| `lca restart [dev\|prod]` | (no skill alias — use CLI) |
| `lca logs --daemon -f` | tail dev/daemon log |

## Orientation — resolve by reference (do this first)

Do **not** open `state.sqlite`, write temp SQL/inspect scripts, or grep agent
transcripts to discover runtime state. The daemon owns that data; the CLI
already surfaces it.

| Operator says… | First call |
|----------------|------------|
| latest / most recent failure, error, halt; "that failed run" | `lca doctor` → pick short id under **Recent failures** / **halted** → `lca doctor <id>` |
| what's running / stuck / needs input | `lca doctor` (**Pipelines**) + `/lca-dev runs` |
| daemon up? remote? counts? | `lca status` |
| which automations / recent run states | `lca list` |
| board-shaped recent rows | `/lca-dev runs` (`-Status failed` when filtering) |

Bare `lca doctor` prints daemon health, active/halted pipelines, and recent
failures with 8-char ids — enough to resolve a vague reference in one round trip.
Escalate only after that: `lca escalate <id> retry|skip|abort`. Deeper layout:
[`docs/troubleshooting.md`](../../docs/troubleshooting.md).

**Queue `--after`:** deps must already be **queue rows** (or prior `done`
entries) — a live `lca implement-fully` feature is not a dependency. For a true
edge, `queue add` the predecessor too; a successor with no `--after` still waits
on settle via the one-pipeline guard. Details:
[`docs/configuration.md`](../../docs/configuration.md) § Feature queue.

**After a green final-gate:** the gate does **not** set feature `Status:
Implemented` or move the backlog row to Completed — update those (or
`/roadmap-tidy`) yourself.

## Trigger words (`/lca-dev help`)

When the user asks for `help` (or "list lca-dev commands"), render this table:

| Trigger | Verb | Action |
|---------|------|--------|
| `/lca-dev dev`, "hot reload", "dev server", "work on the UI" | **dev** | Full hot-reload session: Vite HMR (frontend) + auto-restarting daemon (backend). Use this while iterating. |
| `/lca-dev`, `/lca-dev up`, "start automations", "open lca dashboard" | **up** | Build if needed, start the daemon detached, open the dashboard (production-like, no HMR). |
| `/lca-dev down`, "stop the daemon", "tear down lca" | **down** | Cancel active runs, then graceful shutdown (verified hard-kill fallback). |
| `/lca-dev status`, "lca status" | **status** | Daemon health, port owner, and automation/run/workspace counts. |
| `/lca-dev doctor`, "lca doctor", "diagnose run", "what failed", "latest failure", "halted pipeline" | **doctor** | Health triage (no arg) or run diagnosis; first call for vague failure references. |
| `/lca-dev runs`, "recent runs", "runs by status", "what's running" | **runs** | List recent runs grouped by status with automation name + timing. |
| `/lca-dev reset`, "start fresh", "clean slate" | **reset** | Stop → wipe runtime DB → restart. `-Purge` also deletes workspace YAML. |
| `/lca-dev prune`, "prune workspaces" | **prune** | Remove orphan workspaces whose directory no longer exists on disk. |
| `/lca-dev help` | **help** | Show this table. |

## Defaults

| Item | Value |
|------|--------|
| Port | `3747` (`LCA_PORT` overrides) — **single port for both `up` and `dev`** |
| Dashboard | `http://127.0.0.1:<port>/` (phone: `http://<tailscale-host>:<port>/`) |
| Dev (HMR) | Same URL. `dev` makes the daemon reverse-proxy the Vite dev server (incl. HMR ws) on its own port; Vite stays internal on `127.0.0.1:5273` |
| Repo root | Workspace containing `.cursor/skills/lca-dev/` |
| API key | `~/.cursor-local-automations/.env` → `CURSOR_API_KEY` |
| Runtime DB | `~/.cursor-local-automations/state.sqlite` (+ `-wal` / `-shm`) — prefer CLI over direct SQL |
| Daemon logs | `~/.cursor-local-automations/daemon.err.log` (daemon logs via `console.error`) |

---

## dev — hot-reload session (use this while iterating)

```powershell
lca up dev
# or:
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/lca-dev/scripts/dev.ps1
```

The blessed inner-loop, on a **single port** (`$Port`, default 3747). **`lca up dev`**
starts the rig **detached** (same lifecycle model as `lca up`): `npm run dev` runs
`concurrently` (root script) in the background; logs go to `~/.cursor-local-automations/dev.log`.
Stop with **`lca down`**. Tail logs: **`lca logs --daemon -f`**.

| Watcher | Covers | Behavior on save |
|---------|--------|------------------|
| `tsc -b --watch` | shared + daemon TS | recompiles into `dist/` |
| `node --watch dist/index.js` | daemon process | restarts when `dist/` changes |
| `vite` (`@lca/dashboard`) | dashboard `.tsx`/`.css` | **instant HMR, no refresh** |

**`lca up` semantics while something is already running:**
- `lca up dev` while in **prod** → switches to dev (no prompt).
- `lca up prod` while in **dev** → switches to prod.
- `lca up dev` while already in **dev** → prints status + suggests `lca up prod`.
- Bare **`lca up`** while running → status + suggests the opposite mode (never tears down).

The `dev` npm script sets `LCA_DEV_VITE=http://127.0.0.1:5273`. When that env var
is set, the daemon serves `/api` + `/ws` itself and **reverse-proxies everything
else (including Vite's HMR websocket) to Vite**. So the live-reloading UI is on
the daemon's own port/host — **one URL for everything, and it works on your phone
over Tailscale** (no second port to expose). Vite stays bound to loopback.

1. `predev` runs `npm run build` once so `dist/index.js` exists before `node --watch`.
2. Polls until GET `/` returns 200 (Vite proxied through the daemon).
3. Skill `dev.ps1` also opens the browser; `lca up dev` prints URLs (open manually or use the script).
4. Stop the rig: **`lca down`** (kills the dev process tree + frees internal Vite port).

Browse to **`http://127.0.0.1:$Port/`** (phone: `http://<tailscale-host>:$Port/`).
No rebuild / hard-refresh / `down`+`up` for code edits.

Key wiring (so it "just works"):
- `vite.config.ts`: `server.hmr.clientPort = LCA_PORT` (HMR client dials the daemon
  port, not Vite's), `allowedHosts: true`, Vite bound to `127.0.0.1`.
- Daemon proxy (`http/server.ts`, gated on `LCA_DEV_VITE`): normalizes `Host`,
  relies on Vite's `?token=` for HMR auth (so cross-origin/phone works), and
  hardens sockets so an aborted/refused upgrade can never crash the daemon.

**When to use `up` instead:** run the daemon as a detached background service
(automations firing without a terminal open), or preview the real prod bundle.

**Agent fallback** (no script): `down` → background `npm run dev` → poll
`http://127.0.0.1:$Port/` for 200 → open it.

## up — start prod daemon + open browser

```powershell
lca up
# or:
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/lca-dev/scripts/up.ps1
```

Wraps **`lca up`** (prod, detached). Cancels active runs on **`lca down`** before graceful shutdown. If already up, bare `lca up` prints **status** and mode-switch hints; `lca up dev` switches to dev.

**Agent fallback:** `lca up` after `npm run build -w @lca/cli` if needed.

## down — halt runs + stop instance

```powershell
lca down
# or:
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/lca-dev/scripts/down.ps1
```

Wraps **`lca down`** (mode-aware):
- **prod:** cancel active runs → `POST /api/shutdown` → verified hard-kill fallback if the port stays held.
- **dev:** kill the detached dev rig (`dev.pid` process tree) and free the internal Vite port.

**Agent fallback:** `lca down` — operator teardown only; automation agents must use `lca restart` instead.

## status — health + counts

```powershell
lca status
# or:
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/lca-dev/scripts/status.ps1
```

Wraps **`lca status`**: liveness, **DEV/prod mode**, pid, uptime, **remote** (host +
allowedIps + phone URL), dashboard URLs, automation/run/workspace counts. Uses
`GET /api/status` when the daemon is up.

**Agent fallback:** `lca status`.

## doctor — run diagnosis or health triage

```powershell
lca doctor              # health, Pipelines (active/halted), Recent failures (short ids)
lca doctor <runId>      # summary, key events, correlated daemon.err.log, verdict
```

**Default first call** for “what failed / latest error / halted pipeline” with no id:
bare `lca doctor`, then re-run with the short id. Also use when a run failed silently
(especially resume/auth failures that appear only in `daemon.err.log`). See
[`docs/troubleshooting.md`](../../docs/troubleshooting.md).

**Agent fallback:** `lca doctor`.

## runs — recent runs by status

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/lca-dev/scripts/runs.ps1
# -Limit <n> widens the window (default 20); -Status <s> filters to one status.
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/lca-dev/scripts/runs.ps1 -Limit 50 -Status failed
```

Lists the most recent runs grouped by status (active statuses first), resolving each run's
automation name from `/api/automations` and showing trigger kind, elapsed time, and start
time. Read-only. Where `status` only gives counts, `runs` shows the individual rows.

**Agent fallback**: `GET /api/runs?limit=<n>` + `/api/automations`, join names, group by status.

## reset — clean slate

```powershell
# Wipe runtime DB (runs, events, dashboard automations, workspaces); keep YAML config:
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/lca-dev/scripts/reset.ps1

# Also delete this repo's .cursor/automations/*.yaml for a truly empty board:
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/lca-dev/scripts/reset.ps1 -Purge
```

1. Runs **down** first (so the DB is unlocked and active runs are cancelled). Aborts if the port can't be freed.
2. Deletes `state.sqlite` + `-wal` + `-shm`.
3. With `-Purge`, deletes every `*.yaml` / `*.yml` under `<repo>/.cursor/automations/`.
4. Runs **up** (which rebuilds if needed) and reopens the dashboard.

Without `-Purge`, YAML config automations and config-listed workspaces re-appear on the
next reconcile — `reset` clears **runtime** state (run history + dashboard-created
automations), not your declarative config.

## prune — drop orphan workspaces

```powershell
node .cursor/skills/lca-dev/scripts/prune-workspaces.mjs
```

Removes workspace rows whose directory no longer exists on disk (e.g. leftover
`%TEMP%\lca-*` dirs from verify scripts). The schema's `ON DELETE CASCADE` (with
`foreign_keys = ON`) also clears those workspaces' automations/runs/events. The real repo
and any live path are always kept. Safe to run while the daemon is up; the dashboard
drops them on its next refresh. Use this when the workspace filter bar shows stale entries
but you don't want to nuke run history (that's `reset`).

## Verify

```powershell
# Up
Invoke-RestMethod http://127.0.0.1:3747/health   # { ok: true, ... }
netstat -ano | findstr "LISTENING" | findstr ":3747"

# Down
netstat -ano | findstr "LISTENING" | findstr ":3747"   # empty
```

## Footguns

- **Port in use** — another daemon instance; run `down` first or set `LCA_PORT`.
- **Build required** — dashboard static assets ship with the daemon; `npm run build` builds daemon + dashboard into `packages/daemon/dist` paths.
- **Windows kill is not graceful** — `Stop-Process` calls `TerminateProcess`, so the daemon's `SIGINT`/`SIGTERM` handler never runs. That's why teardown prefers `POST /api/shutdown` (runs the same handler in-process) and only hard-kills as a fallback. A hard kill leaves `state.sqlite-wal`/`-shm`, which SQLite recovers on next open.
- **Daemon's own boot cleanup** — on startup the daemon fails stale `running`/`needs_input` runs and restarts `queued` ones, so a cold start after a hard kill self-heals. `npm run cleanup:runs` is a manual escape hatch, rarely needed.
- **`reset` keeps YAML by default** — it only wipes runtime DB. Pass `-Purge` for a truly empty board; that deletes checked-in `.cursor/automations/*.yaml`.
- **`prune` targets missing dirs only** — a workspace whose folder still exists is never pruned, even with zero automations. To clear everything, use `reset`.

## Agents inside automations

Automation agents (runs spawned by the daemon) **must not** run `lca down`,
`POST /api/shutdown`, or verify preflight that stops the operator daemon
(`scripts/stop-lca-daemons.mjs` hitting `:3747`). Stopping the daemon kills the
active run before a separate `lca up` can execute — especially bad when the
operator is on mobile and the rig stays down.

After building daemon/dashboard changes, restart in **one** command:

```powershell
npm run build -w @lca/daemon
# add: npm run build -w @lca/dashboard  when UI changed
lca restart
```

Use `lca down` only when the operator explicitly wants teardown (`/lca-dev down`,
end of session). For prod code pickup without HMR, `lca restart` — not `down` then `up`.

Isolated UI verify scripts (temp `LCA_HOME`, dedicated port) must **not** call
`stopLcaDaemons()` against `:3747`. Shared-DB verify scripts refuse to tear down
a remote/active daemon unless `LCA_FORCE_STOP_DAEMONS=1`.

## Do not

- Run **`lca down`**, **`POST /api/shutdown`**, or **`stopLcaDaemons()`** against
  the live operator daemon from an automation agent (or to "restart" after a
  build) — use **`lca restart`** so the detached relaunch completes atomically.
- Expect HMR from an `up` (prod-build) daemon — it serves the static bundle (no
  HMR). `index.html` is sent `no-cache` so a normal refresh picks up a rebuild,
  but you still must rebuild. For live editing use **`dev`** (same URL, with HMR).
- Run a detached `up` daemon and `dev` at the same time on the same port — they
  collide. `dev` frees the port first, so just start `dev`.
- Expose Vite's `:5273` directly — in `dev` it's loopback-only and fronted by the
  daemon; remote clients (phone) use the daemon's port, which enforces the IP
  allowlist. Vite's HMR `?token=` authorizes the websocket regardless of origin.
- Use `lca down` (CLI) as a substitute for this skill's `down`. The CLI verb only `POST`s `/api/shutdown` and does **not** cancel active runs first, so non-terminal runs resume on next boot. This skill's `down` cancels runs first for a clean teardown.
- Write ad-hoc one-off scripts for these operations — extend this skill's `scripts/` folder and add the verb to the table above instead.
