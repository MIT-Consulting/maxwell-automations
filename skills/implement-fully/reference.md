# Implement-fully — reference

Sidecar for the entry skill. Informational only; the daemon owns stop reasons,
roadmap resolution, and the loop protocol.

## Daemon resolve boundary

The CLI posts thin input to the daemon. The response is the only source of the
canonical triple:

```text
feature id
feature slug
idea
```

Typical refusal categories (report the daemon message; do not work around):

- Missing or malformed thin input
- Feature not found in the roadmap index
- Ambiguous or malformed roadmap metadata
- Stale next-id allocation for new work
- Workspace missing git or the roadmap index

The skill never chooses an existing folder, derives a slug, reads the next-id
marker, or appends prior-art paths itself.

Operator skip of confirmation: after a successful dry run that already showed
the canonical triple, proceed when the invocation explicitly allows it.

```text
--dry-run
```

## Planning profiles

Kickoff presentation ids map to two durable chain variables. The profile id
itself is not persisted.

| Profile | `planningDepth` | `approvalPolicy` |
| --- | --- | --- |
| `quick` (default) | `jit` | `none` |
| `deep` | `full` | `none` |
| `guided` | `full` | `before-implementation` |

```text
--profile <quick|deep|guided>
```

Omitting the profile option resolves to `quick` (Quick/JIT). Dry run and
confirmed kickoff must use the same profile option.

`planningDepth` changes planning behavior:

- Quick/JIT (`jit`) creates shallow feature stubs; `plan-phase` details one
  selected phase later against real code.
- Deep and Guided (`full`) create all initial detailed phase contracts before
  any tracker row becomes `In Progress`.

Both profiles still pass through adaptive `plan-phase`: evidence-based refresh
(preserve valid contracts; repair only when code or recorded outcomes make them
stale), capacity admission before selection/fan-out, and — on main only —
capacity-driven tracker expansion with additive budget growth
(`extendBy: 6 × net new rows`). Full planning is not blindly regenerated.

When `approvalPolicy` is `before-implementation` (Guided), main-coordinator
`plan-phase` presents a durable no-timeout Input Hub approval gate after
admission/capacity handling and before any row becomes `In Progress` or a wave
starts. The operator sees a Markdown summary, recommendation, Approve / Revise /
Abort choice buttons, and Files-viewer links to `prd.md`, `00-index.md`, and
phase contracts. Only choice id `approve` advances (after a `## Planning
Approval` marker); `revise` stays in the same planning run; `abort` stops the
chain. Deep and Quick (`approvalPolicy: none`) remain ungated. Track workers
never create or bypass the gate. Guided approval grants no escalation authority.

## Role recipe (verb-owned)

The verb resolves these roles:

```text
planner        # required
implementer    # required
reviewer       # required
docs           # required
researcher     # optional — omit disables the research prelude
architect      # optional — omit falls back to the concrete planner selection at plan-skeleton
gatekeeper     # optional — omit falls back to the concrete reviewer selection
```

For **required** roles, resolution is:

```text
--role override → selected --role-profile / active default recipe → error
```

Optional roles use the same precedence chain but resolve to **absent** (not an
error) when neither an override nor the selected profile supplies them.
`gatekeeper` falls back to the concrete persisted reviewer selection at
`final-gate`; omitting `researcher` leaves entry at `plan-skeleton`.

The active default recipe is `defaultPipelineRoleModelProfile` when set, else the
synthetic profile id `default` (= `settings.pipelineRoleModels`). Named recipes
live under `settings.pipelineRoleModelProfiles` in global YAML; do not define a
named profile id `default`. Only concrete `roleModels` persist on the chain — the
profile id is kickoff-only. Changing profile YAML requires a daemon restart:

```bash
lca restart
```

A missing **required** role aborts before any run is created. Prefer named
profiles and YAML defaults over repeating the per-role override flag on every
kickoff. See operator configuration docs for authoring recipes (quality vs
cheap, etc.).

## Research approval gate

Kickoff control `researchApprovalPolicy` via:

```text
--research-approval <none|before-planning>
```

| Value | Behavior |
| --- | --- |
| `none` (default) | Research finishes without an Input Hub card. |
| `before-planning` | After durable `research.md`, a no-timeout two-step ask: choice ids `approve` / `comment`, then free text after `comment`. Operator review lands under `## Operator Review` in `research.md`. |

The parked request survives reload and daemon restart; abort by cancelling the
run. The researcher cannot stop its own chain (only `ask_user`). An armed policy
without a resolved researcher is refused before provision.

Do not confuse planning depth, the model recipe, and the research gate:

```text
--profile            # planning: quick | deep | guided
--role-profile       # model recipe
--research-approval  # research gate: none | before-planning
--execute            # loop mode: skip per-phase plan/review (requires deep or guided)
```

## What stop / skip reasons mean (primer)

When watching a run later with the command below, these are the usual pipeline
skips. Do not treat them as instructions to act on in the kickoff chat.

```bash
lca doctor <runId>
```

| Reason | Meaning (short) |
|---|---|
| `stopped` | A worker called stop (`complete:` / `deadlock:` / `blocked:` prefixes in the detail). |
| `max-depth` | Transition budget hit. Root left at depth 1 with no re-budget is the fail-safe. |
| `already-chained` | Duplicate terminal on a run that already transitioned — usually harmless. |

Recovery (retry / skip / abort from the board) is a later operator surface. Until
then, diagnose with the command below and re-trigger a worker manually if
needed.

```bash
lca doctor <runId>
```

## Watching after kickoff

```bash
lca logs <runId>
lca doctor <runId>
```

Or open the Max dashboard. The invoking chat does not poll.
