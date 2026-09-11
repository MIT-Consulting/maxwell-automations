# Configuration Reference

**Max** is configured through two YAML locations plus a small set of environment
variables. The daemon watches the YAML and reconciles on change; runtime
`settings` and auth are read once at startup (restart to apply).

> `lca`, the `LCA_*` env vars, and `~/.cursor-local-automations/` are stable
> compatibility names for Max — they are intentionally unchanged. See
> [`brand.md`](brand.md) for the product-name background.

## File locations

| Path | Purpose |
| --- | --- |
| `~/.cursor-local-automations/automations.yaml` | Global config: workspace list, daemon `settings`, optional global automations. |
| `<workspace>/.cursor/automations/*.yaml` | Per-workspace automation definitions. |
| `~/.cursor-local-automations/.env` | Secrets — `CURSOR_API_KEY` (gitignored). |
| `~/.cursor-local-automations/state.sqlite` | Runs, events, input requests, history. |

## Global config (`automations.yaml`)

```yaml
workspaces:
  - /path/to/your/workspace

settings:
  maxConcurrentRuns: 3
  eventRetentionPerRun: 2000
  maxEventPayloadBytes: 65536
  spawnTimeoutMs: 120000 # max wait for spawn/resume to return an agent
  runStallTimeoutMs: 600000 # idle running run before stall recovery
  maxSpawnAttempts: 3 # spawn + recovery attempts before give-up
  retryBackoffMs: 5000 # base delay before a retry (grows per attempt)
  retainedSessionTtlMs: 1800000 # dispose idle retained sessions (0 = never)
  # sessionRevive: true # revive expired sessions from stored transcript
  # Network exposure (default: loopback-only, no remote access)
  host: 127.0.0.1
  allowedIps: [] # e.g. ["100.64.0.5"] to allow a specific Tailscale device

automations: [] # optional global (workspace-less) automations
```

Unknown top-level keys are ignored so you can keep notes/metadata in the file.
A configured workspace path that does not exist on disk logs a clear warning.

### `settings`

