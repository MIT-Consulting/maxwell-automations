# Agents in this Max checkout

Instructions for Cursor agents working **in this Max repository** (the local
agent factory checkout). Scoped to this tree — not generic advice for every
folder in a multi-root workspace.

## Before anything

1. Read `engines.node` in `package.json` and compare to `node --version`.
2. `npm ci` then `npm run build`.
3. Make the CLI callable — pick one:
   - `npm link -w @lca/cli` then use `max …`
   - or `npx lca …` without linking
4. `max skills install` — copies bundled skills (including `max-setup`) into
   `~/.cursor/skills/`.
5. Configure `CURSOR_API_KEY` in `~/.cursor-local-automations/.env` (see
   [README.md](./README.md)).
6. `max up` then bare `max doctor`.

Do not run `max …` until step 3 succeeds.

## Setup handoff

After the steps above, follow the **`max-setup`** skill for register → doctor →
create / adopt / ready:

- Register: `max workspace add <path>`
- Readiness: `max doctor <workspace> --json` (text doctor lacks `fixable_by`)
- Roadmap format: [docs/roadmap-format.md](./docs/roadmap-format.md)
- Operator docs: [docs/troubleshooting.md](./docs/troubleshooting.md),
  [docs/configuration.md](./docs/configuration.md)

## Always-applied safety

- **Never** run `lca down`, `max down`, `POST /api/shutdown`, or scripts that
  stop the live daemon from an agent session. Use `lca restart` only when an
  operator explicitly asks to pick up code changes — not during setup.
- **Never** probe `state.sqlite` or grep agent transcripts to infer runtime state.
  Prefer `max doctor`, `max status`, and `max list`.
- **Export/leak rule:** shared files use placeholder tailnet addresses
  (`100.64.0.x`, `100.64.1.x`, `100.127.255.1`) and profile path
  `C:\Users\dev\` — never real machine addresses, usernames, or emails.

## Orchestrating Max

<!-- b80 appends operator orchestration guidance below this seam -->
