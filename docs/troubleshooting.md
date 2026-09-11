# Troubleshooting

Troubleshooting for **Max**. `lca` is the CLI for Max, and its state lives under
`~/.cursor-local-automations/` — both are stable compatibility names, so the
paths, log filenames, and commands below are unchanged.

## Where the daemon writes (logs, DB, timestamps)

All daemon state lives under `~/.cursor-local-automations/`:

| File | Contents |
| --- | --- |
| `dev.log` | Primary run-flow log: greppable decision lines (`Run … — `, `Run … failed: `), trigger arming, lifecycle. |
| `daemon.err.log` | Daemon-level errors and **unhandled rejections** — the *only* place detached-promise failures (e.g. auth expiry) are recorded. Start here when a run failed but its timeline is silent. |
| `daemon.out.log` | SDK/agent stdout — env injection, skill & rule loading. |
| `daemon.log` | Legacy daemon log. |
| `state.sqlite` | `runs`, `run_events`, `automations`, `input_requests` (WAL mode — the `-wal`/`-shm` siblings are normal). |

**Timestamps:** the DB and all log *contents* are **UTC** (`runs.started_at` etc. via `datetime('now')`; `daemon.err.log` uses ISO `…Z`). Only OS file *mtimes* (`ls`, Explorer, `Get-ChildItem`) are local. So a cron `0 7 * * *` (7 AM local) appears everywhere in the DB and logs as `11:00:00` UTC — don't compare a file's local mtime to a UTC log line without converting.

**First-line diagnosis:** `lca doctor <runId-or-chatId>` correlates a run or chat event timeline with the matching `daemon.err.log` window (auth failures often appear only in the log, with no id). `lca doctor` with no args prints daemon health, key presence, and recent failures. Prefer that over hand-written SQLite scripts.

**Query a run ad hoc** — `runs.id` is a full UUID; match on the prefix you have:

```sql
SELECT * FROM runs WHERE id LIKE '<prefix>%';
SELECT seq, event_type, payload FROM run_events WHERE run_id = '<run-id>' ORDER BY seq;
```

## Daemon won't start

- **`CURSOR_API_KEY is not set`** — add it to `~/.cursor-local-automations/.env`
  as `CURSOR_API_KEY=crsr_...` (see `config/.env.example`).
- **`Port 3747 is already in use`** — another daemon is running. Stop it, or
  start with a different port: `LCA_PORT=3748 npm run daemon`.
- **`Schema migration incomplete`** — the on-disk DB is newer/older than the
  binary. Rebuild (`npm run build`) so the daemon and schema match.

## Spawn reliability (stuck / failed runs)

The daemon self-heals orphaned and stalled runs: on boot it reconciles active runs
left from a prior session, and a periodic watchdog recovers `running` runs with no
recent activity. `needs_input` runs are intentionally idle and are never touched by
the watchdog. Manual backstop: `npm run cleanup:runs` (`scripts/cleanup-stale-runs.mjs`)
if the daemon won't start and you need to clear slots by hand.

**Failure reason codes** (`RunFailureReason` — same in daemon log, run events, and
give-up toast):

| Reason | Meaning |
| --- | --- |
| `spawn_timeout` | `spawn()`/`resume()` did not return within `spawnTimeoutMs`. |
| `spawn_error` | Spawn/resume threw or returned an error. |
| `orphaned_no_agent` | Run was active (`running`/`needs_input`) but had no agent (e.g. after daemon crash); retried via requeue. |
| `agent_gone` | Local agent session expired mid-run; marked failed (not retried — may have partial work). |
| `stalled_idle` | `running` run had no new events for longer than `runStallTimeoutMs`. |
| `retries_exhausted` | Terminal give-up after `maxSpawnAttempts`; event payload includes `cause` with the originating reason. |

**Diagnose from the daemon log** (greppable decision lines, or use `lca doctor <runId-or-chatId>` to correlate automatically):

```bash
lca doctor <runId-or-chatId>   # events + correlated daemon.err.log window + verdict
rg "Run .*— " ~/.cursor-local-automations/dev.log
rg "Run .* failed: " ~/.cursor-local-automations/dev.log
```

**Diagnose from run events** (SQLite, or via `lca doctor <runId-or-chatId>` which prints key events in full):

```sql
SELECT event_type, payload FROM run_events WHERE run_id = '<run-id>' ORDER BY seq;
```

