---
name: plan-implement-fully
description: >-
  Composes whole-feature speed-model planning under implement-fully's fixed
  feature-folder and tracker contract. Use when an implement-fully plan-skeleton
  worker has planningDepth full, or when the operator invokes
  /plan-implement-fully to produce every initial Pending phase as a complete
  fast-model contract before plan-phase selects work.
disable-model-invocation: true
---

# Plan Implement Fully

Caller/output profile for Deep and Guided implement-fully runs. Delegates
exploration, architecture, sizing, and phase-writing discipline to
`/plan-for-speed-model-fully`. Overrides that skill's adaptive output shape so
the result always fits the implement-fully repository-state contract.

## When to use

- Generated `plan-skeleton` with `planningDepth: full` (Deep / Guided profiles).
- Explicit `/plan-implement-fully` when the operator wants the same contract
  outside the pipeline.

Do not use for Quick/JIT (`planningDepth: jit`) — that path keeps shallow stubs.

## Inputs (already decided)

Use the already-rendered kickoff values; do not resolve or allocate backlog
identity:

```text
featureDir
featureIndex
featureId
idea
```

## Delegate

1. Invoke `/plan-for-speed-model-fully` for exploration, architecture reasoning,
   capacity-aware sizing, and per-phase writing discipline.
2. Apply the output overrides below while writing. There is one planning
   authority: the delegate's methodology plus this caller's fixed shape.

## Output overrides (non-negotiable)

### Fixed folder

Always retain:

```text
prd.md
00-index.md
NN-<name>.md
```

Never collapse to one consolidated roadmap document, even when the delegate
would choose size S.

### Tracker

Columns, in order, must be exactly:

```text
| Phase | File | Status | Depends on | Commit |
```

- Create every new executable row as `Pending`.
- Fill `Depends on` with mechanically parseable phase numbers (comma-separated)
  or `—`.
- Leave **no** row `In Progress` and select nothing — `plan-phase` owns
  selection.

### Phase contracts

Every initial phase file must include a complete plan-for-speed-model contract
plus:

- `## Implementation Checks` (focused feedback for implement; no full root
  `typecheck → build → full test` pass)
- `## Review Gate` (review-owned; focused/affected checks plus behavioral
  acceptance — no full root `typecheck → build → full test` pass; that is
  `final-gate` only)
- Behavioral acceptance bullets
- `## Parallel Safety` (`Isolation`, expected path prefixes, conflicting phases)

Do not use a single `## Verification` block for these phases.

### Implementation capacity (initial decomposition only)

Prefer the fewest realistic initial phases — oversized over routine over-split.
Every extra tracker row costs a full plan-phase → implement → review cycle
(budget grows as `6 × rows + 1`). File/line/neighbor counts are signals, never
automatic thresholds. Capacity splits are a later `plan-phase` safety valve; do
not stylistically pre-split here. Do not perform runtime Pending-phase splits or
budget extension (later pipeline phases own those).

## Idempotent reruns

- Reuse the canonical `featureDir` and tracker.
- Finish or refresh incomplete `Pending` planning artifacts only.
- Preserve existing `Done` / `In Progress` rows and shipped phase files.
- Never create a second feature folder or renumber history merely to match the
  delegate's normal sizing conventions.

## Authority limits

May write planning artifacts and backlog documentation only.

Must not:

- Implement product code
- Run verification gates
- Commit or push
- Select a phase or mark any row `In Progress`
- Call `pipeline_wave` or `chain_control`
- Enforce Guided approval (approval stays out of this profile)

## Done when

- Feature folder exists with PRD, index, and numbered phase files.
- Tracker has the exact five columns; every executable row is `Pending`.
- Every initial phase file is implementation-ready under the contract above.
- Rerun safety holds for any already-shipped rows.
