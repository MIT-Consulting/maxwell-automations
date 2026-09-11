---
name: implement-fully
description: >-
  Starts a multi-run implement-fully pipeline that plans, implements, and
  reviews a feature in a registered Max workspace — review owns phase closeout
  and commits once per phase. Use when the operator
  says /implement-fully, "implement fully", "take this feature all the way", or
  names a bare backlog id like b42. Loads only when named — never from ambient
  context about implementing code.
disable-model-invocation: true
---

# Implement Fully

This is a thin entry point over the CLI verb:

```text
lca implement-fully
```

You choose one thin input and a workspace; the verb asks the daemon to resolve
canonical feature id, slug, and idea, then provisions workers, merges role
defaults, guards against a second active pipeline, and kicks off the chain.
After kickoff you hand off and stop — the pipeline continues in other runs.

Daemon-owned resolve outcomes, role recipe, and a short stop-reason primer are
in:

```text
reference.md
```

That primer is informational only; the daemon owns the protocol.

## Workflow

Follow these steps in order. Do not skip ahead to planning or implementation.

### 1. Preconditions

Confirm the daemon is reachable:

```bash
lca status
```

If the daemon is not reachable, stop and say so. Do **not** start it, restart
it, or shut it down.

### 2. Resolve the workspace

Default to the current working directory. Use this option only when the
operator named a different registered workspace:

```text
--workspace <id|name|path>
```

If the directory is not a registered Max workspace, stop. Tell the operator to
register it in the Max dashboard (or by adding the path under `workspaces:` in
the global automations YAML). Do **not** register it yourself.

### 3. Choose one thin command input

Exactly one of these forms:

**Named backlog id (`b<n>`):**

```bash
lca implement-fully --feature <bN> --dry-run
```

**Free-form new work (no backlog id):**

```bash
lca implement-fully --idea "<text>" --dry-run
```

Do **not** invent a slug, read the roadmap index, allocate the next id, or
append prior-art paths. The daemon resolve step owns that metadata.

Optional flags (only when the operator asked for them):

```text
--workspace <id|name|path>
--profile <quick|deep|guided>   # planning profile; default quick (Quick/JIT)
--role-profile <id>         # model recipe (named YAML profile or synthetic "default")
--role <role>=<modelId>     # repeatable; roles: planner, implementer, reviewer, docs, researcher, architect, gatekeeper
--research-approval <none|before-planning>  # research gate; default none
--execute                   # execute mode: skip per-phase plan/review (deep/guided only)
--force                     # allow kickoff when an active pipeline already exists
--prune                     # prune stale generated workers during provision
```

Planning vs models vs research gate (do not confuse):

```text
--profile            # planning depth: quick | deep | guided (not models)
--role-profile       # role-model recipe id (named YAML profile or synthetic "default")
--research-approval  # research gate: none | before-planning (not planning, not models)
--execute            # loop mode: skip per-phase plan/review (requires deep or guided)
```

Author named recipes under `pipelineRoleModelProfiles` /
`defaultPipelineRoleModelProfile` in global automations YAML settings. See
operator configuration docs for examples (quality vs cheap).

Use the same profile option on dry run and confirmed kickoff. Profile mapping
and durable controls are documented in `reference.md`.

### 4. Dry run and confirm

Run the dry-run form from step 3 (writes nothing). The output includes the
daemon-resolved canonical feature id, slug, and idea, the selected planning
profile and durable controls, plus the role recipe.

Show those values to the operator. Get one explicit confirmation before the
real kickoff. Skip confirmation only when the invocation explicitly says to
(for example "skip confirm" or "just kick off").

If the dry run refuses (unregistered workspace, resolver failure, missing role
default, active pipeline without the force option, provision conflict), stop
and report the error. Do not work around it — do not inspect the roadmap or
repair metadata yourself.

### 5. Kick off

Run one command with the same options as the dry run, omitting its dry-run
option:

```bash
lca implement-fully --feature <bN> [--profile <quick|deep|guided>] [--role-profile <id>]
```

or

```bash
lca implement-fully --idea "<text>" [--profile <quick|deep|guided>] [--role-profile <id>]
```

Omit the planning profile flag for Quick/JIT (current default). Include the
same planning and model profile options chosen in the dry run when selected.

Report the run id and how to watch it in the dashboard or with:

```bash
lca logs <runId>
lca doctor <runId>
```

### 6. Hand off and stop

**Stop here.** Do not open the phase files. Do not plan. Do not implement. Do
not poll for progress. Do not summarize intermediate pipeline steps. The
pipeline runs in its own agent runs; this chat is done after reporting the run
id.

## Hard constraints

- Do not stop, shut down, or restart the daemon.
- Do not embed or restate worker prompts, the loop protocol, or stop-reason
  vocabulary as rules you enforce — the daemon owns those.
- Do not read or edit the roadmap index to invent kickoff metadata.
- Put every literal command, flag, path, and slash-leading token in a fenced
  code block when documenting them in follow-ups.