Look for `run.spawn.attempt`, `run.retry.scheduled`, `run.reconciled`, `run.stalled`,
and terminal `run.error` with `reason` / `cause`. Startup prints a `Reliability:` line
with the four settings. See [configuration](./configuration.md) for defaults and env
overrides.

## Runs

### Pause / resume (parked automations)

A run in status **`paused`** is an operator-parked automation, not a halt. It still
counts as **active** (holds a concurrency slot and blocks a second pipeline kickoff
for the same feature). In `lca doctor` health output, look for
`paused: N parked pipeline run(s)` — that is separate from `halted:` lines.

- **Parked vs stuck** — `lca doctor <runId>` on a paused run reports that steering
  messages are allowed and names `lca resume`. That means **direct** turns while
  paused (`lca` message / chat Send / `POST /api/runs/:id/message`), not soft-steer:
  `queueMessage` and `POST /api/chats/:id/steer` stay rejected until you resume.
- **Recovery suppressed** — b43/b44 halt recovery and the stall sweep deliberately
  skip `paused` runs. Do not escalate or delete them as if they failed.
- **Daemon restart** — paused runs are **not** boot-resumed; they stay paused with
  `ended_at` null until you `lca resume <runId>`.
- **Soft steer while running** — attach a live run to a workspace chat and use
  dashboard **Steer** or `POST /api/chats/:id/steer`; the message queues on the run
  and delivers after the current turn.

- **Run stuck in `queued`** — the global concurrency cap is full. Active runs
  (`running`, `needs_input`, and operator-`paused`) hold slots. Raise
  `maxConcurrentRuns` (or `LCA_MAX_CONCURRENT`), or answer/resume/cancel the
  blocking run. Queued runs are
  restart-safe — they're stored and the pump restarts them after the daemon
  comes back up. Separately, wave partitioning may leave dependency-ready phases
  **Pending** (not `queued`) when they exceed the same `maxConcurrentRuns` width
  in one wave — those wait for a later coordinator. Lowering the setting does
  not cancel or drop phases.
- **Run marked `failed` after a daemon restart** — its local agent session no
  longer existed (`stale`). Re-trigger it. Runs that were still `running` /
  `needs_input` and whose agent survives are re-attached automatically.
- **Cold resume retries before going stale** — when a follow-up or boot
  re-attach hits a transient `not found` (common seconds after a daemon crash
  or `lca restart`), the daemon retries cold `Agent.resume` up to three times
  with short abort-aware backoff before recording a final `stale` error. The
  same policy applies to long-lived chats. Stop/Interrupt cancels any in-flight
  retry. Authentication expiry (`unauthenticated` / `ERROR_NOT_LOGGED_IN`) is
  **not** retried — it produces `run.error { reason: "auth_expired" }` (or
  `chat.error` equivalent) with the run's terminal status preserved on follow-ups,
  plus toast and log alerts.
- **Session revive after exhausted retries** — for an operator follow-up, once
  cold resume retries are exhausted with `not found`, b32 spawns a fresh agent
  seeded from the stored transcript instead of dropping the message. The
  timeline marker is `run.revived` or `chat.revived`; the new agent has
  transcript memory, not the old session's internal state. A `stale` error now
  means revive is disabled with `sessionRevive: false` /
  `LCA_SESSION_REVIVE=0`, or the revive spawn itself failed
  (`reviveFailed: true`).
- **Chat ends in error and a new message does not continue** — a turn that
  finishes `chat.finished { sdkStatus: "error" }` (often only `status` frames,
  plus a daemon `ConnectError: write ECANCELED`) used to resume the same dead
  local session, which immediately errors again. Send again: chats in `error`
  skip resume and revive from the stored transcript. The same revive also
  runs automatically when a resume handle comes back but the SDK returns
  error with no assistant/tool output. Auth-expired still requires
  re-authentication; `lca restart` does not repair dead credentials.
- **Resume / follow-up fails after long idle** — terminal runs keep an
  in-memory retained session for instant follow-ups. After a long idle (~30 min
  by default, tunable via `retainedSessionTtlMs` in
  [configuration.md](./configuration.md)), that connection's auth can go stale
  even though the API key and on-disk agent session are fine. b20 self-heals:
  a retained follow-up that fails before producing output transparently falls
  back to cold `Agent.resume` (look for `run.retained.fallback` in the
  timeline). Expired retained sessions are disposed proactively by the TTL
  sweep so long-gap follow-ups skip the rotten path entirely. **Do not** use
  `lca restart` as the primary fix. Only re-authenticate when
  `run.error { reason: "auth_expired" }` appears or brand-new runs also fail
  auth. Chat turns show the same `auth_expired` rendering; retry after
  re-authenticating. Confirm with `lca doctor <runId-or-chatId>`.
  `lca restart` does not repair dead credentials.
