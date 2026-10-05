# Adoption sidecar — max-setup

Agent work for converting an existing backlog into `docs/roadmap/`. The CLI
classifies candidates; the operator picks the canonical source.

## Present candidates

Run `max doctor <workspace> --json`. When `state` is `adoptable`, read
`candidates[]` and present **every** candidate with:

- path
- mtime (when present)
- estimated item count (when present)

**Never pick by mtime.** Ask the operator which file is the canonical backlog
source. Wait for an explicit choice before editing.

## Convert

1. `max roadmap init` when `docs/roadmap/00-index.md` does not exist yet.
2. Move or reshape **only** the chosen backlog content into `docs/roadmap/`
   following [docs/roadmap-format.md](../../docs/roadmap-format.md) **Minimum to
   kick off** and **Adopting an existing backlog**.
3. `max roadmap fix [workspace]` for additive CLI-owned repairs (`--yes` only in
   non-TTY with operator approval).
4. Ask whether to **retain** the old file or **replace** it with a one-line
   pointer to the new index.

Show diffs. Do not commit until the operator explicitly approves **one**
reviewable commit.

## Verify

Rerun `max doctor <workspace> --json` until exit 0 (green doctor). Only then is
adoption done.