| Key | Default | Min | Env override | Meaning |
| --- | --- | --- | --- | --- |
| `maxConcurrentRuns` | `3` | `1` | `LCA_MAX_CONCURRENT` | Caps active runs (`running` + `needs_input`); excess triggers stay `queued` until a slot frees. The same value caps how many dependency-ready tracks a wave coordinator accepts into one wave — the rest stay Pending for a later wave. There is no separate parallel-wave setting. `1` keeps sequential operation (fan-out needs at least two accepted tracks). |
| `eventRetentionPerRun` | `2000` | `50` | `LCA_EVENT_RETENTION` | Most recent events kept per run; older events are pruned when the run ends, so long chatty runs don't grow the DB without bound. |
| `maxEventPayloadBytes` | `65536` | `1024` | `LCA_MAX_EVENT_BYTES` | Hard cap on a single event payload; larger payloads are replaced with a valid-JSON truncation summary. |
| `host` | `127.0.0.1` | — | `LCA_HOST` | Address the HTTP/WS server binds to. The default is loopback-only (no remote access). A specific non-loopback address (e.g. a Tailscale IP) is **multi-bound** alongside `127.0.0.1` so local tooling keeps working; `0.0.0.0` binds all interfaces. Prefer `lca remote on <ip>`. |
| `allowedIps` | `[]` | — | `LCA_ALLOWED_IPS` | Device allowlist (comma-separated for the env var). Empty = no allowlist (any IP reaching `host` is allowed). When set, only loopback **and** the listed source IPs may connect; everyone else gets `403`. |
| `controlToken` | _(unset)_ | — | `LCA_CONTROL_TOKEN` | Shared app-auth token. Provisioned + printed once by `lca remote on`. When set, every non-loopback request (reads, writes, `/ws`) must present it via `X-LCA-Control-Token` (or `?token=` on `/ws`); loopback is exempt. Never logged. |
| `spawnTimeoutMs` | `120000` | `10000` | `LCA_SPAWN_TIMEOUT_MS` | Max time for `spawn()`/`resume()` to return a live agent before the attempt is treated as failed. |
| `runStallTimeoutMs` | `600000` | `60000` | `LCA_RUN_STALL_TIMEOUT_MS` | A `running` run with no new event for longer than this is considered stalled and recovered (requeued or failed). `needs_input` is never touched. |
| `maxSpawnAttempts` | `3` | `1` | `LCA_MAX_SPAWN_ATTEMPTS` | Total spawn/recovery attempts per run (`1` = no retry). After exhaustion the run fails with `retries_exhausted`. |
| `retryBackoffMs` | `5000` | `0` | `LCA_RETRY_BACKOFF_MS` | Base delay before a retry; grows per attempt (capped). |
| `retainedSessionTtlMs` | `1800000` (30 min) | `60000` when > 0; `0` disables | `LCA_RETAINED_SESSION_TTL_MS` | Max idle time before a completed run's retained in-memory session is disposed. Long-gap follow-ups then cold-resume immediately instead of hitting a stale connection. `0` = retain forever (legacy behavior). |
| `sessionRevive` | `true` | — | `LCA_SESSION_REVIVE` | Revive expired sessions by spawning a fresh agent seeded from the stored transcript. |
| `maxAttachmentBytes` | `15728640` (15 MiB) | `1024` | `LCA_MAX_ATTACHMENT_BYTES` | Max size of a single chat/run attachment upload. |
| `maxAttachmentsPerMessage` | `5` | `1` | `LCA_MAX_ATTACHMENTS_PER_MESSAGE` | Max attachments on one send, queue, or interrupt. |
| `allowedAttachmentMimeTypes` | PNG/JPEG/GIF/WebP + text-like | — | `LCA_ALLOWED_ATTACHMENT_MIME_TYPES` | MIME allowlist (comma-separated for the env var). Default includes `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `text/plain`, `text/markdown`, `text/csv`, `application/json`, `application/x-yaml`, `text/yaml`, `text/x-log`. |
| `maxFileViewerBytes` | `2097152` (2 MiB) | `65536` (64 KiB) | `LCA_MAX_FILE_VIEWER_BYTES` | Max bytes returned inline for a workspace file preview. Oversize text is truncated with a flag; binary content is never returned inline. Restart required. |
| `maxFileViewerEntries` | `1000` | `50` | `LCA_MAX_FILE_VIEWER_ENTRIES` | Max directory entries returned by the file-viewer listing API. Restart required. |
| `pipelineRoleModels` | — (empty map) | — | — | Default model recipe for pipeline kickoff: required `planner` / `implementer` / `reviewer` / `docs` entries (each a scalar model id or structured selection), plus optional `researcher` (when set, chain starts at `generated:research`), optional `architect` (when set, owns `plan-skeleton`; when unset, falls back to the concrete planner selection), and `gatekeeper` (when set, owns terminal `final-gate`; when unset, falls back to the concrete reviewer selection). Also the synthetic profile id `default` when named profiles are configured. No env override. Restart required. |
| `pipelineRoleModelProfiles` | — (empty map) | — | — | Named role-model recipes for kickoff (e.g. `cheap`, `quality`). Each value is a map with the same shape as `pipelineRoleModels`. Profile ids must match `^[a-z][a-z0-9-]*$`; id `default` is reserved — do not define it here. No env override. Restart required. |
| `defaultPipelineRoleModelProfile` | _(unset)_ | — | — | Optional id pre-selecting a named profile at kickoff. Omit → synthetic `default` (`pipelineRoleModels`). Must reference a key in `pipelineRoleModelProfiles` or `default`. No env override. Restart required. |
| `pipelineResumeLookbackMs` | `86400000` (24h) | `0` | `LCA_PIPELINE_RESUME_LOOKBACK_MS` | How far back (ms) the boot pass looks for (1) `completed` context-aware runs whose chain transition was lost to a restart and (2) failed-halt startup recovery candidates. `0` disables both boot passes. Restart required (`lca restart` after changing). |
| `pipelineAutoEscalate` | `true` | — | `LCA_PIPELINE_AUTO_ESCALATE` | When `true`, the daemon may auto-escalate a narrow allowlisted late `sdk_error` halt (see [troubleshooting](./troubleshooting.md) and [implement-fully protocol](./implement-fully-protocol.md)). Kill switch: `LCA_PIPELINE_AUTO_ESCALATE=0` (or `false`). Does not widen spawn/resume/stall retries or wave/track recovery. Restart required (`lca restart` after changing). |
| `pipelineAutoEscalateMaxPerPipeline` | `2` | `1` | `LCA_PIPELINE_AUTO_ESCALATE_MAX_PER_PIPELINE` | Max daemon-attributed auto-escalations per pipeline lineage (positive integer; values below `1` clamp to `1`). Operator escalations do not spend this budget. Restart required (`lca restart` after changing). |
| `pipelineHaltDiscovery` | `true` | — | `LCA_PIPELINE_HALT_DISCOVERY` | When `true` (default), an unrecovered pipeline halt may spawn a best-effort halt-discovery advisory that parks a no-timeout recommendation card for the operator. Kill switch: `LCA_PIPELINE_HALT_DISCOVERY=0` (or `false`). Discovery has no escalation or pipeline-transition authority; the halted source and `lca escalate` remain authoritative. Restart required (`lca restart` after changing). |
| `notify.ntfy` | _(unset / disabled)_ | — | — | Optional ntfy phone-notify **connection** (topic / server / token). Per-event delivery is under `notify.events` — see [Phone notify (ntfy)](#phone-notify-ntfy). No env override for topic/token. **`settings.notify` hot-reloads** (Settings → Alerts Save or YAML watcher); no restart for notify prefs/connection. |

`pipelineAutoEscalate`, `pipelineAutoEscalateMaxPerPipeline`,
`pipelineHaltDiscovery`, and `pipelineResumeLookbackMs` load once at daemon
startup (same as other `settings:` keys); changing them needs `lca restart`.
Startup failed-halt recovery is a bounded, idempotent replay inside the
lookback window — not a recurring sweep.

Precedence is **env var → YAML `settings:` → default**, then clamped to the
minimum. An invalid `settings:` block (e.g. a typo'd key) is ignored with a
warning and the daemon boots on defaults. A misconfigured laptop and a beefier
desktop (Z240) can use different `maxConcurrentRuns` via the env override.

### Phone notify (ntfy)

Optional phone push (ntfy) and OS toasts for daemon-wide alert events. All
notify configuration lives in the **local gitignored** home file
`~/.cursor-local-automations/automations.yaml` under `settings.notify`. Put
real `topic` / `token` values there (or in a private soak note such as
`~/.cursor-local-automations/b48-ntfy-soak-topic.txt`) — **never commit them**.

Per-event delivery uses `settings.notify.events` (toast and ntfy flags per alert
id). The ntfy **connection** is `settings.notify.ntfy` (topic / server / token
only — no `events` allowlist array). The dashboard notification sink is always
on and is not configurable here.

**Hot-reload:** changes to `settings.notify` (prefs and connection) apply
without `lca restart` — via Settings → **Alerts** → **Save alerts** (PATCH) or
by editing the global YAML notify block (the config watcher reloads notify
only). Other `settings:` keys (bind/host, concurrency, pipeline flags, etc.)
still require `lca restart` — see the table above.

#### Event prefs (`settings.notify.events`)

Optional partial map of alert id → `{ toast, ntfy }`. Omitted ids inherit
**smart defaults** (below). Supported ids (thirteen total, catalog order):

| Alert id | Default toast | Default ntfy | Notes |
| --- | --- | --- | --- |
| `needs_input` | on | on | Input Hub / MCP questions |
| `run_failed` | on | on | Run ended in error |
| `auth_expired` | on | on | Cursor auth/session failure |
| `run_completed` | **off** | **off** | Every engine `completed` transition (quiet) |
| `pipeline_complete` | on | on | implement-fully `final-gate` only (not per-step workers) |
| `queue_batch_complete` | on | on | Serial implement-fully queue drained for one workspace |
| `plan_approval_required` | on | on | Guided approve-plan parks; **replace-not-double** with generic `needs_input` |
| `ux_approval_required` | on | on | Catalog-reserved; no product producer yet — silence expected |
| `pipeline_halt_recovered` | **off** | **off** | Halt cleared without operator action |
| `pipeline_halt_unrecovered` | on | on | Halt still blocking |
| `halt_discovery_ready` | on | on | Discovery advisory card ready |
| `halt_discovery_failed` | on | on | Discovery run failed |
| `halt_discovery_action` | **off** | **off** | Operator acted on discovery card |

**Producer notes (unchanged behavior):**

- `pipeline_complete` fires only when implement-fully `final-gate` settles
  `completed` — not per-step workers, wave integrate, or `complete:` enqueue.
- `queue_batch_complete` fires once when a workspace's **serial** implement-fully
  queue drains (no `running` or `queued` rows left). `blocked` rows do not hold the
  batch open. Cancel-only batches stay silent. Per-feature failures still emit
  `run_failed` / halt events as today.
- **Replace-not-double:** approval-shaped parks emit `plan_approval_required`
  instead of generic `needs_input` notify — you do not get both.
- `ux_approval_required` is catalog-reserved until a UX/design gate producer
  exists; Notifier methods exist but live parks are expected to be silent.
- Answering still uses Input Hub / `needs_input`. Plan-approval cards support
  Cursor-style **Other → free text** (trimmed non-empty free text accepted
  alongside choice ids).

#### ntfy connection (`settings.notify.ntfy`)

| Key | Required | Meaning |
| --- | --- | --- |
| `topic` | yes (when ntfy enabled) | Non-empty ntfy topic string (trimmed). |
| `server` | no | HTTP(S) base URL. When omitted, the publisher defaults to public `https://ntfy.sh`. |
| `token` | no | Non-empty access token when the server requires auth. |

