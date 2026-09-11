# Implement-Fully Protocol — Repo as State

How the `implement-fully` pipeline turns a feature idea into a finished roadmap
cycle. This document is the **canonical** description of the loop: operator
reference first, and the source 03b's worker prompts are derived from.
Prompts restating these rules must change here before they change in the catalog.

The pipeline runs inside *other* workspaces. Those workspaces never see this file;
each worker prompt carries the rules it needs inline. Maintainers diff prompts
against this document when behavior drifts.

This page does not restate daemon internals. File-format rules for the
backlog live in [`roadmap-format.md`](./roadmap-format.md).

## What the pipeline is

Eight generated workers support one fixed **sequential** cycle, a parallel
**wave join**, and a terminal feature gate:

`plan-skeleton` → `plan-phase` → `implement` → `review` → `plan-phase` …

When a kickoff resolves a `researcher` model, entry is the conditional
one-shot `research` worker instead: it runs **once**, writes exactly one
artifact (`<featureDir>/research.md`), and chains into `plan-skeleton`. With no
researcher, entry stays `plan-skeleton` unchanged.

The static transition graph registers eight workers; three are the active loop
(`plan-phase`, `implement`, `review`). Under **`loopMode: execute`**, the per-phase
loop is `plan-phase` → `implement` → `docs-commit` (the daemon remaps the static
`implement → review` edge at runtime to `docs-commit`; the static graph is unchanged).
After the last phase, one feature-level `review` and then `final-gate` replace the
per-phase reviewer. See [Execute mode](#execute-mode) below.

`research`, `plan-skeleton`, `integrate-wave`, and `final-gate` are **off-cycle**
(`cycle: null`, no step number) at **any** depth. A research prelude's one-depth
offset is recovered from the loop worker's own index so a prefixed chain's first
plan→implement→review loop still reads as cycle 1. The retained `docs-commit`
worker is the execute-mode phase closer (runtime remap from `implement`); it stays
provisioned for in-flight runs and the `docs` model role.
`plan-skeleton` is depth-aware:

| `planningDepth` | Skeleton behavior |
| --- | --- |
| `jit` (Quick/JIT) | Emits scope-only PRD/index/stubs; no planning skill. |
| `full` (Deep / Guided) | Composes the installed `/plan-implement-fully` caller (which delegates to `/plan-for-speed-model-fully`) and emits every initial speed-model-ready phase contract before chaining. |

`plan-phase` under `jit` still thickens the selected stub into a full
speed-model novel (what Composer needs). A future creative-implementer
path may leave the stub and merge plan+implement in one context — see
planning-grain notes in operator calibration (private). Not shipped;
do not change worker prompts from this paragraph.

Both paths then enter `plan-phase`, which alone selects work and marks a row
`In Progress`. Full planning leaves every executable row `Pending` until that
selection step.

When `plan-phase` fans out dependency-ready phases that are pairwise parallel-safe,
the daemon provisions isolated **tracks** (one branch + worktree per phase). Each
track runs the same `plan-phase` → `implement` → `review` mini-cycle on its
branch. When every track completes, main runs `integrate-wave` to merge tips
in ordinal order and finalize the wave before returning to `plan-phase`.

Every step is its own Max run. Each run starts a fresh agent context; the
repository (or track worktree) is the handoff. Agents do not rely on conversation
memory across steps. A deadlocked / blocked worker ends the loop through
`chain_control` stop — never by editing a shared automation. When main-coordinator
`plan-phase` reports no runnable phase with `complete:`, the daemon hands off to
terminal `final-gate` for the one full root pass (normal mode), or to one
feature-level `review` then `final-gate` under execute mode.

## Execute mode

Opt-in **`loopMode: execute`** (`lca implement-fully --execute`, dashboard checkbox,
or explicit tenth kickoff variable) runs a thinner per-phase loop when every phase
contract is already speed-model-ready:

```text
normal   plan-skeleton → (plan-phase → implement → review) × P        → final-gate
execute  plan-skeleton → (plan-phase → implement → docs-commit) × P
                       → feature-level review → final-gate
```

**What it is:** defer per-phase `plan-phase` repair/split and per-phase `review`;
keep one commit per phase via the thin `docs-commit` closer; run one acceptance
`review` across every `Done` phase, then the existing `final-gate`.

**Eligibility (fail closed at three layers):** CLI parse, dashboard control, and
`normalizeImplementFullyChainVariables` refuse `loopMode: execute` with Quick/JIT
(`planningDepth: jit`). Admit-only `plan-phase` under execute also refuses a phase
file missing `## Implementation Checks`, `## Review Gate`, or `## Parallel Safety`.

**Budget:** after counting phases `P`, `plan-skeleton` re-budgets to
`3 × phaseCount + 2` under execute (vs `6 × phaseCount + 1` for normal). The
formula varies by **loop mode**, not planning depth.

**Terminal path:** on main-coordinator `plan-phase` `complete:` under execute, the
daemon enqueues one feature-level `review` (depth-cap exempt). When that review
completes, the daemon enqueues `final-gate` (also depth-cap exempt) instead of
following the static `review → plan-phase` edge. A feature-level review that stops
`blocked:` halts — it does not reach `final-gate`.

**Commit accounting:** unchanged at **`P + 1`** — one commit per phase plus the
final gate record. The feature-level review makes no phase commit (it may commit
fixes only).

**v1 exclusions:** no parallel waves under execute; no auto-enter after architect
skeleton; `blocked:` halts rather than splitting; serial main-ordinal admit only.

`lca doctor <runId>` prints `loop mode: execute` on execute lineages; normal runs
omit the line.

## Preconditions on the target workspace

The target must:

1. Be a **git repository** registered as an LCA workspace.
2. Use the `docs/roadmap/` convention, including a backlog
   `docs/roadmap/00-index.md` that carries a `<!-- next: b<n> -->` marker so
   `plan-skeleton` can allocate the next feature id.

Without both, kickoff has nowhere durable to write state and nowhere mechanical
to select the next phase.

## Feature folder shape

`plan-skeleton` always creates (and later workers maintain):

```text
docs/roadmap/b<n>-<slug>/
  prd.md
  00-index.md
  NN-<name>.md   # one file per phase
```

Even a feature that a one-shot planner would size **S** gets this folder. The
tracker table is the loop's state machine; a single consolidated doc has no rows
to select or mark Done. Full-depth planning reuses this same shape and never
collapses to one document.

Each phase file includes a `## Parallel Safety` section:

| Field | Values |
| --- | --- |
| `Isolation` | `parallel-safe` or `sequential` (default `sequential` when unknown) |
| Expected path prefixes | Where this phase may touch files |
| Conflicting phases | Comma-separated phase numbers, or `—` |

Under `planningDepth: jit`, phase files start as scope-only stubs. Under
`planningDepth: full`, every initial phase file is already a complete
fast-model contract (Implementation Checks + Review Gate + acceptance +
Parallel Safety) before `plan-phase` selects.

## The tracker table

The feature `00-index.md` holds a markdown table that *is* the pipeline's state
machine. Columns are exactly:

| Phase | File | Status | Depends on | Commit |

Status values are exactly `Pending`, `In Progress`, and `Done`.

`Depends on` is a comma-separated list of phase numbers (for example `1, 2`), or
`—` when the phase has no dependencies. The fifth column (versus this repo's
usual four-column tracker) exists so dependency-ready selection stays mechanical
and does not require reading phase prose.

Capacity-driven expansion on main retains the original phase row/file as the first
narrowed unit and allocates new top-level numeric phase refs/files from the next
unused integer without renumbering history. Downstream **Pending** dependencies on
the original ref are rewritten to the terminal replacement ref(s) that actually
satisfy the prerequisite; affected Pending contracts are updated when
responsibilities, interfaces, checks, or acceptance moved. `Done` rows and shipped
phase files stay immutable.

## Selection — sequential mode

On the **main** checkout, `plan-phase` admits dependency-ready `Pending` rows with
evidence-based re-evaluation (both `jit` and `full`), applies the capacity
invariant (and any main-only split + additive budget growth), then — when
`approvalPolicy` is `before-implementation` — presents the Guided approval gate
**before** marking `In Progress` or calling `pipeline_wave`. Deep and Quick
(`approvalPolicy: none`) skip the gate and continue to selection.

Valid contracts are preserved. Refresh of anchors, interfaces, constraints, scope,
dependencies, and checks requires current code or recorded prior-phase outcomes —
not stylistic preference, neighboring phase shape, file/line count, or rediscovery.

When a Pending candidate exceeds what one implement worker can safely finish and
one review worker can comprehensively verify, main expands it into the fewest
substantial executable rows (retained original + next-unused integers), extends
budget once, then **restarts** dependency-ready selection from the rewritten
tracker.

### Guided approval gate

When `approvalPolicy` is `before-implementation` and product implementation has
not begun, main-coordinator `plan-phase` pauses with a durable, no-timeout
`needs_input` request via `ask_user` after adaptive admission is coherent:

| Choice id | Effect |
| --- | --- |
| `approve` | Record `## Planning Approval` in the feature index; only then select / fan-out. |
| `revise` | Free-form follow-up for details; update mutable PRD/index/Pending contracts; re-admit; present a fresh structured gate in the same run. |
| `abort` | `chain_control` stop with an `abort:` reason; no row becomes `In Progress`; no success handoff. |

Only the persisted choice id `approve` advances — labels, synonyms, and free-form
prose cannot approve. Artifact links use the existing Files viewer and the run's
authoritative workspace (`prd.md`, `00-index.md`, and every current phase
contract). An existing `## Planning Approval` marker makes an explicitly approved,
unchanged plan idempotent across a retried fresh `plan-phase`; it must never
silently bless revised artifacts. Guided approval grants no escalation authority.

- **One** ready row, or safety unclear → write that topmost phase (same as before).
- **Two or more** ready rows that are **pairwise-safe** (`Isolation: parallel-safe`,
  disjoint path prefixes, no conflicting-phase overlap) → call `pipeline_wave`
  `fan-out` with those candidates; write **no** phase file on main.
- **`sequential-fallback`** from fan-out → write only the topmost accepted/ready phase.

The topmost rule still applies when only one phase is written.

## Selection — track mode

When the daemon appends a trusted `lca-track-context` block, the run is a **track**.
The assigned `phaseRef` and `phaseFile` are authoritative — do not re-select from
the tracker on main. `plan-phase` may refresh that assigned contract under the same
evidence rules, then marks only that row `In Progress` there.

Track runs must **not** split the assigned unit, alter other tracker rows, extend
budget, fan out, or create/bypass the Guided approval gate — main already admitted
the candidate (and, for Guided, obtained approval) and fixed wave topology before
track creation.

Track `implement` and `review` prefer the phase from `lca-track-context`.
Sequential runs on main keep the single-`In Progress` rule.

## Terminal outcomes

Two planning terminals, both delivered through `chain_control` stop (never by
mutating an automation edge):

| Situation | Who stops | Reason prefix |
| --- | --- | --- |
| No `Pending` row remains | `plan-phase` | `complete:` |
| `Pending` rows remain but none is dependency-ready | `plan-phase` | `deadlock:` |

Only `complete:` is success. A deadlock is a planning bug; silently looping or
silently completing would hide it. (A third prefix, `blocked:`, is used by
`implement` / `review` / `integrate-wave` when verification cannot pass or the
tracker is unreadable — still a stop, not a self-marked failed run.)

## Parallel waves — branch ownership and barrier

| Location | Owns |
| --- | --- |
| Main checkout | Coordinator `plan-phase`, `integrate-wave`, sequential single-phase writes |
| Track worktree + branch | That track's `plan-phase` … `review` cycle |

Handoffs:

- Main coordinator fan-out → daemon provisions tracks; main writes nothing.
- Track `review` → daemon intercepts before the static chain edge; no automatic
  `plan-phase` on the track branch.
- All tracks complete → daemon enqueues `integrate-wave` on main with
  `lca-integration-context` (base commit, branches, tips in ordinal order).

`integrate-wave` merges with `git merge --no-ff --no-edit` in ordinal order,
mechanically reconciles tracker/backlog/phase-doc conflicts, aborts on unsafe
product-code conflicts (`pipeline_wave` `block`), runs a merged-tree smoke gate
(root typecheck + build plus the integrated phases' focused checks — not the
full suite), then calls `pipeline_wave` `finalize` only when every tip is merged
and the tree is clean. It chains to `plan-phase` only after finalize succeeds.

Track `review` uses the same single-commit closeout, deferred hash sweep, and
drift vocabulary as main; commits land on the daemon-created branch.

## Barrier failure and operator recovery

When integration cannot complete safely, the wave moves to **blocked**. Operators
use:

```bash
lca wave <waveId> retry|abort [--reason <text>]
```

- **retry** — when the wave is blocked, all tracks are complete, main is clean, and
  no integration run is active; reuses wave state and re-enqueues integration.
- **abort** — idempotent; retains dirty or unmerged work for diagnosis; does not
  delete track branches/worktrees silently.

`lca doctor` reports running tracks, barrier waits, blocked waves, cleanup-required
waves, and the recovery command; it does not perform cleanup. Configuration of
`maxConcurrentRuns`, sequential fallback, and worktree/branch ownership:
[configuration.md](./configuration.md). Blocked-wave and retained-resource
procedures: [troubleshooting.md](./troubleshooting.md). Daemon wave events
(`run.pipeline-wave-blocked`, `run.pipeline-wave-finalized`, etc.) remain on the
lineage timeline.

## Transition budget

After counting phases `P`, `plan-skeleton` re-budgets the chain. The formula
varies by **`loopMode`**, not planning depth:

| `loopMode` | Formula | Reserved ceiling (example `P = 2`) |
| --- | --- | --- |
| `normal` (default) | `6 × phaseCount + 1` | 13 |
| `execute` | `3 × phaseCount + 2` | 8 |

Both formulas are clamped to the daemon's max-depth ceiling of 500. `P` is the
final tracker row count once that worker's planning branch has finished — scope-only
stubs under `jit`, complete initial contracts under `full` — never a pre-planning
estimate.

Every kickoff reserves the loop-mode formula whether the pipeline later runs
sequential or wave execution. Sequential work may consume fewer transitions than
the reserve; the reserved ceiling does not shrink.

The **normal** formula reserves deliberate headroom for parallel waves, coordinator
overhead, and the terminal `final-gate` step — it is **not** a tight derivation
of the three-worker loop length. Up to six transitions per phase (including
fan-out, per-track work, integration, and coordinator overhead), plus the initial
`plan-skeleton → plan-phase`, plus the final terminal `plan-phase` / `final-gate`
path, may consume fewer transitions than the reserve in a purely sequential run.

The **execute** formula reserves three transitions per phase (admit → implement →
thin commit), plus `plan-skeleton`, plus the terminal feature-level `review` and
`final-gate`.

Worked example for `P = 2` under **normal**: depth 0 is `plan-skeleton`; the
reserved ceiling is `6 × 2 + 1 = 13`. A purely sequential path may finish with
fewer transitions than that reserve, but `plan-skeleton` still re-budgets to the
same `6 × phaseCount + 1` bound. Parallel fan-out consumes budget on track
branches and main integration without changing the formula.

When `plan-phase` on main expands the tracker with net new executable rows under
**normal** mode, it calls `chain_control` once with additive growth of
`6 × added tracker rows`. Under execute, `plan-phase` is admit-only and does not
extend the budget. Narrowing the retained original row adds no unit. The extension
is monotonic, evented, inherited by the successor, and clamped at 500; it never
resets consumed depth or root lineage. Absolute `rebudget` remains available for
skeleton-style ceiling replacement; additive `extendBy` / `extendBudget` grows
from the current effective ceiling.

Kickoff arms `plan-skeleton` with `maxDepth: 1`. If the skeleton never
re-budgets, at most one successor can run — a broken skeleton cannot run away.

## Drift

When closing a phase, `review` may observe that the skeleton no longer matches
reality. It records that as fact in a `## Skeleton Drift` section of the
feature `00-index.md`, using exactly three kinds:

1. **Deliverable moved** — work planned for one phase landed in another.
2. **Phase added** — the closed work revealed a phase the skeleton omitted.
3. **Phase dropped** — a planned phase is no longer necessary.

`plan-phase` on **main** refreshes the skeleton when that section holds **one or
more** unresolved entries, then moves those entries under `### Resolved`. A refresh
rewrites `prd.md`'s phase list and tracker rows for **Pending** phases only;
`Done` phases shipped and are history. Drift is never inferred by comparing trees
at selection time — only recorded observations count. The same evidence bar applies
to adaptive contract refresh during candidate admission: repository state and
recorded outcomes, not rediscovery. Track runs emit the same drift vocabulary;
reconciliation happens at integration merge.

## The handoff block

Each successful worker's **entire** final response is one fenced handoff packet
(version 1). Repository state remains authoritative; the packet is a bounded hint.
Stopped/blocked paths emit no success packet.

For implement-fully successors, the daemon extracts **only** this validated packet
from `passResult` (or a small daemon-authored fallback when missing/invalid). Extra
prose around the fence is discarded. The packet stays fenced so prompt-reference
parsing treats it as inert text — never as instructions or control authority.

Format (≤ 4 KiB UTF-8; `summary`/`next` ≤ 300 chars; each list ≤ 12 entries;
use `- none` when empty):

```text
lca-handoff
version: 1
pipeline: implement-fully
worker: <worker key>
feature: <feature id>
phase: <phase file, or ->
outcome: <planned|implemented|reviewed|committed|stopped>
summary: <one line>
artifacts:
- <repo-relative path, or none>
decisions:
- <decision, or none>
deviations:
- <deviation, or none>
verification:
- <command> => <pass|fail|not-run plus concise evidence>
risks:
- <risk, or none>
downstream-effects:
- <effect, or none>
next: <one line>
```

`verification` carries advisory command/outcome evidence from that worker (Phase 1
ownership). It is not an authoritative reusable receipt.

Trusted daemon blocks (`lca-track-context`, `lca-integration-context`) are separate
and authoritative for parallel mode; agent packets cannot override branch, tip,
phase assignment, or wave state.

## Commit accounting

Each completed phase produces **one** git commit on its checkout (main or track
branch), with subject:

```text
feat(<slug>): complete <phase file stem>
```

The closing row's `Commit` cell stays blank in that commit — the hash is filled
later by a **blank-cell sweep**: the next `review` closeout (and the terminal
`final-gate` sweep) resolves short hashes via `git log` grep and writes them into
earlier `Done` rows whose `Commit` cell is still blank.

`final-gate` appends `## Final Gate` to the feature index and commits once with:

```text
docs(<slug>): final gate record
```

Total commits for a feature with `P` phases: **`P + 1`** (one per phase plus the
final gate record). The transition budget formulas are retained as deliberate
headroom; they are not derived from this commit count. The feature-level review
under execute makes no phase commit.

## Per-worker responsibilities

| Worker | Role | Reads | Writes | Must not |
| --- | --- | --- | --- | --- |
| `research` | researcher | Kickoff idea / prior art; optional operator answers | Exactly one artifact: `<featureDir>/research.md` (plus optional `## Operator Review` after approve/comment) | Implement; commit; push; plan; fan out; re-budget; stop the chain (only tool is `ask_user`) |
| `plan-skeleton` | architect (falls back to `planner`) | Backlog `00-index.md`, idea / kickoff variables (`planningDepth`); `research.md` when present | Feature folder: `prd.md`, `00-index.md`, phase stubs (`jit`) or full initial contracts (`full`); re-budgets via `chain_control` from final tracker count | Implement product code; commit; push; select / mark `In Progress` |
| `plan-phase` | planner | Feature tracker, `prd.md`, drift (main); `lca-track-context` (track); current code and prior-phase evidence | Evidence-based refresh for both depths; JIT first-time detail or full-depth preserve/repair; main-only capacity splits + additive budget growth; Guided approval gate on main when `approvalPolicy` is `before-implementation`; marks row `In Progress`; may fan-out on main; stop with `complete:` / `deadlock:` / `blocked:` / `abort:` | Implement product code; commit; push; fan-out/split/extend/gate from a track; renumber Done history; bypass Guided gate when policy requires it |
| `implement` | implementer | Phase file (track context or single `In Progress`) | Product / test code; runs **Implementation Checks** only; stop with `blocked:` if stuck | Commit; push; edit tracker Status to Done; run Review Gate / full root compound pass |
| `review` | reviewer | Phase contract + diff / Review Gate (normal); every `Done` phase contract (execute feature-level) | Review findings; owns focused **Review Gate** once on final code (normal per-phase); focused checks across phases (execute feature-level); after a green gate marks the phase `Done`, refreshes index context, sweeps blank `Commit` cells, records drift, and makes **one** closeout commit (normal only); stop with `blocked:` when gates cannot pass | Push; per-phase closeout commit under execute feature-level review; commit before Review Gate is green (normal); make a second commit for the same phase; silently waive failing gates; blindly rerun an unchanged failed command; run a full root compound pass |
| `docs-commit` | docs (execute-mode phase closer) | Phase file; `lca-track-context` on tracks | Marks phase `Done`, refreshes index, records drift, blank-cell sweep, **one** `/gc` commit; stop with `blocked:` when stuck | Push; Review Gate; run a full root compound pass; active loop step under normal kickoff |
| `integrate-wave` | reviewer | `lca-integration-context`, merged tree | Merge commits on main; merged-wave smoke verification (root typecheck + build + focused checks); `pipeline_wave finalize` | Push; start phases; finalize before merges verify; run the full test suite |
| `final-gate` | gatekeeper (falls back to `reviewer`) | Feature index, whole-repo tree on main | Single full root pass (`typecheck` + `build` + both test lanes); may commit gate fixes only; appends `## Final Gate` to the feature index | Push; start or re-plan phases; edit `Done` contracts; widen scope beyond making the gate green |

Nothing in the pipeline pushes to a remote.

## Verification ownership

Phase contracts split gates so implement gets fast feedback and review owns a
focused contract-fidelity gate. Neither section carries a full root
`typecheck → build → full test` pass — that runs **once per feature at the end**
via the terminal `final-gate` worker:

| Section | Owner | Contents |
| --- | --- | --- |
| `## Implementation Checks` | `implement` | Focused tests for changed behavior; affected-workspace typecheck/build; phase-specific scripts or browser checks. **No** full root `typecheck → build → full test` pass. |
| `## Review Gate` | `review` | Focused/affected checks for the phase's diff plus behavioral acceptance review must own. **No** full root `typecheck → build → full test` pass. After Review Gate is green, `review` also owns phase closeout and **one** commit (subject below) before chaining to `plan-phase`. *(Per-phase only — under execute, `review` runs once at feature end.)* |
| Feature-level acceptance (execute) | `review` | Every `Done` phase contract; focused checks named by those phases; behavioral acceptance across the feature. **No** full root pass; **no** phase closeout commit. May commit fixes only. Routes to `final-gate` on success. |
| Feature-end root pass | `final-gate` | Full `npm run typecheck` → `npm run build` → `npm test` (both lanes) on main after `plan-phase` stops with `complete:` (normal) or after the execute feature-level `review` completes. |

`plan-phase` ensures both phase sections exist (implement-fully exception to the
planning skill's single Verification block). Full upfront contracts written by
`plan-skeleton` already use this split; `plan-phase` validates/repairs the
selected file rather than inventing a single Verification block.
`integrate-wave` runs a merged-tree smoke gate after ordinal merges: root
typecheck + build plus the integrated phases' focused checks — not the full
suite.

The daemon enqueues `final-gate` when main-coordinator `plan-phase` stops with
`complete:` under **normal** mode, or when the execute feature-level `review`
completes. Both enqueues are **depth-cap exempt**: a budget-exhausted feature still
gets its gate (the child's `chainMaxDepth` is floored to fit the terminal step).
Under execute, `plan-phase` `complete:` enqueues the feature-level `review` first
(same exemption). `final-gate` has no chain edge; a green gate stops with
`complete:`, while `blocked:` from `final-gate` is a halt (diagnosed tree left
as-is), not feature completion. A green gate writes `## Final Gate`
and may sweep blank Commit cells — it does **not** set feature `Status:
Implemented` or move the backlog row into `00-index.md` Completed; that closeout
is operator/agent follow-up (or `/roadmap-tidy`).

**Phase boundary (planning profiles):** Both Quick/JIT and full profiles pass
through adaptive `plan-phase`. Full planning is not blindly regenerated — valid
contracts are preserved and refresh requires repository or recorded-outcome
evidence. Capacity splits, dependency propagation, and additive budget growth are
main-coordinator responsibilities during admission. Guided
`approvalPolicy: before-implementation` pauses on main with a durable Input Hub
`needs_input` gate (no-timeout `ask_user`) after admission and before
`In Progress` / fan-out; Deep and Quick remain ungated.

**Legacy fallback** — phases with a single `## Verification` section:

- `implement` runs focused/affected commands but excludes the final root compound pass.
- `review` runs focused/affected commands and any unproved behavioral check; still
  excludes the full root compound pass.

A failed command is diagnosed and fixed, then re-run — never blindly retried
unchanged. The single full root pass is a feature-end concern (`final-gate`), not
a per-phase review obligation.

## Failure behavior

Every chain edge is `when: completed`. A failed step therefore enqueues no
successor; the failed run stays on the board and records `run.chain-skipped`
with reason `status-mismatch` (depth and effective budget included when the run
is context-aware).

**Automatic halt recovery (post-terminal, allowlisted):** when
`settings.pipelineAutoEscalate` is on (default `true`; kill switch
`LCA_PIPELINE_AUTO_ESCALATE=0`), the daemon may retry or skip **only** a safe
late `sdk_error` class — failed context-aware pipeline step, latest
`status-mismatch`, latest bare `sdk_error`, and prior substantive
`assistant` / `tool_call` activity. Worker ladder: `plan-phase` / `implement`
retry once; `review` retries once then halts; `docs-commit` skips once
(legacy in-flight runs only); other workers decline. Cap defaults to `2` daemon escalations per lineage
(`pipelineAutoEscalateMaxPerPipeline`, env
`LCA_PIPELINE_AUTO_ESCALATE_MAX_PER_PIPELINE`). Runtime reuses the operator
escalation machinery and write-once chain claim; durable `actor: "daemon"`
metadata distinguishes automatic action. There is no new endpoint or run-token
authority. Declined, unknown, unsafe, contract-related, and wave/track cases
stay halted for operator escalation (`run.pipeline-halt-unrecovered`). This does
not widen spawn/resume/stall retries, add recurring recovery, hot-reload
settings, wave recovery, or agent escalation authority. Settings load at
startup — change them with `lca restart`. Details:
[configuration](./configuration.md), [troubleshooting](./troubleshooting.md).

**Halt discovery (best-effort post-halt advisory):** when
`settings.pipelineHaltDiscovery` is on (default `true`; kill switch
`LCA_PIPELINE_HALT_DISCOVERY=0`), an unrecovered halt may launch a separate
`halt-discovery` diagnosis worker that parks a no-timeout recommendation for
the operator. Discovery sits **outside** worker transition authority: it cannot
call chain/escalation tools, does not consume transition depth, and never
claims the source. Only the operator may approve a briefing choice (maps to
source escalation) or promote the advisory into chat (diagnosis context only;
does not escalate the source). Direct operator escalation remains the fallback.
Settings load at startup — change with `lca restart`. Details:
[configuration](./configuration.md), [troubleshooting](./troubleshooting.md).

**Operator escalation** (`lca escalate <runId> <action>` or
`POST /api/runs/:id/escalate`, also on the halted card in the dashboard):

| Action | Effect |
| --- | --- |
| `retry` | New run at the **same** depth with the same prompt and chain context. Unavailable on the pipeline root (`root-run`). |
| `skip` | Enqueues the configured successor with an operator notice in the prompt. Unavailable when the budget is exhausted (`budget-exhausted`) or there is no successor. |
| `abort` | Writes a stop marker and reason; the lineage ends. |

Each successful action claims `chain_handled_at` once and appends
`run.pipeline-escalated` on the target (`actor: "operator"` for this path). A
stop or an exhausted transition budget still surfaces as `run.chain-skipped`
(`stopped` / `max-depth`) with a legible reason.

**Restart replay:** on boot, inside `settings.pipelineResumeLookbackMs`
(default 24h; `0` disables), the daemon (1) replays missed transitions for
`completed` context-aware runs whose claim was never written (`run.pipeline-resumed`
once each) and (2) runs a bounded, idempotent failed-halt recovery pass over
halted candidates in that window, acting only on the safe class when
auto-escalate is on (with the kill switch set, each candidate records a
one-time `disabled` decline instead). Legacy (non-context) chains are never
resumed this way. Declined or unsafe failures remain operator-escalation
territory. Wave join and track terminals have separate recovery in the wave
coordinator (out of scope for auto-halt recovery).

## Operator surfaces

- **Kick off** with the CLI verb (preferred):

  ```bash
  lca implement-fully --feature <bN>
  lca implement-fully --idea "<text>"
  ```

  Exactly one thin input is required. The CLI, user-level skill
  (`/implement-fully` after `npm run install:skill`), and dashboard all call
  `POST /api/pipelines/implement-fully/resolve`, review the daemon’s canonical
  feature id / slug / idea, then provision and create the run (`maxDepth: 1`).
  Optional planning depth: `--profile quick|deep|guided` (Quick/JIT default).
  Optional model recipe: `--role-profile <id>` (named profile from YAML) or the
  dashboard **Model profile** control when named profiles exist. Optional
  research gate: `--research-approval none|before-planning` (default `none`).
  Per-role `--role <role>=<modelId>` overrides still win. Resolution order:
  per-role override → selected profile / active default recipe → error (missing
  required role refuses; optional roles resolve to absent). Only concrete
  `roleModels` persist on the chain — the profile id is kickoff-only. Changing
  profile YAML still requires `lca restart`. The verb enforces the
  one-active-pipeline-per-workspace guard (`--force` to override).

- **Escalate** a halted step:
  `lca escalate <runId> retry|skip|abort [--reason <text>]`, or
  `POST /api/runs/:id/escalate` (operator credentials — not a run token).
- **Wave recovery:**
  `lca wave <waveId> retry|abort [--reason <text>]`.
- **Diagnose** a pipeline step: `lca doctor <runId>` (Pipeline + Lineage blocks
  when the run has chain metadata); bare `lca doctor` summarizes active /
  halted / aged `needs_input` pipeline runs, plus wave lines
  (`tracks running`, `barrier wait`, `blocked waves`, `cleanup required`) and
  recovery commands when waves are present. For a `final-gate` run carrying a
  role recipe, `lca doctor <finalGateRunId>` also prints
  `gate:       gatekeeper=<modelId> (explicit | reviewer fallback)`, derived
  from the chain recipe rather than the automation row. Doctor never mutates
  wave state.
- **Real-feature soak gate (Phase 5d, historical):** run end-to-end from a normal
  terminal or Cursor chat — not from a daemon-hosted Max run (`lca restart` there
  kills the session). Set all four roles in `settings.pipelineRoleModels`, restart
  the daemon, dry-run kickoff, then watch the board through completion (including
  one mid-pipeline restart). Restart the daemon from a normal terminal, not
  from inside a hosted run.
- **Phase 6 composite gate:** `npm run verify:b36-6` — root build, workspace
  typechecks, the full Vitest suite, and the isolated UI/worktree verifier on
  port 3767 with a temporary home. It does not bind or probe the operator daemon
  on `:3747`.
- **Focused verifier catalog:** `verify:b51:ui` (Alerts, port 3773),
  `verify:b56-3:ui` (research approval, port 3771), `verify:b56-9:ui` (kickoff,
  port 3772), and `verify:b57` (static graph/docs). Fixed-port UI verifiers run
  sequentially with temporary homes and never touch the live daemon.
- **Final-gate drift lesson:** scripts outside the normal `npm test` lane can
  rot after shared dashboard/worker-graph changes. Before final-gate, run the
  focused verifier named by each affected feature in addition to affected
  typecheck/build/tests; never assume the root test lane covers standalone
  `verify:*` scripts.
- **Provision** the eight registered workers for a workspace:
  `POST /api/pipelines/implement-fully/workers` (body: `workspaceId` *or*
  `workspacePath`, optional `dryRun` / `prune`). Three loop workers run per
  phase; `integrate-wave` and `final-gate` are terminal paths; `docs-commit` is
  the execute-mode phase closer (runtime remap from `implement`).
- **Inspect** the pipeline shape (keys, roles, edges, required variables/skills,
  budget formulas — not prompt text): `GET /api/pipelines/implement-fully`.

The underlying kickoff contract is an ordinary context-aware `POST /api/runs`
against the `plan-skeleton` worker with the ten required variables and
`maxDepth: 1`. Use that path when building a second caller; day-to-day operators
should use `lca implement-fully`.

Required variables:

```text
pipelineId
featureId
featureSlug
featureDir
featureIndex
idea
planningDepth      # jit | full
approvalPolicy     # none | before-implementation
researchApprovalPolicy # none | before-planning
loopMode           # normal | execute
```

Official callers select a presentation profile (`quick` / `deep` / `guided`)
that maps onto `planningDepth` and `approvalPolicy`. Pass `--execute` (CLI) or
check Execute mode (dashboard) for `loopMode: execute`. The profile id is not
persisted. Historical six-variable contexts normalize to Quick/JIT
(`jit` + `none`) before render or descendant persistence; missing `loopMode`
normalizes to `normal`.

## Operator steering and pause

While a worker run is **live**, an operator may **soft-steer** it from an attached
workspace chat (`POST /api/chats/:id/steer` / dashboard **Steer**): guidance is
queued on the run and lands after the current turn without aborting progress.
**Pause** (`lca pause <runId>`) hard-parks the run so you can chat with the same
agent session directly; the chain does not advance and implement-fully budget is
not consumed until you **resume** (`lca resume <runId> [note…]`). Paused runs
stay non-terminal — they are not a halt and do not trigger b43/b44 recovery.

`planningDepth` is behavioral in `plan-skeleton` / `plan-phase` as described
above. `approvalPolicy: before-implementation` pauses Guided main-coordinator
`plan-phase` at the durable approval gate after adaptive admission and before
selection; only choice id `approve` advances. Operators who install the entry
skill via `npm run install:skill` also receive the `plan-implement-fully`
caller profile required by full-depth workers.