- **Daemon crashed mid-run** — on restart the daemon (1) re-attaches active runs
  that still have local agent ids, (2) reconciles orphaned `running` /
  `needs_input` rows with no ids, and (3) restarts any runs left `queued`.
  Completed runs keep their saved agent ids permanently — a follow-up is always
  attempted. If the underlying local session is genuinely gone, cold resume
  retries a few times first, then revives from the stored transcript when
  enabled; the run stays on the same row with fresh agent ids.
  No manual cleanup is needed; `npm run cleanup:runs` exists as a manual escape
  hatch.
- **Implement-fully pipeline stopped (`run.chain-skipped` reason `stopped`)** —
  `plan-phase` (or another worker) called `chain_control` stop, or an operator
  aborted. Read `detail` / `chain_stop_reason` for the prefix: `complete:` on
  main-coordinator `plan-phase` means no runnable Pending phase — the daemon
  enqueues one terminal `final-gate` run for the full root pass (look for
  `run.pipeline-final-gate-enqueued`); `deadlock:` means Pending rows remain but
  none is dependency-ready; `blocked:` means an external blocker (from
  `final-gate`, the feature did not complete — diagnose the red gate and leave
  the tree as-is); anything else is usually an operator abort. Start with
  `lca doctor <runId>` on the leaf run — it distinguishes agent stop prefixes
  from operator abort and labels a `final-gate` run as the feature-end root pass.
- **Implement-fully budget exhausted (`reason: "max-depth"`)** — the effective
  depth cap was hit. On a context-aware run the payload’s `maxDepth` is the
  effective budget (`chain_max_depth_override` when set, else `chain_max_depth`);
  `maxDepthOverride` appears when an override was written. A root left at
  `maxDepth: 1` with no re-budget from `plan-skeleton` is the fail-safe (exactly
  two runs). Confirm with `lca doctor <runId>`. Raise the budget only via the
  planner (`chain_control` maxDepth) — there is no operator escalate flag for this.
- **`already-chained` skip on a re-terminalized run** — a duplicate terminal
  event hit a run whose transition was already claimed (`chain_handled_at`).
  Harmless; no second successor is created. If you expected a new child, look for
  the original `run.chained` event on that run instead of re-triggering mid-chain.
- **Pipeline halted (`status-mismatch`)** — a `when: completed` step failed (or
  was cancelled); the daemon wrote `run.chain-skipped` with
  `reason: "status-mismatch"` and left `chain_handled_at` null. The board shows a
  red-ringed halted card inside the feature group; `lca doctor <runId>` names the
  halt and the three escalations.
  - **Automatic recovery (bounded):** when `pipelineAutoEscalate` is on (default),
    the daemon may retry or skip **one** narrow safe class only — a failed
    context-aware pipeline step with `status-mismatch`, a late bare `sdk_error`,
    and prior substantive `assistant` / `tool_call` activity. Worker ladder:
    `plan-phase` / `implement` retry once; `review` retries once then halts;
    `docs-commit` skips once (legacy in-flight runs); unsupported workers stay halted. Cap defaults to `2` daemon
    escalations per lineage (`pipelineAutoEscalateMaxPerPipeline`). Kill switch:
    `LCA_PIPELINE_AUTO_ESCALATE=0`. See [configuration](./configuration.md).
  - **Evidence of automatic action:** daemon-attributed `run.pipeline-escalated`
    (toast “Max automatically recovered a pipeline halt”), dashboard transcript
    rows, and `lca doctor` saying no operator action is needed.
  - **Declines stay halted:** disabled policy, unsafe/unknown or contract-related
    failures, budget/ladder exhaustion, and wave/track scope emit
    `run.pipeline-halt-unrecovered` (toast “Max pipeline remains halted”) and
    remain operator-actionable. Automatic recovery never claims operator
    authority and does not widen spawn/resume/stall retries.
  - **Halt discovery (best-effort, default on):** when
    `pipelineHaltDiscovery` is on (`LCA_PIPELINE_HALT_DISCOVERY`; default
    `true`; restart-loaded — change with `lca restart`), an unrecovered halt
    may spawn a separate `halt-discovery` advisory that gathers bounded
    evidence and parks a **no-timeout** recommendation card. Sequence:
    unrecovered halt → advisory diagnosis → no-timeout briefing. The source
    run stays failed; discovery has no escalation or pipeline-transition
    authority. Direct `lca escalate <source> retry|skip|abort` remains
    available the whole time.
    - **Approve retry / skip / abort** on the briefing card — maps to one
      operator-attributed source escalation (same write-once claim as the card
      buttons). Stale or lost-claim answers surface as refused; escalate the
      source directly if still needed.
    - **Diagnosis or briefing failure** — durable `run.pipeline-halt-discovery-failed`
      on the source; fall back to `lca escalate` / card buttons. Skips
      (`disabled`, `wave-scoped`, `source-resolved`, `ineligible-source`,
      `invalid-trigger`) are durable visibility outcomes, not new failures.
    - **Promote to chat** — continues diagnosis context in a workspace chat
      linked to the advisory (and source). Promotion does **not** answer the
      card or escalate the halted source.
    Inspect with `lca doctor <source>` or `lca doctor <advisory>`; the
    dashboard labels halt-discovery cards and lifecycle events separately
    from the failed source.
  - **Operator remedy** (declined or any halt you choose to drive):
    - **retry** — same depth / prompt / context (after you fixed the underlying
      failure). Unavailable on the root.
    - **skip** — advance to the successor with an operator notice (when the budget
      and successor allow).
    - **abort** — end the lineage with a reason.
    Run `lca escalate <runId> retry|skip|abort [--reason <text>]` or use the card
    buttons.