There is **no** `events` array under `ntfy`. Per-event ntfy delivery is
controlled only via `settings.notify.events.<id>.ntfy`.

**Legacy migrate:** if older YAML still has `notify.ntfy.events: [...]` and
`notify.events` is absent or partial, listed ids get `ntfy: true` on load (toast
stays from defaults unless overridden). New writes use the events map; the
allowlist array is stripped from persisted YAML.

Example shape (placeholders only):

```yaml
settings:
  notify:
    events:
      needs_input: { toast: true, ntfy: true }
      run_completed: { toast: false, ntfy: false }  # quiet default; explicit override optional
      pipeline_complete: { toast: true, ntfy: true }
    ntfy:
      topic: "<private-topic>"
      # server: "https://ntfy.sh"
      # token: "<access-token>"
```

#### Settings → Alerts (dashboard)

Open **Settings** → **Alerts** (daemon-global; works with zero workspaces).
The panel exposes:

- ntfy connection (enable, topic, optional server/token) and **Test send**
- toast × ntfy matrix for all thirteen alert ids
- **Reset to defaults** (draft only until Save)
- **Save alerts** (PATCH; hot-reloads notify without restart)

When `LCA_NO_TOAST` or `LCA_NO_NTFY` is set in the daemon environment, the
matching matrix columns are greyed with a banner; prefs can still be edited for
when mutes are removed.

`settings.notify` is optional. Omitting it leaves smart defaults and ntfy
disabled. Nested objects are strict — misspelled keys or unsupported event ids
invalidate the whole `settings:` block (daemon boots on defaults with a warning).

**Soak order:** subscribe the phone app to the private topic first. When
introducing notify on an older machine, confirm the installed daemon understands
the events-map schema before writing YAML — a very old strict schema may reject
unknown keys and drop the rest of `settings:` (including remote
`host` / `allowedIps` / `controlToken`).

### Remote access (e.g. viewing the dashboard on your phone over Tailscale)

The server is **loopback-only by default**, so even with Tailscale running, other
devices can't reach it until you opt in. This tool spawns agents with
`settingSources: ["all"]`, so prefer the narrowest exposure. Remote access is
hardened by three layers: a **device allowlist** (source-IP gate), an **origin/CSRF
guard**, and a **control token** (app-auth) required for every non-loopback request.

**Easiest path — the `lca remote` commands** (edit the global YAML for you and
restart the daemon so changes take effect):

```bash
lca remote                  # show current host, allowlist, app-auth state, URL
lca remote on 100.64.0.5    # bind loopback + this machine's Tailscale IP; allow 100.64.0.5
lca remote allowed            # list allowlisted devices (numbered)
lca remote allow <ip>       # add another device to the allowlist
lca remote deny <n>           # remove by index from allowed
lca remote deny --all         # clear the entire allowlist
lca remote detect           # list candidate reachable URLs (IPv4 + IPv6 tailnet)
lca remote off              # back to loopback-only
```

`lca remote on <ip…>` **requires at least one device IP** (or the explicit
`--insecure-any` escape hatch — see below). It auto-detects this machine's
Tailscale address and binds **loopback (`127.0.0.1`) + that address** — never
`0.0.0.0` — so local tooling keeps working while the port is not exposed on every
interface. On first enable it **provisions a control token and prints it once**;
save it. `lca remote` (status) and `lca remote detect` print the
`http://<tailscale-ip>:<port>` URL to open on an allowed device (IPv6 addresses are
bracketed, e.g. `http://[fd7a:…]:3747`). Pass `--no-restart` to edit config without
bouncing the daemon.

