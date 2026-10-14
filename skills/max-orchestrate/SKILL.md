---
name: max-orchestrate
description: >-
  Kick off Max work, supervise pipelines, or answer "what should Max do" and "is Max
  done." Use when the operator asks to run b<n> on Max, start implement-fully,
  orchestrate a wake hook, or check whether a pipeline finished. Routes through
  max capabilities --json — never reimplements version-specific surfaces or flags.
---

# Max Orchestrate

Router over the live capability map. The CLI owns surfaces, playbooks, statuses,
and anti-patterns; this skill says how to load the map and obey what it returns.

## First action — always

1. Run **`max capabilities --json`**, adding **`--workspace <id|name|path>`** when
   the target workspace is known.
2. If the command is missing or the JSON lacks the expected tag/schema, report a
   **version mismatch** and stop — do not invent verbs, flags, or playbooks from
   memory.
3. Select a surface by **`bestFor`**, follow its **playbook** command sequence, and
   treat returned **anti-patterns** as binding constraints.

Do not copy version-specific surface lists or flag catalogs into chat — re-fetch
when facts may have changed.

## Policy boundaries

- **Read** actions (capabilities, status, list, watch, doctor) may be inspected
  freely.
- **Mutating** effects (kickoff, directive, pipeline-stop, queue edits) require
  whatever authorization the calling environment or operator imposed.

## Done semantics

Use the selected surface's playbook **done signal** — usually `max watch … --json`
with `outcome: green` for pipelines. Never infer success from quiet output, a
single notification, or webhook HTTP 200 alone.

For quick snapshots when the map points there, fall back to **`max status --json`**
or **`max list --json`** — still obey anti-patterns.

## Wake-hook routine (b83 contract)

When woken by Max with a JSON body (see
[docs/configuration.md](../../docs/configuration.md) § Grok Bot routine template):

1. Read **`host`** — run commands on that computer only.
2. Run the **`next`** field from the body (e.g. `max doctor` or `max watch … --json`).
3. Act per your playbooks; relay important state to the operator.
4. **Never** run `max down`, `lca down`, or stop the daemon.
5. Set **`LCA_ACTOR`** to the hook's `actorId` on every `max` command so Max can
   suppress self-caused wakes.

HTTP **200** from the webhook means the routine **started**; Max does not wait
for a callback and that response is not pipeline completion.

## Safety invariants

- **Never** probe `state.sqlite` or grep agent transcripts for runtime state.
- **Never** stop or restart the daemon from an agent session unless the operator
  explicitly requests a code pickup via `max restart`.

Setup and registration belong to the **`max-setup`** skill — finish that before
orchestrating unregistered workspaces.