- **Malformed tracker** — `plan-phase` fails or writes a phase file that does not
  match the tracker table. Symptom: failed `plan-phase` with a halted card /
  `status-mismatch`. Fix the tracker by hand in the repo, then
  `lca escalate <runId> retry`.
- **Git conflict on review closeout** — `review` fails against a dirty or
  diverged tree while committing phase closeout. Symptom: failed `review`, halted
  card. Resolve the tree by hand, then **retry**; or finish the commit yourself
  and **skip** so the loop continues without re-committing.
- **Partial commit** — `review` committed some of the closeout work then failed.
  Symptom: `git log` shows a commit but the run is failed/halted. Verify with
  `git log` / `git status`, finish any remaining edits by hand, then **skip**
  (retrying would attempt another commit).
- **Restart mid-pipeline** — after `npm run build -w @lca/daemon` (and dashboard
  if needed), pick up changes with **`lca restart`** — never `lca down`. On boot
  the daemon, inside `pipelineResumeLookbackMs`, (1) replays missed transitions
  for `completed` context-aware runs (once each, with `run.pipeline-resumed`) and
  (2) runs a bounded, idempotent failed-halt recovery pass over halted
  candidates in that window: it recovers the safe `sdk_error` class when
  `pipelineAutoEscalate` is on, and with the kill switch set each candidate
  records a one-time `disabled` decline instead. It is not a recurring sweep,
  and it does not revive legacy (non-context) chains or unsafe/declined
  failures — use `lca escalate` for those.
- **Unanswered pipeline question** — a pipeline run in `needs_input` is never
  stall-swept, so it blocks the lineage until answered. Bare `lca doctor` flags
  pipeline `needs_input` older than ~30 minutes; answer with `lca answer <runId>`
  or the dashboard.
- **`lca implement-fully` says the current directory is not a registered
  workspace** — Max only kicks off inside a workspace it knows. Add the repo
  path under `workspaces:` in `~/.cursor-local-automations/automations.yaml`
  (or register it in the dashboard), then retry. Do not invent a workspace row
  from an agent run.
- **Kickoff refuses: exactly one of `--feature` / `--idea`** — use
  `lca implement-fully --feature <bN>` for documented work or
  `lca implement-fully --idea "<text>"` for new work. Do not pass both, and do
  not pass `--slug` (removed). Confirm with
  `lca implement-fully --feature <bN> --dry-run` (or `--idea` …) before a real
  kickoff.
- **Kickoff refuses: daemon resolve error** — missing feature, ambiguous or
  malformed roadmap metadata, or a stale next-id marker. Fix the roadmap index
  (or pick a real feature id) and retry; do not invent slug/idea in the CLI or
  skill.