The sections below describe the underlying settings the commands write.

1. **Device-specific (recommended).** Multi-bind to loopback + your machine's
   Tailscale IP and allowlist only the devices that may connect. Loopback stays
   bound so the CLI, triggers, and MCP bridge (which all talk to `127.0.0.1`) keep
   working, while `allowedIps` blocks every non-loopback source except the listed
   devices:

```yaml
settings:
  host: 100.64.0.2 # this machine's Tailscale IP — bound alongside 127.0.0.1
  allowedIps: ["100.64.0.5"] # your phone's Tailscale IP
  # controlToken is provisioned automatically by `lca remote on` (printed once).
```

Then browse to `http://<this-machine-tailscale-ip>:3747` on the allowlisted device
and paste the control token when prompted. The frontend uses same-origin relative
paths, so nothing else changes.

> Binding `host` to a specific non-loopback IP no longer drops the loopback
> listener — the daemon **multi-binds** loopback + that host, so the CLI, git-hook
> triggers, and the MCP `ask_user` bridge keep reaching `127.0.0.1`. If the
> configured Tailscale IP isn't assigned at boot (e.g. Tailscale not up yet), the
> daemon logs a warning and **degrades to loopback-only** instead of failing to
> start.

2. **Broad bind (escape hatch).** `lca remote on --insecure-any` binds `0.0.0.0`
   (all interfaces) with no device allowlist — only for hosts that can't enumerate
   their address. Booting with a broad host (`0.0.0.0`/non-loopback) **and** an
   empty allowlist is **fatal** unless `LCA_UNSAFE_NETWORK=1` is set; the error
   message names the fix.

#### Control token (app-auth)

