# Roadmap format

Max's implement-fully pipeline treats `docs/roadmap/` as durable state. This
page is the **public file-format contract**. AMOS (a private scaffolding tool)
happens to emit the same layout; public Max does not depend on AMOS.

Scaffold a workspace that has none:

```bash
max roadmap init          # or: lca roadmap init
# writes docs/roadmap/00-index.md in the current directory (or pass a path)
```

Kickoff (`max implement-fully --feature b42` / `--idea …`) refuses to start
unless this convention exists: there is nowhere durable to write phase state.

## Ids

Feature ids identify backlog items and feature folders. By default — with no
declaration in the index — Max accepts:

- legacy ids: `b42`, `b77`, … (`b` + digits)
- per-person ids: `b-dm58`, `b-xy58`, … (`b-` + 2–3 lowercase owner letters + digits)

Epic ids (`e42`, `e-dm58`, …) are parent briefs only. They are never feature
folders and never implement-fully targets; kickoff refuses them with an
epic-specific message.

Optional whole-line index comments pin a repository's convention (never required
to kick off):

```html
<!-- id-format: b<n>, b-<owner><n> -->
<!-- epic-format: e<n>, e-<owner><n> -->
```

Templates use literal lowercase letters and hyphens, an optional `<owner>`
placeholder (2–3 letters), and exactly one trailing `<n>` for digits. Digits must
be last so `${id}-` folder-prefix lookup stays unambiguous. Duplicate
declarations and raw regex syntax are rejected.

Folder slugs must begin with `${featureId}-` followed by lowercase segments
(for example `b42-thinner-impl-fully`, `b-dm58-my-feature`).

Anchored links (`./file.md#section`) are preserved in the agent-facing prior-art
pointer; path matching uses the path only.

The `<!-- next: … -->` counter exists only for `--idea` allocation. A plain
`<!-- next: b42 -->` marker allocates the next legacy id. Per-person markers
(`<!-- next: b-dm58 -->`) make `--idea` refuse — add the item to the index with
your id and use `--feature` instead.

## Why markdown

Repository roadmap markdown is **live, agent-visible source of truth**. Kickoff,
the resolver, picker, and operator commands read `docs/roadmap/` directly — not
restart-bound Max settings. Edits to the index or feature folders take effect on
the next resolve without a daemon restart.

Format errors say what is wrong, give the exact fix, and point here. Stable
message prefixes (`featureId must match`, `Invalid --feature`, `Invalid --slug`,
`must start with "<id>-"`) are part of the operator contract.

## Minimum to kick off

**Documented work (`--feature`):** the feature id must appear in a canonical
index section (`## Backlog`, `## Documented Ideas`, or `## Completed`) and have
a resolvable feature folder or prior-art doc. No `id-format` declaration is
required for legacy or per-person ids.

**New work (`--idea`):** the global index must contain exactly one plain
`<!-- next: b<n> -->` marker with no per-person `next:` markers present. Max
allocates the id, slug, and folder metadata — do not invent them in the CLI.

Epics, unknown ids, malformed declarations, and per-person `--idea` attempts
fail before provisioning with actionable messages.

## Backlog index — `docs/roadmap/00-index.md`

Required pieces:

1. A `<!-- next: b<n> -->` comment so `plan-skeleton` can allocate the next id
   (plain legacy counter only; see **Ids** for per-person rules).
2. A `## Backlog` section with `- **b<n>** …` items (optional `[detailed plan](./file.md)` links). A short H2 suffix is allowed (`## Backlog (prioritized)`); `###` priority groups stay inside the section.
3. A `## Completed` table:

   `| ID | Feature | Description | Docs |`

4. Optional `## Documented Ideas` table:

   `| ID | Idea | Status | File |`

Ids are never reused. Epics, if you use them, stay in prose or separate briefs
— not as implement-fully feature folders.

When an id appears in more than one of these sections, Backlog wins over
Documented Ideas, which wins over Completed. When it appears twice in the same
section, Max uses the first row and `max doctor` notes the extra one as
information; nothing is blocked.

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

Status values: `Pending`, `In Progress`, `Done` (legacy `Complete` is still
accepted in existing trackers). Commit hashes are recorded in a later
docs-touching commit, not as a dedicated "record the hash" commit.

Max also reads legacy trackers: four-column `Phase | File | Status | Commit`
tables, Phase cells written as `1`, `1. Title`, `P0 — Title`, or
`Phase 2 — Title`, `Depends on` cells that use the same `P1` style, a `—` File
cell on phases that never had a doc, and status cells with a trailing note
after `—`, `-`, `:`, or `(`. New trackers should still use the five-column
form above.

### Phase file

Each phase includes a `## Parallel Safety` section:

| Field | Values |
| --- | --- |
| Isolation | `parallel-safe` or `sequential` (default `sequential` when unknown) |
| Expected path prefixes | Where this phase may touch files |
| Conflicting phases | Comma-separated phase numbers, or `—` |

How the pipeline *uses* these files (workers, waves, execute mode) lives in
[`implement-fully-protocol.md`](./implement-fully-protocol.md).

## Adopting an existing backlog

Many repos arrive with backlog markdown outside `docs/roadmap/`. Max does not
silently convert them — register the workspace, inspect readiness, then choose
create, adopt, or proceed when ready.

1. **Register** the workspace in the dashboard, with
   `max workspace add <path>`, or ensure it appears in `max list -w …`.
2. **Inspect** with bare `max doctor` (Roadmaps section) or
   `max doctor <workspace>` / `max doctor -w <id>` for the full grouped report.
   `max doctor --json` emits the typed report for agents; exit code `1` when
   blockers exist (`blocks-all` or `blocks-some`).
3. **Create** when empty: `max roadmap init` writes `docs/roadmap/00-index.md`
   and creates `docs/` as needed.
4. **Repair** additive, Max-owned index gaps with `max roadmap fix` — the daemon
   returns a plan, the CLI prints a unified diff, asks for confirmation (or pass
   `--yes` in non-TTY), writes locally, and never commits.
5. **Adopt** structural backlogs (competing files, prose tables, renumbering) via
   agent/user edits guided by the finding fix lines — not silent CLI rewrites.

Max does **not** treat index-linked or `<id>-` prefixed markdown under
`docs/roadmap/` as competing backlog candidates — those files are part of the
Max-native roadmap. Other `docs/*.md` files (outside `docs/backlog/`) need a
Backlog, TODO, Roadmap, or similar heading to count as backlog-like; quoted
feature ids alone are not enough. Root `ROADMAP.md`, `BACKLOG.md`, and
`TODO.md` keep their conventional candidate rules.

Per-person ids (`b-dm58`, `b-xy58`, …) are valid **by default** with no
`id-format` declaration. Readiness blocks only ids that violate the active format
or appear in sections Max ignores — not merely because they use an owner segment.