- **Kickoff refuses: role has no override and no default** — every required role
  (`planner`, `implementer`, `reviewer`, `docs`) needs a model. Set
  `settings.pipelineRoleModels` (the synthetic `default` recipe) and/or add named
  entries under `settings.pipelineRoleModelProfiles`, then `lca restart`; pick a
  profile with `--role-profile <id>` or the dashboard **Model profile** control
  instead of rewriting the default map each run. Per-role gaps can also be filled
  with `--role <role>=<modelId>`. There is no silent fallback to the
  daemon’s default model for pipeline roles. Confirm with
  `lca implement-fully --feature <bN> --dry-run` before a real kickoff.
- **Kickoff refuses: unknown `--role-profile`** — the id is not in the introspection
  catalog (`default` plus keys from `pipelineRoleModelProfiles`). The error lists
  valid ids. Fix the flag or add the profile in global YAML and `lca restart`.
  Do not confuse `--role-profile` (model recipe) with `--profile` (planning
  depth: quick/deep/guided).
- **Soak / kickoff from a Max automation run** — do not `lca restart` from inside
  an active daemon-hosted run to pick up new `pipelineRoleModels`; restart kills
  the hosting session. Set YAML defaults and restart from a normal terminal or
  Cursor chat, then kick off the soak. Restart from a normal terminal, not
  from inside a hosted run.
- **Kickoff refuses: workspace already has an active pipeline** — another run
  on a generated implement-fully worker is `queued` / `running` /
  `needs_input`. Finish or cancel it first, or pass `--force` only when you
  intentionally accept two agents committing in one working tree.
- **Provision returns `409` for a worker id** — an operator-authored automation
  already occupies that generated worker’s id. Rename or remove the conflicting
  automation (or choose another workspace). Provisioning will not overwrite
  operator-owned rows.
- **`/implement-fully` skill not found** — the entry skill is not installed in
  the profile. From this repo run `npm run install:skill` (copies
  `skills/implement-fully/` → `~/.cursor/skills/implement-fully/`). Use
  `npm run install:skill -- --check` to verify drift.
- **Serial implement-fully queue not moving** — the queue is **serial** (one active
  pipeline per workspace). Concurrent isolation is not shipped yet. Diagnose in order:
  1. **Bare `lca doctor`** — read the **Queue** line (`queued` / `running` /
     `blocked` counts). Empty means no active batch.
  2. **`blocked` entries** — inspect `detail` on the row (`lca queue list` or
     `GET /api/feature-queue?workspaceId=…`). Dependents park one hop when an
     upstream feature `failed`; clear or `rm` blocked rows before retrying.
  3. **Active-pipeline guard** — if nothing starts but a non-queue implement-fully
     run is still `queued` / `running` / `needs_input`, the slot is occupied.
     Finish or cancel that run first (`lca queue add` intentionally skips this
     guard at enqueue time only).
- **Parallel waves (implement-fully)** — start with bare `lca doctor`. Expect
  `tracks running`, `barrier wait`, `blocked waves`, and `cleanup required`. A
  run-specific Pipeline block may also show
  `recover: lca wave … retry | … abort`. Concurrency and path layout:
  [configuration.md](./configuration.md); tracker / barrier state machine:
  [implement-fully-protocol.md](./implement-fully-protocol.md).
  1. **Barrier wait (`N/M tracks`)** — normal while sibling tracks finish. Do
     not abort solely because the barrier is waiting.
  2. **Blocked wave** — doctor exposes the short wave id / block code. Recover
     with `lca wave <waveId> retry|abort [--reason <text>]` (operator
     credentials — not the agent run token).
  3. **Dirty track after upgrade (`dirty-track-worktree`)** — a wave blocked
     right after upgrading mid-pipeline because a pre-upgrade `review` left an
     uncommitted tree on a track. Commit or discard the track's leftovers on
     that branch/worktree, then run `lca wave <waveId> retry`.
  4. **retry** — re-enqueues integration only when the wave is blocked, all
     tracks are complete, no integration run is active, the wave is
     unfinalized, and main is clean. A refusal changes no wave state. Useful
     codes: `not-blocked`, `tracks-incomplete`, `integration-active`,
     `dirty-checkout`, `not-eligible`.
  5. **abort** — idempotent. Marks the wave aborted, cancels queued siblings,
     stops active siblings, removes only clean worktrees, retains dirty
     resources, and leaves branches for diagnosis (never force-deletes them).
  6. **`cleanup required`** — bare doctor and the board flag durable retained
     resources. The abort CLI response lists branch/worktree diagnostics the
     cleanup sweep recorded as retained. Abort never deletes track branches, so
     a clean removed worktree can still leave a branch even when
     `cleanup required` is false. Inspect, preserve or merge as appropriate,
     and remove only resources you have proven disposable. Never force-reset,
     force-delete branches, or delete the whole LCA home.
  6. **Sequential fallback (not an error)** — the coordinator creates no wave /
     worktree and leaves the transition unclaimed so `plan-phase` writes the
     topmost ready phase. Common causes: one safe candidate, concurrency below
     two, dirty / detached / unborn main, missing git, or invalid
     worktree/preflight state.
  7. **Failure ownership** — a track failure or track-scoped escalate abort
     aborts the wave and stops siblings without a destructive worktree sweep;
     inspect retained work manually. An integration conflict/block leaves the
     wave blocked for operator retry or abort. Successful finalize removes
     clean worktrees and only proven-merged branches.