When remote is enabled, **every** non-loopback request — reads, writes, and the
live `/ws` event stream — must present the control token; without it the device is
blocked entirely (there is no read-only tier). Loopback is exempt, so local
CLI/hooks/MCP need no token. Send it as the `X-LCA-Control-Token` header, or as
`?token=…` on the `/ws` WebSocket (browsers can't set custom WS headers). The
dashboard prompts for it and stores it in `localStorage`. The token lives at
`settings.controlToken` in the global YAML (or the `LCA_CONTROL_TOKEN` env var) and
is **never** logged or returned by `/api/status`.

#### Audit logging

With a logger attached, the daemon logs the effective posture at startup, the
**first non-loopback request per boot** (source IP + whether allowlisted), and
**every remote mutation** (method, path, source IP). The control token and `/ws`
query strings are never logged.

### File viewer deep links

The dashboard Files view browses registered workspaces read-only and opens
markdown as a full-document preview. Agents can hand the operator a shareable URL
that opens a specific file (or directory) after load — including on a phone after
TokenGate unlock.

The Files toolbar provides **Back** and **Forward** across prior Files locations
and the top-level view that led into Files (for example Board). That history is
session-local: it resets on refresh and does not use the browser Back/Forward
buttons. On narrow layouts, **Back to file list** only closes the file preview
to the directory list; it is separate from Files history Back/Forward.

URL forms (params are **not** stripped on boot; in-view navigation rewrites them
via `history.replaceState`):

```
http://<host>:<port>/?view=files&workspace=<workspaceId>&path=<url-encoded rel file>
http://<host>:<port>/?view=files&workspace=<workspaceId>&dir=<url-encoded rel dir>
```

- `path` opens the file preview (browse dir = parent of the file).
- `dir` opens the directory browser.
- Both absent → Files view at workspace root. `workspace` absent → default workspace selection.

**Deriving `workspaceId` offline** (deterministic; same as the daemon):

```
workspaceId = base64url(resolve(<workspace path>))
```

Node one-liner an agent can run:

```js
Buffer.from(require("node:path").resolve(p)).toString("base64url")
```

**Remote behavior:** deep links carry **no** control token (never put `?token=` on
HTTP). A remote browser hits TokenGate once, stores the token in `localStorage`,
then authenticated fetches load the file. Host choice (loopback `127.0.0.1` vs a
Tailscale hostname/IP) belongs to whoever writes the link — use the same host the
operator already opens for the dashboard.

## Per-workspace automations

Each entry (validated strictly; bad entries are skipped with a warning):

```yaml
automations:
  - id: nightly-review # optional but recommended (stable history key)
    name: Nightly Review
    enabled: true
    trigger:
      type: cron # cron | git | file-watch | command | manual
      expression: "0 2 * * *"
    prompt: Review today's commits and summarize risks.
    model: composer-2.5 # optional — scalar id or structured selection (below)
```

Trigger shapes: `cron {expression}`, `git {events: [post-commit|pre-push|post-merge]}`,
`file-watch {globs: [...], debounceMs?}`, `command {command, cwd?}`, `manual {}`.

### Model selection

Max persists Cursor SDK `ModelSelection` values (`id` + optional parameter pairs)
everywhere an agent is started or continued. Legacy scalar strings remain valid.

**YAML — scalar (legacy):**

```yaml
model: grok-4.5
```

**YAML — structured (parameters):**

```yaml
model:
  id: grok-4.5
  params:
    - id: reasoning
      value: high
    - id: fast
      value: "true"   # boolean-like params are strings in the SDK
```

Parameter ids and allowed values come from `GET /api/models` (the calling
account's `Cursor.models.list()` catalog). Max does not hard-code reasoning
levels or Fast/Max toggles — the dashboard renders switches and enums from the
catalog's allowed values. Unknown/custom ids stay editable when the catalog is
down or the model is absent from the latest list.

**Precedence** (first non-empty wins):

| Surface | Order |
| --- | --- |
| Automation run | per-run override → automation model → global default (`composer-2.5`) |
| Workspace chat | per-chat override → `<workspace>/.cursor/chat.yaml` default → global default |

Changing a run or chat model applies to the **next turn** (follow-up / send), not
the turn already in flight. Clearing an override (dashboard **Default**, or
`model: null` / omit after clear) restores inheritance without deleting workspace
or automation defaults.

**REST / WebSocket:** responses expose both legacy `model` (base id string or
`null`) and canonical `modelSelection`. Mutations accept either field; sending
both is allowed only when they agree. Conflicting pairs return `400`.

**CLI:** `lca run` does not take a `--model` flag — it triggers the automation and
executes whatever selection is already persisted.

Workspace chat defaults use the same scalar/structured `model` syntax in
`<workspace>/.cursor/chat.yaml` (see also the dashboard **Settings** view).

## Automation chaining

Chain automations so completing one step automatically starts the next. Each step
keeps its own `model`, `prompt`, and skills; the repo (docs, diffs, commits) is
the durable handoff between steps. There is no orchestrator — a `chain.next` link
plus a daemon completion listener fires the successor.

```yaml
automations:
  - id: plan-step
    name: Plan
    enabled: true
    trigger: { type: manual }
    prompt: Plan the next feature phase.
    chain:
      next: implement-step   # YAML id (preferred) or name in the same workspace
      when: completed        # completed | failed | always (default: completed)

  - id: implement-step
    name: Implement
    enabled: false           # chain-only: no real trigger needed
    trigger: { type: manual }
    prompt: Implement the plan.
    chain:
      next: review-step
      when: completed
      passResult: true       # append prior step's output to this prompt
```

### `chain` fields

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `next` | yes | — | Target automation `id` (preferred) or `name` within the same workspace. |
| `when` | no | `completed` | Fire on `completed`, `failed`, or `always` (completed or failed). |
| `passResult` | no | `false` | When `true`, append the prior run's agent output to the next prompt. |

### Behavior and safety

- **Chained steps bypass the enabled gate.** The daemon calls `triggerRun` directly,
  so middle steps can stay `enabled: false` with `trigger: { type: manual }`. Only
  the first step needs a real trigger (cron, git, manual button, etc.).
- **`cancelled` never chains.** A cancelled run does not fire its successor regardless
  of `when`.
- **Depth cap (default 20).** The daemon walks `parent_run_id` to measure chain
  depth; exceeding the cap emits a `run.chain-skipped` event and stops the chain.
- **Single successor.** `next` is one target; fan-out, branching, and loop-back are
  deferred (loop-back is not detected — depth cap is the safety net).

See the full 3-step example in [`config/automations.example.yaml`](../config/automations.example.yaml).

**Dashboard authoring:** For dashboard-origin automations, the automation modal exposes
**Next automation**, **When to chain** (`completed` / `failed` / `always`), and
**Append previous step's result to the prompt** (`passResult`). The dropdown stores the
target automation's **config key** (not its display name), matching how
`resolveChainTarget` resolves successors. YAML remains the canonical authoring path for
config-origin automations; the dashboard does not edit their chains.

### Implement-fully pipeline

The first real consumer of context-aware chaining is the **implement-fully** pipeline:
eight registered generated workers — three active loop workers (`plan-phase`,
`implement`, `review`), plus the conditional pre-planning prelude `research`,
`integrate-wave`, `final-gate`, and the retained `docs-commit` worker for
in-flight compatibility — that turn a feature idea into (optional research →)
skeleton → phase plan → implement → review, with optional dependency-aware
parallel waves, looping until the tracker is dry. `integrate-wave` runs on main
only after a track barrier. Repository-state rules (tracker shape, drift,
stop-reason prefixes, barrier semantics) live in
[`docs/implement-fully-protocol.md`](./implement-fully-protocol.md) — this section
covers daemon wiring only. Wave recovery procedures:
[`docs/troubleshooting.md`](./troubleshooting.md).

**Operator kickoff:** `lca implement-fully --feature <bN>` or
`lca implement-fully --idea "<text>"` (see `lca help`), or the
`/implement-fully` skill installed via `npm run install:skill`. Both call
resolve → provision → introspect → `POST /api/runs` below.

**Workers (fixed cycle):** when a `researcher` role resolves,
`research` → `plan-skeleton` → `plan-phase` → `implement` → `review` →
`plan-phase` …; otherwise entry is `plan-skeleton` → `plan-phase` → `implement` →
`review` → `plan-phase` … (unchanged). Exit is a run-scoped `chain_control` stop
from `plan-phase` (never an edit to a shared automation). Every edge is
`when: completed` with `passResult: true`. The retained `docs-commit` worker is
still provisioned but unreachable from kickoff.

**Optional wave path:** when main `plan-phase` fans out, each accepted track runs its
own implement → review cycle in an isolated worktree; after the barrier,
`integrate-wave` merges on main, then the next main `plan-phase` continues. There is
no second concurrency knob — `maxConcurrentRuns` is both the global active-run cap and
the maximum accepted wave width.

**Parallel wave ownership / fallback:**

| Concern | Behavior |
| --- | --- |
| Worktree layout | `<LCA_HOME>/worktrees/<full-root-id>/w<wave>/t<track>` — daemon-derived |
| Branch layout | `lca/<featureSlug>/<root8>/w<wave>-t<track>` — daemon-derived |
| Path ownership | Agents and callers never supply an execution cwd; the daemon sets it internally |
| Sequential fallback | Fewer than two safe candidates, `maxConcurrentRuns: 1`, dirty / detached / unborn main, missing git, or invalid worktree/preflight → one sequential phase, no wave created |

**Resolve / provision / introspect:**

```http
POST /api/pipelines/implement-fully/resolve
{ "workspaceId": "<id>", "input": { "kind": "feature-id", "featureId": "b42" } }
{ "workspaceId": "<id>", "input": { "kind": "idea", "idea": "…" } }

POST /api/pipelines/implement-fully/workers
{ "workspaceId": "<id>", "dryRun": false, "prune": false }

GET /api/pipelines/implement-fully
GET /api/pipelines/implement-fully?workspaceId=<id>
```

`POST …/resolve` accepts exactly one of the two `input` intents and returns
`{ featureId, featureSlug, idea }` — no provisioning or run creation.
`POST …/workers` returns the generated-worker plan plus any `missingSkills`.
`GET` returns the entry worker key/config key, required variables, role names,
budget formula, and a per-worker summary — no prompt text. Optional
`?workspaceId=` adds a `preconditions` block (registered workspace, git/roadmap
checks) for that workspace; unknown ids return `400`.

**Escalation** (operator credentials — IP allowlist / control token like other
mutations; **not** a per-run token):

```http
POST /api/runs/:id/escalate
{ "action": "retry" | "skip" | "abort", "reason": "optional text" }
```

Success returns `{ action, runId, childRunId, stopReason }`. Refusals are machine
codes: `not-found`, `not-pipeline`, `not-halted`, `already-chained`, `root-run`,
`no-successor`, `budget-exhausted`. CLI: `lca escalate <runId> retry|skip|abort
[--reason <text>]`.

Automatic halt recovery (when `pipelineAutoEscalate` is on) reuses this same
escalation path and write-once chain claim with durable `actor: "daemon"`
metadata — there is no separate endpoint or run-token authority. Declined or
unsafe halts stay operator-actionable here.

**Halt discovery** (when `pipelineHaltDiscovery` is on, default) is a separate
best-effort advisory after an unrecovered halt: it may diagnose and park a
no-timeout Input Hub briefing on a `halt-discovery` child run. Approving a
briefing choice maps to the same operator escalation path above; promoting the
briefing to chat continues diagnosis context only and does **not** answer or
escalate the source. Direct `lca escalate` stays available throughout. See
[troubleshooting](./troubleshooting.md).

**Wave recovery** (same operator credentials; distinct from the run-token-gated agent
`pipeline_wave` MCP control):

```bash
lca wave <waveId> retry|abort [--reason <text>]
```

```http
POST /api/pipeline-waves/:id/actions
{ "action": "retry-integration" | "abort", "reason": "optional text" }
```

CLI `retry` maps to the wire action `retry-integration`. See
[troubleshooting.md](./troubleshooting.md) for eligibility and refusal codes.

**Roles:** kickoff supplies concrete `roleModels` for the four required roles
`planner`, `implementer`, `reviewer`, and `docs`, plus optional slots. A
kickoff errors when any required role is unresolved — there is **no** silent
fallback for a required role.

| Role | Required? | Semantics |
| --- | --- | --- |
| `planner` | yes | Owns `plan-phase`. Also covers `plan-skeleton` when `architect` is unset. |
| `implementer` | yes | Owns `implement`. |
| `reviewer` | yes | Owns `review` and `integrate-wave` (wave join stays reviewer-owned). |
| `docs` | yes | Retained `docs-commit` role (unreachable from kickoff). |
| `researcher` | optional | When resolved, the chain **starts** at `generated:research` with the researcher's model and chains into `plan-skeleton`. When unset, kickoff starts at `plan-skeleton` exactly as before. |
| `architect` | optional | Owns `plan-skeleton` only. When unset, falls back to the **concrete persisted planner selection** (params preserved). |
| `gatekeeper` | optional | Owns terminal `final-gate` only. When unset, falls back to the **concrete persisted reviewer selection** (params preserved), never the daemon default model. |

A workspace provisioned before this feature may still have
`model_role = 'reviewer'` on its `final-gate` row. There a six-role recipe gates
on the **reviewer**, not the gatekeeper — that is designed behavior, not a bug.
`lca doctor <finalGateRunId>` derives its `gate:` line from the chain's role
recipe rather than from the row, so it still reports
`gatekeeper=<modelId> (explicit)`; on such a workspace that line describes the
configured recipe, not the model that actually ran. Reprovision
(`POST /api/pipelines/implement-fully/workers`) rewrites the row to
`gatekeeper` so the two agree.

A workspace provisioned before the architect role may still have
`model_role = 'planner'` on its `plan-skeleton` row. There an explicit
`architect` override in the recipe is ineffective until reprovision — the row
keeps the planner binding. `lca doctor` and `lca implement-fully --dry-run`
derive skeleton binding from the chain's role recipe, not the stale row.
Reprovision (`POST /api/pipelines/implement-fully/workers`) rewrites the row to
`architect` when the recipe supplies one.

The base recipe comes from the selected **Model profile** (`--role-profile` /
dashboard) or the synthetic profile id `default`
(= `settings.pipelineRoleModels`). Per-role overrides (`--role` / UI) win over
the selected profile.

**Research approval:** kickoff variable `researchApprovalPolicy` is `none`
(default) or `before-planning`. When armed, the research worker parks a
no-timeout two-step Input Hub flow (`approve` / `comment`, then free text after
comment); durable findings live in `<featureDir>/research.md` (Files-viewer
linkable) and survive reload/restart. Cancel the run to abort. An armed policy
without a resolved researcher is refused before any provision or trigger.

```yaml
settings:
  # Default recipe (synthetic profile id "default")
  pipelineRoleModels:
    planner: gpt-5.6-sol
    implementer: grok-4.5
    reviewer: claude-opus-5
    docs: composer-2.5

  # Named recipes — switch at kickoff without rewriting the default map.
  # `deep` / `max` below are operator-authored examples, not built-in product
  # profiles; every model id must match the live SDK catalog.
  pipelineRoleModelProfiles:
    # Calibrated on b51 (four-phase M feature, ~42m including one transient retry).
    fast-moderate:
      planner:
        id: grok-4.5
        params:
          - { id: effort, value: high }
          - { id: fast, value: "true" }
      implementer:
        id: composer-2.5
        params:
          - { id: fast, value: "true" }
      reviewer:
        id: grok-4.5
        params:
          - { id: effort, value: high }
          - { id: fast, value: "true" }
      docs:
        id: composer-2.5
        params:
          - { id: fast, value: "true" }
    cheap:
      planner: grok-4.5
      implementer: composer-2.5
      reviewer: grok-4.5
      docs: composer-2.5
    # Sol plans once at skeleton; Grok implements; Composer reviews/docs.
    deep-fast:
      architect: gpt-5.6-sol
      planner:
        id: grok-4.5
        params:
          - { id: effort, value: high }
          - { id: fast, value: "true" }
      implementer: composer-2.5
      reviewer: grok-4.5
      docs: composer-2.5
    deep:
      planner: gpt-5.6-sol
      implementer: grok-4.5
      reviewer:
        id: claude-opus-5
        params:
          - id: reasoning
            value: high
      docs: composer-2.5
    max:
      researcher: gpt-5.4-high-fast
      planner: gpt-5.6-sol
      implementer: grok-4.5
      reviewer: claude-opus-5
      docs: composer-2.5
      gatekeeper: gpt-5.4-high-fast

  # optional — pre-select cheap at kickoff; omit → "default"
  # Do not set defaultPipelineRoleModelProfile: max (expensive models stay opt-in).
  defaultPipelineRoleModelProfile: cheap
```

Do not define a named profile id `default` in YAML — that id is reserved for
`pipelineRoleModels`. Structured selections (b35 params) work inside any recipe
map; scalar and structured forms can be mixed per role.

`fast-moderate` is a measured starting point, not a universal default.
Before kickoff, settle material scope decisions, restart after recipe edits,
and confirm the concrete role params with
`lca implement-fully --feature <bN> --dry-run`.

Recipes above are the *how*. Attended vs unattended trust is an operator
calibration choice, not a product default.

Changing any of `pipelineRoleModels`, `pipelineRoleModelProfiles`, or
`defaultPipelineRoleModelProfile` requires `lca restart` (settings load once at
startup).

**Kickoff variables** (all ten required; nothing is concatenated by the daemon):

`pipelineId`, `featureId`, `featureSlug`, `featureDir`, `featureIndex`, `idea`,
`planningDepth`, `approvalPolicy`, `researchApprovalPolicy`, `loopMode`

**Budget / fail-safe:** arm the root at `maxDepth: 1`. `plan-skeleton` re-budgets to
`6 × phaseCount + 1` (normal) or `3 × phaseCount + 2` (execute) via `chain_control`.
If it never re-budgets, the chain stops after one extra run on `max-depth` — that
is the fail-safe.

**Generated workers** use `origin: generated` and the reserved `generated:` config-key
namespace. They are read-only from the dashboard and survive a config reconcile (the
watcher does not prune them). Re-run `POST …/workers` to refresh prompts idempotently.

Example kickoff:

```http
POST /api/runs
{
  "automationId": "<workspaceId>::generated:research",
  "maxDepth": 1,
  "variables": {
    "pipelineId": "implement-fully",
    "featureId": "b42",
    "featureSlug": "b42-my-feature",
    "featureDir": "docs/roadmap/b42-my-feature",
    "featureIndex": "docs/roadmap/b42-my-feature/00-index.md",
    "idea": "…",
    "planningDepth": "jit",
    "approvalPolicy": "none",
    "researchApprovalPolicy": "none",
    "loopMode": "normal"
  },
  "roleModels": {
    "planner": { "id": "…" },
    "implementer": { "id": "…" },
    "reviewer": { "id": "…" },
    "docs": { "id": "…" },
    "researcher": { "id": "…" },
    "gatekeeper": { "id": "…" }
  },
  "model": { "id": "…" }
}
```

The example above is a six-role kickoff, so it enters at `generated:research`
and carries both optional roles. A four-role kickoff is unchanged: post to
`<workspaceId>::generated:plan-skeleton` with the four required `roleModels`
entries and the same ten variables. Use `"loopMode": "execute"` (or
`lca implement-fully --execute`) for execute mode; Quick/JIT refuses execute.

Use the root model from `resolveEntryWorkerKey`'s `rootRole` as `model` (the
researcher when a researched chain starts at `generated:research`, otherwise the
planner), or omit and rely on the entry worker's stored model.

**Run list projection:** context-aware runs on `GET /api/runs` (and the dashboard-shaped
`GET /api/runs/:id` snapshot) also carry the chain scalars —
`chainRootRunId`, `chainDepth`, `chainMaxDepth`, `chainMaxDepthOverride`,
`chainStopRequestedAt`, `chainStopReason`, `chainHandledAt` — plus a board-safe
`pipeline` object `{ pipelineId, featureId, featureSlug }` parsed from persisted context.
When a run belongs to a wave, board-safe `pipelineWave` and `pipelineTrack` summaries
may appear; parallel labels use wave / track / phase identity rather than a fabricated
sequential cycle. The list surface **deliberately never** includes the idea text, role
recipe, `executionCwd`, or absolute worktree paths. Legacy or non-chained runs have
`null` for all of these. The full immutable context (`idea`, `roleModels`, and the nine
kickoff variables) remains on the per-run engine snapshot only (`chain_context_json` /
`chainContext`). Step label and cycle number for sequential runs are derived client-side
from the automation’s `generated:` config key and `chainDepth` via `@lca/shared`
helpers (`describePipelineStep`, `workerKeyFromConfigKey`).

### Serial implement-fully queue (`lca queue`)

Overnight **serial** chaining for implement-fully: enqueue multiple features in one
workspace and let the daemon start the next eligible entry when the current pipeline
settles. This reuses today's **one active pipeline per workspace** guard as the slot
of one — it is **not** concurrent multi-feature execution. Parallel waves and
multi-feature concurrency is not shipped yet (serial queue only).

**CLI** (daemon must be running; same resolve/provision path as `lca implement-fully`):

| Command | Meaning |
| --- | --- |
| `lca queue add --feature <bN>` | Enqueue documented work (options mirror implement-fully) |
| `lca queue add --idea "<text>"` | Enqueue new work from an idea |
| `lca queue list` | List entries for all workspaces (bare `lca queue` aliases list) |
| `lca queue rm <id>` | Cancel a waiting (`queued` or `blocked`) entry |
| `lca queue clear` | Cancel all `queued` and `blocked` entries |

**`--after`:** comma-separated feature ids (`b58`, `b49`, …). Dependencies must
already exist as queue rows or prior `done` entries in the same workspace. The CLI
parses the flag; the daemon validates edges at enqueue.

**Entry states:** `queued`, `running`, `done`, `failed`, `blocked`, `cancelled`.
A failure parks direct dependents one hop (`blocked`). The queue does not replay
completed batches after daemon restart.

**Staleness (AD3):** kickoff variables and role models are snapshotted on the row at
enqueue time. Edits to global role recipes or planning settings **after** enqueue do
not apply retroactively — cancel and re-add if you need a fresh kickoff.

**Morning digest:** when a batch drains, `queue_batch_complete` can toast/push a
single summary (done/failed/blocked counts plus parked feature ids). Toggle it under
Settings → **Alerts** or `settings.notify.events.queue_batch_complete` (hot-reloads).

Bare `lca doctor` prints a one-line **Queue** summary when entries exist.

## Environment variables

| Var | Purpose |
| --- | --- |
| `CURSOR_API_KEY` | Cursor **User** API key (`crsr_…`) in `~/.cursor-local-automations/.env`. Required. |
| `LCA_PORT` | Daemon HTTP/WS port (default `3747`). |
| `LCA_DAEMON_URL` | Daemon base URL for the `lca` CLI (overrides `LCA_PORT`). |
| `LCA_NO_TOAST` | `1` suppresses OS toast notifications (headless/CI). |
| `LCA_NO_NTFY` | `1` suppresses ntfy HTTP publishing once the transport sink exists (independent of `LCA_NO_TOAST`). Absent config also disables ntfy. |
| `LCA_HOST` | Bind address (default `127.0.0.1`). See `settings.host` above. |
| `LCA_ALLOWED_IPS` | Comma-separated device allowlist. See `settings.allowedIps` above. |
| `LCA_CONTROL_TOKEN` | Shared app-auth token. See `settings.controlToken` above. |
| `LCA_UNSAFE_NETWORK` | `1` permits booting with a broad host (`0.0.0.0`/non-loopback) **and** an empty allowlist (otherwise fatal). Explicit opt-in only. |
| `LCA_MAX_CONCURRENT` / `LCA_EVENT_RETENTION` / `LCA_MAX_EVENT_BYTES` | See `settings` above. |
| `LCA_MAX_ATTACHMENT_BYTES` / `LCA_MAX_ATTACHMENTS_PER_MESSAGE` / `LCA_ALLOWED_ATTACHMENT_MIME_TYPES` | Chat/run attachment limits — see `settings` table above. |
| `LCA_MAX_FILE_VIEWER_BYTES` / `LCA_MAX_FILE_VIEWER_ENTRIES` | Workspace file-viewer caps — see `settings` table above. |
| `LCA_SPAWN_TIMEOUT_MS` / `LCA_RUN_STALL_TIMEOUT_MS` / `LCA_MAX_SPAWN_ATTEMPTS` / `LCA_RETRY_BACKOFF_MS` | Spawn reliability settings — see `settings` table above. |
| `LCA_PIPELINE_RESUME_LOOKBACK_MS` | Boot lookback for missed completed transitions and failed-halt startup recovery — see `settings.pipelineResumeLookbackMs` above. |
| `LCA_PIPELINE_AUTO_ESCALATE` | Enable/disable safe post-terminal halt auto-escalation (`0`/`false` off, `1`/`true` on) — see `settings.pipelineAutoEscalate` above. |
| `LCA_PIPELINE_AUTO_ESCALATE_MAX_PER_PIPELINE` | Positive integer cap on daemon auto-escalations per pipeline lineage — see `settings.pipelineAutoEscalateMaxPerPipeline` above. |
| `LCA_PIPELINE_HALT_DISCOVERY` | Enable/disable best-effort halt-discovery advisories after unrecovered halts (`0`/`false` off, `1`/`true` on; default on) — see `settings.pipelineHaltDiscovery` above. Restart required. |

## Auth (decided)

Authentication uses a **personal Cursor User API key** (`crsr_…`), stored in the
gitignored `~/.cursor-local-automations/.env` as `CURSOR_API_KEY`. A
service-account key is not required for a single-operator local tool. The MCP
↔ daemon `ask_user` channel is additionally protected by a per-run token (see
[troubleshooting](./troubleshooting.md)).

## Observability: `.cursor/hooks.json` (decided — not used)

We deliberately do **not** wire `.cursor/hooks.json` for needs-input
observability. The blocking `ask_user` MCP tool already gives a precise,
synchronous pause/resume signal; adding hooks would duplicate that path with a
looser, fire-and-forget one. Git hooks remain in use only as dumb triggers that
POST to the daemon.
