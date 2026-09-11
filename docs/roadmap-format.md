# Roadmap format

Max's implement-fully pipeline treats `docs/roadmap/` as durable state. This
page is the **public file-format contract**. AMOS (a private scaffolding tool)
happens to emit the same layout; public Max does not depend on AMOS.

Scaffold a workspace that has none:

```bash
max roadmap init          # or: lca roadmap init
# writes docs/roadmap/00-index.md in the current directory (or pass a path)
```

Kickoff (`max implement-fully --feature bN` / `--idea …`) refuses to start
unless this convention exists: there is nowhere durable to write phase state.

## Backlog index — `docs/roadmap/00-index.md`

Required pieces:

1. A `<!-- next: b<n> -->` comment so `plan-skeleton` can allocate the next id.
2. A `## Backlog` section with `- **b<n>** …` items (optional `[detailed plan](./file.md)` links).
3. A `## Completed` table:

   `| ID | Feature | Description | Docs |`

4. Optional `## Documented Ideas` table:

   `| ID | Idea | Status | File |`

Ids are `b<n>` (never reused). Epics, if you use them, are `e<n>` parent briefs
only — never a feature folder, never implement-fully targets.

## Feature folder

```text
docs/roadmap/<slug>/          # often b<n>-<slug> after promotion
  00-index.md                 # phase tracker (pipeline state machine)
  prd.md                      # design / requirements
  NN-phase-name.md            # one file per phase
```

Even a small feature gets this folder. A single consolidated doc has no rows
for the pipeline to select or mark Done.

### Tracker table

`00-index.md` columns are exactly:

| Phase | File | Status | Depends on | Commit |

Status values: `Pending`, `In Progress`, `Complete`. Commit hashes are recorded
in a later docs-touching commit, not as a dedicated "record the hash" commit.

### Phase file

Each phase includes a `## Parallel Safety` section:

| Field | Values |
| --- | --- |
| Isolation | `parallel-safe` or `sequential` (default `sequential` when unknown) |
| Expected path prefixes | Where this phase may touch files |
| Conflicting phases | Comma-separated phase numbers, or `—` |

How the pipeline *uses* these files (workers, waves, execute mode) lives in
[`implement-fully-protocol.md`](./implement-fully-protocol.md).