## Phone notify (ntfy)

Per-event toast and ntfy delivery for twelve daemon-wide alert ids (seven
catalog + five halt/discovery). Configuration and smart defaults are documented
under [Phone notify (ntfy)](./configuration.md#phone-notify-ntfy). This section
is diagnostics only — delivery requires the per-event prefs flags you want,
a usable ntfy connection when `ntfy` is on for that event, and no
`LCA_NO_NTFY=1` / `LCA_NO_TOAST=1` mute for that channel.

- **Phone not subscribed / wrong topic** — open the ntfy app and confirm the
  subscribed topic matches `settings.notify.ntfy.topic` (private value; do not
  paste it into chat or git). Use Settings → **Alerts** → **Test send** after
  saving a connection to verify publish without waiting for a live event.
- **Event prefs off** — check Settings → **Alerts** (or YAML
  `settings.notify.events.<id>`): `toast: false` silences OS toasts;
  `ntfy: false` skips phone push even when connection is configured. **Reset to
  defaults** restores smart defaults in the draft; **Save alerts** persists.
- **Quiet smart defaults** — `run_completed`, `pipeline_halt_recovered`, and
  `halt_discovery_action` default to toast off and ntfy off. Turn them on in
  the matrix if you want those alerts.
- **ntfy unconfigured / not usable** — phone push needs `settings.notify.ntfy`
  with a non-empty topic (and valid server/token when required). The ntfy column
  is greyed when connection is missing or `usable.ntfy` is false; enable and
  save connection before expecting pushes.
- **Plan approval toast but no phone push** — OS toast can be on while
  `plan_approval_required` has `ntfy: false` in prefs; enable the ntfy toggle
  for that row and save.
- **Unexpected generic `needs_input` notify on a plan gate** — replace-not-double
  applies only when the parked request is approval-shaped (`kind: approval` with
  the approve/revise/abort triad). Missing shape falls back to generic
  `needs_input` notify.
- **`ux_approval_required` silence** — expected until a product UX/design gate
  producer exists; the id is catalog-reserved only (Notifier seam callable, no
  live park yet).
- **Loud `pipeline_complete`** — defaults toast on and ntfy on; feature-end
  silence usually means prefs turned off, ntfy unconfigured, `LCA_NO_NTFY`, or
  the settling worker was not implement-fully `final-gate` (not a per-step
  worker).
- **Server / token** — self-hosted or auth-required servers need a valid
  HTTP(S) `server` and optional `token`. Public `https://ntfy.sh` is the
  default when `server` is omitted.
- **Kill switches** — `LCA_NO_NTFY=1` disables ntfy publishing;
  `LCA_NO_TOAST=1` disables OS toasts. They are independent. Settings → Alerts
  shows greyed columns when mutes are active.
- **Daemon logs** — look for settings-parse warnings in
  `~/.cursor-local-automations/dev.log` / `daemon.err.log` if the nested
  block was rejected (typo, empty topic, bad server URL, unknown event id).
  Notify prefs hot-reload after YAML edits or Alerts Save — no restart needed
  for notify-only changes. Do not restart the live daemon from inside an
  active automation run.

## Needs-input / `ask_user`

- **`invalid or missing run token` (HTTP 403 on `/ask`)** — only a run's own
  spawned MCP child carries the per-run token (passed via `LCA_RUN_TOKEN`). A
  403 means an arbitrary local process tried to inject a question; legitimate
  runs never hit this. Operator answers (`/answer`, dashboard, `lca answer`) do
  not need the token.
- **Agent never pauses** — `ask_user` tool calls are nondeterministic. Pause/
  resume itself is covered by `verify:phase3`; if a given run doesn't call the
  tool, it simply finishes without pausing.
- **Research approval parked on `needs_input`** — see
  [Implement-fully roles and research approval](#implement-fully-roles-and-research-approval).

## Implement-fully roles and research approval

- **Armed approval policy with no researcher** — kickoff refuses
  `researchApprovalPolicy: before-planning` when no `researcher` model resolves,
  **before** any provision or trigger (zero side effects). The CLI message
  carries a `--role researcher=<modelId>` hint when the policy came from the
  explicit `--research-approval` flag.
- **Unknown role or profile id** — a `--role` key outside the six-role
  vocabulary (`planner`, `implementer`, `reviewer`, `docs`, `researcher`,
  `gatekeeper`), or a `--role-profile` id absent from
  `pipelineRoleModelProfiles`, fails at kickoff. Settings load at daemon
  startup, so a freshly edited YAML profile needs `lca restart` before the verb
  can see it.
- **Run parked on research approval** — status is `needs_input` by design and
  has **no** timeout (`RunStore.listStallCandidates` selects `status = 'running'`
  only, so the stall sweep cannot reap it). The card survives reload and daemon
  restart. Answer from the dashboard, `lca answer <runId>` (bare form first —
  it prints the choice **ids**), or the phone. Answering with a *label* instead
  of an id is rejected and the request stays pending. Abort by cancelling the
  run. Over-cap answers (>8192 chars) are refused at both the HTTP route and
  the hub, with different message wording — that is by design.
- **Gatekeeper fallback diagnosis** — `lca doctor <finalGateRunId>` prints
  `gate:       gatekeeper=<modelId> (explicit | reviewer fallback)` for any
  `final-gate` run whose chain context carries a role recipe. The line comes
  from that recipe, not from the automation row: a four-role recipe reads
  `reviewer fallback`, a six-role recipe reads `explicit`. On a workspace
  provisioned before this feature the `final-gate` row still says
  `model_role = 'reviewer'`, so a six-role recipe there runs the gate on the
  reviewer while the line still reads `explicit` — the one case where the
  doctor line and the model that ran disagree, and designed behavior rather
  than a bug. Reprovision (`POST /api/pipelines/implement-fully/workers`) to
  move the row's `model_role` to `gatekeeper` and make the two agree.

## Triggers

- **Git hook does nothing** — hooks only install in real repos (a `.git`
  directory must exist) and only POST to the daemon; matching happens in the
  daemon. A hook firing in a non-configured repo (or via the `pwd` fallback
  outside a repo) posts a workspace that matches no automation and is a no-op.
- **File-watch not firing** — globs are matched workspace-relative with
  forward slashes and dotfiles enabled. Confirm the glob base resolves under the
  workspace; paths outside the workspace never match.

## History / storage

- **SQLite file growing** — events are capped per payload and pruned to
  `eventRetentionPerRun` when a run ends. Retention applies to runs that end
  after the setting takes effect; very old pre-existing runs keep their events
  until they're (re-)pruned.
- **Export** — `lca export --format csv|json [--workspace <id|name>] [--out file]`,
  or `GET /api/runs/export?format=csv|json[&workspaceId=...]`. The dashboard
  toolbar has Export CSV/JSON buttons that respect a single selected workspace.

## Remote restart (phone over Tailscale)

- **Automation agent ran `lca down` / verify preflight and the daemon stayed down** —
  agents must **never** use `lca down`, `POST /api/shutdown`, or
  `scripts/stop-lca-daemons.mjs` against the live operator port to pick up code
  changes or "clear" the machine for a verify script. That stops the daemon and
  the run is cancelled before a follow-up `lca up` can run (common when you're
  away on mobile). Rebuild, then run **`lca restart`** in one shot (or
  **Settings → Application → Restart daemon**). `lca down` is operator teardown only.
  `stop-lca-daemons.mjs` now refuses remote/active sessions unless
  `LCA_FORCE_STOP_DAEMONS=1`. After the daemon is back, a follow-up may briefly
  see `not found` while the SDK store settles; cold resume retries automatically
  before declaring the session stale.
- **`Settings → Application → Restart daemon` from the phone leaves it down / "restart failed"** — the
  daemon force-closes in-flight connections during teardown, so a phone's
  persistent `/ws` socket can't stall the relaunch. Before this, `server.close()`
  waited for the live dashboard socket to drain, `http.close()` hung, the
  relaunch never ran, and you could be left with a zombie old process (still
  holding the phone's WS) plus, on a fast handoff, `EADDRINUSE` on the rebind.
- **`Port 3747 ... already in use` right after a restart** — a relaunched daemon
  now retries the bind for ~5s to ride out the outgoing daemon's socket release
  instead of dying fatally. A persistent EADDRINUSE past that means a genuine
  second daemon is running — stop it (`lca down`) or use a different `LCA_PORT`.
- **Diagnose** — `netstat -ano | findstr ":3747"`. Exactly one PID should be
  `LISTENING` (on loopback and the Tailscale host). Two daemon PIDs, or a flood
  of `TIME_WAIT` (the phone's WS reconnect loop hammering a dead listener),
  means a restart left a zombie; kill the stale PID(s) and `lca up`. The
  relaunched daemon logs to `~/.cursor-local-automations/daemon.err.log`.

## Dashboard

- **`Cannot reach daemon`** — the daemon isn't running or is on another port.
  Start it (`npm run daemon`) or point the dashboard/CLI at the right
  `LCA_PORT` / `LCA_DAEMON_URL`.
- **Workspace filter** — chips multi-select (empty = all); the selection is
  persisted in `localStorage`.

## Chat attachments

- **File too large** — uploads are capped by `settings.maxAttachmentBytes`
  (default 15 MiB). Raise it in global YAML or `LCA_MAX_ATTACHMENT_BYTES`, then
  `lca restart`.
- **Unsupported file type** — only the MIME allowlist is accepted (images +
  conservative text-like types by default). Adjust
  `settings.allowedAttachmentMimeTypes` / `LCA_ALLOWED_ATTACHMENT_MIME_TYPES`
  and restart.
- **Clipboard paste did nothing** — focus the compose box, ensure an image is
  on the clipboard (not only a file path), and confirm the MIME is allowlisted.
- **Attachment preview cannot load** — check the daemon is reachable and the
  control token is set for remote access; use `lca doctor <runId-or-chatId>` to confirm
  the `run.message` / `chat.message` payload still lists the attachment id.
- **Agent did not receive image** — confirm the message was sent (not only
  staged), the run/chat is local-resumable, and `daemon.err.log` has no follow-up
  errors. Non-image files are referenced in text, not inlined as SDK images.
- **Queued message lost attachments** — should not happen after schema v10
  (`attachments_json`). If it does, `lca doctor <runId-or-chatId>` and check the
  queued event payload for attachment refs.
- **Orphan / leftover attachment files** — the daemon reconciles ownerless
  attachment metadata and directories (rows whose run or chat owner is gone, and
  stray files under the attachments tree). Cleanup is maintenance, not a
  retention policy — there is no age-based expiry for staged uploads.

## Chat titles, archive, and delete

- **Stuck as “Untitled chat”** — auto-title runs after the first user message
  (heuristic) and may refine after the first successful turn. Rebuild/restart
  the daemon on a b31+ build (`npm run build -w @lca/daemon` then `lca restart`),
  hard-refresh the dashboard, and send a new message in a fresh chat. If you
  already renamed the chat, auto-title will not overwrite (`title_source=user`).
- **Rename did not stick** — use the header title click or list **Rename**; empty
  titles are ignored. Confirm with a hard refresh; live updates also arrive on
  the `chat_session` WebSocket frame.
- **Find an archived chat** — in the chat sidebar, switch the **Active /
  Archived** control to **Archived**. Open a row to inspect its transcript
  (read-only). Use **Unarchive** in the list menu or conversation header to
  restore it to Active; compose stays hidden until then. **Delete** still
  hard-removes the session, events, queue rows, and attachment blobs under
  `~/.cursor-local-automations/attachments/chat/<chatId>/` — confirm the dialog
  before deleting.
- **Archive vs delete** — **Archive** moves the chat out of Active (recoverable
  from Archived). Archived chats reject send/queue/interrupt until unarchived.
  **Delete** is permanent.
- **Chat diagnosis** — `lca doctor <runId-or-chatId>` accepts a run or chat id
  and interprets chat recovery events (`chat.error` with `auth_expired`,
  `chat.revived`, stale/revive-failed, `chat.finished`, and related resume
  frames). An `error` chat is still resumable — send a new message. Auth-expired
  still means re-authenticate; `lca restart` does not repair dead credentials.
- **Delete while running** — the daemon cancels in-flight work first, then
  purges. If the UI still shows the chat, hard-refresh; `chats_deleted` should
  clear the selection.
