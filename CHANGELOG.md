# Changelog

All notable public releases of Max are recorded here. The public git history
is snapshot-based (one commit per export), so this file is the human changelog.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and version numbers follow [SemVer](https://semver.org/).

## [Unreleased]

### Upgrade actions

none

## [1.2.0] - 2026-10-14

### Added

- **`max capabilities [--json] [--workspace, -w <id|name|path>]`** — tag-stamped orchestrator map (surfaces with `bestFor` / `notFor`, live role-model profiles with optional YAML `description`, planning profiles, status vocabulary, playbooks, anti-patterns, and doc pointers). With `--workspace`, projects roadmap readiness, active pipeline state, and feature-queue counts to mark kickoff surfaces and playbooks `available` or `blocked`.
- **`max-orchestrate` skill and `AGENTS.md` Orchestrating Max router** — bundled skill (installed by `max skills install` and `max update --apply`) and root `AGENTS.md` section that route outside orchestrators (Cursor chat, Grok Bot) to `max capabilities --json`.
- **JSON fallbacks (`max status --json`, `max list --json`)** — machine-readable single-document JSON outputs with explicit window/display limits, alongside `max queue list --json`.
- **Orchestrator wake hooks (`settings.wakeHooks[]`)** — outbound HTTPS webhook and workspace-chat doorbells on pipeline lifecycle events (`needs_input`, `halted`, `blocked`, `green`, `queue_drained`) with bearer token from `.env` (`tokenEnv`), hot reload, coalescing, hourly cap, self-caused `X-LCA-Actor` suppression, retry, `max doctor` ring log, and a **Wake hooks** panel with a **Test** button in Dashboard **Settings → Alerts**.
- **Inbound webhook trigger (`trigger: webhook`)** — HMAC-SHA256-verified `POST /api/triggers/webhook/<name>` (`X-LCA-Signature`), exempt from the control token, with delivery-id deduplication (`X-LCA-Delivery`, schema v25), 64 KiB body cap, optional payload field allowlist mapped into prompt variables, untrusted-input prompt preface, and a `Webhooks` status block in `max doctor`.
- **`--then <automation>` after a green `implement-fully`** — chains an ordinary workspace automation when `final-gate` stops with `complete:` and holds the checkout and feature queue until the tail chain is terminal; supported on `max implement-fully`, `max queue add`, the Dashboard kickoff modal (**After the gate**), `max queue list`, Running-column preview cards, and `max doctor`.
- **Queue entry detail (`max queue list -v` / `--json` and Running-column preview cards)** — shows the clickable feature doc link (opens in the Files viewer), role-model profile or resolved `role=model` list, planning profile and `--execute` / research-approval controls, `--after` dependencies with live states, queue position, and enqueue time.
- **Cancel and reorder queued entries (`max queue move` and preview-card actions)** — Running-column preview cards add **Move to top**, **Move up**, **Move down**, and dependent-aware **Cancel** confirmation; `max queue move <id> --before <id> | --after <id> | --top` rewrites waiting positions inside a transaction and refuses moving an entry ahead of an unfinished `--after` dependency.

### Fixed

- Wake hooks ring on the first lifecycle event even when the pipeline was kicked off with an `X-LCA-Actor` header; TLS failures classify nested error causes; coalesce summaries preserve the original payload alongside `suppressed`; Settings → Alerts Wake hooks shows load errors instead of empty-config copy.
- `POST /api/triggers/webhook/<name>` stays control-token-exempt when the webhook name fails charset validation so typos return `404` instead of `401`, and webhook triggers declared in global config are reported as `not armed` in `max doctor`.
- Dashboard kickoff modal resets the **After the gate** (`--then`) selection if loading workspace automations fails so a previous workspace's automation key cannot be submitted.

### Upgrade actions

- **Upgrading from 1.1.4:** `max update --apply` fetches `v1.2.0`, builds, installs the new **`max-orchestrate`** skill into `~/.cursor/skills/`, restarts the daemon (migrating `state.sqlite` to schema v25 automatically), and reloads open dashboard tabs. If you upgrade by hand with `git checkout v1.2.0`, run **`max skills install`** after `npm ci && npm run build` so `max doctor` does not flag skills-bundle drift.
- **Upgrading from 1.1.0–1.1.3:** `max update --apply` works; reload any open dashboard tab once after upgrading (automatic tab reload on version change shipped in 1.1.4) and run **`max skills install`** if hopping from 1.1.0–1.1.3 by hand.
- **Windows installs still on 1.0.7 or earlier:** `max update --apply` cannot make the hop (`spawnSync npm.cmd EINVAL`). Move the pin once by hand from a clean tree: `git fetch --tags origin`, `git checkout v1.2.0`, `npm ci` (requires Node 22.13+), `npm run build`, `max skills install`, `max up`, `max doctor`. From 1.1.0 onward, `--apply` works.

## [1.1.4] - 2026-10-05

### Added

- Test builds as files: `max update --from <file>` installs a test bundle on a public clone and saves the release it left; `max update --stable` returns to it. Settings → About shows a **Test build** badge with the way back, and `max update --apply` refuses on a test build with the same instruction. `scripts/make-test-bundle.mjs` cuts the bundle, and refuses a clone whose origin is GitHub so the test stamp is not committed in the repo that publishes.

### Fixed

- The dashboard is no longer built against the previous version's shared code. The root build ran packages alphabetically, so after `max update --apply` the dashboard bundled the old `@lca/shared`; on 1.1.3 that left the duplicate-row picker fix out of the browser.
- `max update --apply` builds from empty `dist` folders, then fails and rolls back unless the daemon, CLI, and dashboard all report the new version and the dashboard was built from the shared code this build produced.
- A successful `max update --apply` no longer breaks the next one. It records the local release tag, and when that tag is missing it compares HEAD with the published tag instead of refusing.
- `max update --apply` installs the bundled skills, and restores them on rollback.
- Open dashboard tabs reload themselves when the daemon comes back on a different version.
- CLI refusals print as one `Error: …` line instead of a Node stack trace.

### Upgrade actions

- Reload any open dashboard tab once after this upgrade. The 1.1.3 dashboard does not reload itself, and the 1.1.3 updater does not gain that behavior on the hop into this release.
- Windows installs still on 1.0.7 or earlier: `max update --apply` cannot make the hop. Move the pin by hand with `git checkout v1.1.4`, then `npm ci`, `npm run build`, `max skills install`, `max up`. From 1.1.0 onward, `--apply` works.

## [1.1.3] - 2026-10-05

### Fixed

- A feature id listed twice in the same index section no longer blocks anything: kickoff and the dashboard picker use the first row, and doctor reports the extra row as information. On 1.1.1 and 1.1.2 one such row emptied the picker's **Existing feature** list for the whole workspace.

### Upgrade actions

- Windows installs still on 1.0.7 or earlier: the 1.1.1 note applies unchanged — `max update --apply` cannot make the hop; move the pin by hand with `git checkout v1.1.3`, then `npm ci`, `npm run build`, `max skills install`, `max up`. From 1.1.0 onward, `--apply` works.

## [1.1.2] - 2026-10-05

### Fixed

- Readiness no longer blocks `--feature` for ids that appear in both a priority table and **Documented Ideas**; only ids with no canonical index row stay in `ignored-section-ids`.
- Legacy trackers with bare phase numbers, numbered or `P0`-style Phase cells (`1. Title`, `P2 — Title`, `Phase 3: Title`), `P1`-style `Depends on` references, `—` File cells on phases without a doc, four-column AMOS-style headers, or status cells with trailing notes parse cleanly instead of blocking kickoff.
- Tracker findings now carry the real parser error instead of a generic or wrong hint (for example a false “add Depends on” message when that column already exists).
- Doctor **Per feature:** and `--json` `features` list each id once (Backlog beats Documented Ideas beats Completed).

### Upgrade actions

- `max roadmap fix` repairs **only** missing canonical sections (`## Backlog`, `## Completed`, `## Documented Ideas`), a missing **plain** `<!-- next: … -->` marker, and the id-format declaration. Per-person `next:` markers skip the plain-marker step; the plan is not refused for them.
- Tracker, ignored-section, duplicate-row, and other readiness findings need agent or operator edits — doctor fix lines say which. `roadmap fix` does not repair those.
- Repos that showed `adoptable` on 1.1.0 or 1.1.1 should run `max doctor <workspace>` after upgrading **before** editing any tracker.
- Windows installs still on 1.0.7 or earlier: the 1.1.1 note applies unchanged — `max update --apply` cannot make the hop; move the pin by hand with `git checkout v1.1.2`, then `npm ci`, `npm run build`, `max skills install`, `max up`. From 1.1.0 onward, `--apply` works.

## [1.1.1] - 2026-10-04

### Fixed

- Public CI: six test files added in 1.1.0 read the private `docs/roadmap/` tree (self-index parity, live b77 tracker, b80 playbook contracts) and the `deep-fast` recipe example that 1.1.0 removed. Those assertions now skip when the private docs are absent and the architect example points at the `quality` recipe. No runtime change.

### Upgrade actions

- **Windows, coming from 1.0.7 or earlier: `max update --apply` cannot make this hop.** The installed CLI runs its own `update-apply`, and 1.0.7's spawns `npm.cmd` without `shell: true`, so apply fails `spawnSync npm.cmd EINVAL` at `npm ci` and the rollback fails the same way (HEAD is reset to the backup first, so the checkout stays on 1.0.7 with its build intact; the daemon is left stopped). Move the pin once by hand, then `--apply` works for later releases:

  ```powershell
  git status --short            # must be empty
  git fetch --tags origin
  git checkout v1.1.1
  npm ci                        # engine-strict: needs Node 22.13+
  npm run build
  max skills install
  max up
  max doctor
  ```

- Non-Windows installs: `max update --apply` works as documented; the 1.1.0 Upgrade actions still apply.

## [1.1.0] - 2026-10-04

### Added

- Node floor enforced at CLI/daemon bootstrap; `.npmrc` `engine-strict`; `max update --apply` / `--dry-run` preflight (`node-floor` from the target tag's `package.json`); doctor **Environment** (Node, npm, skills-bundle drift); every changelog entry has `### Upgrade actions`.
- Shared feature-id module + index parser; default `^b(?:-[a-z]{2,3})?\d+$`; optional `<!-- id-format: … -->` in the index; kickoff / picker / `--idea` follow it.
- Per-workspace roadmap readiness (`ready` / `empty` / `adoptable`) on bare `max doctor`, `max doctor <workspace>`, `--json`, Register, kickoff, picker, workspace badge; `max roadmap fix`; `max doctor --report`.
- User-level `max-setup` skill; root `AGENTS.md`; README Getting Started as register → doctor → create / adopt / ready.
- Pipeline snapshot + cursor feed; `max watch`; `--feature` addressing; `X-LCA-Actor`; `max directive`; `max pipeline-stop`; schema v23–v24 (`pipeline_directives`).
- Direct implement-fully kickoffs are queue-visible (`origin: direct`); `queue add --after` accepts those roots and releases on green; schema v22.

### Fixed

- `pipeline_complete` only when the final gate stops with `complete:`; distinct `pipeline_blocked` alert (toast + ntfy on by default) for `blocked:` / `deadlock:`.
- `max run` refuses extra arguments (kickoff-looking flags point at `max implement-fully`); daemon refuses a manual context-less trigger of a `generated:` worker.
- On Windows, doctor Environment and `max update --apply` spawn `npm.cmd` with `shell: true` so they no longer fail `EINVAL`.
- Doctor no longer flags index-linked / id-prefixed `docs/roadmap/*.md` single-doc plans as `ignored-backlog-file`, and a slug with two index entries no longer duplicates the same tracker finding.
- Remote bind retries after `EADDRNOTAVAIL`.

### Changed

- Minor bump: the enforced Node floor and the default-on `pipeline_blocked` alert change behaviour for existing installs (see Upgrade actions).
- Role-model recipe examples (`docs/configuration.md`, `config/automations.example.yaml`) replaced with the calibrated `fast-moderate` / `quality` / `ui-polish` house seats; the stale `cheap` / `deep` / `max` examples that named non-catalog ids are gone.

### Upgrade actions

- **Node 22.13+ is now enforced.** `npm ci` / `npm install` fail under
  `engine-strict`, and `max` / the daemon refuse to start on an older Node with
  a message that names the floor and the download URL. Upgrade Node before
  pulling; `max update --apply --dry-run` reports the target tag's floor ahead
  of time.
- Rerun `max skills install` so the new `max-setup` skill and the updated
  pipeline skills are copied into `~/.cursor/skills/`. Bare `max doctor` now
  flags skills-bundle drift under **Environment** until this is done.
- The first `max restart` after upgrading migrates `state.sqlite` from schema
  v21 to v24 (feature-queue `origin`, chain-root index, `pipeline_directives`).
  Automatic and additive; no operator step, but take a copy of
  `~/.cursor-local-automations/state.sqlite` first if you want a rollback path.
- New `pipeline_blocked` alert is **on by default** for toast and ntfy. Phone
  users who only want green pushes should turn it off under dashboard
  **Settings → Alerts** or `settings.notify.events.pipeline_blocked`.
- Run `max doctor <workspace>` on each registered repo. Readiness findings
  (`adoptable`, `bad-tracker-header`, …) are new and may surface pre-existing
  roadmap drift; `max roadmap fix` handles the additive ones.
- Role-model recipe examples in `docs/configuration.md` and
  `config/automations.example.yaml` now show the calibrated house seats
  (Grok 4.6 `effort=high fast=false` for plan/review, Composer 2.5 `fast=true`
  for implement/docs, Opus 5.5 gatekeeper, Fable 5.1 researcher, Gemini 3.8
  Flash `ui-polish` reviewer). Existing YAML is untouched; refresh your
  `pipelineRoleModels` / `pipelineRoleModelProfiles` and `lca restart` to adopt.

## [1.0.7] - 2026-09-29

### Added

- `max update --apply` moves a clean tag-pinned checkout to a newer release tag, then builds and health-checks. A failed health check rolls back to `refs/max/update-backup`. Factory checkouts and dirty trees are refused. `--dry-run` prints the plan.
- The Running column shows the next feature-queue entries before they become runs, with one Next mark per workspace.
- Pipeline kickoff probes each role model and refuses up front when the runtime rejects a selection. `max escalate retry|skip --role` swaps that role for the retry and later steps.

### Fixed

- The feature queue waits until the chain transition settles before starting the next entry. A failed entry returns to done when a retry greens final-gate, and the rows it parked return to queued. Slot-waiting queued runs are labeled on the board.
- Halt-discovery advisories are no longer treated as halted pipeline steps, and a failed advisory no longer marks the pipeline failed or completed.
- Failed runs record the SDK error message instead of a bare `sdk_error`.
- Expanding or collapsing an implement-fully group stays in the clicked column.

### Changed

- `@cursor/sdk` 1.0.32, so failed runs can carry the backend's error message. Node floor is 22.13+.

### Upgrade actions

- Node 22.13+ is required because `@cursor/sdk` 1.0.32 needs it. Install Node 22 or 24 LTS from https://nodejs.org/en/download before running `npm ci`.

## [1.0.6] - 2026-09-21

### Added

- Report three versions: running (embedded at build), checkout (`version.json`), and the newest approved GitHub release.
- `max --version`, `max version`, and `max update check`. `status` and `doctor` include the cached update line.
- Settings → About shows those versions, links to the Apache-2.0 license and NOTICE, and restarts the daemon. A chip opens About when an approved update is available or a restart is required.
- `settings.update` chooses the approved repo, cache interval, and optional token. The check does not install a release. Factory checkouts (`0.0.0-dev`) are not told to move to a public tag.

### Upgrade actions

none

## [1.0.5] - 2026-09-16

### Fixed

- Export leak-scan now reads `.mdc` rule files. The `C:\Users\dev` placeholder
  is allowed as a complete path (Gitleaks previously required a trailing slash).

### Upgrade actions

none

## [1.0.4] - 2026-09-16

### Added

- Auto-select the first workspace chat when the Chat view has no current
  conversation.
- Sidebar Add workspace uses the same `POST /api/workspaces` path as the
  new-automation form.

### Fixed

- YAML writer initializes empty sequence and map nodes so Add workspace,
  notify settings, and chat defaults do not throw on a missing or `{}`
  config.
- Feature queue stays `running` until a lineage run actually fails or is
  cancelled, or final-gate settles; do not start the next row in the
  green-worker gap. `max queue add --dry-run` prints the payload and skips
  enqueue.
- Chat revive recovers error turns from the transcript instead of leaving
  the conversation stuck.
- Public export pins snapshot commits to
  `MIT-Consulting <MIT-Consulting@users.noreply.github.com>` and scans the
  operator email as a split literal.
- Public Gitleaks workflow now actually loads `gitleaks.toml` (the action only
  auto-discovers the dotted filename, so the custom personal-info rules were
  silently unused) and supports manual full-history runs via `workflow_dispatch`.

### Upgrade actions

none

## [1.0.3] - 2026-09-11

### Fixed

- Replace a real Tailscale address that leaked into a test fixture with a
  documentation-range placeholder; add a gitleaks rule for the 100.64.0.0/10
  range so the export scan catches this class going forward.

### Upgrade actions

none

## [1.0.2] - 2026-09-10

### Fixed

- Bump `actions/checkout` and `actions/setup-node` to v5 (silence Node 20
  action-runtime deprecation annotations).

### Upgrade actions

none

## [1.0.1] - 2026-09-10

### Fixed

- Public CI: Node 22 (undici 8 on Node 20 crashed three test suites), stale
  model-label and Files-nav seam tests, export of `.cursor/rules/`.

### Upgrade actions

none

## [1.0.0] - 2026-09-10

First public snapshot of Max (Maxwell) as a local agent factory.

### Added

- Daemon, dashboard, and `max` CLI (`lca` alias) for local Cursor-agent automations.
- Implement-fully pipeline, serial feature queue, workspace chats, and Files view.
- Apache-2.0 license and personal-time provenance NOTICE.
- `max skills install` and `max roadmap init`.
- Public skill bundle companion repo `maxwell-automations-skills` (lockstep tags).

### Upgrade actions

none
